use nucleo::pattern::{CaseMatching, Normalization};
use nucleo::{Config, Matcher, Nucleo, Utf32Str};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;

#[derive(Debug, Serialize, Deserialize)]
pub struct FileSearchResult {
    pub path: String,
    pub indices: Vec<u32>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchResult {
    pub path: String,
    pub line: Option<u64>,
    pub text: Option<String>,
}

pub struct FileIndex {
    inner: Mutex<Option<IndexState>>,
}

struct IndexState {
    root: std::path::PathBuf,
    nucleo: Nucleo<String>,
}

impl FileIndex {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    pub async fn search(&self, query: &str, root: &Path) -> Result<Vec<FileSearchResult>, String> {
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }

        let mut guard = self.inner.lock().await;
        let needs_reindex = match &*guard {
            Some(state) => state.root != root,
            None => true,
        };

        if needs_reindex {
            let nucleo = Nucleo::new(Config::DEFAULT, Arc::new(|| {}), None, 1);
            let injector = nucleo.injector();

            let root_owned = root.to_path_buf();
            let mut child = Command::new("find")
                .args([
                    ".",
                    "-type",
                    "f",
                    "-not",
                    "-path",
                    "./.git/*",
                    "-not",
                    "-path",
                    "*/node_modules/*",
                    "-not",
                    "-path",
                    "./target/*",
                    "-not",
                    "-path",
                    "*/dist/*",
                ])
                .current_dir(&root_owned)
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| format!("Failed to run find: {}", e))?;

            let stdout = child.stdout.take().unwrap();
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let path = line.trim_start_matches("./").to_string();
                injector.push(path, |s, cols| {
                    cols[0] = s.as_str().into();
                });
            }
            let _ = child.wait().await;

            *guard = Some(IndexState {
                root: root.to_path_buf(),
                nucleo,
            });
        }

        let state = guard.as_mut().unwrap();
        let root_str = state.root.to_string_lossy().to_string();

        state
            .nucleo
            .pattern
            .reparse(0, query, CaseMatching::Ignore, Normalization::Smart, false);

        loop {
            let status = state.nucleo.tick(10);
            if !status.running {
                break;
            }
        }

        let snapshot = state.nucleo.snapshot();
        let pattern = state.nucleo.pattern.column_pattern(0);
        let mut matcher = Matcher::new(Config::DEFAULT);
        let mut buf = Vec::new();
        let mut indices_buf = Vec::new();

        let results: Vec<FileSearchResult> = snapshot
            .matched_items(..snapshot.matched_item_count().min(100))
            .map(|item| {
                let path = format!("{}/{}", root_str, item.data);
                indices_buf.clear();
                let prefix_len = (root_str.len() + 1) as u32;
                let haystack = Utf32Str::new(item.data.as_str(), &mut buf);
                pattern.indices(haystack, &mut matcher, &mut indices_buf);
                indices_buf.sort_unstable();
                indices_buf.dedup();
                let indices = indices_buf.iter().map(|&i| i + prefix_len).collect();
                FileSearchResult { path, indices }
            })
            .collect();

        Ok(results)
    }
}

pub async fn content_search(query: &str, root: &Path) -> Result<Vec<SearchResult>, String> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }

    let root_str = root.to_string_lossy();

    let mut child = Command::new("rg")
        .args([
            "--json",
            "--max-count",
            "5",
            "--max-filesize",
            "1M",
            "--max-columns",
            "200",
            query,
        ])
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to run ripgrep: {}", e))?;

    let stdout = child.stdout.take().unwrap();
    let reader = BufReader::new(stdout);
    let mut lines = reader.lines();
    let mut results = Vec::new();

    while let Ok(Some(line)) = lines.next_line().await {
        if results.len() >= 100 {
            break;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(|t| t.as_str()) != Some("match") {
            continue;
        }
        let Some(data) = value.get("data") else {
            continue;
        };

        let rel_path = data
            .get("path")
            .and_then(|p| p.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");
        let path = format!("{}/{}", root_str, rel_path.trim_start_matches("./"));
        let line_number = data.get("line_number").and_then(|n| n.as_u64());
        let text = data
            .get("lines")
            .and_then(|l| l.get("text"))
            .and_then(|t| t.as_str())
            .map(|s| s.trim().to_string());

        results.push(SearchResult {
            path,
            line: line_number,
            text,
        });
    }

    let _ = child.kill().await;
    Ok(results)
}

use nucleo::pattern::{CaseMatching, Normalization};
use nucleo::{Config, Matcher, Nucleo, Utf32Str};
use serde::{Deserialize, Serialize};
use std::io::ErrorKind;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;

const MAX_CONTENT_RESULTS: usize = 100;

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
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| format!("Failed to run find: {}", e))?;

            let stdout = child.stdout.take().unwrap();
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            let mut lines_read = 0;
            while let Ok(Some(line)) = lines.next_line().await {
                let path = line.trim_start_matches("./").to_string();
                injector.push(path, |s, cols| {
                    cols[0] = s.as_str().into();
                });
                lines_read += 1;
                if lines_read % 256 == 0 {
                    tokio::task::yield_now().await;
                }
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
            tokio::task::yield_now().await;
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

    let mut rg = Command::new("rg");
    rg.args([
        "--json",
        "--max-count",
        "5",
        "--max-filesize",
        "1M",
        "--max-columns",
        "200",
        "--",
    ])
    .arg(query)
    .arg(".")
    .current_dir(root)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null());

    match rg.spawn() {
        Ok(child) => return collect_rg_results(child, root).await,
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Failed to run ripgrep: {}", error)),
    }

    let mut grep = Command::new("grep");
    grep.args(["-R", "-n", "-H", "-I", "-e"])
        .arg(query)
        .arg(".")
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    let child = grep
        .spawn()
        .map_err(|error| format!("Failed to run ripgrep or grep: {}", error))?;
    collect_grep_results(child, root).await
}

async fn collect_rg_results(
    mut child: tokio::process::Child,
    root: &Path,
) -> Result<Vec<SearchResult>, String> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to read ripgrep output".to_string())?;
    let mut lines = BufReader::new(stdout).lines();
    let mut results = Vec::new();

    while results.len() < MAX_CONTENT_RESULTS {
        let line = lines
            .next_line()
            .await
            .map_err(|error| format!("Failed to read ripgrep output: {}", error))?;
        let Some(line) = line else { break };
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
        let line_number = data.get("line_number").and_then(|n| n.as_u64());
        let text = data
            .get("lines")
            .and_then(|l| l.get("text"))
            .and_then(|t| t.as_str())
            .map(|s| s.trim().to_string());

        results.push(SearchResult {
            path: search_path(root, rel_path),
            line: line_number,
            text,
        });
    }

    let limited = results.len() >= MAX_CONTENT_RESULTS;
    drop(lines);
    if limited {
        let _ = child.kill().await;
    }
    let status = child
        .wait()
        .await
        .map_err(|error| format!("Failed to wait for ripgrep: {}", error))?;
    if !limited && !matches!(status.code(), Some(0) | Some(1)) {
        return Err(format!("ripgrep failed with status {}", status));
    }

    Ok(results)
}

async fn collect_grep_results(
    mut child: tokio::process::Child,
    root: &Path,
) -> Result<Vec<SearchResult>, String> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to read grep output".to_string())?;
    let mut lines = BufReader::new(stdout).lines();
    let mut results = Vec::new();

    while results.len() < MAX_CONTENT_RESULTS {
        let line = lines
            .next_line()
            .await
            .map_err(|error| format!("Failed to read grep output: {}", error))?;
        let Some(line) = line else { break };
        if let Some(result) = parse_grep_result(&line, root) {
            results.push(result);
        }
    }

    let limited = results.len() >= MAX_CONTENT_RESULTS;
    drop(lines);
    if limited {
        let _ = child.kill().await;
    }
    let status = child
        .wait()
        .await
        .map_err(|error| format!("Failed to wait for grep: {}", error))?;
    if !limited && !matches!(status.code(), Some(0) | Some(1)) {
        return Err(format!("grep failed with status {}", status));
    }

    Ok(results)
}

fn search_path(root: &Path, relative: &str) -> String {
    root.join(relative.trim_start_matches("./"))
        .to_string_lossy()
        .into_owned()
}

fn parse_grep_result(line: &str, root: &Path) -> Option<SearchResult> {
    // Split at the colon followed by a numeric line number, so filenames
    // containing colons remain valid.
    for (index, character) in line.char_indices() {
        if character != ':' {
            continue;
        }
        let rest = &line[index + 1..];
        let (line_number, text) = rest.split_once(':')?;
        let Ok(line_number) = line_number.parse() else {
            continue;
        };
        return Some(SearchResult {
            path: search_path(root, &line[..index]),
            line: Some(line_number),
            text: Some(text.trim().to_string()),
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::content_search;
    use std::fs;

    #[tokio::test]
    async fn content_search_finds_matching_lines() {
        let root =
            std::env::temp_dir().join(format!("btmux-content-search-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(
            root.join("nested/matches.txt"),
            "before\nneedle with context\nafter\n",
        )
        .unwrap();

        let results = content_search("needle", &root).await.unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(
            results[0].path,
            root.join("nested/matches.txt").to_string_lossy()
        );
        assert_eq!(results[0].line, Some(2));
        assert_eq!(results[0].text.as_deref(), Some("needle with context"));
        fs::remove_dir_all(root).unwrap();
    }
}

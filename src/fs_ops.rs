use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(Debug, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<String>,
    pub extension: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileContent {
    pub path: String,
    pub content: String,
    pub mime_type: String,
    pub encoding: String,
    pub size: u64,
    pub truncated: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileMetadata {
    pub path: String,
    pub size: u64,
    pub modified: Option<String>,
    pub created: Option<String>,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub permissions: String,
}

pub fn validate_path(root: &Path, requested: &str) -> Result<PathBuf, String> {
    let candidate = if requested == "~" {
        dirs::home_dir().ok_or_else(|| "Cannot determine home directory".to_string())?
    } else if let Some(rest) = requested.strip_prefix("~/") {
        dirs::home_dir()
            .ok_or_else(|| "Cannot determine home directory".to_string())?
            .join(rest)
    } else if requested.starts_with('/') {
        PathBuf::from(requested)
    } else {
        root.join(requested)
    };
    let canonical = candidate
        .canonicalize()
        .map_err(|e| format!("Cannot resolve path: {}", e))?;

    Ok(canonical)
}

pub async fn list_dir(root: &Path, path: &str) -> Result<(Vec<FileEntry>, String), String> {
    let dir_path = if path.is_empty() || path == "." {
        root.to_path_buf()
    } else {
        validate_path(root, path)?
    };

    let resolved_path = dir_path.to_string_lossy().to_string();

    let mut entries = Vec::new();
    let mut read_dir = tokio::fs::read_dir(&dir_path)
        .await
        .map_err(|e| format!("Cannot read directory: {}", e))?;

    while let Some(entry) = read_dir.next_entry().await.map_err(|e| e.to_string())? {
        let metadata = match entry.metadata().await {
            Ok(m) => m,
            Err(_) => continue,
        };

        let name = entry.file_name().to_string_lossy().to_string();
        let extension = entry
            .path()
            .extension()
            .map(|e| e.to_string_lossy().to_string());

        entries.push(FileEntry {
            name,
            is_dir: metadata.is_dir(),
            size: metadata.len(),
            modified: metadata
                .modified()
                .ok()
                .and_then(|t| time_to_string(t).ok()),
            extension,
        });
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok((entries, resolved_path))
}

pub async fn read_file(root: &Path, path: &str) -> Result<FileContent, String> {
    let file_path = validate_path(root, path)?;
    let metadata = tokio::fs::metadata(&file_path)
        .await
        .map_err(|e| format!("Cannot read metadata: {}", e))?;

    let size = metadata.len();
    if size > 10 * 1024 * 1024 {
        return Err("File too large (>10MB).".to_string());
    }

    let mut mime = mime_guess::from_path(&file_path)
        .first_or_octet_stream()
        .to_string();

    let data = tokio::fs::read(&file_path)
        .await
        .map_err(|e| format!("Cannot read file: {}", e))?;

    if mime == "application/octet-stream" && std::str::from_utf8(&data).is_ok() {
        mime = "text/plain".to_string();
    }

    let is_text = mime.starts_with("text/")
        || mime == "application/json"
        || mime == "application/javascript"
        || mime == "application/toml"
        || mime == "application/xml"
        || mime == "application/x-yaml";

    const PREVIEW_LIMIT: usize = 512 * 1024;

    let (content, encoding, truncated) = if is_text || std::str::from_utf8(&data).is_ok() {
        let full = String::from_utf8_lossy(&data);
        if full.len() > PREVIEW_LIMIT {
            let truncated_str = &full[..full.floor_char_boundary(PREVIEW_LIMIT)];
            (truncated_str.to_string(), "utf-8".to_string(), true)
        } else {
            (full.to_string(), "utf-8".to_string(), false)
        }
    } else {
        (
            base64::engine::general_purpose::STANDARD.encode(&data),
            "base64".to_string(),
            false,
        )
    };

    Ok(FileContent {
        path: path.to_string(),
        content,
        mime_type: mime,
        encoding,
        size,
        truncated,
    })
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TreeNode {
    pub name: String,
    pub is_dir: bool,
    pub children: Option<Vec<TreeNode>>,
    pub truncated: bool,
}

pub async fn list_tree(
    root: &Path,
    path: &str,
    max_depth: usize,
    max_items: usize,
) -> Result<TreeNode, String> {
    let dir_path = if path.is_empty() || path == "." {
        root.to_path_buf()
    } else {
        validate_path(root, path)?
    };

    let name = dir_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| dir_path.to_string_lossy().to_string());

    build_tree_node(&dir_path, &name, max_depth, max_items).await
}

#[async_recursion::async_recursion]
async fn build_tree_node(
    path: &Path,
    name: &str,
    remaining_depth: usize,
    max_items: usize,
) -> Result<TreeNode, String> {
    if remaining_depth == 0 {
        return Ok(TreeNode {
            name: name.to_string(),
            is_dir: true,
            children: None,
            truncated: true,
        });
    }

    let mut read_dir = tokio::fs::read_dir(path)
        .await
        .map_err(|e| format!("Cannot read directory: {}", e))?;

    let mut entries: Vec<(String, bool)> = Vec::new();
    while let Some(entry) = read_dir.next_entry().await.map_err(|e| e.to_string())? {
        let meta = match entry.metadata().await {
            Ok(m) => m,
            Err(_) => continue,
        };
        let entry_name = entry.file_name().to_string_lossy().to_string();
        if entry_name.starts_with('.') {
            continue;
        }
        entries.push((entry_name, meta.is_dir()));
    }

    entries.sort_by(|a, b| match (a.1, b.1) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.0.to_lowercase().cmp(&b.0.to_lowercase()),
    });

    let truncated = entries.len() > max_items;
    let entries: Vec<_> = entries.into_iter().take(max_items).collect();

    let mut children = Vec::new();
    for (entry_name, is_dir) in entries {
        if is_dir {
            let child_path = path.join(&entry_name);
            let child =
                build_tree_node(&child_path, &entry_name, remaining_depth - 1, max_items).await?;
            children.push(child);
        } else {
            children.push(TreeNode {
                name: entry_name,
                is_dir: false,
                children: None,
                truncated: false,
            });
        }
    }

    Ok(TreeNode {
        name: name.to_string(),
        is_dir: true,
        children: Some(children),
        truncated,
    })
}

pub async fn get_metadata(root: &Path, path: &str) -> Result<FileMetadata, String> {
    let file_path = validate_path(root, path)?;
    let metadata = tokio::fs::symlink_metadata(&file_path)
        .await
        .map_err(|e| format!("Cannot read metadata: {}", e))?;

    #[cfg(unix)]
    let permissions = {
        use std::os::unix::fs::PermissionsExt;
        format!("{:o}", metadata.permissions().mode() & 0o777)
    };
    #[cfg(not(unix))]
    let permissions = if metadata.permissions().readonly() {
        "readonly".to_string()
    } else {
        "readwrite".to_string()
    };

    Ok(FileMetadata {
        path: path.to_string(),
        size: metadata.len(),
        modified: metadata
            .modified()
            .ok()
            .and_then(|t| time_to_string(t).ok()),
        created: metadata.created().ok().and_then(|t| time_to_string(t).ok()),
        is_dir: metadata.is_dir(),
        is_symlink: metadata.is_symlink(),
        permissions,
    })
}

pub async fn rename_file(from: &str, to: &str) -> Result<(), String> {
    tokio::fs::rename(from, to)
        .await
        .map_err(|e| format!("Cannot rename: {}", e))
}

#[async_recursion::async_recursion]
async fn copy_entry(src: std::path::PathBuf, dst: std::path::PathBuf) -> Result<(), String> {
    let meta = tokio::fs::symlink_metadata(&src)
        .await
        .map_err(|e| format!("Cannot stat {}: {}", src.display(), e))?;
    if meta.is_dir() {
        tokio::fs::create_dir_all(&dst)
            .await
            .map_err(|e| format!("Cannot create dir {}: {}", dst.display(), e))?;
        let mut rd = tokio::fs::read_dir(&src)
            .await
            .map_err(|e| format!("Cannot read dir {}: {}", src.display(), e))?;
        while let Some(entry) = rd.next_entry().await.map_err(|e| e.to_string())? {
            let child_dst = dst.join(entry.file_name());
            copy_entry(entry.path(), child_dst).await?;
        }
    } else {
        tokio::fs::copy(&src, &dst)
            .await
            .map_err(|e| format!("Cannot copy {} → {}: {}", src.display(), dst.display(), e))?;
    }
    Ok(())
}

fn unique_dest(dest_dir: &Path, name: &str) -> std::path::PathBuf {
    let candidate = dest_dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let p = Path::new(name);
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| name.to_string());
    let ext = p
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let mut i = 1usize;
    loop {
        let new_name = if i == 1 {
            format!("{}_copy{}", stem, ext)
        } else {
            format!("{}_copy_{}{}", stem, i, ext)
        };
        let candidate = dest_dir.join(&new_name);
        if !candidate.exists() {
            return candidate;
        }
        i += 1;
    }
}

pub async fn copy_entries(src_paths: Vec<String>, dest_dir: &str) -> Result<Vec<String>, String> {
    let dest = PathBuf::from(dest_dir);
    if !dest.is_dir() {
        return Err(format!("Destination is not a directory: {}", dest_dir));
    }
    let mut errors = Vec::new();
    for src_str in src_paths {
        let src = PathBuf::from(&src_str);
        let name = match src.file_name() {
            Some(n) => n.to_string_lossy().to_string(),
            None => {
                errors.push(format!("Cannot determine filename for {}", src_str));
                continue;
            }
        };
        let dst = unique_dest(&dest, &name);
        if let Err(e) = copy_entry(src, dst).await {
            errors.push(e);
        }
    }
    Ok(errors)
}

pub async fn move_entries(src_paths: Vec<String>, dest_dir: &str) -> Result<Vec<String>, String> {
    let dest = PathBuf::from(dest_dir);
    if !dest.is_dir() {
        return Err(format!("Destination is not a directory: {}", dest_dir));
    }
    let mut errors = Vec::new();
    for src_str in src_paths {
        let src = PathBuf::from(&src_str);
        let name = match src.file_name() {
            Some(n) => n.to_string_lossy().to_string(),
            None => {
                errors.push(format!("Cannot determine filename for {}", src_str));
                continue;
            }
        };
        let dst = unique_dest(&dest, &name);
        // Try rename first (atomic, works within same filesystem)
        if tokio::fs::rename(&src, &dst).await.is_ok() {
            continue;
        }
        // Fall back to copy + delete for cross-device moves
        if let Err(e) = copy_entry(src.clone(), dst).await {
            errors.push(e);
            continue;
        }
        if let Err(e) = delete_file_path(&src).await {
            errors.push(format!(
                "Copied but could not remove source {}: {}",
                src.display(),
                e
            ));
        }
    }
    Ok(errors)
}

async fn delete_file_path(path: &Path) -> Result<(), String> {
    let meta = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|e| format!("Cannot stat: {}", e))?;
    if meta.is_dir() {
        tokio::fs::remove_dir_all(path)
            .await
            .map_err(|e| format!("Cannot delete directory: {}", e))
    } else {
        tokio::fs::remove_file(path)
            .await
            .map_err(|e| format!("Cannot delete file: {}", e))
    }
}

pub async fn trash_file(root: &Path, path: &str) -> Result<(), String> {
    let file_path = validate_path(root, path)?;
    tokio::task::spawn_blocking(move || {
        trash::delete(&file_path).map_err(|e| format!("Cannot trash: {}", e))
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

pub async fn delete_file(root: &Path, path: &str) -> Result<(), String> {
    let file_path = validate_path(root, path)?;
    let meta = tokio::fs::symlink_metadata(&file_path)
        .await
        .map_err(|e| format!("Cannot stat: {}", e))?;
    if meta.is_dir() {
        tokio::fs::remove_dir_all(&file_path)
            .await
            .map_err(|e| format!("Cannot delete directory: {}", e))
    } else {
        tokio::fs::remove_file(&file_path)
            .await
            .map_err(|e| format!("Cannot delete file: {}", e))
    }
}

fn time_to_string(time: SystemTime) -> Result<String, String> {
    let duration = time
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(|e| e.to_string())?;
    let secs = duration.as_secs();
    Ok(format!("{}", secs))
}

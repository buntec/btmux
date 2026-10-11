//! `btmux open-editor`: open a file (or just the editor) where `file-editor`
//! says: the built-in Neovim, or `$EDITOR` in this terminal.
//!
//! Also injected into a pane's shell by `OpenFile` so the typed line stays
//! short and shell-agnostic; the editor-specific argument handling lives here.

use std::os::unix::process::CommandExt;
use std::path::Path;
use std::time::Duration;

/// Editor argv for `editor` (a command line, split on whitespace) opening
/// `file`. `vi`-likes take `+LINE`; VS Code variants take `--goto file:LINE`.
pub fn editor_argv(editor: &str, file: Option<&str>, line: Option<u32>) -> Vec<String> {
    let mut argv: Vec<String> = editor.split_whitespace().map(String::from).collect();
    if argv.is_empty() {
        argv.push("vi".into());
    }
    let name = Path::new(&argv[0])
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    let Some(file) = file else {
        return argv;
    };
    match (name, line.filter(|&l| l >= 1)) {
        ("vi" | "vim" | "nvim" | "nano" | "emacs", Some(line)) => {
            argv.push(format!("+{line}"));
            argv.push(file.into());
        }
        ("code" | "code-insiders" | "codium", Some(line)) => {
            argv.push("--goto".into());
            argv.push(format!("{file}:{line}"));
        }
        _ => argv.push(file.into()),
    }
    argv
}

/// Open `file` where `file-editor` says. Returns the exit code on failure.
pub async fn run(file: Option<&str>, line: Option<u32>) -> i32 {
    let file = match file.map(std::path::absolute).transpose() {
        Ok(file) => file.map(|f| f.to_string_lossy().into_owned()),
        Err(error) => {
            eprintln!("btmux: {error}");
            return 1;
        }
    };
    match open_in_server(file.as_deref(), line).await {
        Ok(true) => 0,
        Ok(false) => exec_editor(file.as_deref(), line),
        Err(error) => {
            eprintln!("btmux: {error}");
            1
        }
    }
}

/// Ask the server owning this pane to open the built-in Neovim. `Ok(false)`
/// means use `$EDITOR`: outside a btmux pane, `file-editor = "pane"`, or no
/// server (or an older one) to ask.
async fn open_in_server(file: Option<&str>, line: Option<u32>) -> Result<bool, String> {
    let env = |name| std::env::var(name).ok().filter(|v| !v.is_empty());
    let (Some(url), Some(pane), Some(token)) = (
        env("BTMUX_API_URL"),
        env("BTMUX_PANE_ID"),
        env("BTMUX_AUTH_TOKEN"),
    ) else {
        return Ok(false);
    };
    let client = reqwest::Client::builder()
        // Long enough for Neovim's first start.
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let response = match client
        .post(format!("{url}/api/panes/{pane}/open-editor"))
        .bearer_auth(token)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(serde_json::json!({ "path": file, "line": line }).to_string())
        .send()
        .await
    {
        Ok(response) => response,
        Err(e) if e.is_connect() => return Ok(false),
        Err(e) => return Err(e.to_string()),
    };
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(false);
    }
    let body = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(if body.is_empty() {
            status.to_string()
        } else {
            body
        });
    }
    let reply: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(reply["opened"].as_bool() == Some(true))
}

/// Replace this process with `$EDITOR`. Returns the exit code on failure.
fn exec_editor(file: Option<&str>, line: Option<u32>) -> i32 {
    let editor = std::env::var("EDITOR").unwrap_or_default();
    let argv = editor_argv(&editor, file, line);
    let error = std::process::Command::new(&argv[0]).args(&argv[1..]).exec();
    eprintln!("btmux: cannot run {}: {error}", argv[0]);
    127
}

#[cfg(test)]
mod tests {
    use super::editor_argv;

    fn argv(editor: &str, line: Option<u32>) -> Vec<String> {
        editor_argv(editor, Some("/a b/f.rs"), line)
    }

    #[test]
    fn vi_family_uses_plus_line() {
        assert_eq!(argv("nvim", Some(7)), ["nvim", "+7", "/a b/f.rs"]);
        assert_eq!(
            argv("/usr/bin/vim -p", Some(7)),
            ["/usr/bin/vim", "-p", "+7", "/a b/f.rs"]
        );
    }

    #[test]
    fn vscode_uses_goto() {
        assert_eq!(
            argv("code --wait", Some(3)),
            ["code", "--wait", "--goto", "/a b/f.rs:3"]
        );
    }

    #[test]
    fn no_line_or_unknown_editor_gets_bare_path() {
        assert_eq!(argv("nvim", None), ["nvim", "/a b/f.rs"]);
        assert_eq!(argv("nvim", Some(0)), ["nvim", "/a b/f.rs"]);
        assert_eq!(argv("hx", Some(5)), ["hx", "/a b/f.rs"]);
    }

    #[test]
    fn no_file_runs_bare_editor() {
        assert_eq!(editor_argv("nvim -p", None, Some(3)), ["nvim", "-p"]);
        assert_eq!(editor_argv("", None, None), ["vi"]);
    }

    #[test]
    fn empty_editor_falls_back_to_vi() {
        assert_eq!(argv("", Some(2)), ["vi", "+2", "/a b/f.rs"]);
    }
}

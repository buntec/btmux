//! `btmux open-editor`: run `$EDITOR` on a file, jumping to a line.
//!
//! Injected into a pane's shell by `OpenFile` so the typed line stays short
//! and shell-agnostic; the editor-specific argument handling lives here.

use std::os::unix::process::CommandExt;
use std::path::Path;

/// Editor argv for `editor` (a command line, split on whitespace) opening
/// `file`. `vi`-likes take `+LINE`; VS Code variants take `--goto file:LINE`.
pub fn editor_argv(editor: &str, file: &str, line: Option<u32>) -> Vec<String> {
    let mut argv: Vec<String> = editor.split_whitespace().map(String::from).collect();
    if argv.is_empty() {
        argv.push("vi".into());
    }
    let name = Path::new(&argv[0])
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
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

/// Replace this process with the editor. Returns the exit code on failure.
pub fn run(file: &str, line: Option<u32>) -> i32 {
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
        editor_argv(editor, "/a b/f.rs", line)
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
    fn empty_editor_falls_back_to_vi() {
        assert_eq!(argv("", Some(2)), ["vi", "+2", "/a b/f.rs"]);
    }
}

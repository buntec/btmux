//! A pane's shell: its command line and the syntax of the text btmux types
//! into it.

use serde::Serialize;
use std::borrow::Cow;
use std::sync::LazyLock;

/// Submits a typed line; PSReadLine reads LF as "add a line".
pub const ENTER: char = if cfg!(windows) { '\r' } else { '\n' };

/// The syntax a pane's shell reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dialect {
    /// bash, zsh, fish; on Windows also Git Bash and other native shells,
    /// which take `C:/…` paths.
    Posix,
    /// A Linux shell started by `wsl.exe`: POSIX with `/mnt/c/…` paths.
    Wsl,
    PowerShell,
    Cmd,
}

/// The program and arguments in `shell`. On Windows it is a command line
/// (`wsl.exe -d Ubuntu`) whose program path may be quoted or, with spaces,
/// bare (`C:\Program Files\Git\bin\bash.exe --login`).
pub fn argv(shell: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        split_command_line(shell, |path| std::path::Path::new(path).is_file())
    }
    #[cfg(not(windows))]
    {
        vec![shell.to_string()]
    }
}

#[cfg(any(windows, test))]
fn split_command_line(line: &str, is_file: impl Fn(&str) -> bool) -> Vec<String> {
    let line = line.trim();
    if !line.starts_with('"') {
        let mut ends = line.match_indices(' ').map(|(i, _)| i).chain([line.len()]);
        if let Some(end) = ends.find(|&end| is_file(&line[..end])) {
            let mut argv = vec![line[..end].to_string()];
            argv.extend(split_words(&line[end..]));
            return argv;
        }
    }
    split_words(line)
}

/// Whitespace-separated words; `"…"` groups.
#[cfg(any(windows, test))]
fn split_words(s: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = None::<String>;
    let mut quoted = false;
    for c in s.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                word.get_or_insert_with(String::new);
            }
            c if c.is_whitespace() && !quoted => words.extend(word.take()),
            c => word.get_or_insert_with(String::new).push(c),
        }
    }
    words.extend(word);
    words
}

impl Dialect {
    pub fn of(shell: &str) -> Self {
        #[cfg(windows)]
        if let Some(program) = argv(shell).first() {
            return program_dialect(std::path::Path::new(program));
        }
        let _ = shell;
        Self::Posix
    }

    /// Quote `s` as one word.
    pub fn quote(self, s: &str) -> String {
        let escaped = match self {
            Self::Posix | Self::Wsl => "'\\''",
            Self::PowerShell => "''",
            // Windows paths can't contain `"`.
            Self::Cmd => return format!("\"{s}\""),
        };
        format!("'{}'", s.replace('\'', escaped))
    }

    /// `path`, a server path, as the shell names it.
    pub fn path(self, path: &str) -> Cow<'_, str> {
        match self {
            Self::Wsl => Cow::Owned(wsl_path(path)),
            _ => Cow::Borrowed(path),
        }
    }

    /// Text that changes to `path`. PowerShell's `cd` reads `[` and `]` as
    /// wildcards; `-LiteralPath` doesn't.
    pub fn change_directory(self, path: &str) -> String {
        let quoted = self.quote(&self.path(path));
        match self {
            Self::Posix | Self::Wsl => format!("cd {quoted}{ENTER}"),
            Self::PowerShell => format!("Set-Location -LiteralPath {quoted}{ENTER}"),
            Self::Cmd => format!("cd /d {quoted}{ENTER}"),
        }
    }

    /// Text that runs this server's `btmux`: `exe` once an upgrade replaced
    /// the shell's `$BTMUX_BIN`.
    pub fn btmux(self, exe: Option<&str>) -> String {
        match (self, exe) {
            (Self::PowerShell, Some(exe)) => format!("& {}", self.quote(exe)),
            (_, Some(exe)) => self.quote(&self.path(exe)),
            (Self::Posix | Self::Wsl, None) => "\"$BTMUX_BIN\"".into(),
            (Self::PowerShell, None) => "& $env:BTMUX_BIN".into(),
            (Self::Cmd, None) => "\"%BTMUX_BIN%\"".into(),
        }
    }

    /// Text that opens `path` (at `line`) with `btmux open-editor` through
    /// `bin` (`btmux`), which resolves the editor's arguments. The leading
    /// space keeps it out of history in shells that honor it.
    pub fn open_editor(self, bin: &str, path: Option<&str>, line: Option<u32>) -> String {
        let line = line.filter(|&l| l >= 1);
        let path = path.map(|path| self.quote(&self.path(path)));
        let words: Vec<String> = if self == Self::Wsl {
            // The Windows `btmux` would run a Windows editor.
            [
                Some(LINUX_EDITOR.into()),
                line.map(|l| format!("+{l}")),
                path,
            ]
            .into_iter()
            .flatten()
            .collect()
        } else {
            [
                Some(format!("{bin} open-editor")),
                path,
                line.map(|l| l.to_string()),
            ]
            .into_iter()
            .flatten()
            .collect()
        };
        format!(" {}{ENTER}", words.join(" "))
    }

    /// Text that opens `path` in `editor`, or under WSL in the shell's
    /// `$EDITOR`. It ends in `\r`, the byte the Enter key sends.
    pub fn edit(self, editor: &str, path: &str) -> String {
        let editor = if self == Self::Wsl {
            LINUX_EDITOR
        } else {
            editor
        };
        format!(" {editor} {}\r", self.quote(&self.path(path)))
    }
}

/// The Linux `$VISUAL`/`$EDITOR`, through `sh` as fish lacks `${…:-…}`.
const LINUX_EDITOR: &str = r#"sh -c '${VISUAL:-${EDITOR:-vi}} "$@"' sh"#;

/// An installed shell offered in settings.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct ShellOption {
    pub label: String,
    /// The `shell` value that runs it.
    pub command: String,
}

/// Shells found on this machine, looked up once.
pub fn installed() -> Vec<ShellOption> {
    static SHELLS: LazyLock<Vec<ShellOption>> = LazyLock::new(detect);
    SHELLS.clone()
}

fn option(label: impl Into<String>, command: impl Into<String>) -> ShellOption {
    ShellOption {
        label: label.into(),
        command: command.into(),
    }
}

/// `/etc/shells` and `$SHELL`, one entry per executable.
#[cfg(unix)]
fn detect() -> Vec<ShellOption> {
    let listed = std::fs::read_to_string("/etc/shells").unwrap_or_default();
    let login = std::env::var("SHELL").ok();
    let mut seen = std::collections::HashSet::new();
    let paths = listed.lines().map(str::trim).chain(login.as_deref());
    paths
        .filter(|path| path.starts_with('/'))
        .filter(|path| {
            std::fs::canonicalize(path).is_ok_and(|real| real.is_file() && seen.insert(real))
        })
        .map(|path| {
            let name = std::path::Path::new(path).file_name().unwrap_or_default();
            option(name.to_string_lossy(), path)
        })
        .collect()
}

#[cfg(windows)]
fn detect() -> Vec<ShellOption> {
    use std::path::Path;
    let mut shells = vec![option("Windows PowerShell", "powershell.exe")];
    let pwsh = Path::new(r"C:\Program Files\PowerShell\7\pwsh.exe");
    if resolve(Path::new("pwsh")).is_some() {
        shells.push(option("PowerShell 7", "pwsh"));
    } else if pwsh.is_file() {
        shells.push(option("PowerShell 7", pwsh.to_string_lossy()));
    }
    shells.push(option("Command Prompt", "cmd.exe"));
    // Git's installer puts `cmd\git.exe` (or `bin\git.exe`) on `PATH`.
    let git = resolve(Path::new("git"))
        .and_then(|git| {
            git.ancestors()
                .skip(1)
                .take(3)
                .map(|root| root.join(r"bin\bash.exe"))
                .find(|bash| bash.is_file())
        })
        .or_else(|| Some(Path::new(r"C:\Program Files\Git\bin\bash.exe").to_path_buf()))
        .filter(|bash| bash.is_file());
    if let Some(bash) = git {
        shells.push(option("Git Bash", bash.to_string_lossy()));
    }
    for distro in wsl_distros() {
        shells.push(option(
            format!("{distro} (WSL)"),
            format!("wsl.exe -d {distro}"),
        ));
    }
    shells
}

/// Installed WSL distributions, except Docker Desktop's.
#[cfg(windows)]
fn wsl_distros() -> Vec<String> {
    use std::os::windows::process::CommandExt;
    use std::time::{Duration, Instant};
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let Ok(mut child) = std::process::Command::new("wsl.exe")
        .args(["--list", "--quiet"])
        .env("WSL_UTF8", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
    else {
        return Vec::new();
    };
    // A wedged WSL service mustn't hold up the server.
    let deadline = Instant::now() + Duration::from_secs(3);
    while child.try_wait().is_ok_and(|status| status.is_none()) {
        if Instant::now() > deadline {
            let _ = child.kill();
            return Vec::new();
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let Ok(output) = child.wait_with_output() else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|line| line.trim().trim_matches('\0').to_string())
        .filter(|name| !name.is_empty() && !name.starts_with("docker-desktop"))
        .collect()
}

#[cfg(windows)]
fn program_dialect(program: &std::path::Path) -> Dialect {
    let name = program
        .file_stem()
        .map(|name| name.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match name.as_str() {
        "powershell" | "pwsh" => Dialect::PowerShell,
        "cmd" => Dialect::Cmd,
        "wsl" => Dialect::Wsl,
        // On `PATH`, `bash` is usually WSL's launcher in System32.
        "bash" if resolve(program).is_some_and(|path| in_system_dir(&path)) => Dialect::Wsl,
        _ => Dialect::Posix,
    }
}

/// `program` found on `PATH` if it is a bare name.
#[cfg(windows)]
fn resolve(program: &std::path::Path) -> Option<std::path::PathBuf> {
    if program.components().count() > 1 {
        return Some(program.to_path_buf());
    }
    let program = program.with_extension("exe");
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join(&program))
        .find(|path| path.is_file())
}

#[cfg(windows)]
fn in_system_dir(path: &std::path::Path) -> bool {
    let Some(root) = std::env::var_os("SystemRoot") else {
        return false;
    };
    let system = std::path::Path::new(&root).join("System32");
    path.parent().is_some_and(|dir| {
        dir.to_string_lossy()
            .eq_ignore_ascii_case(&system.to_string_lossy())
    })
}

/// `C:\a` as `/mnt/c/a`; `\\wsl.localhost\<distro>\a` as `/a`.
fn wsl_path(path: &str) -> String {
    let path = path.replace('\\', "/");
    match path.as_bytes() {
        [drive, b':'] | [drive, b':', b'/', ..] if drive.is_ascii_alphabetic() => {
            return format!("/mnt/{}{}", drive.to_ascii_lowercase() as char, &path[2..]);
        }
        _ => {}
    }
    for prefix in ["//wsl.localhost/", "//wsl$/"] {
        let Some(distro) = path.get(..prefix.len()) else {
            continue;
        };
        if distro.eq_ignore_ascii_case(prefix) {
            let rest = &path[prefix.len()..];
            return rest.find('/').map_or("/".into(), |i| rest[i..].to_string());
        }
    }
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_command_lines() {
        let git_bash = r"C:\Program Files\Git\bin\bash.exe";
        let is_file = |path: &str| path == git_bash;
        assert_eq!(
            split_command_line(&format!("{git_bash} --login -i"), is_file),
            [git_bash, "--login", "-i"]
        );
        assert_eq!(split_command_line(git_bash, is_file), [git_bash]);
        assert_eq!(
            split_command_line(r#""C:\a b\sh.exe" -c "x y""#, is_file),
            [r"C:\a b\sh.exe", "-c", "x y"]
        );
        assert_eq!(
            split_command_line("wsl.exe -d Ubuntu", is_file),
            ["wsl.exe", "-d", "Ubuntu"]
        );
        assert_eq!(split_command_line(r#"x """#, is_file), ["x", ""]);
    }

    #[test]
    fn translates_paths_for_wsl() {
        assert_eq!(wsl_path(r"C:\src\a b"), "/mnt/c/src/a b");
        assert_eq!(wsl_path("D:/x"), "/mnt/d/x");
        assert_eq!(wsl_path("C:"), "/mnt/c");
        assert_eq!(wsl_path(r"\\wsl.localhost\Ubuntu\home\me"), "/home/me");
        assert_eq!(wsl_path(r"\\WSL$\Ubuntu"), "/");
        assert_eq!(wsl_path("/home/me"), "/home/me");
    }

    #[test]
    fn quotes_per_dialect() {
        assert_eq!(Dialect::Posix.quote("a'b"), r"'a'\''b'");
        assert_eq!(Dialect::PowerShell.quote("a'b"), "'a''b'");
        assert_eq!(Dialect::Cmd.quote(r"C:\a b"), r#""C:\a b""#);
    }

    #[test]
    fn change_directory_quotes_literal_path() {
        assert_eq!(
            Dialect::PowerShell.change_directory("/a'b[1]"),
            format!("Set-Location -LiteralPath '/a''b[1]'{ENTER}")
        );
        assert_eq!(
            Dialect::Posix.change_directory("/a'b[1]"),
            format!("cd '/a'\\''b[1]'{ENTER}")
        );
        assert_eq!(
            Dialect::Wsl.change_directory(r"C:\src"),
            format!("cd '/mnt/c/src'{ENTER}")
        );
        assert_eq!(
            Dialect::Cmd.change_directory(r"D:\src"),
            format!("cd /d \"D:\\src\"{ENTER}")
        );
    }

    #[test]
    fn open_editor_per_dialect() {
        let bin = Dialect::PowerShell.btmux(None);
        assert_eq!(
            Dialect::PowerShell.open_editor(&bin, Some(r"C:\a.rs"), Some(3)),
            format!(r" & $env:BTMUX_BIN open-editor 'C:\a.rs' 3{ENTER}")
        );
        assert_eq!(
            Dialect::PowerShell.btmux(Some(r"C:\b.exe")),
            r"& 'C:\b.exe'"
        );
        let bin = Dialect::Posix.btmux(None);
        assert_eq!(
            Dialect::Posix.open_editor(&bin, None, None),
            format!(" \"$BTMUX_BIN\" open-editor{ENTER}")
        );
        assert_eq!(
            Dialect::Wsl.open_editor("", Some(r"C:\a.rs"), Some(3)),
            format!(" {LINUX_EDITOR} +3 '/mnt/c/a.rs'{ENTER}")
        );
        assert_eq!(
            Dialect::Cmd.open_editor(&Dialect::Cmd.btmux(None), Some(r"C:\a.rs"), None),
            format!(" \"%BTMUX_BIN%\" open-editor \"C:\\a.rs\"{ENTER}")
        );
    }
}

//! `GET /api/health`: which optional programs the server found, and whether they work.
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use axum::{extract::State, Json};
use serde::Serialize;

use crate::config::{Editor, VscodeServer};
use crate::system_info::{shell_version, version};
use crate::AppState;

/// `code --version` starts Electron, and agents start Node.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct HealthReport {
    pub groups: Vec<HealthGroup>,
    /// The server's `PATH`, where programs are looked up.
    pub path: Vec<String>,
}

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct HealthGroup {
    pub title: String,
    pub checks: Vec<HealthCheck>,
}

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct HealthCheck {
    pub name: String,
    pub status: HealthStatus,
    /// A version, or a word such as "Not found".
    pub value: String,
    pub path: Option<String>,
    pub purpose: String,
    /// What is wrong, or what happens without it.
    pub note: Option<String>,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum HealthStatus {
    Ok,
    /// Optional and absent; nothing is broken.
    Missing,
    /// A feature won't work as it should.
    Warning,
    /// Something btmux is configured to use can't run.
    Error,
}

/// What looking for a program found.
#[derive(Default)]
struct Probe {
    path: Option<PathBuf>,
    /// `stdout` of a successful version command.
    output: Option<String>,
}

/// `name` on `PATH`, or a path as is.
fn locate(name: &str) -> Option<PathBuf> {
    let path = Path::new(name);
    if path.components().count() > 1 {
        return path.is_file().then(|| path.to_path_buf());
    }
    #[cfg(windows)]
    {
        let name = name.strip_suffix(".exe").unwrap_or(name);
        return crate::agent_launch::windows_program(name, &std::env::var_os("PATH")?);
    }
    #[cfg(not(windows))]
    crate::vscode::find_on_path(name)
}

async fn probe(path: Option<PathBuf>, args: &[&str], timeout: Duration) -> Probe {
    let Some(path) = path else {
        return Probe::default();
    };
    let mut command = tokio::process::Command::new(&path);
    command
        .args(args)
        // Outside any project, whose version manager settings could apply.
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let output = match tokio::time::timeout(timeout, command.output()).await {
        Ok(Ok(output)) if output.status.success() => {
            Some(String::from_utf8_lossy(&output.stdout).into_owned())
        }
        _ => None,
    };
    Probe {
        path: Some(path),
        output,
    }
}

async fn version_of(path: Option<PathBuf>) -> Probe {
    probe(path, &["--version"], PROBE_TIMEOUT).await
}

fn check(name: &str, purpose: &str, status: HealthStatus, value: impl Into<String>) -> HealthCheck {
    HealthCheck {
        name: name.into(),
        status,
        value: value.into(),
        path: None,
        purpose: purpose.into(),
        note: None,
    }
}

impl HealthCheck {
    fn note(mut self, note: impl Into<String>) -> Self {
        self.note = Some(note.into());
        self
    }
}

fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// A program that should report a version. `missing` is its status and note when absent.
fn program(
    name: &str,
    purpose: &str,
    probe: Probe,
    missing: (HealthStatus, Option<String>),
) -> HealthCheck {
    let Some(path) = probe.path else {
        return HealthCheck {
            note: missing.1,
            ..check(name, purpose, missing.0, "Not found")
        };
    };
    let version = probe.output.as_deref().and_then(version);
    let mut result = check(
        name,
        purpose,
        if version.is_some() {
            HealthStatus::Ok
        } else {
            HealthStatus::Warning
        },
        version.unwrap_or("Found"),
    );
    result.path = Some(display(&path));
    if version.is_none() {
        result.note = Some("Found, but it didn't report a version, so it may not run.".into());
    }
    result
}

/// A program with no version command worth running.
fn present(
    name: &str,
    purpose: &str,
    path: Option<PathBuf>,
    missing: Option<String>,
) -> HealthCheck {
    match path {
        Some(path) => HealthCheck {
            path: Some(display(&path)),
            ..check(name, purpose, HealthStatus::Ok, "Found")
        },
        None => HealthCheck {
            note: missing,
            ..check(name, purpose, HealthStatus::Missing, "Not found")
        },
    }
}

/// Absent is an error only for the configured editor.
fn optional_editor(configured: bool, name: &str) -> (HealthStatus, Option<String>) {
    if configured {
        (
            HealthStatus::Error,
            Some(format!("The editor setting needs {name}.")),
        )
    } else {
        (HealthStatus::Missing, None)
    }
}

fn neovim(probe: Probe, configured: bool, started_usable: bool) -> HealthCheck {
    let purpose = "The built-in Neovim surface.";
    let suitable = probe
        .output
        .as_deref()
        .map(crate::ws::nvim::supported_version);
    let mut result = program(
        "Neovim",
        purpose,
        probe,
        optional_editor(configured, "Neovim"),
    );
    let (major, minor) = crate::ws::nvim::MIN_VERSION;
    match suitable {
        Some(false) => {
            result.status = if configured {
                HealthStatus::Error
            } else {
                HealthStatus::Warning
            };
            result.note = Some(format!("Needs Neovim {major}.{minor} or newer."));
        }
        // `nvim::available` is checked once.
        Some(true) if !started_usable => {
            result.status = HealthStatus::Warning;
            result.note = Some("Installed after btmux started. Restart btmux to use it.".into());
        }
        _ => {}
    }
    result
}

/// A surface whose server needs Unix.
fn unix_only(mut result: HealthCheck) -> HealthCheck {
    if cfg!(windows) {
        result.status = HealthStatus::Missing;
        result.value = "Unsupported".into();
        result.note = Some("Not available on Windows yet.".into());
    }
    result
}

fn ripgrep(probe: Probe, grep: bool) -> HealthCheck {
    let missing = if grep {
        (
            HealthStatus::Missing,
            Some("Content search falls back to grep, which is slower.".into()),
        )
    } else {
        (
            HealthStatus::Warning,
            Some("Content search needs ripgrep or grep.".into()),
        )
    };
    program(
        "ripgrep",
        "Content search in the file browser.",
        probe,
        missing,
    )
}

fn fd(probe: Probe) -> HealthCheck {
    let missing = if cfg!(windows) {
        (HealthStatus::Warning, Some("File search needs fd.".into()))
    } else {
        (
            HealthStatus::Missing,
            Some("File search falls back to find, which ignores .gitignore.".into()),
        )
    };
    program("fd", "File search in the file browser.", probe, missing)
}

fn config_check(file: Option<&str>, error: Option<&str>) -> HealthCheck {
    let purpose = "Settings, keybindings, and themes.";
    let mut result = match error {
        Some(error) => check("Config file", purpose, HealthStatus::Error, "Invalid").note(error),
        None if file.is_some_and(|file| Path::new(file).is_file()) => {
            check("Config file", purpose, HealthStatus::Ok, "Loaded")
        }
        None => check("Config file", purpose, HealthStatus::Ok, "Using defaults"),
    };
    result.path = file.map(str::to_string);
    result
}

async fn shell_check(shell: String) -> HealthCheck {
    let purpose = "What new panes run.";
    let argv = crate::shell::argv(&shell);
    let path = argv.first().and_then(|program| locate(program));
    let Some(path) = path else {
        return check("Default shell", purpose, HealthStatus::Error, "Not found")
            .note(format!("New panes can't start {shell}."));
    };
    HealthCheck {
        path: Some(display(&path)),
        ..check(
            "Default shell",
            purpose,
            HealthStatus::Ok,
            shell_version(shell).await,
        )
    }
}

pub async fn handle(State(state): State<AppState>) -> Json<HealthReport> {
    Json(report(&state).await)
}

async fn report(state: &AppState) -> HealthReport {
    let (shell, editor, vscode_kind, config_error, config_file) = {
        let state = state.read().await;
        let config = state.config();
        (
            state.shell().to_string(),
            config.editor,
            config.vscode.server,
            config.config_error.clone(),
            crate::config::config_path().map(|path| display(&path)),
        )
    };
    let vscode_name = match vscode_kind {
        VscodeServer::Code => "VS Code",
        VscodeServer::OpenvscodeServer => "openvscode-server",
    };
    let (shell, nvim, vscode, browser, claude, codex, rg, fd_probe, fzf, git, tailscale) = tokio::join!(
        shell_check(shell),
        version_of(locate("nvim")),
        version_of(crate::vscode::program(vscode_kind)),
        version_of(crate::browser::program()),
        version_of(locate("claude")),
        version_of(locate("codex")),
        version_of(locate("rg")),
        version_of(locate("fd").or_else(|| locate("fdfind"))),
        version_of(locate("fzf")),
        version_of(locate("git")),
        probe(
            crate::tailscale::PROGRAMS
                .iter()
                .find_map(|name| locate(name)),
            &["version"],
            PROBE_TIMEOUT
        ),
    );

    let mut tools = vec![
        program(
            "Git",
            "Git mode, worktrees, and the branch names on sessions.",
            git,
            (
                HealthStatus::Warning,
                Some("Git mode and worktrees won't work.".into()),
            ),
        ),
        program(
            "Tailscale",
            "The --tailscale option, for reaching btmux from your tailnet.",
            tailscale,
            (HealthStatus::Missing, None),
        ),
    ];
    if cfg!(unix) {
        tools.push(present(
            "lsof",
            "Finding a pane's foreground Neovim to open files in.",
            locate("lsof"),
            None,
        ));
        let opener = if cfg!(target_os = "macos") {
            "open"
        } else {
            "xdg-open"
        };
        tools.push(present(
            opener,
            "Opening binary files from the file browser.",
            locate(opener),
            Some("Binary files won't open on the server's desktop.".into()),
        ));
    }

    HealthReport {
        groups: vec![
            HealthGroup {
                title: "Server".into(),
                checks: vec![
                    config_check(config_file.as_deref(), config_error.as_deref()),
                    shell,
                ],
            },
            HealthGroup {
                title: "Surfaces".into(),
                checks: vec![
                    neovim(nvim, editor == Editor::Neovim, crate::ws::nvim::available()),
                    unix_only(program(
                        vscode_name,
                        "The built-in VS Code surface.",
                        vscode,
                        optional_editor(editor == Editor::Vscode, vscode_name),
                    )),
                    unix_only(program(
                        "Chrome or Chromium",
                        "The built-in browser surface.",
                        browser,
                        (HealthStatus::Missing, None),
                    )),
                ],
            },
            HealthGroup {
                title: "Agents".into(),
                checks: vec![
                    program(
                        "Claude Code",
                        "Plan limits in agent view, and usage through btmux claude.",
                        claude,
                        (HealthStatus::Missing, None),
                    ),
                    program(
                        "Codex",
                        "Plan limits in agent view, and usage through btmux codex.",
                        codex,
                        (HealthStatus::Missing, None),
                    ),
                ],
            },
            HealthGroup {
                title: "Search".into(),
                checks: vec![
                    ripgrep(rg, locate("grep").is_some()),
                    fd(fd_probe),
                    program(
                        "fzf",
                        "Not used by btmux; for your shell and Neovim plugins.",
                        fzf,
                        (HealthStatus::Missing, None),
                    ),
                ],
            },
            HealthGroup {
                title: "Tools".into(),
                checks: tools,
            },
        ],
        path: std::env::var_os("PATH")
            .map(|path| {
                std::env::split_paths(&path)
                    .map(|dir| display(&dir))
                    .collect()
            })
            .unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found(output: Option<&str>) -> Probe {
        Probe {
            path: Some(PathBuf::from("/bin/tool")),
            output: output.map(str::to_string),
        }
    }

    #[test]
    fn programs_report_their_versions() {
        let missing = (HealthStatus::Missing, None);
        let result = program("x", "", found(Some("ripgrep 14.1.1\n")), missing);
        assert_eq!(result.status, HealthStatus::Ok);
        assert_eq!(result.value, "14.1.1");
        assert_eq!(result.path.as_deref(), Some("/bin/tool"));
    }

    #[test]
    fn a_program_that_fails_to_run_warns() {
        let result = program("x", "", found(None), (HealthStatus::Missing, None));
        assert_eq!(result.status, HealthStatus::Warning);
        assert!(result.note.is_some());
    }

    #[test]
    fn neovim_needs_a_supported_version() {
        let old = || found(Some("NVIM v0.11.4\nBuild type: Release"));
        assert_eq!(neovim(old(), false, false).status, HealthStatus::Warning);
        assert_eq!(neovim(old(), true, false).status, HealthStatus::Error);

        let new = || found(Some("NVIM v0.13.0-dev-123+gabc\n"));
        let result = neovim(new(), true, true);
        assert_eq!(result.status, HealthStatus::Ok);
        assert_eq!(result.value, "0.13.0");
        // Checked once at startup, so the surface isn't offered yet.
        let result = neovim(new(), false, false);
        assert_eq!(result.status, HealthStatus::Warning);
        assert!(result.note.unwrap().contains("Restart"));
    }

    #[test]
    fn only_the_configured_editor_is_an_error_when_absent() {
        let absent = neovim(Probe::default(), false, false);
        assert_eq!(absent.status, HealthStatus::Missing);
        assert_eq!(absent.value, "Not found");
        let absent = neovim(Probe::default(), true, false);
        assert_eq!(absent.status, HealthStatus::Error);
    }

    #[test]
    fn search_fallbacks_are_not_problems() {
        let result = ripgrep(Probe::default(), true);
        assert_eq!(result.status, HealthStatus::Missing);
        assert!(result.note.unwrap().contains("grep"));
        assert_eq!(
            ripgrep(Probe::default(), false).status,
            HealthStatus::Warning
        );
    }

    #[test]
    fn config_errors_are_reported() {
        let result = config_check(Some("/nonexistent/config.toml"), Some("bad key"));
        assert_eq!(result.status, HealthStatus::Error);
        assert_eq!(result.note.as_deref(), Some("bad key"));
        let result = config_check(Some("/nonexistent/config.toml"), None);
        assert_eq!(result.status, HealthStatus::Ok);
        assert_eq!(result.value, "Using defaults");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn probes_run_programs_and_give_up_on_hung_ones() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("btmux-health-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = |name: &str, body: &str| {
            let path = dir.join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            Some(path)
        };
        let timeout = Duration::from_secs(5);

        let ok = probe(script("ok", "echo tool 1.2.3"), &["--version"], timeout).await;
        assert_eq!(ok.output.as_deref(), Some("tool 1.2.3\n"));
        let failed = probe(script("failed", "echo 1.2.3; exit 1"), &[], timeout).await;
        assert!(failed.path.is_some() && failed.output.is_none());
        let hung = probe(
            script("hung", "exec sleep 60"),
            &[],
            Duration::from_millis(50),
        )
        .await;
        assert!(hung.path.is_some() && hung.output.is_none());
        assert!(probe(None, &[], timeout).await.path.is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

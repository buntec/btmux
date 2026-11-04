#![cfg(unix)]

use std::ffi::OsString;
use std::io::Write;
use std::os::unix::ffi::OsStringExt;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::ExitStatusExt;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

const PANE: &str = "00000000-0000-0000-0000-000000000001";
const ENDPOINT: &str =
    "http://127.0.0.1:8044/api/panes/00000000-0000-0000-0000-000000000001/telemetry";

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("btmux-agent-launch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        for agent in ["claude", "codex"] {
            let path = dir.join(agent);
            std::fs::write(&path, r#"#!/bin/sh
IFS= read -r input
printf '%s\0' "$$" "$input" "$CLAUDE_CODE_ENABLE_TELEMETRY" "$OTEL_EXPORTER_OTLP_METRICS_ENDPOINT" "$OTEL_EXPORTER_OTLP_LOGS_ENDPOINT" "$OTEL_EXPORTER_OTLP_LOGS_HEADERS" "$OTEL_EXPORTER_OTLP_LOGS_PROTOCOL" "$@"
printf 'agent stderr\n' >&2
if [ "$BTMUX_TEST_SIGNAL" = yes ]; then kill -TERM "$$"; fi
exit 23
"#).unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        Self(dir)
    }

    fn command(&self, agent: &str) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_btmux"));
        command
            .env_clear()
            .env("PATH", &self.0)
            .env("HOME", self.0.join("home"))
            .env("XDG_CONFIG_HOME", self.0.join("config"))
            .current_dir(&self.0)
            .arg(agent);
        command
    }

    fn pane(&self, agent: &str) -> Command {
        let mut command = self.command(agent);
        command
            .env("BTMUX_PANE_ID", PANE)
            .env("BTMUX_AUTH_TOKEN", "test-token")
            .env("BTMUX_OTEL_ENDPOINT", ENDPOINT);
        command
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn run(mut command: Command) -> (u32, Output) {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let pid = child.id();
    if let Err(error) = child
        .stdin
        .take()
        .unwrap()
        .write_all(b"stdin with spaces\n")
    {
        assert_eq!(error.kind(), std::io::ErrorKind::BrokenPipe);
    }
    let output = child.wait_with_output().unwrap();
    (pid, output)
}

// Empty environment fields are meaningful, unlike the final NUL separator.
fn fields(output: &Output) -> Vec<OsString> {
    let mut fields: Vec<_> = output
        .stdout
        .split(|byte| *byte == 0)
        .map(|field| OsString::from_vec(field.to_vec()))
        .collect();
    assert_eq!(fields.pop().as_deref(), Some(std::ffi::OsStr::new("")));
    fields
}

#[test]
fn outside_panes_executes_agents_with_exact_arguments_and_terminal_streams() {
    let fixture = Fixture::new();
    let args: Vec<OsString> = [
        "--help",
        "--version",
        "--profile",
        "agent profile",
        "--",
        "$(echo untouched)",
    ]
    .into_iter()
    .map(Into::into)
    .chain([OsString::from_vec(vec![b'x', 0xff])])
    .collect();
    for agent in ["claude", "codex"] {
        let mut command = fixture.command(agent);
        command.args(&args);
        let (pid, output) = run(command);
        assert_eq!(output.status.code(), Some(23));
        assert_eq!(output.stderr, b"agent stderr\n");
        let fields = fields(&output);
        assert_eq!(fields[0], pid.to_string().as_str());
        assert_eq!(fields[1], "stdin with spaces");
        assert!(fields[2..7].iter().all(|value| value.is_empty()));
        assert_eq!(&fields[7..], args);
        assert!(!fixture.0.join("config").exists());
        assert!(!fixture.0.join("home").exists());
    }
}

#[test]
fn claude_routes_inherited_signal_settings_to_the_current_pane() {
    let fixture = Fixture::new();
    let mut command = fixture.pane("claude");
    command
        .env(
            "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
            "http://old-collector:4318/v1/logs",
        )
        .env("OTEL_EXPORTER_OTLP_LOGS_PROTOCOL", "grpc")
        .env("OTEL_EXPORTER_OTLP_LOGS_HEADERS", "Authorization=old-value")
        .args(["--", "-literal"]);
    let (_, output) = run(command);
    let fields = fields(&output);
    assert_eq!(fields[2], "1");
    assert_eq!(fields[3], format!("{ENDPOINT}/v1/metrics").as_str());
    assert_eq!(fields[4], format!("{ENDPOINT}/v1/logs").as_str());
    assert_eq!(fields[5], "Authorization=Bearer test-token");
    assert_eq!(fields[6], "http/protobuf");
    assert_eq!(&fields[7..], ["--", "-literal"]);
}

#[test]
fn codex_passes_runtime_configuration_and_user_overrides_without_token_arguments() {
    let fixture = Fixture::new();
    let mut command = fixture.pane("codex");
    command.args(["-c", "model=\"test\"", "exec", "--json", "prompt"]);
    let (_, output) = run(command);
    let fields = fields(&output);
    assert_eq!(fields[5], "Authorization=Bearer%20test-token");
    let args: Vec<_> = fields[7..]
        .iter()
        .map(|value| value.to_str().unwrap())
        .collect();
    assert_eq!(args[0], "-c");
    assert!(args[1].starts_with("otel.exporter="));
    assert!(!args.join(" ").contains("test-token"));
    assert_eq!(
        &args[2..],
        ["-c", "model=\"test\"", "exec", "--json", "prompt"]
    );
}

#[test]
fn terminal_signals_reach_the_replacement_process() {
    let fixture = Fixture::new();
    let mut command = fixture.command("claude");
    command.env("BTMUX_TEST_SIGNAL", "yes");
    let (pid, output) = run(command);
    assert_eq!(fields(&output)[0], pid.to_string().as_str());
    assert_eq!(output.status.signal(), Some(libc::SIGTERM));
}

#[test]
fn incomplete_panes_and_missing_executables_fail_clearly() {
    let fixture = Fixture::new();
    let mut command = fixture.pane("codex");
    command.env_remove("BTMUX_AUTH_TOKEN");
    let (_, output) = run(command);
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8(output.stderr)
        .unwrap()
        .contains("BTMUX_AUTH_TOKEN"));
    std::fs::remove_file(fixture.0.join("codex")).unwrap();
    let (_, output) = run(fixture.command("codex"));
    assert_eq!(output.status.code(), Some(127));
    assert!(String::from_utf8(output.stderr)
        .unwrap()
        .contains("cannot run codex"));
}

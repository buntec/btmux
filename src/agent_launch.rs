//! Agent launchers configure telemetry for this invocation, then hand over the terminal.

use std::ffi::OsString;
use std::process::Command;

#[derive(Clone, Copy)]
pub enum Agent {
    Claude,
    Codex,
}

impl Agent {
    fn program(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }
}

struct Telemetry {
    endpoint: String,
    authorization: String,
}

impl Telemetry {
    fn from_env(env: &impl Fn(&str) -> Option<OsString>) -> Result<Option<Self>, String> {
        let get = |key: &str| -> Result<Option<String>, String> {
            env(key)
                .filter(|value| !value.is_empty())
                .map(|value| {
                    value
                        .into_string()
                        .map_err(|_| format!("{key} must be valid UTF-8"))
                })
                .transpose()
        };
        let Some(pane) = get("BTMUX_PANE_ID")? else {
            return Ok(None);
        };
        let pane = uuid::Uuid::parse_str(&pane).map_err(|_| "BTMUX_PANE_ID is not a pane ID")?;
        let endpoint = match get("BTMUX_OTEL_ENDPOINT")? {
            Some(endpoint) => endpoint,
            None => {
                let api = get("BTMUX_API_URL")?
                    .ok_or("this pane has no BTMUX_OTEL_ENDPOINT or BTMUX_API_URL")?;
                format!("{}/api/panes/{pane}/telemetry", api.trim_end_matches('/'))
            }
        };
        let url = reqwest::Url::parse(&endpoint).map_err(|_| "invalid btmux telemetry endpoint")?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("btmux telemetry endpoint must be an HTTP(S) URL without credentials, a query, or a fragment".into());
        }
        let token = get("BTMUX_AUTH_TOKEN")?.ok_or("this pane has no BTMUX_AUTH_TOKEN")?;
        if !crate::discovery::valid_token(&token) {
            return Err("invalid BTMUX_AUTH_TOKEN".into());
        }
        Ok(Some(Self {
            endpoint: url.as_str().trim_end_matches('/').into(),
            authorization: format!("Bearer {token}"),
        }))
    }
}

fn command(
    agent: Agent,
    args: &[OsString],
    env: impl Fn(&str) -> Option<OsString>,
) -> Result<Command, String> {
    let mut command = Command::new(agent.program());
    if let Some(telemetry) = Telemetry::from_env(&env)? {
        match agent {
            Agent::Claude => {
                command
                    .env("CLAUDE_CODE_ENABLE_TELEMETRY", "1")
                    .env("OTEL_SDK_DISABLED", "false")
                    .env("OTEL_METRICS_EXPORTER", "otlp")
                    .env("OTEL_LOGS_EXPORTER", "otlp");
                for (signal, path) in [("METRICS", "metrics"), ("LOGS", "logs")] {
                    command
                        .env(
                            format!("OTEL_EXPORTER_OTLP_{signal}_ENDPOINT"),
                            format!("{}/v1/{path}", telemetry.endpoint),
                        )
                        .env(
                            format!("OTEL_EXPORTER_OTLP_{signal}_PROTOCOL"),
                            "http/protobuf",
                        )
                        .env(
                            format!("OTEL_EXPORTER_OTLP_{signal}_HEADERS"),
                            format!("Authorization={}", telemetry.authorization),
                        );
                }
                for (name, default) in [
                    ("OTEL_METRIC_EXPORT_INTERVAL", "10000"),
                    ("OTEL_LOGS_EXPORT_INTERVAL", "5000"),
                ] {
                    if env(name).is_none_or(|value| value.is_empty()) {
                        command.env(name, default);
                    }
                }
            }
            Agent::Codex => {
                // A whole exporter replaces an existing gRPC exporter. The secret stays in env.
                let endpoint = toml::Value::String(format!("{}/v1/logs", telemetry.endpoint));
                command.env("BTMUX_OTEL_AUTHORIZATION", telemetry.authorization)
                    .args(["-c", &format!("otel.exporter={{otlp-http={{endpoint={endpoint},protocol=\"binary\",headers={{Authorization=\"${{BTMUX_OTEL_AUTHORIZATION}}\"}}}}}}")]);
            }
        }
    }
    command.args(args);
    Ok(command)
}

/// Unix replaces the wrapper so PTY process detection and signals see the agent.
pub fn run(agent: Agent, args: &[OsString]) -> i32 {
    let argv: Vec<_> = std::env::args_os().collect();
    let mut command = match command(agent, forwarded_args(&argv, args), |name| {
        std::env::var_os(name)
    }) {
        Ok(command) => command,
        Err(error) => {
            eprintln!("btmux: {error}");
            return 1;
        }
    };
    #[cfg(unix)]
    let error = std::os::unix::process::CommandExt::exec(&mut command);
    #[cfg(windows)]
    let error = match command.status() {
        Ok(status) => return status.code().unwrap_or(1),
        Err(error) => error,
    };
    eprintln!("btmux: cannot run {}: {error}", agent.program());
    if error.kind() == std::io::ErrorKind::NotFound {
        127
    } else {
        126
    }
}

fn forwarded_args<'a>(argv: &'a [OsString], parsed: &[OsString]) -> &'a [OsString] {
    let mut start = argv.len() - parsed.len();
    // Clap consumes a leading `--`; it belongs to the wrapped agent.
    if start > 0 && argv[start - 1] == "--" {
        start -= 1;
    }
    &argv[start..]
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn forwards_agent_flags_and_positionals() {
        for agent in ["claude", "codex"] {
            for args in [
                vec!["--help"],
                vec!["-h"],
                vec!["--version"],
                vec!["help"],
                vec!["--profile", "dev", "--model", "test"],
                vec!["exec", "--json", "a prompt with spaces", "--", "-literal"],
                vec!["--", "-literal"],
                vec!["--", "--"],
                vec![""],
                vec![],
            ] {
                let argv: Vec<OsString> = ["btmux", "--profile", "btmux-profile", agent]
                    .into_iter()
                    .chain(args.iter().copied())
                    .map(Into::into)
                    .collect();
                let parsed = crate::config::CliArgs::try_parse_from(&argv).unwrap();
                assert_eq!(parsed.profile.as_deref(), Some("btmux-profile"));
                let forwarded = match parsed.command.unwrap() {
                    crate::config::SubCommand::Claude { args }
                    | crate::config::SubCommand::Codex { args } => args,
                    _ => panic!("wrong command"),
                };
                assert_eq!(forwarded_args(&argv, &forwarded), args, "{agent}");
            }
        }
    }

    fn env(name: &str) -> Option<OsString> {
        match name {
            "BTMUX_PANE_ID" => Some("00000000-0000-0000-0000-000000000001".into()),
            "BTMUX_OTEL_ENDPOINT" => Some("http://127.0.0.1:8044/api/panes/test/telemetry/".into()),
            "BTMUX_AUTH_TOKEN" => Some("test-token".into()),
            _ => None,
        }
    }

    fn settings(command: &Command) -> std::collections::HashMap<String, String> {
        command
            .get_envs()
            .filter_map(|(key, value)| Some((key.to_str()?.into(), value?.to_str()?.into())))
            .collect()
    }

    #[test]
    fn outside_panes_adds_no_args_or_environment() {
        let args: Vec<OsString> = ["--help", "--profile", "agent-profile"]
            .into_iter()
            .map(Into::into)
            .collect();
        for agent in [Agent::Claude, Agent::Codex] {
            let command = command(agent, &args, |_| None).unwrap();
            assert_eq!(command.get_program(), agent.program());
            assert_eq!(command.get_args().collect::<Vec<_>>(), args);
            assert_eq!(command.get_envs().count(), 0);
        }
    }

    #[test]
    fn claude_sets_both_signal_destinations_and_keeps_custom_intervals() {
        let command = command(Agent::Claude, &["--resume".into()], |name| {
            if name == "OTEL_METRIC_EXPORT_INTERVAL" {
                Some("2000".into())
            } else {
                env(name)
            }
        })
        .unwrap();
        let settings = settings(&command);
        assert_eq!(settings["CLAUDE_CODE_ENABLE_TELEMETRY"], "1");
        assert_eq!(settings["OTEL_METRICS_EXPORTER"], "otlp");
        assert_eq!(settings["OTEL_LOGS_EXPORTER"], "otlp");
        for (signal, path) in [("METRICS", "metrics"), ("LOGS", "logs")] {
            assert_eq!(
                settings[&format!("OTEL_EXPORTER_OTLP_{signal}_ENDPOINT")],
                format!("http://127.0.0.1:8044/api/panes/test/telemetry/v1/{path}")
            );
            assert_eq!(
                settings[&format!("OTEL_EXPORTER_OTLP_{signal}_PROTOCOL")],
                "http/protobuf"
            );
            assert_eq!(
                settings[&format!("OTEL_EXPORTER_OTLP_{signal}_HEADERS")],
                "Authorization=Bearer test-token"
            );
        }
        assert!(!settings.contains_key("OTEL_METRIC_EXPORT_INTERVAL"));
        assert_eq!(settings["OTEL_LOGS_EXPORT_INTERVAL"], "5000");
        assert_eq!(command.get_args().collect::<Vec<_>>(), ["--resume"]);
    }

    #[test]
    fn codex_replaces_the_exporter_without_putting_credentials_in_args() {
        let command = command(
            Agent::Codex,
            &["exec".into(), "--json".into(), "prompt".into()],
            env,
        )
        .unwrap();
        let args: Vec<_> = command
            .get_args()
            .map(|value| value.to_str().unwrap())
            .collect();
        assert_eq!(args[0], "-c");
        assert_eq!(&args[2..], ["exec", "--json", "prompt"]);
        let config: toml::Value = toml::from_str(args[1]).unwrap();
        let exporter = &config["otel"]["exporter"]["otlp-http"];
        assert_eq!(exporter["protocol"].as_str(), Some("binary"));
        assert_eq!(
            exporter["headers"]["Authorization"].as_str(),
            Some("${BTMUX_OTEL_AUTHORIZATION}")
        );
        assert!(!args.join(" ").contains("test-token"));
        assert_eq!(
            settings(&command)["BTMUX_OTEL_AUTHORIZATION"],
            "Bearer test-token"
        );
    }

    #[test]
    fn derives_endpoints_for_older_panes() {
        let telemetry = Telemetry::from_env(&|name| match name {
            "BTMUX_OTEL_ENDPOINT" => None,
            "BTMUX_API_URL" => Some("http://127.0.0.1:8044/".into()),
            _ => env(name),
        })
        .unwrap()
        .unwrap();
        assert_eq!(
            telemetry.endpoint,
            "http://127.0.0.1:8044/api/panes/00000000-0000-0000-0000-000000000001/telemetry"
        );
    }

    #[test]
    fn incomplete_or_invalid_pane_configuration_is_an_error_without_secrets() {
        for (key, value) in [
            ("BTMUX_AUTH_TOKEN", None),
            ("BTMUX_AUTH_TOKEN", Some("secret\nvalue")),
            ("BTMUX_OTEL_ENDPOINT", None),
            (
                "BTMUX_OTEL_ENDPOINT",
                Some("https://secret@example.test/telemetry"),
            ),
            (
                "BTMUX_OTEL_ENDPOINT",
                Some("https://example.test/telemetry?token=secret"),
            ),
            ("BTMUX_OTEL_ENDPOINT", Some("file:///tmp/secret")),
            ("BTMUX_PANE_ID", Some("secret")),
        ] {
            let error = Telemetry::from_env(&|name| {
                if name == key {
                    value.map(Into::into)
                } else {
                    env(name)
                }
            })
            .err()
            .expect("invalid pane config");
            assert!(!error.contains("secret"));
        }
    }
}

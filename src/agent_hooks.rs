use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

/// Ready-to-paste hook configurations for agent harnesses that can run a
/// command with the lifecycle event JSON on stdin.
pub fn claude_code() -> &'static str {
    include_str!("../extras/claude-code/hooks.json")
}

pub fn codex() -> &'static str {
    include_str!("../extras/codex/hooks.json")
}

pub fn gemini_cli() -> &'static str {
    include_str!("../extras/gemini-cli/hooks.json")
}

#[derive(Clone, Copy)]
pub enum Target {
    ClaudeCode,
    Codex,
    GeminiCli,
}

impl Target {
    fn label(self) -> &'static str {
        match self {
            Self::ClaudeCode => "Claude Code",
            Self::Codex => "Codex",
            Self::GeminiCli => "Gemini CLI",
        }
    }

    fn snippet(self) -> &'static str {
        match self {
            Self::ClaudeCode => claude_code(),
            Self::Codex => codex(),
            Self::GeminiCli => gemini_cli(),
        }
    }

    fn config_path(self) -> Result<PathBuf, String> {
        let home = dirs::home_dir()
            .ok_or_else(|| format!("cannot resolve home directory for {} hooks", self.label()))?;
        Ok(match self {
            Self::ClaudeCode => home.join(".claude").join("settings.json"),
            Self::Codex => std::env::var_os("CODEX_HOME")
                .filter(|path| !path.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".codex"))
                .join("hooks.json"),
            Self::GeminiCli => home.join(".gemini").join("settings.json"),
        })
    }
}

/// Merge btmux hooks into the user's config, preserving unrelated settings.
pub fn install(target: Target) -> Result<PathBuf, String> {
    let path = target.config_path()?;
    let generated: Value = serde_json::from_str(target.snippet())
        .map_err(|error| format!("invalid embedded {} hook JSON: {error}", target.label()))?;
    let generated_hooks = generated
        .get("hooks")
        .and_then(Value::as_object)
        .ok_or_else(|| format!("embedded {} hooks have no hooks object", target.label()))?;

    let mut config = match fs::read_to_string(&path) {
        Ok(contents) => serde_json::from_str(&contents).map_err(|error| {
            format!(
                "cannot parse {}: {error}; file was left unchanged",
                path.display()
            )
        })?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => generated.clone(),
        Err(error) => return Err(format!("cannot read {}: {error}", path.display())),
    };

    let config_object = config.as_object_mut().ok_or_else(|| {
        format!(
            "{} must contain a JSON object; file was left unchanged",
            path.display()
        )
    })?;
    let generated_object = generated
        .as_object()
        .expect("generated hook JSON was checked as an object");
    for (key, value) in generated_object {
        if key != "hooks" {
            config_object
                .entry(key.clone())
                .or_insert_with(|| value.clone());
        }
    }

    let hooks = config_object
        .entry("hooks".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let hooks_object = hooks.as_object_mut().ok_or_else(|| {
        format!(
            "{} has a non-object `hooks` value; file was left unchanged",
            path.display()
        )
    })?;
    for (event, generated_groups) in generated_hooks {
        merge_event_hooks(hooks_object, event, generated_groups).map_err(|error| {
            format!(
                "cannot merge {} hooks in {}: {error}",
                event,
                path.display()
            )
        })?;
    }

    let mut contents = serde_json::to_string_pretty(&config)
        .map_err(|error| format!("cannot serialize {}: {error}", path.display()))?;
    contents.push('\n');
    write_config(&path, &contents)?;
    Ok(path)
}

fn merge_event_hooks(
    destination: &mut Map<String, Value>,
    event: &str,
    generated_groups: &Value,
) -> Result<(), String> {
    let generated_groups = generated_groups
        .as_array()
        .ok_or_else(|| "generated event hooks must be an array".to_string())?;
    let generated_handlers: Vec<Value> = generated_groups
        .iter()
        .filter_map(|group| group.get("hooks").and_then(Value::as_array))
        .flatten()
        .filter(|handler| is_btmux_hook(handler))
        .cloned()
        .collect();
    let replacement = generated_handlers
        .first()
        .ok_or_else(|| "generated event has no btmux command hook".to_string())?;

    let existing = destination
        .remove(event)
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let mut groups = existing
        .as_array()
        .cloned()
        .ok_or_else(|| "configured event hooks must be an array".to_string())?;
    let mut found_btmux = false;
    let mut merged_groups = Vec::with_capacity(groups.len() + generated_groups.len());

    for mut group in groups.drain(..) {
        let mut empty_group = false;
        if let Some(group_object) = group.as_object_mut() {
            if let Some(handlers) = group_object.get_mut("hooks") {
                let handlers = handlers
                    .as_array_mut()
                    .ok_or_else(|| "each hook group's `hooks` must be an array".to_string())?;
                let old_handlers = std::mem::take(handlers);
                let mut kept_handlers = Vec::with_capacity(old_handlers.len());
                for handler in old_handlers {
                    if is_btmux_hook(&handler) {
                        if !found_btmux {
                            kept_handlers.push(replacement.clone());
                            found_btmux = true;
                        }
                    } else {
                        kept_handlers.push(handler);
                    }
                }
                empty_group = kept_handlers.is_empty();
                *handlers = kept_handlers;
            }
        }
        if !empty_group {
            merged_groups.push(group);
        }
    }

    if !found_btmux {
        merged_groups.extend(generated_groups.iter().cloned());
    }
    destination.insert(event.to_string(), Value::Array(merged_groups));
    Ok(())
}

fn is_btmux_hook(handler: &Value) -> bool {
    handler
        .get("command")
        .and_then(Value::as_str)
        .is_some_and(|command| {
            command.contains("${BTMUX_API_URL}/api/panes/${BTMUX_PANE_ID}/notify")
        })
}

fn write_config(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
    }

    // Resolve symlinks so dotfile-managed configs keep their link in place.
    let destination = if fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        fs::canonicalize(path)
            .map_err(|error| format!("cannot resolve config symlink {}: {error}", path.display()))?
    } else {
        path.to_path_buf()
    };
    let parent = destination
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."));
    let file_name = destination
        .file_name()
        .ok_or_else(|| format!("invalid config path {}", destination.display()))?;
    let mut temporary_name = file_name.to_os_string();
    temporary_name.push(format!(".btmux-{}.tmp", std::process::id()));
    let temporary = parent.join(temporary_name);
    let permissions = fs::metadata(&destination)
        .ok()
        .map(|metadata| metadata.permissions());

    fs::write(&temporary, contents)
        .map_err(|error| format!("cannot write {}: {error}", temporary.display()))?;
    if let Some(permissions) = permissions {
        if let Err(error) = fs::set_permissions(&temporary, permissions) {
            let _ = fs::remove_file(&temporary);
            return Err(format!(
                "cannot preserve permissions on {}: {error}",
                path.display()
            ));
        }
    }
    if let Err(error) = fs::rename(&temporary, &destination) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("cannot update {}: {error}", path.display()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_hook_snippets_are_valid_json() {
        for snippet in [claude_code(), codex(), gemini_cli()] {
            let parsed: serde_json::Value = serde_json::from_str(snippet).unwrap();
            let hooks = parsed["hooks"].as_object().unwrap();
            for event in ["SessionStart", "SessionEnd"] {
                assert!(hooks.contains_key(event));
            }
            for groups in hooks.values() {
                for group in groups.as_array().unwrap() {
                    for handler in group["hooks"].as_array().unwrap() {
                        let command = handler["command"].as_str().unwrap();
                        assert!(command.contains("X-Btmux-Agent-Pid"));
                        assert!(command.contains("--max-time 2"));
                    }
                }
            }
        }
        let codex: serde_json::Value = serde_json::from_str(codex()).unwrap();
        for event in [
            "SessionStart",
            "UserPromptSubmit",
            "PermissionRequest",
            "Stop",
        ] {
            assert_ne!(codex["hooks"][event][0]["hooks"][0]["async"], true);
        }
        assert!(codex["hooks"].get("PostToolUse").is_some());
        assert!(codex["hooks"].get("Interrupt").is_some());
        let claude: serde_json::Value = serde_json::from_str(claude_code()).unwrap();
        for event in ["PostToolUse", "PostToolUseFailure", "PermissionDenied"] {
            assert!(claude["hooks"].get(event).is_some());
        }
    }
}

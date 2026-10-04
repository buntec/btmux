mod regions;

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use regex::Regex;
use serde::{Deserialize, Serialize};

use super::AgentState;

const ENGINE_VERSION: u32 = 3;
const BUNDLED: &[(&str, &str)] = &[
    ("claude", include_str!("manifests/claude.toml")),
    ("codex", include_str!("manifests/codex.toml")),
    ("gemini", include_str!("manifests/gemini.toml")),
];

pub struct DetectionInput<'a> {
    pub screen: &'a str,
    pub osc_title: &'a str,
    pub osc_progress: &'a str,
}

#[derive(Clone, Debug, Serialize)]
pub struct Detection {
    pub state: AgentState,
    pub rule: Option<String>,
    pub region: Option<String>,
    pub priority: Option<i32>,
    pub screen_revision: u64,
    pub version: Option<String>,
    pub source: String,
    pub visible_idle: bool,
    pub visible_working: bool,
    pub visible_blocker: bool,
    pub skip_state_update: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    id: String,
    version: Option<String>,
    min_engine_version: Option<u32>,
    #[serde(rename = "updated_at")]
    _updated_at: Option<String>,
    #[serde(default, rename = "aliases")]
    _aliases: Vec<String>,
    rules: Vec<Rule>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Rule {
    id: String,
    state: AgentState,
    #[serde(default)]
    priority: i32,
    #[serde(default = "default_region")]
    region: String,
    #[serde(default)]
    visible_idle: bool,
    #[serde(default)]
    visible_working: bool,
    #[serde(default)]
    visible_blocker: bool,
    #[serde(default)]
    skip_state_update: bool,
    #[serde(default)]
    contains: Vec<String>,
    #[serde(default)]
    regex: Vec<String>,
    #[serde(default)]
    line_regex: Vec<String>,
    #[serde(default)]
    all: Vec<Gate>,
    #[serde(default)]
    any: Vec<Gate>,
    #[serde(default, rename = "not")]
    not_gate: Vec<Gate>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Gate {
    contains: Vec<String>,
    regex: Vec<String>,
    line_regex: Vec<String>,
    all: Vec<Gate>,
    any: Vec<Gate>,
    #[serde(rename = "not")]
    not_gate: Vec<Gate>,
}

struct CompiledGate {
    contains: Vec<String>,
    regex: Vec<Regex>,
    line_regex: Vec<Regex>,
    all: Vec<Self>,
    any: Vec<Self>,
    not_gate: Vec<Self>,
}

impl CompiledGate {
    fn compile(gate: Gate, depth: usize) -> Result<Self, String> {
        if depth > 16 {
            return Err("matcher nesting exceeds 16".into());
        }
        let regexes = |patterns: Vec<String>| {
            patterns
                .into_iter()
                .map(|pattern| {
                    if pattern.len() > 8192 {
                        return Err("pattern exceeds 8192 bytes".into());
                    }
                    Regex::new(&pattern).map_err(|error| error.to_string())
                })
                .collect::<Result<Vec<_>, String>>()
        };
        let nested = |gates: Vec<Gate>| {
            gates
                .into_iter()
                .map(|gate| Self::compile(gate, depth + 1))
                .collect::<Result<Vec<_>, _>>()
        };
        Ok(Self {
            contains: gate
                .contains
                .into_iter()
                .map(|s| s.to_lowercase())
                .collect(),
            regex: regexes(gate.regex)?,
            line_regex: regexes(gate.line_regex)?,
            all: nested(gate.all)?,
            any: nested(gate.any)?,
            not_gate: nested(gate.not_gate)?,
        })
    }

    fn matches(&self, text: &str, lower: &str) -> bool {
        self.contains.iter().all(|needle| lower.contains(needle))
            && self.regex.iter().all(|regex| regex.is_match(text))
            && self
                .line_regex
                .iter()
                .all(|regex| text.lines().any(|line| regex.is_match(line)))
            && self.all.iter().all(|gate| gate.matches(text, lower))
            && (self.any.is_empty() || self.any.iter().any(|gate| gate.matches(text, lower)))
            && !self.not_gate.iter().any(|gate| gate.matches(text, lower))
    }
}

struct CompiledManifest {
    manifest: Manifest,
    gates: Vec<CompiledGate>,
    source: String,
}

fn default_region() -> String {
    "whole_recent".into()
}

fn valid_region(spec: &str) -> bool {
    matches!(
        spec,
        "whole_recent"
            | "osc_title"
            | "osc_progress"
            | "after_last_prompt_marker"
            | "before_current_prompt_marker"
            | "whole_recent_without_current_prompt_marker"
            | "current_prompt_block_marker"
            | "after_current_prompt_block_marker"
            | "prompt_box_body"
            | "above_prompt_box"
            | "last_non_empty_above_prompt_box"
            | "after_last_horizontal_rule"
    ) || [
        "top_non_empty_lines",
        "bottom_non_empty_lines",
        "bottom_lines",
    ]
    .iter()
    .any(|name| {
        spec.strip_prefix(name)
            .and_then(|s| s.strip_prefix('('))
            .and_then(|s| s.strip_suffix(')'))
            .and_then(|s| s.parse::<usize>().ok())
            .is_some_and(|count| (1..=1000).contains(&count))
    })
}

impl CompiledManifest {
    fn parse(name: &str, text: &str, source: String) -> Result<Self, String> {
        if text.len() > 256 * 1024 {
            return Err("manifest exceeds 256 KiB".into());
        }
        let manifest: Manifest = toml::from_str(text).map_err(|e| e.to_string())?;
        if manifest.id != name || manifest.min_engine_version.unwrap_or(1) > ENGINE_VERSION {
            return Err("incompatible manifest identity or engine version".into());
        }
        if manifest.rules.len() > 256 {
            return Err("too many rules".into());
        }
        let mut ids = std::collections::HashSet::new();
        let gates = manifest
            .rules
            .iter()
            .map(|rule| {
                if rule.state == AgentState::Done {
                    return Err("screen rules cannot establish completion".into());
                }
                if !valid_region(&rule.region) || !ids.insert(&rule.id) {
                    return Err(format!("invalid region or duplicate rule: {}", rule.id));
                }
                if rule.contains.is_empty()
                    && rule.regex.is_empty()
                    && rule.line_regex.is_empty()
                    && rule.all.is_empty()
                    && rule.any.is_empty()
                {
                    return Err(format!("rule {} has no positive matcher", rule.id));
                }
                let gate = Gate {
                    contains: rule.contains.clone(),
                    regex: rule.regex.clone(),
                    line_regex: rule.line_regex.clone(),
                    all: rule.all.clone(),
                    any: rule.any.clone(),
                    not_gate: rule.not_gate.clone(),
                };
                CompiledGate::compile(gate, 0)
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            manifest,
            gates,
            source,
        })
    }

    fn detect(&self, input: DetectionInput<'_>) -> Detection {
        let mut matched = None;
        let mut cache: HashMap<&str, (&str, String)> = HashMap::new();
        for (rule, gate) in self.manifest.rules.iter().zip(&self.gates) {
            let (text, lower) = cache.entry(&rule.region).or_insert_with(|| {
                let text = regions::region(DetectionInput { ..input }, &rule.region);
                (text, text.to_lowercase())
            });
            if gate.matches(text, lower)
                && matched.is_none_or(|previous: &Rule| rule.priority > previous.priority)
            {
                matched = Some(rule);
            }
        }
        Detection {
            state: matched.map_or(AgentState::Unknown, |rule| rule.state.clone()),
            rule: matched.map(|rule| rule.id.clone()),
            region: matched.map(|rule| rule.region.clone()),
            priority: matched.map(|rule| rule.priority),
            screen_revision: 0,
            version: self.manifest.version.clone(),
            source: self.source.clone(),
            visible_idle: matched
                .is_some_and(|rule| rule.visible_idle && rule.state == AgentState::Idle),
            visible_working: matched
                .is_some_and(|rule| rule.visible_working && rule.state == AgentState::Working),
            visible_blocker: matched
                .is_some_and(|rule| rule.visible_blocker && rule.state == AgentState::Blocked),
            skip_state_update: matched.is_some_and(|rule| rule.skip_state_update),
        }
    }
}

pub struct Detector {
    manifests: HashMap<String, CompiledManifest>,
    directory: Option<PathBuf>,
    overrides: HashMap<String, Option<std::time::SystemTime>>,
}

impl Detector {
    pub fn new(directory: Option<PathBuf>) -> Self {
        let manifests = BUNDLED
            .iter()
            .map(|(name, text)| {
                (
                    (*name).into(),
                    CompiledManifest::parse(name, text, "bundled".into())
                        .expect("bundled manifest"),
                )
            })
            .collect();
        let mut detector = Self {
            manifests,
            directory,
            overrides: HashMap::new(),
        };
        detector.reload();
        detector
    }

    pub fn reload(&mut self) -> bool {
        let Some(directory) = &self.directory else {
            return false;
        };
        let mut changed = false;
        for (name, bundled) in BUNDLED {
            let path = directory.join(format!("{name}.toml"));
            let modified = std::fs::metadata(&path)
                .and_then(|meta| meta.modified())
                .ok();
            if self.overrides.get(*name) == Some(&modified) {
                continue;
            }
            self.overrides.insert((*name).into(), modified);
            // A panicking override must not take detection down with it.
            let loaded = std::panic::catch_unwind(|| load_override(name, &path))
                .unwrap_or_else(|_| {
                    tracing::warn!(path = %path.display(), "agent manifest panicked; using bundled rules");
                    None
                })
                .unwrap_or_else(|| {
                CompiledManifest::parse(name, bundled, "bundled".into()).expect("bundled manifest")
            });
            self.manifests.insert((*name).into(), loaded);
            changed = true;
        }
        changed
    }

    pub fn detect(&self, agent: &str, input: DetectionInput<'_>) -> Option<Detection> {
        self.manifests
            .get(agent)
            .map(|manifest| manifest.detect(input))
    }
}

fn load_override(name: &str, path: &Path) -> Option<CompiledManifest> {
    use std::io::Read;
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            tracing::warn!(%error, path = %path.display(), "cannot read agent manifest");
            return None;
        }
    };
    let mut text = String::new();
    let result = file
        .take(256 * 1024 + 1)
        .read_to_string(&mut text)
        .map_err(|e| e.to_string())
        .and_then(|_| CompiledManifest::parse(name, &text, "local".into()));
    match result {
        Ok(manifest) => Some(manifest),
        Err(error) => {
            tracing::warn!(%error, path = %path.display(), "invalid agent manifest; using bundled rules");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn detect(agent: &str, screen: &str, title: &str) -> Detection {
        Detector::new(None)
            .detect(
                agent,
                DetectionInput {
                    screen,
                    osc_title: title,
                    osc_progress: "",
                },
            )
            .unwrap()
    }

    #[test]
    fn bundled_rules_recognize_live_ui_and_ignore_stale_prompt_text() {
        let cases = [
            (
                "codex",
                "› fix it\npress enter to confirm or esc to cancel",
                "",
                AgentState::Blocked,
                Some("live_strong_blocker"),
            ),
            (
                "codex",
                "› print ‘do you want to yes’",
                "",
                AgentState::Unknown,
                None,
            ),
            (
                "codex",
                "Working (3s • esc to interrupt)\n›",
                "",
                AgentState::Working,
                Some("screen_working_fallback"),
            ),
            (
                "codex",
                "› next question",
                "Codex",
                AgentState::Unknown,
                None,
            ),
            (
                "codex",
                "",
                "⠋ Codex",
                AgentState::Working,
                Some("osc_title_working"),
            ),
            (
                "codex",
                "",
                "Action Required",
                AgentState::Blocked,
                Some("osc_title_blocked"),
            ),
            (
                "claude",
                "──────\n❯\n──────",
                "",
                AgentState::Idle,
                Some("live_prompt_box"),
            ),
            (
                "claude",
                "──────\nDo you want to proceed?\n❯ 1. Yes\n2. No\nesc to cancel",
                "",
                AgentState::Blocked,
                Some("generic_permission_prompt"),
            ),
            (
                "claude",
                "",
                "◐ Claude",
                AgentState::Working,
                Some("osc_title_working"),
            ),
            (
                "gemini",
                "│ Allow execution\n❯ Yes",
                "",
                AgentState::Blocked,
                Some("apply_or_allow_change"),
            ),
            (
                "gemini",
                "esc to cancel",
                "",
                AgentState::Working,
                Some("esc_cancel_working"),
            ),
        ];
        for (agent, screen, title, state, rule) in cases {
            let result = detect(agent, screen, title);
            assert_eq!(result.state, state, "{agent}: {screen}");
            assert_eq!(result.rule.as_deref(), rule, "{agent}: {screen}");
        }
        let transcript = detect("codex", "› show history\n↑/↓ to scroll pgup/pgdn to home/end to jump q to quit esc to edit prev", "");
        assert!(transcript.skip_state_update);
    }

    #[test]
    fn rejects_incompatible_invalid_and_unconditional_rules() {
        let manifest = "id='codex'\n[[rules]]\nid='test'\nstate='working'\ncontains=['marker']\n";
        assert!(CompiledManifest::parse("codex", manifest, "test".into()).is_ok());
        for text in [
            manifest.replace("id='codex'", "id='wrong'"),
            manifest.replace("state='working'", "state='done'"),
            manifest.replace("id='codex'", "id='codex'\nmin_engine_version=99"),
            manifest.replace("contains=['marker']", "regex=['[']"),
            manifest.replace("contains=['marker']", "region='typo'\ncontains=['marker']"),
            manifest.replace("contains=['marker']", "not=[{contains=['marker']}]"),
        ] {
            assert!(CompiledManifest::parse("codex", &text, "test".into()).is_err());
        }
    }

    #[test]
    fn local_overrides_reload_and_invalid_edits_fall_back() {
        let directory =
            std::env::temp_dir().join(format!("btmux-manifest-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("codex.toml");
        std::fs::write(&path, "id='codex'\nversion='test'\n[[rules]]\nid='local'\nstate='blocked'\ncontains=['custom marker']").unwrap();
        let mut detector = Detector::new(Some(directory.clone()));
        let input = || DetectionInput {
            screen: "custom marker",
            osc_title: "",
            osc_progress: "",
        };
        assert_eq!(detector.detect("codex", input()).unwrap().source, "local");
        assert!(!detector.reload());
        std::fs::remove_file(&path).unwrap();
        assert!(detector.reload());
        assert_eq!(detector.detect("codex", input()).unwrap().source, "bundled");
        std::fs::write(&path, "broken manifest").unwrap();
        assert!(detector.reload());
        assert_eq!(detector.detect("codex", input()).unwrap().source, "bundled");
        std::fs::remove_dir_all(directory).unwrap();
    }
}

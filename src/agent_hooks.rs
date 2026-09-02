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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_hook_snippets_are_valid_json() {
        for snippet in [claude_code(), codex(), gemini_cli()] {
            let parsed: serde_json::Value = serde_json::from_str(snippet).unwrap();
            assert!(parsed.get("hooks").is_some());
        }
    }
}

#!/bin/bash
# A scripted coding agent for scripts/desktop-demo.applescript.
#
#   exec -a <claude|codex|gemini> /bin/bash desktop-demo-agent.sh <name>
#
# argv[0] makes btmux detect it as that agent; it reports its state through
# the pane's hook endpoint, like the real agents' hooks. BTMUX_DEMO picks the
# script (agents or latex), BTMUX_DEMO_SCALE scales its pauses, and it marks
# its progress as files in BTMUX_DEMO_SYNC for the driver to wait on.
set -u
name="$1"
scale="${BTMUX_DEMO_SCALE:-1}"

bold=$'\e[1m'
dim=$'\e[2m'
green=$'\e[32m'
yellow=$'\e[33m'
blue=$'\e[34m'
magenta=$'\e[35m'
reset=$'\e[0m'

pause() { sleep "$(awk -v d="$1" -v s="$scale" 'BEGIN { print d * s }')"; }

hook() {
    curl --silent --output /dev/null --max-time 2 \
        --header "Authorization: Bearer $BTMUX_AUTH_TOKEN" \
        --header "Content-Type: application/json" \
        --header "X-Btmux-Agent-Pid: $$" \
        --data "$1" "$BTMUX_API_URL/api/panes/$BTMUX_PANE_ID/notify"
}

mark() { [[ -n "${BTMUX_DEMO_SYNC:-}" ]] && touch "$BTMUX_DEMO_SYNC/$name-$1"; }

# Lines, then a pause.
say() {
    local delay="$1"
    shift
    printf '%s\n' "$@"
    pause "$delay"
}

step() { say "${2:-1}" "${blue}●${reset} $1"; }

prompt() { printf '\n%s>%s ' "$bold" "$reset"; }

permission() {
    printf '\n  %sAllow %s: %s?%s (y/n) ' "$yellow" "$1" "$2" "$reset"
    hook "{\"hook_event_name\":\"PermissionRequest\",\"tool_name\":\"$1\",\"tool_input\":{\"command\":\"$2\"}}"
    mark blocked
    local key=""
    while [[ "$key" != y ]]; do read -rsn1 key; done
    printf 'y\n\n'
    hook '{"hook_event_name":"PostToolUse"}'
}

done_turn() {
    hook "{\"hook_event_name\":\"Stop\",\"last_assistant_message\":\"$1\"}"
    mark done
}

case "$name" in
claude) color="$magenta" ;;
codex) color="$green" ;;
*) color="$blue" ;;
esac
printf '%s%s%s %s(btmux demo agent)%s\n' "$bold$color" "$name" "$reset" "$dim" "$reset"
printf '%s%s%s\n' "$dim" "$PWD" "$reset"
hook '{"hook_event_name":"SessionStart"}'
prompt
read -r _
hook '{"hook_event_name":"UserPromptSubmit"}'
echo

case "${BTMUX_DEMO:-agents}:$name" in
agents:claude)
    step "Read src/main.rs" 1.2
    step "Read src/api/sessions.rs" 1
    step "Edit src/api/sessions.rs ${green}+42${reset} ${dim}-3${reset}" 1.5
    step "Edit src/main.rs ${green}+18${reset}" 1.2
    permission Bash "cargo test list"
    step "Bash cargo test list" 2
    say 1 "  ${dim}test result: ok. 9 passed; 0 failed${reset}" ""
    say 0 "Added ${bold}--json${reset} to ${bold}btmux list${reset}; it prints one object per session."
    done_turn "Added --json to btmux list; all 9 list tests pass."
    ;;
agents:codex)
    step "Explored src/pty/replay.rs" 2
    step "Ran cargo bench replay" 3
    say 2 "  ${dim}replay/8MiB    41.2 ms${reset}" "  ${dim}replay/128MiB  690 ms${reset}"
    step "Explored src/pty/mod.rs" 2
    say 0 "" "Replay re-parses the whole journal on every attach. Starting from the" \
        "checkpoint instead would make it proportional to the journal tail."
    done_turn "Replay re-parses the whole journal on every attach; start from the checkpoint."
    ;;
agents:gemini)
    step "ReadFolder src/session" 2
    step "ReadManyFiles src/session/*.rs" 4
    step "SearchText \"resolve_index\"" 4
    step "ReadFile src/session/manager.rs" 5
    say 0 "The session tree lives in SessionManager; every mutation broadcasts state."
    done_turn "The session tree lives in SessionManager; every mutation broadcasts state."
    ;;
latex:*)
    step "Thinking" 1.5
    say 0.6 "Square the integral and switch to polar coordinates. Let"
    say 0.6 "[" "I = \int_{-\infty}^{\infty} e^{-x^2}\,dx" "]"
    say 0.6 "Then"
    say 0.6 "[" "I^2 = \int_{-\infty}^{\infty}\int_{-\infty}^{\infty} e^{-(x^2+y^2)}\,dx\,dy" "]"
    say 0.6 "With \(x = r\cos\theta\), \(y = r\sin\theta\) and \(dx\,dy = r\,dr\,d\theta\):"
    say 0.6 "[" "I^2 = \int_0^{2\pi}\int_0^{\infty} e^{-r^2}\,r\,dr\,d\theta = 2\pi \cdot \frac{1}{2} = \pi" "]"
    say 0.6 "Since \(I > 0\),"
    say 0 "[" "\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}" "]"
    done_turn "The Gaussian integral is the square root of pi."
    ;;
esac

while :; do
    prompt
    read -r _ || exit 0
done

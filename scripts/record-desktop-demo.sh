#!/usr/bin/env bash
# Record a demo of the macOS desktop app against an isolated demo server.
#
#   scripts/record-desktop-demo.sh [--dark|--light] [--delay-scale X] [output.mp4]
#
# Records in dark mode by default. --delay-scale (0 < X <= 1, default 1)
# shortens the demo's pauses, typing, and mouse movement; 0.5 runs it twice as
# fast. The output defaults to demo.mp4 (dark) or demo-light.mp4 (light) in
# the repo root.
#
# The terminal running this needs Accessibility (keystrokes) and Screen
# Recording permissions. Don't touch the keyboard or mouse while it runs.
#
# The demo server runs with the default config (plus an opaque window and the
# chosen color scheme), a temporary HOME and XDG directories, and fish with
# only the btmux theme, so the demo looks the same on every machine.
# Each run recreates ~/btmux-demo with fresh clones of btmux and ghostty-web
# as the demo's playground. The built-in Neovim gets a minimal config with
# rust-analyzer, whose build cache persists in ~/Library/Caches/btmux-demo so
# it loads within seconds.
#
# Environment overrides:
#   BTMUX_APP  desktop app bundle (default /Applications/btmux.app)
#   BTMUX_BIN  server binary (default: the app's bundled server)
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
driver="$repo_root/scripts/desktop-demo.applescript"
mode=dark
delay_scale=1
while [[ $# -gt 0 ]]; do
    case "$1" in
    --dark | --light)
        mode="${1#--}"
        shift
        ;;
    --delay-scale)
        delay_scale="${2:-}"
        shift 2 || true
        if ! awk -v x="$delay_scale" 'BEGIN { exit !(x ~ /^[0-9]*\.?[0-9]+$/ && x > 0 && x <= 1) }'; then
            echo "--delay-scale must be a number in (0, 1], got '$delay_scale'" >&2
            exit 1
        fi
        ;;
    -*)
        echo "Unknown option: $1" >&2
        exit 1
        ;;
    *) break ;;
    esac
done
if [[ "$mode" == dark ]]; then
    output="${1:-$repo_root/demo.mp4}"
else
    output="${1:-$repo_root/demo-light.mp4}"
fi

app="${BTMUX_APP:-/Applications/btmux.app}"
server_bin="${BTMUX_BIN:-$app/Contents/MacOS/btmux}"
demo_root="$HOME/btmux-demo"
demo_cwd="$demo_root/btmux"
demo_port=8045
demo_url="http://127.0.0.1:$demo_port"

die() {
    echo "$*" >&2
    exit 1
}

[[ "$(uname -s)" == Darwin ]] || die "The desktop demo recorder only runs on macOS"
[[ -d "$app" ]] || die "No desktop app at $app"
[[ -x "$server_bin" ]] || die "No server binary at $server_bin"
command -v ffmpeg >/dev/null || die "ffmpeg is required"
command -v nvim >/dev/null || die "nvim 0.12+ is required"
command -v cargo >/dev/null || die "cargo is required"
command -v rust-analyzer >/dev/null || die "rust-analyzer is required"
fish="$(command -v fish)" || die "fish is required"
if pgrep -xq btmux-desktop; then
    die "Quit the btmux desktop app first; the demo needs a fresh launch"
fi
if curl --silent --connect-timeout 1 --output /dev/null "$demo_url/"; then
    die "$demo_url is already in use"
fi

# Only replace a playground this script created.
if [[ -e "$demo_root" ]]; then
    [[ -f "$demo_root/.btmux-demo" ]] || die "$demo_root was not created by this script; move it away first"
    rm -rf "$demo_root"
fi
mkdir -p "$demo_root"
touch "$demo_root/.btmux-demo"
for repo in btmux ghostty-web; do
    echo "Cloning ${repo}…"
    env GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
        git clone --quiet "https://github.com/buntec/$repo.git" "$demo_root/$repo"
done
# Uncommitted changes give the Git UI something to show.
printf '\nEdited during the btmux demo.\n' >>"$demo_cwd/README.md"
printf '# Notes\n\n- Try the Git UI: <prefix> + g\n' >"$demo_cwd/NOTES.md"

# rust-analyzer runs under the demo's temporary HOME, so point it at the real
# toolchain. BTMUX_UPDATE_PROTOCOL makes build.rs skip the frontend build.
rust_env=(
    RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
    CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
    CARGO_TARGET_DIR="${XDG_CACHE_HOME:-$HOME/Library/Caches}/btmux-demo/target"
    BTMUX_UPDATE_PROTOCOL=1
)
echo "Warming the build cache for rust-analyzer…"
(cd "$demo_cwd" && env "${rust_env[@]}" cargo check --workspace --all-targets --quiet)

# The default config's prefix.
prefix="C-a"

work_dir="$(mktemp -d)"
# Kept beside the output until the conversion succeeds.
raw="${output%.*}.raw.mov"
# A private state directory also makes the demo server the app's only
# discoverable server.
demo_home="$work_dir/home"
state_home="$work_dir/state"
config_home="$work_dir/config"
demo_token_file="$state_home/btmux/demo/state.token"
mkdir -p "$demo_home" "$state_home" "$config_home/fish" "$work_dir/data" "$work_dir/cache"
XDG_CONFIG_HOME="$config_home" "$server_bin" install-fish-theme >/dev/null
mkdir -p "$config_home/btmux"
# An opaque window keeps the desktop out of the recording.
cat >"$config_home/btmux/config.toml" <<EOF
desktop-background-opacity = 1.0
appearance = "$mode"
EOF
# A prompt without user and host names.
cat >"$config_home/fish/config.fish" <<'EOF'
set -g fish_greeting
function fish_prompt
    set_color $fish_color_cwd
    echo -n (basename $PWD)
    set_color normal
    echo -n ' > '
end
EOF
# rust-analyzer with completion as you type. The driver waits for the ready
# file, written once rust-analyzer has loaded the workspace.
lsp_ready="$work_dir/lsp-ready"
mkdir -p "$config_home/nvim"
{
    echo "local ready = [==[$lsp_ready]==]"
    echo "local cmd_env = {"
    for var in "${rust_env[@]}"; do
        echo "  ${var%%=*} = [==[${var#*=}]==],"
    done
    echo "}"
    cat <<'EOF'
vim.o.number = true
vim.o.signcolumn = "yes"
vim.o.completeopt = "menuone,noselect,popup"
vim.lsp.config("rust_analyzer", {
  cmd = { "rust-analyzer" },
  cmd_env = cmd_env,
  filetypes = { "rust" },
  root_markers = { "Cargo.toml" },
  capabilities = { experimental = { serverStatusNotification = true } },
  -- Plain names, so typing "(" shows signature help.
  settings = { ["rust-analyzer"] = { completion = { callable = { snippets = "none" } } } },
  handlers = {
    ["experimental/serverStatus"] = function(_, status)
      if status.quiescent then
        vim.fn.writefile({}, ready)
      end
    end,
  },
})
vim.lsp.enable("rust_analyzer")
vim.api.nvim_create_autocmd("LspAttach", {
  callback = function(args)
    -- Complete after "." and "::" but not "(", which shows signature help.
    local provider = vim.lsp.get_client_by_id(args.data.client_id).server_capabilities.completionProvider
    if provider then
      provider.triggerCharacters = vim.tbl_filter(function(c)
        return c ~= "("
      end, provider.triggerCharacters or {})
    end
    vim.lsp.completion.enable(true, args.data.client_id, args.buf, { autotrigger = true })
  end,
})
EOF
} >"$config_home/nvim/init.lua"
server_pid=""
capture_pid=""

cleanup() {
    if [[ -n "$capture_pid" ]] && kill -0 "$capture_pid" 2>/dev/null; then
        kill -INT "$capture_pid" 2>/dev/null || true
        wait "$capture_pid" 2>/dev/null || true
    fi
    osascript -e 'tell application id "com.btmux.desktop" to quit' >/dev/null 2>&1 || true
    if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
        kill "$server_pid" 2>/dev/null || true
        wait "$server_pid" 2>/dev/null || true
    fi
    rm -rf "$work_dir"
}
trap cleanup EXIT

(cd "$demo_cwd" && exec env -i \
    PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" USER="$USER" LOGNAME="$USER" LANG=en_US.UTF-8 \
    HOME="$demo_home" SHELL="$fish" \
    XDG_CONFIG_HOME="$config_home" XDG_STATE_HOME="$state_home" \
    XDG_DATA_HOME="$work_dir/data" XDG_CACHE_HOME="$work_dir/cache" \
    GIT_CONFIG_NOSYSTEM=1 \
    "$server_bin" --no-browser --profile demo --port "$demo_port" --shell "$fish") &
server_pid=$!

demo_token=""
for _ in {1..60}; do
    if [[ -s "$demo_token_file" ]]; then
        demo_token="$(<"$demo_token_file")"
        break
    fi
    kill -0 "$server_pid" 2>/dev/null || die "The demo server exited"
    sleep 0.1
done
[[ -n "$demo_token" ]] || die "Could not find the demo profile token at $demo_token_file"

api() {
    curl --silent --fail --connect-timeout 1 --header "Authorization: Bearer $demo_token" "$@"
}

ready=0
for _ in {1..60}; do
    if api --output /dev/null "$demo_url/api/sessions"; then
        ready=1
        break
    fi
    kill -0 "$server_pid" 2>/dev/null || die "The demo server exited"
    sleep 0.5
done
[[ "$ready" -eq 1 ]] || die "Timed out waiting for the demo server at $demo_url"

first_session="$(api "$demo_url/api/sessions" | sed -E 's/^\[\{"id":"([^"]+)".*/\1/')"
first_pane="$(api "$demo_url/api/sessions/$first_session" | sed -E 's/.*"panes":\[\{"id":"([^"]+)".*/\1/')"

# One session per playground repo.
api --output /dev/null --request POST --header "Content-Type: application/json" \
    --data '{"name":"btmux"}' "$demo_url/api/sessions/$first_session/rename"
api --output /dev/null --request POST --header "Content-Type: application/json" \
    --data "{\"name\":\"ghostty-web\",\"cwd\":\"$demo_root/ghostty-web\"}" "$demo_url/api/sessions"

echo "Launching the desktop app…"
open --env XDG_STATE_HOME="$state_home" -a "$app"
bounds="$(osascript "$driver" connect)"

# The marker proves the app connected and keystrokes reach the terminal.
marker="btmux-demo-ready"
osascript "$driver" line "cd '$demo_cwd'; echo $marker"
connected=0
for _ in {1..30}; do
    if api "$demo_url/api/panes/$first_pane/output" | grep -q "$marker"; then
        connected=1
        break
    fi
    sleep 0.5
done
[[ "$connected" -eq 1 ]] || die "The app did not connect to the demo server, or keystrokes did not reach it"
osascript "$driver" line clear
sleep 1

osascript "$driver" park

echo "Recording $bounds in $mode mode (delay scale $delay_scale)…"
screencapture -v -x -C -R"$bounds" "$raw" >/dev/null 2>&1 &
capture_pid=$!
sleep 2
osascript "$driver" play "$prefix" "$delay_scale" "$lsp_ready"
sleep 1
kill -INT "$capture_pid"
wait "$capture_pid" || true
capture_pid=""
[[ -s "$raw" ]] || die "screencapture produced no video; check the Screen Recording permission"

echo "Converting to ${output}…"
ffmpeg -v error -y \
    -i "$raw" \
    -vf "scale=1280:-2:flags=lanczos,fps=30" \
    -c:v libx264 \
    -preset medium \
    -crf 23 \
    -pix_fmt yuv420p \
    -movflags +faststart \
    -an \
    "$output"
rm -f "$raw"
echo "Saved $output"

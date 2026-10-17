#!/usr/bin/env bash
# Record demos of the macOS desktop app against an isolated demo server.
#
#   scripts/record-desktop-demo.sh [--dark|--light] [--delay-scale X] [--out-dir DIR] [--vm NAME] [DEMO...]
#
# Demos: panes (sessions, windows, panes), files (file browser, Git mode,
# process viewer), nvim (built-in Neovim), agents (agent detection, state, and
# grid), latex (LaTeX overlay), and shaders (wallpaper shaders following the
# keyboard and mouse, switched in Settings); all by default, each with a fresh
# server and app. Records in dark mode by default. --delay-scale (0 < X <= 1,
# default 1) shortens the demos' pauses, typing, and mouse movement; 0.5 runs
# them twice as fast. Each demo is saved as demo-<name>.mp4 (dark) or
# demo-<name>-light.mp4 (light) in --out-dir, the repo root by default.
#
# The terminal running this needs Accessibility (keystrokes) and Screen
# Recording permissions. Don't touch the keyboard or mouse while it runs.
# Only the app's window and the pointer are recorded.
#
# scripts/desktop-demo-server.sh prepares the playground and runs the server:
# on this machine with the app's bundled server, or with --vm in that
# Multipass VM (scripts/vm.sh) with its installed btmux, which must match the
# app's version. The app reaches the VM's server through an SSH port forward
# to 127.0.0.1:8045. The agents in the agents and latex demos are
# scripts/desktop-demo-agent.sh, run as claude, codex, and gemini.
#
# Environment overrides:
#   BTMUX_APP  desktop app bundle (default: the first of /Applications,
#              ~/Applications/Home Manager Apps, and ~/Applications with btmux.app)
#   BTMUX_BIN  local server binary (default: the app's bundled server)
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
driver="$repo_root/scripts/desktop-demo.applescript"
mode=dark
delay_scale=1
out_dir="$repo_root"
vm=""
all_demos=(panes files nvim agents latex shaders)
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
    --out-dir)
        out_dir="${2:-}"
        shift 2 || true
        [[ -d "$out_dir" ]] || {
            echo "--out-dir must be a directory, got '$out_dir'" >&2
            exit 1
        }
        ;;
    --vm)
        vm="${2:-}"
        shift 2 || true
        [[ -n "$vm" ]] || {
            echo "--vm needs a VM name" >&2
            exit 1
        }
        ;;
    -*)
        echo "Unknown option: $1" >&2
        exit 1
        ;;
    *) break ;;
    esac
done
demos=("$@")
[[ ${#demos[@]} -gt 0 ]] || demos=("${all_demos[@]}")
for demo in "${demos[@]}"; do
    [[ " ${all_demos[*]} " == *" $demo "* ]] || {
        echo "Unknown demo '$demo'; choose from: ${all_demos[*]}" >&2
        exit 1
    }
done
wants() { [[ " ${demos[*]} " == *" $1 "* ]]; }

app="${BTMUX_APP:-}"
if [[ -z "$app" ]]; then
    for dir in /Applications "$HOME/Applications/Home Manager Apps" "$HOME/Applications"; do
        if [[ -d "$dir/btmux.app" ]]; then
            app="$dir/btmux.app"
            break
        fi
    done
fi
server_bin="${BTMUX_BIN:-$app/Contents/MacOS/btmux}"
demo_port=8045
demo_url="http://127.0.0.1:$demo_port"
# The default config's prefix.
prefix="C-a"
# Points; cropped from the video with the capture indicator macOS puts there.
title_bar=32

die() {
    echo "$*" >&2
    exit 1
}

[[ "$(uname -s)" == Darwin ]] || die "The desktop demo recorder only runs on macOS"
[[ -n "$app" && -d "$app" ]] || die "No desktop app${app:+ at $app}; set BTMUX_APP to its bundle"
command -v ffmpeg >/dev/null || die "ffmpeg is required"
if pgrep -xq btmux-desktop; then
    die "Quit the btmux desktop app first; the demo needs a fresh launch"
fi
if curl --silent --connect-timeout 1 --output /dev/null "$demo_url/"; then
    die "$demo_url is already in use"
fi
app_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")"

work_dir="$(mktemp -d)"
tunnel_pid=""
capture_pid=""

if [[ -n "$vm" ]]; then
    command -v multipass >/dev/null || die "multipass is required for --vm"
    [[ "$(multipass info "$vm" 2>/dev/null | awk '/^State:/ {print $2}')" == Running ]] ||
        die "VM $vm is not running; start it with: just vm up"
    remote_dir=/home/ubuntu/.cache/btmux-demo-scripts
    multipass exec "$vm" -- mkdir -p "$remote_dir"
    for script in desktop-demo-server.sh desktop-demo-agent.sh; do
        multipass transfer "$repo_root/scripts/$script" "$vm:$remote_dir/$script"
    done
    on_server() { multipass exec "$vm" -- bash "$remote_dir/desktop-demo-server.sh" "$@"; }
    # AppleScript's shell has a minimal PATH.
    sync_test() { printf '%q exec %q -- test -e %q' "$(command -v multipass)" "$vm" "$1"; }

    # Forward the VM's demo port with a key of our own.
    key="$HOME/Library/Caches/btmux-demo/vm_ed25519"
    if [[ ! -f "$key" ]]; then
        mkdir -p "$(dirname "$key")"
        ssh-keygen -q -t ed25519 -N "" -C btmux-demo -f "$key"
    fi
    multipass transfer "$key.pub" "$vm:$remote_dir/key.pub"
    on_server authorize "$remote_dir/key.pub"
    vm_ip="$(multipass info "$vm" | awk '/^IPv4:/ {print $2; exit}')"
    ssh -N -i "$key" -o IdentitiesOnly=yes -o ExitOnForwardFailure=yes \
        -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
        -L "127.0.0.1:$demo_port:127.0.0.1:$demo_port" "ubuntu@$vm_ip" &
    tunnel_pid=$!
else
    [[ -x "$server_bin" ]] || die "No server binary at $server_bin"
    on_server() { BTMUX_BIN="$server_bin" bash "$repo_root/scripts/desktop-demo-server.sh" "$@"; }
    sync_test() { printf 'test -e %q' "$1"; }
fi

stop() {
    if [[ -n "$capture_pid" ]] && kill -0 "$capture_pid" 2>/dev/null; then
        kill -INT "$capture_pid" 2>/dev/null || true
        wait "$capture_pid" 2>/dev/null || true
    fi
    capture_pid=""
    osascript -e 'tell application id "com.btmux.desktop" to quit' >/dev/null 2>&1 || true
    for _ in {1..50}; do
        pgrep -xq btmux-desktop || break
        sleep 0.2
    done
    on_server stop || true
}

cleanup() {
    stop
    if [[ -n "$tunnel_pid" ]]; then
        kill "$tunnel_pid" 2>/dev/null || true
        wait "$tunnel_pid" 2>/dev/null || true
    fi
    rm -rf "$work_dir"
}
trap cleanup EXIT

on_server setup "$mode" "$(wants nvim && echo 1 || echo 0)"

record() {
    local demo="$1" output
    if [[ "$mode" == dark ]]; then
        output="$out_dir/demo-$demo.mp4"
    else
        output="$out_dir/demo-$demo-light.mp4"
    fi
    # Kept beside the output until the conversion succeeds.
    local raw="${output%.*}.raw.mov"

    local started token first_pane demo_cwd sync_dir
    started="$(on_server start "$demo" "$delay_scale")"
    {
        read -r token
        read -r first_pane
        read -r demo_cwd
        read -r sync_dir
    } <<<"$started"

    api() {
        curl --silent --fail --connect-timeout 1 --header "Authorization: Bearer $token" "$@"
    }
    # Through the port forward, which may still be connecting.
    local version=""
    for _ in {1..30}; do
        version="$(api "$demo_url/api/info" | sed -E 's/.*"version":"([^"]+)".*/\1/')" && break
        sleep 0.5
    done
    [[ -n "$version" ]] || die "Could not reach the demo server at $demo_url"
    [[ "$version" == "$app_version" ]] ||
        die "The demo server is btmux $version but the app is $app_version${vm:+; install it in the VM with: just vm release v$app_version}"

    # The app's only discoverable server.
    local app_state="$work_dir/app-state-$demo"
    mkdir -p "$app_state/btmux"
    (umask 077 && printf '{"pid":%d,"address":"127.0.0.1:%d","profile":"demo","token":"%s"}' \
        $$ "$demo_port" "$token" >"$app_state/btmux/state.server")

    echo "Launching the desktop app…"
    open --env XDG_STATE_HOME="$app_state" -a "$app"
    osascript "$driver" connect >/dev/null

    # The marker proves the app connected and keystrokes reach the terminal.
    local marker="btmux-demo-ready"
    osascript "$driver" line "cd '$demo_cwd'; echo $marker"
    local connected=0
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

    # Only the app's window, without its shadow, so other windows and
    # notifications stay out of the video.
    local window height
    read -r window height < <(osascript -l JavaScript "$repo_root/scripts/desktop-demo-window.js" "$(pgrep -x btmux-desktop)")
    echo "Recording $demo: window $window in $mode mode (delay scale $delay_scale)…"
    screencapture -v -x -o -C -l"$window" "$raw" >/dev/null 2>&1 &
    capture_pid=$!
    # screencapture starts within ~0.25 s and the driver within ~0.3 s, so
    # this leaves about a second of idle prompt.
    sleep 1
    osascript "$driver" play "$demo" "$prefix" "$delay_scale" "$(sync_test "$sync_dir")"
    sleep 1
    kill -INT "$capture_pid"
    wait "$capture_pid" || true
    capture_pid=""
    stop
    [[ -s "$raw" ]] || die "screencapture produced no video; check the Screen Recording permission"

    echo "Converting to ${output}…"
    ffmpeg -v error -y \
        -i "$raw" \
        -vf "crop=iw:ih-ih*$title_bar/$height:0:ih*$title_bar/$height,scale=1280:-2:flags=lanczos,fps=30" \
        -c:v libx264 \
        -preset medium \
        -crf 23 \
        -pix_fmt yuv420p \
        -movflags +faststart \
        -an \
        "$output"
    rm -f "$raw"
    echo "Saved $output"
}

for demo in "${demos[@]}"; do
    record "$demo"
done

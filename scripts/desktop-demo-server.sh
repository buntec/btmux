#!/usr/bin/env bash
# The demo server side of scripts/record-desktop-demo.sh, run on this machine
# or in the Multipass VM.
#
#   desktop-demo-server.sh setup <dark|light> <nvim: 0|1>
#   desktop-demo-server.sh start <demo> <delay scale>
#   desktop-demo-server.sh stop
#   desktop-demo-server.sh authorize <public key file>
#
# `setup` recreates ~/btmux-demo with fresh clones of btmux and wterm as
# the demos' playground and the demo shells' HOME, so new windows open beside
# the repos, and an isolated config: the default btmux config (plus an
# opaque window, the color scheme, and a wallpaper shader for the shaders
# demo), fish with only the btmux
# theme, and a minimal Neovim config with rust-analyzer, whose build cache it
# warms when the nvim demo is recorded. `start` runs a server with a fresh
# session tree on 127.0.0.1:8045 in the background and prints its token, first
# pane, working directory, and sync dir, one per line. `authorize` adds an SSH
# key for the recorder's port forward.
#
# BTMUX_BIN overrides the server binary (default: btmux on PATH).
set -euo pipefail

export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
server_bin="${BTMUX_BIN:-$(command -v btmux || true)}"
demo_root="$HOME/btmux-demo"
demo_cwd="$demo_root/btmux"
run_dir="$demo_root/.run"
demo_port=8045
demo_url="http://127.0.0.1:$demo_port"
if [[ "$(uname -s)" == Darwin ]]; then
    cache_dir="$HOME/Library/Caches/btmux-demo"
else
    cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/btmux-demo"
fi
# rust-analyzer runs under the demo's temporary HOME, so point it at the real
# toolchain. BTMUX_UPDATE_PROTOCOL makes build.rs skip the frontend build.
rust_env=(
    RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
    CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
    CARGO_TARGET_DIR="$cache_dir/target"
    BTMUX_UPDATE_PROTOCOL=1
)

die() {
    echo "$*" >&2
    exit 1
}

setup() {
    local mode="$1" nvim="$2"
    [[ -x "$server_bin" ]] || die "No btmux server binary${server_bin:+ at $server_bin}"
    command -v fish >/dev/null || die "fish is required"
    command -v git >/dev/null || die "git is required"
    command -v curl >/dev/null || die "curl is required"
    if [[ "$nvim" == 1 ]]; then
        command -v nvim >/dev/null || die "nvim 0.12+ is required"
        command -v cargo >/dev/null || die "cargo is required"
        command -v rust-analyzer >/dev/null || die "rust-analyzer is required"
    fi
    stop

    # Only replace a playground this script created.
    if [[ -e "$demo_root" ]]; then
        [[ -f "$demo_root/.btmux-demo" ]] || die "$demo_root was not created by this script; move it away first"
        rm -rf "$demo_root"
    fi
    mkdir -p "$demo_root"
    touch "$demo_root/.btmux-demo"
    for repo in buntec/btmux vercel-labs/wterm; do
        echo "Cloning ${repo}…" >&2
        env GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
            git clone --quiet "https://github.com/$repo.git" "$demo_root/${repo#*/}"
    done
    # Uncommitted changes give the Git UI something to show.
    printf '\nEdited during the btmux demo.\n' >>"$demo_cwd/README.md"
    printf '# Notes\n\n- Try the Git UI: <prefix> + g\n' >"$demo_cwd/NOTES.md"

    if [[ "$nvim" == 1 ]]; then
        if command -v rustup >/dev/null; then
            (cd "$demo_cwd" && rustup -q toolchain install && rustup -q component add rust-analyzer)
        fi
        echo "Warming the build cache for rust-analyzer…" >&2
        (cd "$demo_cwd" && env "${rust_env[@]}" cargo check --workspace --all-targets --quiet)
    fi

    local config_home="$run_dir/config"
    mkdir -p "$config_home/fish" "$config_home/btmux" "$config_home/nvim" \
        "$run_dir/data" "$run_dir/cache" "$run_dir/bin"
    # Demo agents, named so btmux detects them.
    for agent in claude codex gemini; do
        printf '#!/bin/bash\nexec -a %s /bin/bash %q %s "$@"\n' \
            "$agent" "$script_dir/desktop-demo-agent.sh" "$agent" >"$run_dir/bin/$agent"
        chmod +x "$run_dir/bin/$agent"
    done
    XDG_CONFIG_HOME="$config_home" "$server_bin" install-fish-theme >/dev/null
    echo "$mode" >"$run_dir/mode"
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
    # rust-analyzer with completion as you type. The driver waits for the
    # ready file, written once rust-analyzer has loaded the workspace.
    {
        echo 'local ready = vim.env.BTMUX_DEMO_SYNC .. "/lsp-ready"'
        echo "local cmd_env = {"
        for var in "${rust_env[@]}"; do
            echo "  ${var%%=*} = [==[${var#*=}]==],"
        done
        echo "}"
        cat <<'EOF'
-- The VM has no clipboard provider; don't toast about it.
require("btmux").setup({ check = false })
vim.o.number = true
vim.o.signcolumn = "yes"
vim.o.completeopt = "menuone,noselect,popup"
vim.o.pumblend = 20
vim.o.winblend = 20
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
}

start() {
    local demo="$1" delay_scale="$2"
    [[ -d "$run_dir/config" ]] || die "Run setup first"
    stop
    if curl --silent --connect-timeout 1 --output /dev/null "$demo_url/"; then
        die "$demo_url is already in use"
    fi
    # A fresh state directory gives each demo a clean session tree.
    local state_home="$run_dir/state-$demo" sync_dir="$run_dir/sync-$demo"
    local token_file="$state_home/btmux/demo/state.token"
    rm -rf "$state_home" "$sync_dir"
    mkdir -p "$state_home" "$sync_dir"
    write_config "$demo"
    local detach=()
    command -v setsid >/dev/null && detach=(setsid)
    (cd "$demo_cwd" && exec ${detach[@]+"${detach[@]}"} nohup env -i \
        PATH="$run_dir/bin:$PATH" TMPDIR="${TMPDIR:-/tmp}" USER="$USER" LOGNAME="$USER" LANG=en_US.UTF-8 \
        HOME="$demo_root" SHELL="$(command -v fish)" \
        XDG_CONFIG_HOME="$run_dir/config" XDG_STATE_HOME="$state_home" \
        XDG_DATA_HOME="$run_dir/data" XDG_CACHE_HOME="$run_dir/cache" \
        GIT_CONFIG_NOSYSTEM=1 \
        BTMUX_DEMO="$demo" BTMUX_DEMO_SCALE="$delay_scale" BTMUX_DEMO_SYNC="$sync_dir" \
        "$server_bin" --no-browser --profile demo --port "$demo_port" --shell "$(command -v fish)") \
        </dev/null >"$run_dir/server.log" 2>&1 &
    echo $! >"$run_dir/server.pid"

    local token=""
    for _ in {1..60}; do
        if [[ -s "$token_file" ]]; then
            token="$(<"$token_file")"
            break
        fi
        sleep 0.1
    done
    [[ -n "$token" ]] || die "The demo server did not start; see $run_dir/server.log"

    api() {
        curl --silent --fail --connect-timeout 1 --header "Authorization: Bearer $token" "$@"
    }
    local ready=0
    for _ in {1..60}; do
        if api --output /dev/null "$demo_url/api/sessions"; then
            ready=1
            break
        fi
        sleep 0.5
    done
    [[ "$ready" -eq 1 ]] || die "Timed out waiting for the demo server; see $run_dir/server.log"

    local first_session first_pane
    first_session="$(api "$demo_url/api/sessions" | sed -E 's/^\[\{"id":"([^"]+)".*/\1/')"
    first_pane="$(api "$demo_url/api/sessions/$first_session" | sed -E 's/.*"panes":\[\{"id":"([^"]+)".*/\1/')"
    # One session per playground repo.
    api --output /dev/null --request POST --header "Content-Type: application/json" \
        --data '{"name":"btmux"}' "$demo_url/api/sessions/$first_session/rename"
    api --output /dev/null --request POST --header "Content-Type: application/json" \
        --data "{\"name\":\"wterm\",\"cwd\":\"$demo_root/wterm\"}" "$demo_url/api/sessions"

    printf '%s\n' "$token" "$first_pane" "$demo_cwd" "$sync_dir"
}

write_config() {
    {
        # An opaque window keeps the desktop out of the recording.
        echo "desktop-background-opacity = 1.0"
        echo "appearance = \"$(<"$run_dir/mode")\""
        # Cursor Trail, following the keyboard and the mouse; the demo adds
        # Pixelate over it. More opaque than the default 0.1 to show up in the
        # video.
        if [[ "$1" == shaders ]]; then
            cat <<'EOF'
wallpaper-opacity = 0.25
wallpaper-fps = 60
wallpaper-speed = 1.0
wallpaper-saturate = 1.0
wallpaper-shader-follows-keyboard-input = true
wallpaper-shader-follows-mouse-cursor = true

[[wallpaper-shader]]
shader = "cursor-trail"
EOF
        fi
    } >"$run_dir/config/btmux/config.toml"
}

stop() {
    local pid_file="$run_dir/server.pid"
    [[ -f "$pid_file" ]] || return 0
    local pid
    pid="$(<"$pid_file")"
    if kill "$pid" 2>/dev/null; then
        for _ in {1..50}; do
            kill -0 "$pid" 2>/dev/null || break
            sleep 0.1
        done
    fi
    rm -f "$pid_file"
}

authorize() {
    local key
    key="$(<"$1")"
    mkdir -p "$HOME/.ssh"
    chmod 700 "$HOME/.ssh"
    touch "$HOME/.ssh/authorized_keys"
    chmod 600 "$HOME/.ssh/authorized_keys"
    grep -qxF "$key" "$HOME/.ssh/authorized_keys" || echo "$key" >>"$HOME/.ssh/authorized_keys"
}

case "${1:-}" in
setup) setup "$2" "$3" ;;
start) start "$2" "$3" ;;
stop) stop ;;
authorize) authorize "$2" ;;
*) die "usage: $0 setup <dark|light> <0|1> | start <demo> <delay scale> | stop | authorize <key file>" ;;
esac

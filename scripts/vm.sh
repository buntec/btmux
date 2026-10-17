#!/usr/bin/env bash
# Linux VM (Multipass) running btmux as a user service, reachable from the host.
set -euo pipefail

VM="${BTMUX_VM:-btmux}"
IMAGE="${BTMUX_VM_IMAGE:-26.04}"
CPUS="${BTMUX_VM_CPUS:-4}"
MEMORY="${BTMUX_VM_MEMORY:-8G}"
DISK="${BTMUX_VM_DISK:-40G}"
PORT="${BTMUX_VM_PORT:-8004}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR=/home/ubuntu/.local/state/btmux

usage() {
    cat <<EOF
usage: $0 <command> [args]

  up              create (or start) the VM
  deploy          build this working tree in the VM and (re)start btmux
  release [TAG]   install a release binary (default: latest) and (re)start btmux
  info            print the URL and access token
  shell           open a shell in the VM
  demo            record the Playwright demo against the VM
  desktop-demo [ARGS]
                  record the desktop app demos with the server in the VM
                  (ARGS as for scripts/record-desktop-demo.sh)
  stop            stop the VM
  delete          delete and purge the VM

Environment: BTMUX_VM ($VM), BTMUX_VM_IMAGE ($IMAGE), BTMUX_VM_CPUS ($CPUS),
BTMUX_VM_MEMORY ($MEMORY), BTMUX_VM_DISK ($DISK), BTMUX_VM_PORT ($PORT).
EOF
}

# Not a login shell: ~/.bash_logout turns `set -e; exit 0` into status 1.
vsh() { multipass exec "$VM" -- bash -c ". /etc/profile.d/btmux-vm.sh; $1"; }

vm_state() { multipass info "$VM" 2>/dev/null | awk '/^State:/ {print $2}'; }

vm_ip() { multipass info "$VM" | awk '/^IPv4:/ {print $2; exit}'; }

up() {
    case "$(vm_state)" in
        "")
            multipass launch "$IMAGE" --name "$VM" --cpus "$CPUS" --memory "$MEMORY" \
                --disk "$DISK" --cloud-init "$ROOT/scripts/vm-cloud-init.yaml" --timeout 1800
            ;;
        Running) ;;
        *) multipass start "$VM" ;;
    esac
    # SSH can briefly fail right after launch or start.
    for _ in $(seq 30); do multipass exec "$VM" -- true 2>/dev/null && break; sleep 2; done
    vsh 'cloud-init status --wait >/dev/null' || {
        echo "cloud-init failed; see /var/log/cloud-init-output.log in the VM" >&2
        exit 1
    }
}

# Install or upgrade the service. Reinstalls when the VM's address changed.
start_service() {
    local url
    url="http://$(vm_ip):$PORT"
    vsh "set -e
        unit=~/.config/systemd/user/btmux.service
        if systemctl --user is-active --quiet btmux && grep -qF -- '$url' \"\$unit\"; then
            btmux upgrade || btmux restart
        else
            btmux --host 0.0.0.0 --port $PORT --public-url $url install
        fi
        for _ in \$(seq 50); do [ -s $STATE_DIR/state.token ] && exit 0; sleep 0.2; done
        echo 'btmux did not start; see journalctl --user -u btmux' >&2
        exit 1"
    info
}

deploy() {
    up
    local tarball
    tarball="$(mktemp "${TMPDIR:-/tmp}/btmux-src.XXXXXX")"
    # Tracked and untracked files, minus ignored ones and deleted ones.
    git -C "$ROOT" ls-files -z -co --exclude-standard --deduplicate |
        (cd "$ROOT" && while IFS= read -r -d '' f; do
            if [[ -e "$f" && "$f" != *.mp4 ]]; then printf '%s\0' "$f"; fi
        done) |
        COPYFILE_DISABLE=1 tar -C "$ROOT" --null -T - -czf "$tarball"
    multipass transfer "$tarball" "$VM:/home/ubuntu/btmux-src.tar.gz"
    rm -f "$tarball"
    vsh 'set -e
        command -v cargo >/dev/null || curl -fsSL https://sh.rustup.rs |
            sh -s -- -y --profile minimal --default-toolchain none --no-modify-path
        command -v bun >/dev/null || curl -fsSL https://bun.sh/install | bash >/dev/null
        mkdir -p ~/btmux-src && cd ~/btmux-src
        find . -mindepth 1 -maxdepth 1 ! -name target -exec rm -rf {} +
        tar -xzf ~/btmux-src.tar.gz && rm ~/btmux-src.tar.gz
        rustup toolchain install
        (cd frontend && bun install --frozen-lockfile)
        cargo build --release
        mkdir -p ~/.local/bin
        cp target/release/btmux ~/.local/bin/btmux.new && mv ~/.local/bin/btmux.new ~/.local/bin/btmux'
    start_service
}

release() {
    up
    local path=latest/download
    [[ -n "${1:-}" ]] && path="download/$1"
    vsh "set -e
        mkdir -p ~/.local/bin
        curl -fsSL https://github.com/buntec/btmux/releases/$path/btmux-\$(uname -m)-unknown-linux-gnu \
            -o ~/.local/bin/btmux.new
        chmod +x ~/.local/bin/btmux.new && mv ~/.local/bin/btmux.new ~/.local/bin/btmux
        btmux version"
    start_service
}

token() { multipass exec "$VM" -- cat "$STATE_DIR/state.token"; }

info() {
    echo
    echo "btmux:    http://$(vm_ip):$PORT"
    echo "username: btmux"
    echo "token:    $(token)"
}

# Fresh session tree, then drive the host's Playwright against the VM.
demo() {
    vsh "systemctl --user stop btmux && rm -f $STATE_DIR/state.json && systemctl --user start btmux"
    local tok
    tok="$(token)"
    for _ in $(seq 50); do
        curl -fs -o /dev/null -H "Authorization: Bearer $tok" "http://$(vm_ip):$PORT/api/sessions" && break
        sleep 0.2
    done
    cd "$ROOT/frontend"
    bunx playwright install chromium
    BTMUX_URL="http://$(vm_ip):$PORT" BTMUX_AUTH_TOKEN="$tok" BTMUX_CWD=/home/ubuntu/btmux \
        bun run record-demo.ts
}

case "${1:-}" in
    up) up ;;
    deploy) deploy ;;
    release) release "${2:-}" ;;
    info) info ;;
    shell) multipass shell "$VM" ;;
    demo) demo ;;
    desktop-demo)
        shift
        up
        exec "$ROOT/scripts/record-desktop-demo.sh" --vm "$VM" "$@"
        ;;
    stop) multipass stop "$VM" ;;
    delete) multipass delete --purge "$VM" ;;
    *) usage; exit 1 ;;
esac

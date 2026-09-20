default:
    @just --list

# Dev backend port — kept distinct from the production default (8004) so a
# running production/service instance and `just dev` don't fight over the port.
# Vite (vite.config.ts) proxies /ws and /api here.
dev_port := "8044"

# Demo backend port — kept distinct from both the production default and the
# development backend.
demo_port := "8045"

# Run both backend and frontend in dev mode. Default backend logging to debug;
# an explicitly exported BTMUX_*_LOG value still wins.
dev:
    BTMUX_CONSOLE_LOG="${BTMUX_CONSOLE_LOG:-debug}" BTMUX_FILE_LOG="${BTMUX_FILE_LOG:-debug}" \
      bunx concurrently --names backend,frontend --prefix-colors blue,green \
        "cargo run -- --no-browser --profile dev --public-url http://localhost:5173 --public-url http://127.0.0.1:5173 --port {{dev_port}}" \
        "cd frontend && bunx vite --open"

# Run only the backend
dev-backend:
    cargo run -- --profile dev --public-url http://localhost:5173 --public-url http://127.0.0.1:5173 --port {{dev_port}}

# Run only the frontend
dev-frontend:
    cd frontend && bunx vite

# Build everything for production (frontend assets are embedded into the binary)
build:
    cd frontend && bun install && bun run build
    cargo build --release

# Type-check the frontend without emitting
check-frontend:
    cd frontend && bunx tsc --noEmit

# Check the backend (fast compile check)
check-backend:
    cargo check

# Check both
check: check-backend check-frontend

# Format the whole codebase
fmt:
    cargo fmt
    cd frontend && bunx prettier --write "src/**/*.{ts,tsx}"

format: fmt

# Run clippy on the backend
lint:
    cargo clippy -- -D warnings

# Install all dependencies
setup:
    cd frontend && bun install
    cargo fetch

# Refresh the vendored Radiant shader catalog at the revision pinned by the script.
# Pass a local checkout to avoid downloading: just sync-radiant /path/to/radiant
sync-radiant source="":
    node scripts/sync-radiant.mjs {{source}}

# Clean build artifacts
clean:
    cargo clean
    rm -rf frontend/dist

# Bump version (patch by default; `just bump minor` or `just bump major`)
# Requires cargo-edit: `cargo install cargo-edit`
bump level="patch":
    cargo set-version --bump {{level}}
    @echo "bumped to $(grep '^version' Cargo.toml | head -1 | sed 's/.*"\(.*\)"/\1/')"

# Update the Nix package to the latest published GitHub release.
update-nix-package:
    ./scripts/update-nix-package.sh

# Install the binary to ~/.cargo/bin
install: build
    cargo install --path .

# Record a demo against an isolated btmux instance (port 8045).
# Output: demo.webm (and demo.mp4 if ffmpeg is in PATH) in the repo root.
# Override the session/prefix with: BTMUX_SESSION=my-session BTMUX_PREFIX=C-a just record-demo
record-demo:
    #!/usr/bin/env bash
    set -euo pipefail

    demo_url="http://127.0.0.1:{{demo_port}}"
    demo_state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/btmux/demo"
    demo_state_file="$demo_state_dir/state.json"
    demo_token_file="$demo_state_dir/state.token"

    cd "{{justfile_directory()}}"
    (cd frontend && bunx playwright install --with-deps chromium)

    if curl --silent --connect-timeout 1 --output /dev/null "$demo_url/"; then
        echo "Cannot reset the demo profile while $demo_url is already in use" >&2
        exit 1
    fi

    # Start each recording with a clean session tree and token. Keep the lock
    # inode: ProfileLock intentionally never unlinks it while a server runs.
    rm -f "$demo_state_file" "$demo_token_file"

    # Always use the demo profile's own token, even when the caller has the
    # production token exported in its environment.
    env -u BTMUX_AUTH_TOKEN ./target/release/btmux --no-browser --profile demo --port {{demo_port}} &
    server_pid=$!

    cleanup() {
        if kill -0 "$server_pid" 2>/dev/null; then
            kill "$server_pid" 2>/dev/null || true
            wait "$server_pid" 2>/dev/null || true
        fi
    }
    trap cleanup EXIT

    demo_token=""
    for _ in {1..60}; do
        if [[ -s "$demo_token_file" ]]; then
            demo_token="$(<"$demo_token_file")"
            break
        fi
        if ! kill -0 "$server_pid" 2>/dev/null; then
            wait "$server_pid"
        fi
        sleep 0.1
    done
    if [[ -z "$demo_token" ]]; then
        echo "Could not find the demo profile token at $demo_token_file" >&2
        exit 1
    fi

    ready=0
    for _ in {1..60}; do
        if curl --silent --fail --connect-timeout 1 \
            --header "Authorization: Bearer $demo_token" \
            --output /dev/null "$demo_url/api/sessions"; then
            ready=1
            break
        fi
        if ! kill -0 "$server_pid" 2>/dev/null; then
            wait "$server_pid"
        fi
        sleep 0.5
    done
    if [[ "$ready" -ne 1 ]]; then
        echo "Timed out waiting for the demo server at $demo_url" >&2
        exit 1
    fi

    export BTMUX_URL="$demo_url"
    export BTMUX_AUTH_TOKEN="$demo_token"
    (cd frontend && bun run record-demo.ts)

# Kill all dev processes (vite, dev backend, concurrently)
kill-dev:
    -pkill -f "target/debug/btmux"
    -pkill -f "vite.*frontend"
    -pkill -f "concurrently.*backend,frontend"

# Build and run the production binary (frontend embedded at compile time)
run: build
    ./target/release/btmux

# Run backend regression tests
test:
    cargo test

# Frontend unit tests (LaTeX detector)
test-frontend:
    cd frontend && bun test

# Generate the TypeScript wire contract from Rust
protocol:
    BTMUX_UPDATE_PROTOCOL=1 cargo test protocol::generated_protocol_is_current

# Browser regressions against an isolated dev stack (requires BTMUX_AUTH_TOKEN)
test-browser:
    cd frontend && bun reliability-test.ts

default:
    @just --list

# Dev backend port — kept distinct from the production default (8004) so a
# running production/service instance and `just dev` don't fight over the port.
# Vite (vite.config.ts) proxies /ws and /api here.
dev_port := "8044"

# Run both backend and frontend in dev mode
dev:
    bunx concurrently --names backend,frontend --prefix-colors blue,green \
        "cargo run -- --no-browser --port {{dev_port}}" \
        "cd frontend && bunx vite --open"

# Run only the backend
dev-backend:
    cargo run -- --port {{dev_port}}

# Run only the frontend
dev-frontend:
    cd frontend && bunx vite

# Build everything for production (frontend assets are embedded into the binary)
build:
    cd frontend && bun run build
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

# Clean build artifacts
clean:
    cargo clean
    rm -rf frontend/dist

# Bump version (patch by default; `just bump minor` or `just bump major`)
# Requires cargo-edit: `cargo install cargo-edit`
bump level="patch":
    cargo set-version --bump {{level}}
    @echo "bumped to $(grep '^version' Cargo.toml | head -1 | sed 's/.*"\(.*\)"/\1/')"

# Install the binary to ~/.cargo/bin
install: build
    cargo install --path .

# Kill all dev processes (vite, dev backend, concurrently)
kill-dev:
    -pkill -f "target/debug/btmux"
    -pkill -f "vite.*frontend"
    -pkill -f "concurrently.*backend,frontend"

# Build and run the production binary (frontend embedded at compile time)
run: build
    ./target/release/btmux

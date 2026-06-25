#!/bin/sh
cd "$(dirname "$0")/.."
npx concurrently \
  --names backend,frontend \
  --prefix-colors blue,green \
  "cargo run --manifest-path backend/Cargo.toml" \
  "cd frontend && npx vite"

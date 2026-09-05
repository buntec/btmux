#!/usr/bin/env bash
set -euo pipefail

package_file="nix/package.nix"
release_api="https://api.github.com/repos/buntec/btmux/releases/latest"

echo "looking up the latest GitHub release"
version="$({
  curl --fail --location --silent --show-error \
    --header 'Accept: application/vnd.github+json' "$release_api"
} | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p')"

if [[ -z "$version" ]]; then
  echo "error: could not determine the latest GitHub release" >&2
  exit 1
fi

targets=(aarch64-apple-darwin aarch64-unknown-linux-gnu x86_64-unknown-linux-gnu)
hashes=()

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

for i in "${!targets[@]}"; do
  target="${targets[$i]}"
  artifact="$tmp_dir/btmux-$target"
  url="https://github.com/buntec/btmux/releases/download/v$version/btmux-$target"

  echo "fetching $url"
  curl --fail --location --silent --show-error --output "$artifact" "$url"
  hashes[$i]="$(nix hash file --type sha256 --sri "$artifact")"
done

updated_package="$tmp_dir/package.nix"
awk \
  -v version="$version" \
  -v aarch64_darwin="${hashes[0]}" \
  -v aarch64_linux="${hashes[1]}" \
  -v x86_64_linux="${hashes[2]}" '
    /^  version = / {
      print "  version = \"" version "\";"
      next
    }
    /^  hashes = \{/ { in_hashes = 1 }
    in_hashes && /"aarch64-darwin" = / {
      print "    \"aarch64-darwin\" = \"" aarch64_darwin "\";"
      next
    }
    in_hashes && /"aarch64-linux" = / {
      print "    \"aarch64-linux\" = \"" aarch64_linux "\";"
      next
    }
    in_hashes && /"x86_64-linux" = / {
      print "    \"x86_64-linux\" = \"" x86_64_linux "\";"
      next
    }
    in_hashes && /^  \};/ { in_hashes = 0 }
    { print }
  ' "$package_file" > "$updated_package"
mv "$updated_package" "$package_file"

echo "updated Nix package to $version"

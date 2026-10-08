#!/usr/bin/env bash
# Usage: update-nix-package.sh [version]  (default: latest GitHub release)
set -euo pipefail

package_files=(nix/package.nix nix/desktop-package.nix)
release_api="https://api.github.com/repos/buntec/btmux/releases/latest"

version="${1:-}"
version="${version#v}"

if [[ -z "$version" ]]; then
  echo "looking up the latest GitHub release"
  version="$({
    curl --fail --location --silent --show-error \
      --header 'Accept: application/vnd.github+json' "$release_api"
  } | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p')"
fi

if [[ -z "$version" ]]; then
  echo "error: could not determine the latest GitHub release" >&2
  exit 1
fi

targets=(aarch64-apple-darwin aarch64-unknown-linux-gnu x86_64-unknown-linux-gnu)
hashes=()

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

for package_file in "${package_files[@]}"; do
  for i in "${!targets[@]}"; do
    target="${targets[$i]}"
    name="btmux-$target"
    if [[ "$package_file" == "nix/desktop-package.nix" ]]; then
      extension="deb"
      [[ "$target" != *darwin ]] || extension="zip"
      name="btmux-desktop-$target.$extension"
    fi
    artifact="$tmp_dir/$name"
    url="https://github.com/buntec/btmux/releases/download/v$version/$name"

    echo "fetching $url"
    curl --fail --location --silent --show-error --output "$artifact" "$url"
    hashes[$i]="$(nix hash file --type sha256 --sri "$artifact")"
  done

  updated_package="$tmp_dir/$(basename "$package_file")"
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
done

for package_file in "${package_files[@]}"; do
  mv "$tmp_dir/$(basename "$package_file")" "$package_file"
done

echo "updated Nix packages to $version"

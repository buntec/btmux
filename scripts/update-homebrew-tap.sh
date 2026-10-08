#!/usr/bin/env bash
# Write Formula/btmux.rb and Casks/btmux.rb for a GitHub release into a tap checkout.
# Usage: update-homebrew-tap.sh TAP_DIR [VERSION]
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: $0 TAP_DIR [VERSION]" >&2
  exit 1
fi

tap_dir="$1"
version="${2:-}"
repo="buntec/btmux"

if [[ -z "$version" ]]; then
  echo "looking up the latest GitHub release"
  version="$({
    curl --fail --location --silent --show-error \
      --header 'Accept: application/vnd.github+json' \
      "https://api.github.com/repos/$repo/releases/latest"
  } | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p')"
fi
version="${version#v}"

if [[ -z "$version" ]]; then
  echo "error: could not determine the release version" >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

sha256() {
  local name="$1"
  local url="https://github.com/$repo/releases/download/v$version/$name"
  echo "fetching $url" >&2
  curl --fail --location --silent --show-error --output "$tmp_dir/$name" "$url"
  shasum -a 256 "$tmp_dir/$name" | cut -d' ' -f1
}

aarch64_darwin="$(sha256 btmux-aarch64-apple-darwin)"
aarch64_linux="$(sha256 btmux-aarch64-unknown-linux-gnu)"
x86_64_linux="$(sha256 btmux-x86_64-unknown-linux-gnu)"
desktop_darwin="$(sha256 btmux-desktop-aarch64-apple-darwin.zip)"

mkdir -p "$tap_dir/Formula" "$tap_dir/Casks"

cat > "$tap_dir/Formula/btmux.rb" <<EOF
class Btmux < Formula
  desc "Browser-based tmux"
  homepage "https://github.com/$repo"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/$repo/releases/download/v$version/btmux-aarch64-apple-darwin"
      sha256 "$aarch64_darwin"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/$repo/releases/download/v$version/btmux-aarch64-unknown-linux-gnu"
      sha256 "$aarch64_linux"
    end
    on_intel do
      url "https://github.com/$repo/releases/download/v$version/btmux-x86_64-unknown-linux-gnu"
      sha256 "$x86_64_linux"
    end
  end

  def install
    bin.install Dir["btmux-*"].first => "btmux"
  end

  def caveats
    <<~EOS
      A running background service keeps the old version until restarted:
        btmux restart
      If you installed it with an older btmux, re-run \`btmux install\` once so
      it follows future upgrades.
    EOS
  end

  test do
    assert_match "Browser-based tmux", shell_output("#{bin}/btmux --help")
  end
end
EOF

cat > "$tap_dir/Casks/btmux.rb" <<EOF
cask "btmux" do
  version "$version"
  sha256 "$desktop_darwin"

  url "https://github.com/$repo/releases/download/v#{version}/btmux-desktop-aarch64-apple-darwin.zip"
  name "btmux"
  desc "Desktop client for btmux"
  homepage "https://github.com/$repo"

  depends_on arch: :arm64

  app "btmux.app"

  # Ad-hoc signed, not notarized.
  postflight_steps do
    run "/usr/bin/xattr",
        args:           ["-dr", "com.apple.quarantine", "{{appdir}}/btmux.app"],
        writable_paths: ["btmux.app"],
        writable_base:  :appdir
  end

  zap trash: [
    "~/Library/Application Support/btmux-desktop",
    "~/Library/Application Support/com.btmux.desktop",
    "~/Library/Caches/btmux-desktop",
    "~/Library/Caches/com.btmux.desktop",
    "~/Library/WebKit/btmux-desktop",
    "~/Library/WebKit/com.btmux.desktop",
  ]
end
EOF

echo "updated Homebrew tap to $version"

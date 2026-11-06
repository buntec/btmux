#!/usr/bin/env bash
# Signs a macOS binary with the hardened runtime and notarizes it.
#
# Usage: scripts/macos-sign.sh <binary>
#
# Environment:
#   SIGN_IDENTITY  codesign identity, e.g. "Developer ID Application: Name (TEAMID)".
#                  Default "-": ad-hoc signing, for testing without a certificate.
#   NOTARY_KEY, NOTARY_KEY_ID, NOTARY_ISSUER
#                  App Store Connect API key (path to the .p8 file), its key ID and issuer ID.
#                  Without them the binary is not notarized.
#
# A bare binary can't be stapled; Gatekeeper looks its ticket up online.
set -euo pipefail

binary=${1:?usage: $0 <binary>}
identity=${SIGN_IDENTITY:--}

notarizing=false
if [[ -n ${NOTARY_KEY:-} && -n ${NOTARY_KEY_ID:-} && -n ${NOTARY_ISSUER:-} ]]; then
    notarizing=true
fi
if [[ $identity == "-" && $notarizing == true ]]; then
    echo "error: notarization needs a Developer ID identity in SIGN_IDENTITY" >&2
    exit 1
fi

if [[ $identity == "-" ]]; then
    codesign --force --sign - --identifier com.btmux.cli "$binary"
else
    codesign --force --options runtime --timestamp --sign "$identity" --identifier com.btmux.cli "$binary"
fi
codesign --verify --strict --verbose=1 "$binary"

if [[ $notarizing != true ]]; then
    echo "Not notarizing $binary (no NOTARY_KEY, NOTARY_KEY_ID and NOTARY_ISSUER)"
    exit 0
fi

dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
zip="$dir/$(basename "$binary").zip"
ditto -c -k --keepParent "$binary" "$zip"
# Usually minutes, but Apple sometimes takes hours.
result=$(xcrun notarytool submit "$zip" --key "$NOTARY_KEY" --key-id "$NOTARY_KEY_ID" \
    --issuer "$NOTARY_ISSUER" --wait --timeout 3h --output-format json) || {
    echo "Notarization of $binary failed or timed out: $result" >&2
    exit 1
}
id=$(python3 -I -c 'import json, sys; print(json.load(sys.stdin)["id"])' <<<"$result")
status=$(python3 -I -c 'import json, sys; print(json.load(sys.stdin)["status"])' <<<"$result")
echo "Notarization of $binary: $status ($id)"
if [[ $status != Accepted ]]; then
    xcrun notarytool log "$id" --key "$NOTARY_KEY" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER" >&2
    exit 1
fi

#!/usr/bin/env bash
# Fetch Anthropic's Claude for Chrome extension from the Chrome Web Store and
# unpack it into vendor/<version>/. Nothing from upstream is committed — the
# repo holds only the Arc patches in arc/ plus these scripts.
#
#   ./scripts/fetch-upstream.sh            # whatever the Web Store serves today
set -euo pipefail

EXT_ID="fcoeoabgfenejglbffodgkkbkcdhcgfn"   # Claude for Chrome
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

URL="https://clients2.google.com/service/update2/crx?response=redirect&prodversion=140&acceptformat=crx2,crx3&x=id%3D${EXT_ID}%26uc"

echo "→ downloading ${EXT_ID}"
curl -fsSL -o "$TMP/ext.crx" "$URL"

# CRX3: "Cr24" | version(4) | header length(4) | header | zip
python3 - "$TMP/ext.crx" "$TMP/ext.zip" <<'PY'
import struct, sys
data = open(sys.argv[1], 'rb').read()
if data[:4] != b'Cr24':
    raise SystemExit('not a CRX file')
hlen = struct.unpack('<I', data[8:12])[0]
open(sys.argv[2], 'wb').write(data[12 + hlen:])
PY

rm -rf "$TMP/x" && mkdir -p "$TMP/x"
unzip -qo "$TMP/ext.zip" -d "$TMP/x"

VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$TMP/x/manifest.json")"
DEST="$ROOT/vendor/$VERSION"

rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
mv "$TMP/x" "$DEST"

SHA="$(shasum -a 256 "$TMP/ext.crx" | cut -d' ' -f1)"
printf '%s  sha256:%s  %s\n' "$VERSION" "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$ROOT/UPSTREAM.txt"

echo "→ vendor/$VERSION  (crx sha256 ${SHA:0:16}…)"
echo "→ next: node scripts/apply-patches.mjs $VERSION"

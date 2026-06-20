#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  build.sh — reproducible package builder for the SubVibe Chrome extension.
#
#  SubVibe has NO build step: it's vanilla JS/HTML/CSS, nothing minified or
#  bundled. So the files in this repo ARE the files that ship and run. This
#  script just zips them (minus dev-only files) into the exact package that is
#  uploaded to the Chrome Web Store, so anyone can reproduce it from source.
#
#  Usage:  ./build.sh
#  Output: subvibe-v<version>.zip  (version read from manifest.json)
# ─────────────────────────────────────────────────────────────────────────────
set -e
cd "$(dirname "$0")"

VER=$(grep -m1 '"version"[[:space:]]*:' manifest.json | grep -oE '[0-9]+(\.[0-9]+)+')
OUT="subvibe-v${VER}.zip"
rm -f "$OUT"

# Everything EXCEPT dev-only files. What's left is exactly what ships.
zip -r -X "$OUT" . \
  -x "tools/*" \
  -x "*.md" \
  -x ".gitignore" \
  -x ".git/*" \
  -x ".github/*" \
  -x "build.sh" \
  -x "icons/icon.svg" \
  -x "*.zip" \
  -x "*.DS_Store" \
  -x "**/.DS_Store" >/dev/null

echo "✓ Built $OUT"
echo ""
echo "Contents (manifest.json must be at the root):"
unzip -l "$OUT" | awk 'NR>3 && $4!="" {print "   "$4}' | grep -v '^   ----' | head -40
echo ""
echo "$(unzip -l "$OUT" | tail -1 | awk '{print $2}') files. No build step — these are the same files as the source."

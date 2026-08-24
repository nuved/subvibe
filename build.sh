#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  build.sh — reproducible package builder for the SubVibe Chrome extension.
#
#  SubVibe has NO build step: it's vanilla JS/HTML/CSS, nothing minified or
#  bundled. So the files in this repo ARE the files that ship and run. This
#  script just zips them (minus dev-only files) into the exact package that is
#  uploaded to the Chrome Web Store, so anyone can reproduce it from source.
#
#  Usage:  ./build.sh              → subvibe-v<version>.zip           (Chrome)
#          ./build.sh --firefox    → subvibe-firefox-v<version>.zip   (Firefox)
#
#  The Firefox package is the SAME source with two manifest tweaks (Firefox runs
#  MV3 backgrounds as event pages, not service workers, and AMO requires a gecko
#  id) — the transform below is the whole "build step", kept inline so reviewers
#  can read it.
# ─────────────────────────────────────────────────────────────────────────────
set -e
cd "$(dirname "$0")"

VER=$(grep -m1 '"version"[[:space:]]*:' manifest.json | grep -oE '[0-9]+(\.[0-9]+)+')
if [ "${1:-}" = "--firefox" ]; then
  OUT="subvibe-firefox-v${VER}.zip"
else
  OUT="subvibe-v${VER}.zip"
fi
rm -f "$OUT"

# Everything EXCEPT dev-only files. What's left is exactly what ships.
# The `.*` / `*/.*` excludes drop ALL hidden files — not just .git, but local
# dev state (.claude, .playwright-mcp, .superpowers) that a clean CI checkout
# never has but a local build would otherwise bake into the store package.
zip -r -X "$OUT" . \
  -x "tools/*" \
  -x "docs/*" \
  -x "*.md" \
  -x ".gitignore" \
  -x ".git/*" \
  -x ".github/*" \
  -x "build.sh" \
  -x "icons/icon.svg" \
  -x ".*" \
  -x "*/.*" \
  -x "*.zip" \
  -x "*.DS_Store" \
  -x "**/.DS_Store" >/dev/null

if [ "${1:-}" = "--firefox" ]; then
  # Replace manifest.json inside the zip with the Firefox variant:
  #  • background: event-page "scripts" alongside "service_worker" (the MDN
  #    cross-browser pattern — Firefox ≥121 starts the event page, Chrome the worker)
  #  • browser_specific_settings: required gecko id + min version (128 = MV3 on
  #    Android + world:MAIN content scripts), and gecko_android for the AMO listing
  TMP=$(mktemp -d)
  python3 - "$TMP" <<'PY'
import json, sys, os
with open("manifest.json") as f:
    m = json.load(f)
m["background"] = {
    # Event pages can't importScripts (worker-only API) — list the shared pure
    # modules explicitly; they attach to globalThis, so background.js sees the
    # same SV_* globals the Chrome worker gets via its (guarded) importScripts.
    "scripts": ["shared/pricing.js", "shared/leitner.js", "shared/stopwords.js", "shared/vocab.js", "shared/simplify.js", "shared/shot.js", "background.js"],
    "service_worker": "background.js",
}
m["browser_specific_settings"] = {
    "gecko": {"id": "subvibe@nimanou.com", "strict_min_version": "128.0"},
    "gecko_android": {},
}
# Strip the Chrome-only manifest bits Firefox warns on: the offscreen + tabCapture
# permissions (both gated behind hasOffscreen in background.js, so live audio is
# Chrome-only regardless), and version_name (a Chrome-ism — Firefox uses "version").
m["permissions"] = [p for p in m["permissions"] if p not in ("offscreen", "tabCapture")]
m.pop("version_name", None)
with open(os.path.join(sys.argv[1], "manifest.json"), "w") as f:
    json.dump(m, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY
  (cd "$TMP" && zip -X "$OLDPWD/$OUT" manifest.json >/dev/null)
  rm -rf "$TMP"
fi

echo "✓ Built $OUT"
echo ""
echo "Contents (manifest.json must be at the root):"
unzip -l "$OUT" | awk 'NR>3 && $4!="" {print "   "$4}' | grep -v '^   ----' | head -40
echo ""
echo "$(unzip -l "$OUT" | tail -1 | awk '{print $2}') files. No build step — these are the same files as the source."

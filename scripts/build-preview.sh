#!/usr/bin/env bash
# Build the STATIC design preview for GitHub Pages.
#
# This is a preview artefact, not the product. The real deployment runs on
# Cloudflare Workers with server components, a D1 database and a live
# POST /api/appointments. GitHub Pages serves files and nothing else, so this
# script produces the two pages as flat HTML and the booking form declares
# itself a preview at runtime rather than 404-ing.
#
# Two things make it work:
#   PREVIEW_BASE_PATH  prefixes every asset URL, because a project site is
#                      served from /<repo>/ and not from the domain root.
#   NODE_OPTIONS       loads the `cloudflare:workers` stub. vinext prerenders by
#                      booting the app under plain Node, which cannot resolve
#                      that specifier — the same wall the test suite hit.
#
# Usage: scripts/build-preview.sh <base-path> <output-dir>
set -euo pipefail

BASE_PATH="${1:?usage: build-preview.sh <base-path> <output-dir>}"
OUT_DIR="${2:?usage: build-preview.sh <base-path> <output-dir>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> building static preview at base path '${BASE_PATH}'"
rm -rf dist
PREVIEW_BASE_PATH="$BASE_PATH" NODE_OPTIONS="--import ./tests/setup.mjs" \
  npx vinext build --prerender-all

PRE="dist/server/prerendered-routes"
[ -d "$PRE" ] || { echo "ERROR: no prerendered routes at $PRE"; exit 1; }

echo "==> assembling ${OUT_DIR}"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

# Client assets (JS, CSS, fonts, photographs) sit at the site root.
cp -R dist/client/. "$OUT_DIR"/

# The prerendered pages. /founders must be a directory index so the pretty URL
# works without a server rewriting anything.
cp "$PRE/index.html" "$OUT_DIR/index.html"
cp "$PRE/404.html" "$OUT_DIR/404.html"
mkdir -p "$OUT_DIR/founders"
cp "$PRE/founders.html" "$OUT_DIR/founders/index.html"

# Vite's `base` only rewrites URLs it PROCESSES — imports and CSS url(). It does
# not touch string literals in our own source, and three families of those are
# root-absolute:
#   /images/...   the generated manifest in app/_media/images.ts
#   /founders     internal navigation
#   /             links home
# The manifest is also bundled into the client JS, because Flip is a client
# component, so the JS chunks need the same treatment as the HTML.
echo "==> rewriting root-absolute paths for the subpath"
python3 - "$OUT_DIR" "$BASE_PATH" <<'PYEOF'
import pathlib, re, sys
out, base = pathlib.Path(sys.argv[1]), sys.argv[2]

def fix(text: str) -> str:
    # Images: quoted, and inside srcset lists after a comma.
    text = text.replace('"/images/', f'"{base}/images/')
    text = text.replace(", /images/", f", {base}/images/")
    # Internal links. /founders must gain a trailing slash so the directory
    # index resolves without a server rewrite.
    text = text.replace('href="/founders"', f'href="{base}/founders/"')
    text = text.replace('"/founders"', f'"{base}/founders/"')
    text = re.sub(r'href="/"', f'href="{base}/"', text)
    return text

changed = 0
for path in list(out.rglob("*.html")) + list(out.rglob("*.js")):
    original = path.read_text(encoding="utf-8", errors="ignore")
    fixed = fix(original)
    if fixed != original:
        path.write_text(fixed, encoding="utf-8")
        changed += 1
print(f"   rewrote {changed} files")

# Fail loudly rather than shipping a preview with broken pictures.
leaks = []
for path in list(out.rglob("*.html")) + list(out.rglob("*.js")):
    body = path.read_text(encoding="utf-8", errors="ignore")
    if '"/images/' in body or ", /images/" in body:
        leaks.append(path.name)
if leaks:
    raise SystemExit(f"ERROR: unprefixed /images/ paths remain in: {leaks[:5]}")
print("   verified: no unprefixed /images/ paths remain")
PYEOF

# Stop Pages running the output through Jekyll, which would drop _-prefixed
# paths and silently break assets.
touch "$OUT_DIR/.nojekyll"

echo "==> done"
find "$OUT_DIR" -maxdepth 2 -name "*.html" | sort
du -sh "$OUT_DIR"

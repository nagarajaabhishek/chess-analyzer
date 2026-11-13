#!/usr/bin/env bash
# Copy Stockfish 19 lite single-threaded WASM into static/js for the Analyzer.
# Lite-single: ~1.8MB, no COOP/COEP headers required, works on iOS WKWebView.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/node_modules/stockfish/bin"
DEST="$ROOT/static/js"

if [[ ! -f "$SRC/stockfish-19-lite-single.js" || ! -f "$SRC/stockfish-19-lite-single.wasm" ]]; then
  echo "error: Stockfish 19 lite-single not found under node_modules/stockfish/bin" >&2
  echo "run: cd client && npm install" >&2
  exit 1
fi

mkdir -p "$DEST"
# Stable names expected by app.js Worker("/js/stockfish.js").
# The engine resolves its sibling as stockfish.wasm (pathname .js → .wasm).
cp "$SRC/stockfish-19-lite-single.js"   "$DEST/stockfish.js"
cp "$SRC/stockfish-19-lite-single.wasm" "$DEST/stockfish.wasm"

echo "Copied Stockfish 19 lite-single → static/js/stockfish.{js,wasm}"
ls -lh "$DEST/stockfish.js" "$DEST/stockfish.wasm"

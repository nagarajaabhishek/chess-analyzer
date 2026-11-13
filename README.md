# ChessNow

**Primary focus right now: ChessNow Analyzer** (`client/`) — local-first game analysis with Stockfish in the browser / iOS app.

Voice telephony (`server/`) stays in this monorepo but is **secondary** until Analyzer is a solid, shippable product.

| Product | Path | Status |
|---------|------|--------|
| **ChessNow Analyzer** | [`client/`](client/) | **Active focus** — web + Capacitor iOS |
| ChessNow Voice | [`server/`](server/) | Frozen / later — Twilio phone chess |

Official product name: **ChessNow**. Do not reintroduce “ChessLens” or “Voice Chessbot” in user-facing copy. Exception: iOS bundle ID `com.abhisheknagaraja.chesslens` must never change.

---

## Analyzer — start here

Full setup, checklists, and iOS notes:

**→ [`client/README.md`](client/README.md)**

Fastest web run (no Python backend):

```bash
cd client
npm install                 # installs deps + copies Stockfish 19 lite-single → static/js
cd static
python3 -m http.server 5173
```

Open http://localhost:5173 — enter a Chess.com username, analyse with WebAssembly Stockfish 19.

---

## Repo map

```text
client/          Analyzer UI, Stockfish WASM, Capacitor iOS
server/          Voice bot + optional API (not needed for Analyzer daily work)
projects/        Product specs / OpenSpec notes
```

Architecture notes for contributors: [`CLAUDE.md`](CLAUDE.md).

---

## Voice (later)

When Analyzer is in good shape, develop Voice from `server/`:

```bash
cd server
pip install -r requirements.txt
python3 app.py   # port 5174; loads env from server/.env
```

Requires Twilio (and related) secrets — never commit `.env`. Prefer keeping Voice deploys and secrets off any Analyzer static / App Store pipeline.

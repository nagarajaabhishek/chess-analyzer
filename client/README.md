# ChessNow Analyzer

Local-first chess game analysis. Load Chess.com games, run **Stockfish 19** in the browser, and review accuracy / move classifications — **no account, no paywall, no Voice server required**.

Product name: **ChessNow**. Bundle ID `com.abhisheknagaraja.chesslens` is permanent (do not change).

This folder (`client/`) is the Analyzer product. The phone Voice bot lives in `../server/` and is **out of scope** for day-to-day Analyzer work.

---

## What works without the server

| Feature | Backend needed? |
|---------|-----------------|
| Chess.com game list | No — browser calls Chess.com’s public API (paginated archives + retry) |
| Full-game analysis (Quick / Normal / Deep) | No — Stockfish 19 **lite single-threaded** WASM |
| Win%-based accuracy + Brilliant / Great / Miss | No — `static/js/review-math.js` |
| Live eval / multi-PV on the board | No — same WASM worker |
| iOS Capacitor wrapper | No — ships `static/` as the web assets |
| Phone auth, voice call UI, challenge SMS, saved cloud games | Yes — `../server/` (ignore while building Analyzer) |

If Flask is not running, the app sets `useLocalWasm = true` and stays fully usable for analysis.

---

## Quick start (web)

```bash
cd client
npm install          # also runs copy-engine (Stockfish → static/js)
cd static
python3 -m http.server 5173
```

Open **http://localhost:5173**

### Checklist — first run

- [ ] `static/js/stockfish.js` + `stockfish.wasm` present (~1.8MB wasm = SF19 lite-single)
- [ ] Badge shows **Stockfish 19 ready (Local WebAssembly)**
- [ ] Username prefills from the last lookup stored in this browser (`localStorage`)
- [ ] Enter a Chess.com username → games list appears (more than 2 months of history if needed)
- [ ] Or paste / upload a PGN under Local Game Analyzer
- [ ] Open a game → analysis progress runs in-browser (Cancel works)
- [ ] Review summary opens first; jump chips + eval chart scrub moves
- [ ] Keyboard: ←/→ (or ↓/↑) step moves; Home / End jump ends

---

## Stockfish engine (copy step)

We ship **Stockfish.js 19 lite single-threaded** (no COOP/COEP headers; iOS-friendly).

```bash
cd client
npm install                 # postinstall → copy-engine
npm run copy-engine         # re-copy after cleaning static/js
```

`scripts/copy-engine.sh` copies:

| From `node_modules/stockfish/bin/` | To `static/js/` |
|------------------------------------|-----------------|
| `stockfish-19-lite-single.js` | `stockfish.js` |
| `stockfish-19-lite-single.wasm` | `stockfish.wasm` |

`app.js` loads `Worker("/js/stockfish.js")`. Do **not** wrap the engine in another worker file.

Analysis results are cached under `localStorage` keys prefixed `review_v3_` (bumped when engine/math change).

---

## Review math

`static/js/review-math.js` (loaded before `app.js`):

- Centipawns → win% (Lichess sigmoid)
- Move accuracy from win% drop (Lichess curve)
- Game accuracy = mean of move accuracies
- Labels: Brilliant / Great / Best / Excellent / Good / Inaccuracy / Mistake / Miss / Blunder  
  (Brilliant = best + material sacrifice; Great = only-move MultiPV gap; Miss = failed to punish blunder)

---

## Project layout

```text
client/
├── scripts/copy-engine.sh  # npm run copy-engine
├── static/                 # The web app (no bundler)
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   ├── js/
│   │   ├── review-math.js
│   │   ├── stockfish.js    # SF19 lite-single (generated)
│   │   └── stockfish.wasm
│   ├── pieces/
│   └── pages/
├── ios/                    # Capacitor iOS project
├── capacitor.config.json   # webDir = "static"
└── package.json
```

Stack: vanilla HTML/JS/CSS. **Do not add a SPA framework or bundler** unless there is a hard product reason.

---

## Board strategy (current vs later)

| Now | Later |
|-----|--------|
| **chessboard.js** + custom SVG arrows for review / engine lines | **Chessground** when we want first-class shapes, freer exploration, better mobile DnD |
| Keep shipping without a build step | Chessground is GPL (same family as Stockfish) — acceptable once we migrate deliberately |

Do **not** start a Chessground rewrite until Analyzer packaging (web + iOS) is stable.

Deferred on purpose: `chessops`, TypeScript, bundlers.

---

## Analysis modes (WASM)

| Mode   | Per-move time budget |
|--------|----------------------|
| Quick  | ~50 ms               |
| Normal | ~120 ms              |
| Deep   | ~300 ms              |

MultiPV=2 during review enables Great / only-move detection.

---

## iOS (Capacitor)

Always run Capacitor commands **from `client/`**:

```bash
cd client
npm install
npm run copy-engine
npx cap sync ios
npx cap open ios
```

- `webDir` is `static`
- After HTML/JS/CSS or engine copy: `npx cap sync ios` before Xcode build
- Bundle ID must stay `com.abhisheknagaraja.chesslens`

---

## Optional: Flask as static + API host

Not required for Analyzer development.

```bash
cd ../server
pip install -r requirements.txt
python3 app.py   # port 5174; may serve ../client/static
```

Server-side analysis uses the same win%-based accuracy bands when native Stockfish is available.

---

## Non-goals (Analyzer phase)

- Twilio webhooks, OTP, call streaming
- Elo, challenges, SMS recap
- Admin metrics / keep-alive cron
- Full SF multi-thread (~94MB) / COOP-COEP static hosting

---

## Deploy sketch (Analyzer only)

- Host `client/static/` on Netlify / Cloudflare Pages / GitHub Pages / S3+CDN
- Serve `stockfish.wasm` as `application/wasm`
- No Python, Docker, or secrets on the Analyzer host

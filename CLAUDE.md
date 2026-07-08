# Chess Analyzer

Flask app for chess game analysis with Stockfish, plus voice-call analysis via Twilio and an iOS wrapper via Capacitor.

## Stack
- **Backend:** [app.py](app.py) — single Flask app (routes, WebSocket via flask-sock, Twilio voice, Whisper transcription). Models in [models.py](models.py) (SQLAlchemy; SQLite in `instance/`, psycopg2 available for Postgres).
- **Frontend:** vanilla JS, no build step — [static/index.html](static/index.html), [static/app.js](static/app.js), [static/style.css](static/style.css). Client-side Stockfish WASM worker lives under `static/js/`.
- **Analysis:** python-chess + Stockfish; results cached in `analysis_cache.json`.
- **iOS:** Capacitor project in `ios/` (config: [capacitor.config.json](capacitor.config.json)); sync with `npx cap sync ios`.

## Run
- Dev server: `python3 app.py` — port **5174** (preview config: `.claude/launch.json`, name `chess-analyzer`)
- Env vars load from `.env` (python-dotenv). Never commit `.env`.
- Deps: `pip install -r requirements.txt`

## Conventions
- Frontend is intentionally framework-free; don't introduce npm build tooling for UI changes.
- Mobile/iOS quirks matter: WASM worker setup and piece rendering have had iOS-specific fixes — test mobile viewport when touching the board or worker code.
- A repo split is under consideration — see [repository_split_analysis.md](repository_split_analysis.md) before large structural moves; known bugs tracked in [BUGFIX_PLAN.md](BUGFIX_PLAN.md).

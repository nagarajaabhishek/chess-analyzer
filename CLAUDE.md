# Chess Analyzer — Decoupled Architecture

> **Official product name: ChessNow.** All user-facing copy (web, voice prompts, SMS, App Store) says **ChessNow**. "ChessLens" and "Voice Chessbot" are retired codenames — do not reintroduce them. Exception: the iOS bundle ID `com.abhisheknagaraja.chesslens` is permanent and must never change.

Decoupled codebase containing:
1. **`client/`**: The client-side, local-first web/mobile chess analyzer (**ChessNow Analyzer**) and iOS Capacitor wrapper.
2. **`server/`**: The cloud-dependent telephony/voice bot platform (**ChessNow Voice**).

---

## 📂 Codebase Structure

### 💻 Frontend Client (`client/`)
* **Stack**: Vanilla HTML/JS, framework-free (no npm build steps).
* **Assets**: [client/static/index.html](file:///Users/abhisheknagaraja/Documents/chess-analyzer/client/static/index.html), [client/static/app.js](file:///Users/abhisheknagaraja/Documents/chess-analyzer/client/static/app.js), [client/static/style.css](file:///Users/abhisheknagaraja/Documents/chess-analyzer/client/static/style.css).
* **Stockfish**: Client-side Stockfish WASM worker lives in `client/static/js/`.
* **Capacitor Mobile Config**: [client/capacitor.config.json](file:///Users/abhisheknagaraja/Documents/chess-analyzer/client/capacitor.config.json).
* **Capacitor Commands**: All Capacitor CLI commands (e.g. `npx cap sync ios`) must be executed from **within the `client/` directory**.

### 📞 Telephony Server (`server/`)
* **Stack**: Python Flask API server + SQL database.
* **Core files**: [server/app.py](file:///Users/abhisheknagaraja/Documents/chess-analyzer/server/app.py) (telephony voice webhooks, WebSockets, REST APIs), [server/models.py](file:///Users/abhisheknagaraja/Documents/chess-analyzer/server/models.py) (SQLAlchemy schemas).
* **Database**: Local SQLite database resides in `server/instance/database.db` during development.
* **Stockfish**: Uses a compiled native Stockfish binary on the host server for phone game engines.

---

## 🚀 Running & Developing Locally

### Start the Python API Server
Run the Flask server from within the `server/` directory:
```bash
cd server
pip install -r requirements.txt
python3 app.py
```
* **Port**: Runs on port **5174**.
* **Development Static Route**: The Flask server dynamically falls back to serving static files from `../client/static` during local testing.
* **Environment variables**: Loaded from `server/.env`. Never commit this file.

### Mobile App Build & Sync
Run from within the `client/` directory:
```bash
cd client
npm install
npx cap sync ios
```

---

## 🎨 Design Conventions
* **Framework-free**: The frontend UI is intentionally vanilla JS; do not introduce complex build tooling for layout tweaks.
* **CORS Middleware**: Any new REST API route on the server must support CORS preflight and allowed origins to communicate with separate frontend client hosts in production.
* **Mobile / WASM**: Test layout changes on mobile viewports as WebAssembly worker initializations have strict path rules on iOS.

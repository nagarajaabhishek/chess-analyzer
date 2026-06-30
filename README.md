# ChessLens — Free Local Chess Analyzer

Analyse your Chess.com games locally with Stockfish. No paywall, no ads, no cloud.

---

## Setup (one time)

### 1. Install Stockfish
```bash
brew install stockfish
```

### 2. Install Python dependencies
```bash
cd chess-analyzer
pip install -r requirements.txt
```

---

## Run

```bash
python app.py
```

Then open **http://localhost:5000** in your browser.

---

## How it works

1. Enter your Chess.com username
2. Your recent games load via Chess.com's **free public API** (no account needed)
3. Click any game to analyse it
4. Stockfish runs **locally on your machine** — nothing is sent anywhere
5. See move-by-move analysis with accuracy %, eval bar, and win probability chart

## Analysis modes

| Mode   | Speed (40-move game) | Quality      |
|--------|----------------------|--------------|
| Quick  | ~3 sec               | Good         |
| Normal | ~10 sec              | Very good    |
| Deep   | ~30 sec              | Excellent    |

## Move classifications

| Symbol | Name       | Centipawn loss |
|--------|------------|----------------|
| ●  | Best       | 0–5            |
| ●  | Excellent  | 6–20           |
| ●  | Good       | 21–50          |
| ⚠  | Inaccuracy | 51–100         |
| ?  | Mistake    | 101–200        |
| ?? | Blunder    | > 200          |

## Keyboard shortcuts

| Key         | Action     |
|-------------|------------|
| ← / ↓      | Previous move |
| → / ↑      | Next move  |
| Home        | Go to start |
| End         | Go to last move |

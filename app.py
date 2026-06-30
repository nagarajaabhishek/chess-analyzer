import os
import io
import json
import math
import uuid
import subprocess
import threading
import requests
import chess
import chess.pgn
import chess.engine
from flask import Flask, render_template, request, jsonify, send_from_directory
from datetime import datetime

app = Flask(__name__, static_url_path="", static_folder="static")
tasks = {}  # In-memory task store

CACHE_FILE = "analysis_cache.json"
analysis_cache = {}

def load_cache():
    global analysis_cache
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, "r") as f:
                analysis_cache = json.load(f)
            print(f"♟  Loaded {len(analysis_cache)} cached game reviews.")
        except Exception as e:
            print(f"⚠️ Failed to load analysis cache: {e}")

def save_cache():
    try:
        with open(CACHE_FILE, "w") as f:
            json.dump(analysis_cache, f)
    except Exception as e:
        print(f"⚠️ Failed to save analysis cache: {e}")


# ──────────────────────────────────────────────
# Stockfish helpers
# ──────────────────────────────────────────────

def find_stockfish():
    """Locate the Stockfish binary on common paths."""
    paths = [
        "/opt/homebrew/bin/stockfish",   # Apple Silicon Mac
        "/usr/local/bin/stockfish",       # Intel Mac (Homebrew)
        "/usr/bin/stockfish",             # Linux
        "/usr/games/stockfish",           # Linux (games)
    ]
    for path in paths:
        if os.path.exists(path):
            return path
    try:
        result = subprocess.run(["which", "stockfish"], capture_output=True, text=True)
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    except Exception:
        pass
    return None


def get_cp(score, mate_score=10000):
    """Convert a chess.engine Score to centipawns (relative to side to move)."""
    if score.is_mate():
        m = score.mate()
        return (mate_score - abs(m) * 10) * (1 if m > 0 else -1)
    cp = score.score()
    return cp if cp is not None else 0


def win_prob(cp_white):
    """Map centipawns (white perspective) → win probability 0-100."""
    cp_white = max(-1500, min(1500, cp_white))
    return round(50 + 50 * (2 / (1 + math.exp(-0.00368208 * cp_white)) - 1), 1)


def classify(cpl, is_best):
    """Return move classification string from centipawn loss."""
    if is_best or cpl <= 5:
        return "best"
    elif cpl <= 20:
        return "excellent"
    elif cpl <= 50:
        return "good"
    elif cpl <= 100:
        return "inaccuracy"
    elif cpl <= 200:
        return "mistake"
    else:
        return "blunder"


def accuracy(cpls):
    """Accuracy % from centipawn losses. 0 CPL → 100%, ~100 CPL → 78%, ~200 CPL → 61%."""
    if not cpls:
        return 100.0
    avg = sum(cpls) / len(cpls)
    acc = 100.0 * math.exp(-avg / 400.0)
    return round(max(0.0, min(100.0, acc)), 1)


def eval_str(score_pov_white):
    """Human-readable eval string from White's PovScore."""
    if score_pov_white.is_mate():
        m = score_pov_white.mate()
        return f"M{m}" if m > 0 else f"-M{abs(m)}"
    cp = score_pov_white.score()
    return f"{cp / 100:+.1f}" if cp is not None else "0.0"


# ──────────────────────────────────────────────
# Background analysis worker
# ──────────────────────────────────────────────

def run_analysis(task_id, pgn_text, username, time_per_move, cache_key=None):
    task = tasks[task_id]
    try:
        sf_path = find_stockfish()
        if not sf_path:
            task.update(status="error", error="Stockfish not found. Install: brew install stockfish")
            return

        game = chess.pgn.read_game(io.StringIO(pgn_text))
        if not game:
            task.update(status="error", error="Invalid PGN format.")
            return

        h = game.headers
        white_player = h.get("White", "White")
        black_player = h.get("Black", "Black")
        opening = h.get("Opening", h.get("ECO", "Unknown Opening"))

        total = sum(1 for _ in game.mainline_moves())
        task["total"] = total

        moves_data = []
        white_cpls, black_cpls = [], []
        board = game.board()
        node = game
        idx = 0

        with chess.engine.SimpleEngine.popen_uci(sf_path) as engine:
            engine.configure({"Threads": 2, "Hash": 128})
            limit = chess.engine.Limit(time=time_per_move)

            # Analyse starting position
            info = engine.analyse(board, limit, multipv=1)

            while node.variations:
                next_node = node.variation(0)
                move = next_node.move
                white_to_move = board.turn == chess.WHITE

                # ── BEFORE the move ──────────────────────────
                best_move = info[0]["pv"][0] if info[0].get("pv") else move
                score_before_rel = get_cp(info[0]["score"].relative)

                # ── Make the move ────────────────────────────
                san = board.san(move)
                board.push(move)

                # ── AFTER the move ───────────────────────────
                info = engine.analyse(board, limit, multipv=1)
                score_after_rel = get_cp(info[0]["score"].relative)
                score_white_pov = info[0]["score"].white()
                eval_white_cp = get_cp(score_white_pov)

                # CPL (from the mover's perspective)
                eval_after_mover = -score_after_rel   # negate: opponent now to move
                cpl = max(0, score_before_rel - eval_after_mover)
                cpl = min(cpl, 1000)

                is_best = move == best_move
                cls = classify(cpl, is_best)
                wp = win_prob(eval_white_cp)

                if white_to_move:
                    white_cpls.append(min(cpl, 300))   # cap per-move CPL at 300
                else:
                    black_cpls.append(min(cpl, 300))

                idx += 1
                task["progress"] = int(idx / total * 100)

                moves_data.append({
                    "idx":         idx,
                    "move_num":    (idx + 1) // 2,
                    "san":         san,
                    "uci":         move.uci(),
                    "color":       "white" if white_to_move else "black",
                    "fen":         board.fen(),
                    "eval_cp":     eval_white_cp,
                    "eval_str":    eval_str(score_white_pov),
                    "cpl":         round(cpl),
                    "cls":         cls,
                    "win_prob":    wp,
                    "is_best":     is_best,
                    "best_uci":    best_move.uci() if not is_best else None,
                    "variations":  [],
                })
                node = next_node

        def counts(color):
            c = {k: 0 for k in ["best", "excellent", "good", "inaccuracy", "mistake", "blunder"]}
            for m in moves_data:
                if m["color"] == color and m["cls"] in c:
                    c[m["cls"]] += 1
            return c

        task["result"] = {
            "white_player":   white_player,
            "black_player":   black_player,
            "opening":        opening,
            "white_accuracy": accuracy(white_cpls),
            "black_accuracy": accuracy(black_cpls),
            "white_counts":   counts("white"),
            "black_counts":   counts("black"),
            "moves":          moves_data,
            "start_fen":      game.board().fen(),
        }
        
        # Save to local JSON cache database
        if cache_key:
            analysis_cache[cache_key] = task["result"]
            save_cache()

        task["status"] = "done"
        task["progress"] = 100

    except Exception as exc:
        import traceback
        task.update(status="error", error=f"{exc}\n{traceback.format_exc()}")


# ──────────────────────────────────────────────
# Routes
# ──────────────────────────────────────────────

@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/api/check")
def check():
    path = find_stockfish()
    return jsonify({"ok": path is not None, "path": path})


@app.route("/api/games/<username>")
def get_games(username):
    try:
        count = min(max(int(request.args.get("count", 20)), 5), 100)
        hdrs = {"User-Agent": "LocalChessAnalyzer/1.0 (personal use)"}

        resp = requests.get(
            f"https://api.chess.com/pub/player/{username.lower()}/games/archives",
            headers=hdrs, timeout=10
        )
        if resp.status_code == 404:
            return jsonify({"error": f'User "{username}" not found on Chess.com'}), 404
        resp.raise_for_status()

        archives = resp.json().get("archives", [])
        if not archives:
            return jsonify({"error": "No games found for this user"}), 404

        # Fetch enough months to cover requested count
        months_needed = min(max(math.ceil(count / 12), 2), len(archives))
        all_games = []
        for url in archives[-months_needed:]:
            r = requests.get(url, headers=hdrs, timeout=10)
            if r.ok:
                all_games.extend(r.json().get("games", []))

        result_map = {
            "win": "Win", "checkmated": "Loss", "resigned": "Loss",
            "timeout": "Loss", "abandoned": "Loss",
            "agreed": "Draw", "repetition": "Draw", "stalemate": "Draw",
            "insufficient": "Draw", "timevsinsufficient": "Draw", "50move": "Draw",
        }

        formatted = []
        for g in reversed(all_games[-count:]):
            white = g.get("white", {})
            black = g.get("black", {})
            is_white = white.get("username", "").lower() == username.lower()
            player = white if is_white else black
            opponent = black if is_white else white
            result = result_map.get(player.get("result", ""), "?")

            end_ts = g.get("end_time", 0)
            date = datetime.fromtimestamp(end_ts).strftime("%b %d") if end_ts else ""

            pgn_text = g.get("pgn", "")
            opening = "Unknown Opening"
            for line in pgn_text.splitlines():
                if "[ECOUrl" in line and '"' in line:
                    opening = line.split('"')[1].split("/")[-1].replace("-", " ").title()[:55]
                    break
                if "[Opening" in line and '"' in line:
                    opening = line.split('"')[1][:55]
                    break

            formatted.append({
                "white":          white.get("username", ""),
                "black":          black.get("username", ""),
                "white_rating":   white.get("rating", "?"),
                "black_rating":   black.get("rating", "?"),
                "opponent":       opponent.get("username", "?"),
                "opponent_rating": opponent.get("rating", "?"),
                "player_color":   "White" if is_white else "Black",
                "result":         result,
                "date":           date,
                "opening":        opening,
                "time_class":     g.get("time_class", "rapid"),
                "time_control":   g.get("time_control", ""),
                "pgn":            pgn_text,
                "url":            g.get("url", ""),
            })

        return jsonify({"games": formatted, "username": username, "count": len(formatted)})

    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/api/analyze", methods=["POST"])
def analyze():
    data = request.json or {}
    pgn_text = data.get("pgn", "")
    username = data.get("username", "")
    mode = data.get("mode", "normal")   # "quick" | "normal" | "deep"
    url = data.get("url", "")

    if not pgn_text:
        return jsonify({"error": "No PGN provided"}), 400

    # Check local JSON cache first
    cache_key = f"{url}_{mode}" if url else None
    if cache_key and cache_key in analysis_cache:
        task_id = str(uuid.uuid4())
        # Return a task that is already marked as done
        tasks[task_id] = {
            "status": "done",
            "progress": 100,
            "total": 0,
            "result": analysis_cache[cache_key],
            "error": None
        }
        return jsonify({"task_id": task_id})

    time_map = {"quick": 0.05, "normal": 0.15, "deep": 0.4}
    tpm = time_map.get(mode, 0.15)

    task_id = str(uuid.uuid4())
    tasks[task_id] = {"status": "running", "progress": 0, "total": 0, "result": None, "error": None}

    threading.Thread(
        target=run_analysis,
        args=(task_id, pgn_text, username, tpm, cache_key),
        daemon=True
    ).start()
    return jsonify({"task_id": task_id})


@app.route("/api/status/<task_id>")
def status(task_id):
    task = tasks.get(task_id)
    if not task:
        return jsonify({"error": "Task not found"}), 404

    resp = {"status": task["status"], "progress": task["progress"], "total": task["total"]}
    if task["status"] == "done":
        resp["result"] = task["result"]
        tasks.pop(task_id, None)
    elif task["status"] == "error":
        resp["error"] = task["error"]
        tasks.pop(task_id, None)

    return jsonify(resp)


@app.route("/api/live_eval", methods=["POST"])
def live_eval():
    try:
        data = request.json or {}
        fen = data.get("fen")
        if not fen:
            return jsonify({"error": "No FEN provided"}), 400

        # Auto-locate stockfish path
        sf_path = find_stockfish()
        if not sf_path:
            return jsonify({"error": "Stockfish not found"}), 404

        board = chess.Board(fen)
        
        # Start a quick local engine instance
        with chess.engine.SimpleEngine.popen_uci(sf_path) as local_engine:
            result = local_engine.analyse(
                board,
                chess.engine.Limit(depth=12, time=0.15),
                multipv=3
            )
            
        lines = []
        for info in result:
            pv = info.get("pv", [])
            if not pv:
                continue
            best_move = pv[0]
            san = board.san(best_move)
            score = info.get("score")
            
            # POV score relative to side to move
            score_pov = score.relative
            if score_pov.is_mate():
                score_str = f"#M{abs(score_pov.mate())}"
                cp = 10000 if score_pov.mate() > 0 else -10000
            else:
                cp = score_pov.score()
                score_val = (cp / 100.0) if cp is not None else 0.0
                score_str = f"+{score_val:.2f}" if score_val > 0 else f"{score_val:.2f}"

            lines.append({
                "uci": best_move.uci(),
                "san": san,
                "score": score_str,
                "cp": cp or 0
            })
            
        return jsonify({"lines": lines})

    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


if __name__ == "__main__":
    print("\n♟  Chess Analyzer — Local Edition")
    print("─" * 42)
    load_cache()  # Load cached game reviews from disk
    sf = find_stockfish()
    if sf:
        print(f"✅  Stockfish: {sf}")
    else:
        print("⚠️   Stockfish not found — install with: brew install stockfish")
    print("\n🌐  http://localhost:5174")
    print("─" * 42 + "\n")
    app.run(debug=False, port=5174, threaded=True)

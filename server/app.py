import os
import io
import secrets
import json
import math
import uuid
import re
import subprocess
import threading
import requests
import hmac
import hashlib
import time
from functools import wraps
from collections import OrderedDict
from xml.sax.saxutils import escape as _xml_escape
import chess
import chess.pgn
import chess.engine
import random
import urllib.parse
from flask import Flask, render_template, request, jsonify, send_from_directory
from flask_sock import Sock
from datetime import datetime, timedelta, timezone
from sqlalchemy import or_, and_, select, func
from dotenv import load_dotenv
import base64
from pydub import AudioSegment
import audioop
import wave
from twilio.request_validator import RequestValidator

load_dotenv()


app = Flask(__name__, static_url_path="", static_folder="../client/static")
sock = Sock(app)
tasks = {}  # In-memory task store

# ── Database Configuration ──
from models import db, User, Game, CallLog, EventLog

raw_db_url = os.environ.get("DATABASE_URL", "").strip()
if raw_db_url:
    if raw_db_url.startswith("postgres://"):
        raw_db_url = raw_db_url.replace("postgres://", "postgresql://", 1)
    app.config["SQLALCHEMY_DATABASE_URI"] = raw_db_url
    print("🌐  Connected to Online PostgreSQL Database.")
else:
    app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///database.db"
    print("💾  Connected to Local SQLite Database.")

app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
db.init_app(app)

with app.app_context():
    db.create_all()

    # Additive migration for database.db files created before the live-voice-game
    # columns existed on Game — never drops or rewrites existing data.
    _inspector = db.inspect(db.engine)
    if "games" in _inspector.get_table_names():
        _existing_cols = {c["name"] for c in _inspector.get_columns("games")}
        _migrations = {
            "source":      "ALTER TABLE games ADD COLUMN source VARCHAR(20) DEFAULT 'analyzed'",
            "white_phone": "ALTER TABLE games ADD COLUMN white_phone VARCHAR(30)",
            "black_phone": "ALTER TABLE games ADD COLUMN black_phone VARCHAR(30)",
            "bot_elo":     "ALTER TABLE games ADD COLUMN bot_elo INTEGER",
            "commentary_style": "ALTER TABLE games ADD COLUMN commentary_style VARCHAR(30) DEFAULT 'formal'",
            "draw_offered_by": "ALTER TABLE games ADD COLUMN draw_offered_by VARCHAR(30)",
            "pending_promotion_uci": "ALTER TABLE games ADD COLUMN pending_promotion_uci VARCHAR(5)",
            "pending_ambiguous_moves": "ALTER TABLE games ADD COLUMN pending_ambiguous_moves TEXT",
            "pending_confirmation_uci": "ALTER TABLE games ADD COLUMN pending_confirmation_uci VARCHAR(5)",
            "player_color": "ALTER TABLE games ADD COLUMN player_color VARCHAR(5)",
            "last_activity_at": "ALTER TABLE games ADD COLUMN last_activity_at DATETIME",
            "white_acknowledged": "ALTER TABLE games ADD COLUMN white_acknowledged BOOLEAN DEFAULT FALSE",
            "black_acknowledged": "ALTER TABLE games ADD COLUMN black_acknowledged BOOLEAN DEFAULT FALSE",
        }
        for _col, _stmt in _migrations.items():
            if _col not in _existing_cols:
                db.session.execute(db.text(_stmt))
        # Backfill so pre-existing in-progress games don't look infinitely idle on first boot.
        db.session.execute(db.text(
            "UPDATE games SET last_activity_at = created_at WHERE last_activity_at IS NULL"
        ))
        db.session.commit()

    if "users" in _inspector.get_table_names():
        _existing_cols = {c["name"] for c in _inspector.get_columns("users")}
        if "elo" not in _existing_cols:
            db.session.execute(db.text("ALTER TABLE users ADD COLUMN elo INTEGER DEFAULT 1000"))

    if "call_logs" in _inspector.get_table_names():
        _existing_cols = {c["name"] for c in _inspector.get_columns("call_logs")}
        _calllog_migrations = {
            "call_type":       "ALTER TABLE call_logs ADD COLUMN call_type VARCHAR(30)",
            "first_call":      "ALTER TABLE call_logs ADD COLUMN first_call BOOLEAN DEFAULT FALSE",
            "moves_played":    "ALTER TABLE call_logs ADD COLUMN moves_played INTEGER DEFAULT 0",
            "speech_retries":  "ALTER TABLE call_logs ADD COLUMN speech_retries INTEGER DEFAULT 0",
            "confirm_prompts": "ALTER TABLE call_logs ADD COLUMN confirm_prompts INTEGER DEFAULT 0",
            "first_move_at":   "ALTER TABLE call_logs ADD COLUMN first_move_at TIMESTAMP",
        }
        for _col, _stmt in _calllog_migrations.items():
            if _col not in _existing_cols:
                db.session.execute(db.text(_stmt))
        db.session.commit()

@app.before_request
def handle_options_preflight():
    if request.method == "OPTIONS":
        return app.make_default_options_response()


@app.after_request
def add_cors_headers(response):
    origin = request.headers.get("Origin")
    if origin:
        allowed_origins = [
            "https://chessnow.app",
            "https://www.chessnow.app",
            "http://localhost:5173",
            "http://localhost:5174",
            "http://127.0.0.1:5173",
            "http://127.0.0.1:5174"
        ]
        if origin in allowed_origins or origin.endswith(".chessnow.app"):
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Access-Control-Allow-Headers"] = "Content-Type,Authorization"
            response.headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS,PUT,DELETE"
            response.headers["Access-Control-Allow-Credentials"] = "true"
    return response


# ── Twilio credentials (loaded from .env) ──
# All Twilio REST calls and webhook-signature verification authenticate with the
# account-level Account SID + Auth Token pair. (An API Key SID/Secret pair would also
# work for REST calls, but not for RequestValidator, so we standardize on the Auth Token.)
TWILIO_ACCOUNT_SID  = os.environ.get("TWILIO_ACCOUNT_SID", "")
TWILIO_AUTH_TOKEN   = os.environ.get("TWILIO_AUTH_TOKEN", "")
TWILIO_PHONE_NUMBER = os.environ.get("TWILIO_PHONE_NUMBER", "")

# Bearer token for the read-only retention-metrics endpoint (/api/admin/metrics).
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")
CHESS_VOCABULARY_HINTS = (
    "pawn, knight, bishop, rook, queen, king, castle, takes, check, checkmate, "
    "alpha, bravo, charlie, delta, echo, foxtrot, golf, hotel, "
    "a1, a2, a3, a4, a5, a6, a7, a8, b1, b2, b3, b4, b5, b6, b7, b8, "
    "c1, c2, c3, c4, c5, c6, c7, c8, d1, d2, d3, d4, d5, d6, d7, d8, "
    "e1, e2, e3, e4, e5, e6, e7, e8, f1, f2, f3, f4, f5, f6, f7, f8, "
    "g1, g2, g3, g4, g5, g6, g7, g8, h1, h2, h3, h4, h5, h6, h7, h8, "
    "resign, draw, takeback, undo, repeat, position, last move, whose turn, status, help"
)
GEMINI_API_KEY      = os.environ.get("GEMINI_API_KEY", "")

# Public base URL for game review links (override via BASE_URL env var)
BASE_URL = os.environ.get("BASE_URL", "https://chessnow.app")
# Inbound local-number voice rate used for cost-per-game estimates (USD/min).
TWILIO_VOICE_COST_PER_MIN = float(os.environ.get("TWILIO_VOICE_COST_PER_MIN", "0.0085"))

if not TWILIO_AUTH_TOKEN:
    print("⚠️  TWILIO_AUTH_TOKEN not set — incoming Twilio webhook requests will NOT be "
          "signature-verified. Anyone who finds these URLs can forge calls/moves. "
          "Set TWILIO_AUTH_TOKEN (Account SID's Auth Token from the Twilio console) to enable verification.")

CACHE_FILE = "analysis_cache.json"
analysis_cache = {}
cache_lock = threading.Lock()

def load_cache():
    global analysis_cache
    if os.path.exists(CACHE_FILE):
        try:
            with cache_lock:
                with open(CACHE_FILE, "r") as f:
                    analysis_cache = json.load(f)
            print(f"♟  Loaded {len(analysis_cache)} cached game reviews.")
        except Exception as e:
            print(f"⚠️ Failed to load analysis cache: {e}")

def save_cache():
    try:
        temp_file = CACHE_FILE + ".tmp"
        with cache_lock:
            with open(temp_file, "w") as f:
                json.dump(analysis_cache, f)
            os.replace(temp_file, CACHE_FILE)
    except Exception as e:
        print(f"⚠️ Failed to save analysis cache: {e}")

load_cache()  # Load cached game reviews from disk at module level


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

def run_analysis(task_id, pgn_text, username, time_per_move, cache_key=None, phone=None, game_id=None):
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

                # Parse remaining clock time from comments
                comment = next_node.comment
                clk_match = re.search(r'\[%clk\s+([0-9:]+(?:\.[0-9]+)?)\]', comment)
                clk = clk_match.group(1) if clk_match else None

                # ── BEFORE the move ──────────────────────────
                # Stockfish occasionally returns no principal variation (e.g. near mate);
                # falling back to the played move must NOT be treated as a verified match —
                # otherwise a real blunder can get silently classified as "Best".
                pv_moves = info[0].get("pv")
                has_pv = bool(pv_moves)
                best_move = pv_moves[0] if has_pv else move
                best_san = board.san(best_move)
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

                is_best = has_pv and move == best_move
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
                    "best_uci":    best_move.uci() if (has_pv and not is_best) else None,
                    "best_san":    best_san if (has_pv and not is_best) else None,
                    "clk":         clk,
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
            "result":         game.headers.get("Result", "*"),
        }
        
        # Save to local JSON cache database
        if cache_key:
            with cache_lock:
                analysis_cache[cache_key] = task["result"]
            save_cache()

        # Save to SQLite Database if phone is provided and it's a new game (no game_id)
        if phone and not game_id:
            with app.app_context():
                try:
                    user_clean = "".join(filter(str.isdigit, phone))
                    user = db.session.get(User, user_clean)
                    if user:
                        db_game = Game(
                            id=str(uuid.uuid4()),
                            user_phone=user_clean,
                            white_player=white_player,
                            black_player=black_player,
                            pgn=pgn_text,
                            white_accuracy=accuracy(white_cpls),
                            black_accuracy=accuracy(black_cpls),
                            opening=opening,
                            result=game.headers.get("Result", "*")
                        )
                        db.session.add(db_game)
                        db.session.commit()
                except Exception as db_exc:
                    print(f"Error saving analyzed game to DB: {db_exc}")

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
    return send_from_directory(app.static_folder, "index.html")


@app.route("/signup")
def signup():
    # No separate signup flow exists — the phone-auth overlay on the homepage already
    # creates the account on submit, so this just points the post-game SMS link somewhere real.
    return send_from_directory(app.static_folder, "index.html")


@app.route("/robots.txt")
def robots_txt():
    return send_from_directory(app.static_folder, "robots.txt")


@app.route("/sitemap.xml")
def sitemap_xml():
    return send_from_directory(app.static_folder, "sitemap.xml")


@app.route("/faq")
@app.route("/accessibility")
@app.route("/guides/blindfold-chess")
@app.route("/guides/voice-commands")
def content_pages():
    path_map = {
        "/faq": "faq.html",
        "/accessibility": "accessibility.html",
        "/guides/blindfold-chess": "blindfold-chess.html",
        "/guides/voice-commands": "voice-commands.html"
    }
    filename = path_map.get(request.path)
    if filename:
        return send_from_directory(os.path.join(app.static_folder, "pages"), filename)
    return jsonify({"error": "Page not found"}), 404


@app.route("/api/game/<game_id>")
def get_game_by_id(game_id):
    """Fetch a single game by id — backs the shareable '?game=' review link sent post-game."""
    g = db.session.get(Game, game_id)
    if not g:
        return jsonify({"error": "Game not found"}), 404
    return jsonify({
        "id": g.id,
        "white_player": g.white_player,
        "black_player": g.black_player,
        "pgn": g.pgn,
        "result": g.result,
        "opening": g.opening,
        "white_accuracy": g.white_accuracy,
        "black_accuracy": g.black_accuracy,
        "created_at": g.created_at.isoformat(),
    })


@app.route("/api/check")
def check():
    path = find_stockfish()
    return jsonify({"ok": path is not None, "path": path})


@app.route("/api/config")
def get_config():
    return jsonify({
        "phone_number": TWILIO_PHONE_NUMBER
    })


LIVE_FEED_LIMIT = 12


def _public_player_name(name):
    """Anonymize human players in the public feed. Bot names ("Thara (1240)")
    stay; anything else — "You", "Player 1234" (trailing phone digits) — must
    never leak to unauthenticated viewers."""
    if name and name.startswith("Thara"):
        return name
    return "Anonymous"


@app.route("/api/games/live")
def get_live_games():
    try:
        stmt = (
            db.select(Game)
            .where(Game.result == '*')
            .order_by(Game.last_activity_at.desc())
            .limit(LIVE_FEED_LIMIT)
        )
        games = db.session.execute(stmt).scalars().all()
        live_games = []
        for g in games:
            live_games.append({
                "id": g.id,
                "white_player": _public_player_name(g.white_player),
                "black_player": _public_player_name(g.black_player),
                "source": g.source,
                "created_at": g.created_at.isoformat() if g.created_at else None,
                "last_activity_at": g.last_activity_at.isoformat() if g.last_activity_at else None,
            })
        return jsonify({"games": live_games})
    except Exception as e:
        return jsonify({"error": str(e)}), 500




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
    phone = data.get("phone", "")
    token = data.get("token", "")
    game_id = data.get("game_id", None)

    if not pgn_text:
        return jsonify({"error": "No PGN provided"}), 400

    # Clean phone — only attribute/save this analysis to an account if the caller
    # actually proved ownership of it via a valid session token. Otherwise treat
    # the request as anonymous rather than letting anyone write into someone else's history.
    phone_clean = "".join(filter(str.isdigit, phone)) if phone else None
    if phone_clean and get_phone_for_token(token) != phone_clean:
        phone_clean = None

    # Check local JSON cache first
    cache_key = f"{url}_{mode}" if url else None
    cached_result = None
    if cache_key:
        with cache_lock:
            if cache_key in analysis_cache:
                cached_result = analysis_cache[cache_key]

    if cached_result:
        task_id = str(uuid.uuid4())
        # Return a task that is already marked as done
        tasks[task_id] = {
            "status": "done",
            "progress": 100,
            "total": 0,
            "result": cached_result,
            "error": None
        }

        # Save to DB if phone exists and it is a new game (not loaded from history)
        if phone_clean and not game_id:
            with app.app_context():
                try:
                    user = db.session.get(User, phone_clean)
                    if user:
                        db_game = Game(
                            id=str(uuid.uuid4()),
                            user_phone=phone_clean,
                            white_player=cached_result.get("white_player", "White"),
                            black_player=cached_result.get("black_player", "Black"),
                            pgn=pgn_text,
                            white_accuracy=cached_result.get("white_accuracy", 0.0),
                            black_accuracy=cached_result.get("black_accuracy", 0.0),
                            opening=cached_result.get("opening", "Unknown Opening"),
                            result=cached_result.get("result", "*")
                        )
                        db.session.add(db_game)
                        db.session.commit()
                except Exception as db_exc:
                    print(f"Error saving cached game to DB: {db_exc}")

        return jsonify({"task_id": task_id})

    time_map = {"quick": 0.05, "normal": 0.15, "deep": 0.4}
    tpm = time_map.get(mode, 0.15)

    task_id = str(uuid.uuid4())
    tasks[task_id] = {"status": "running", "progress": 0, "total": 0, "result": None, "error": None}

    threading.Thread(
        target=run_analysis,
        args=(task_id, pgn_text, username, tpm, cache_key, phone_clean, game_id),
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
    elif task["status"] == "error":
        resp["error"] = task["error"]
    # Deliberately not popped from `tasks` here — a second concurrent poller (another tab,
    # or a client retry after a network blip) would otherwise get a spurious 404 instead of
    # the already-computed result. This is a local single-user tool, so the in-memory dict
    # growing until the next restart is an acceptable tradeoff for that correctness fix.

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


# ── Account Authentication & Database Operations ──

session_tokens = {}  # token -> {"phone": phone_clean, "expires_at": timestamp}
pending_otps = {}    # phone_clean -> {"code": otp_code, "created_at": timestamp, "attempts": int}
otp_rate_limits = {} # phone_clean -> last_request_timestamp

def _prune_expired_sessions_and_otps():
    """Periodically clear expired OTPs and session tokens to free memory."""
    now = time.time()
    # Prune expired OTPs (older than 5 mins)
    expired_otps = [phone for phone, data in list(pending_otps.items()) if now - data["created_at"] > 300]
    for phone in expired_otps:
        pending_otps.pop(phone, None)
        
    # Prune expired sessions
    expired_sessions = [tok for tok, data in list(session_tokens.items()) if now > data["expires_at"]]
    for tok in expired_sessions:
        session_tokens.pop(tok, None)

def get_phone_for_token(token):
    """Retrieve the phone number if the session token is valid and not expired."""
    if not token or token not in session_tokens:
        return None
    token_data = session_tokens[token]
    if time.time() > token_data["expires_at"]:
        session_tokens.pop(token, None)
        return None
    return token_data["phone"]

def token_required(view_func):
    """Authenticate requests via Bearer token in the Authorization header or token query/JSON param."""
    @wraps(view_func)
    def wrapper(*args, **kwargs):
        auth_header = request.headers.get("Authorization", "")
        token = None
        if auth_header.startswith("Bearer "):
            token = auth_header.split(" ")[1]
        else:
            token = request.args.get("token") or (request.json.get("token") if (request.is_json and request.json) else None)
        
        phone_clean = get_phone_for_token(token)
        if not phone_clean:
            return jsonify({"error": "Unauthorized session token"}), 401
            
        request.phone_clean = phone_clean
        return view_func(*args, **kwargs)
    return wrapper


@app.route("/api/auth", methods=["POST"])
def auth_phone():
    try:
        _prune_expired_sessions_and_otps()
        data = request.json or {}
        phone = data.get("phone", "")
        if not phone:
            return jsonify({"error": "Phone number is required"}), 400

        phone_clean = "".join(filter(str.isdigit, phone))
        if len(phone_clean) < 7:
            return jsonify({"error": "Invalid phone number"}), 400

        # Rate limiting: limit request frequency to once every 60 seconds
        now = time.time()
        last_req = otp_rate_limits.get(phone_clean, 0)
        if now - last_req < 60:
            return jsonify({"error": "Please wait 60 seconds before requesting another code."}), 429

        # Generate a random 6-digit OTP code using cryptographically secure secrets module
        otp_code = str(secrets.SystemRandom().randint(100000, 999999))
        pending_otps[phone_clean] = {
            "code": otp_code,
            "created_at": now,
            "attempts": 0
        }
        otp_rate_limits[phone_clean] = now

        # Check if Twilio settings are configured
        is_mock = not all([TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER])
        
        # Explicit opt-in validation for mock bypass
        is_prod = os.environ.get("FLASK_ENV") == "production" or os.environ.get("ENV") == "production" or not is_mock
        allow_mock = os.environ.get("ALLOW_MOCK_AUTH", "false" if is_prod else "true").lower() == "true"
        
        if is_mock:
            if allow_mock:
                print(f"\n[MOCK OTP] 🔑 Verification code for {phone_clean} is: {otp_code}\n")
            else:
                print(f"\n[BLOCKED] 🚨 Attempted to use mock auth but ALLOW_MOCK_AUTH is disabled on this environment.\n")
                return jsonify({"error": "SMS gateway credentials missing."}), 500
        else:
            # Send real SMS verification code via Twilio API
            to_e164 = f"+{phone_clean}" if phone_clean.startswith("1") else f"+1{phone_clean}"
            body = f"♟ ChessNow verification code: {otp_code}"
            try:
                resp = requests.post(
                    f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_ACCOUNT_SID}/Messages.json",
                    auth=(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN),
                    data={"From": TWILIO_PHONE_NUMBER, "To": to_e164, "Body": body},
                    timeout=10,
                )
                if resp.status_code != 201:
                    print(f"⚠️  Twilio OTP SMS send failed: {resp.text[:200]}")
            except Exception as se:
                print(f"⚠️  Twilio OTP SMS exception: {se}")

        return jsonify({"status": "otp_sent", "phone": phone_clean, "mock": is_mock and allow_mock})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/auth/verify", methods=["POST"])
def auth_verify():
    try:
        _prune_expired_sessions_and_otps()
        data = request.json or {}
        phone = data.get("phone", "")
        code = data.get("code", "").strip()
        if not phone or not code:
            return jsonify({"error": "Both phone and verification code are required"}), 400

        phone_clean = "".join(filter(str.isdigit, phone))
        otp_data = pending_otps.get(phone_clean)

        if not otp_data:
            return jsonify({"error": "Invalid or expired verification code"}), 400

        # Enforce expiration limit (5 minutes = 300 seconds)
        if time.time() - otp_data["created_at"] > 300:
            pending_otps.pop(phone_clean, None)
            return jsonify({"error": "Invalid or expired verification code"}), 400

        # Enforce rate limit (max 3 verification attempts)
        otp_data["attempts"] += 1

        # Allow '123456' as a universal mock bypass if mock mode is active
        is_mock = not all([TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER])
        is_prod = os.environ.get("FLASK_ENV") == "production" or os.environ.get("ENV") == "production" or not is_mock
        allow_mock = os.environ.get("ALLOW_MOCK_AUTH", "false" if is_prod else "true").lower() == "true"

        expected_code = otp_data["code"]
        is_valid = (expected_code == code) or (is_mock and allow_mock and code == "123456")

        if not is_valid:
            # Let user try again up to the limit
            if otp_data["attempts"] >= 3:
                pending_otps.pop(phone_clean, None)
                return jsonify({"error": "Too many failed attempts. Please request a new code."}), 429
            attempts_left = 3 - otp_data["attempts"]
            return jsonify({
                "error": f"Invalid or expired verification code. {attempts_left} attempts remaining."
            }), 400

        # Success - clean up OTP and register session token
        pending_otps.pop(phone_clean, None)

        token = "token_" + str(uuid.uuid4())
        # Set session expiration (30 days)
        session_tokens[token] = {
            "phone": phone_clean,
            "expires_at": time.time() + 30 * 24 * 60 * 60
        }

        # Ensure user exists in DB
        user = db.session.get(User, phone_clean)
        if not user:
            user = User(phone_number=phone_clean)
            db.session.add(user)
            db.session.commit()

        return jsonify({"status": "success", "phone": phone_clean, "token": token})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/games", methods=["GET"])
@token_required
def get_user_games():
    try:
        phone = request.args.get("phone", "")
        if not phone:
            return jsonify({"error": "Phone number is required"}), 400

        phone_clean = "".join(filter(str.isdigit, phone))
        if phone_clean != request.phone_clean:
            return jsonify({"error": "Access denied to other user's game records"}), 403

        user_games = db.session.execute(
            select(Game).filter(
                Game.user_phone == phone_clean,
                Game.source.in_(["voice_bot", "voice_pvp"])
            ).order_by(Game.created_at.desc())
        ).scalars().all()
        
        games_list = []
        for g in user_games:
            games_list.append({
                "id": g.id,
                "white_player": g.white_player,
                "black_player": g.black_player,
                "white_accuracy": g.white_accuracy,
                "black_accuracy": g.black_accuracy,
                "opening": g.opening,
                "result": g.result,
                "pgn": g.pgn,
                "created_at": g.created_at.isoformat()
            })
        return jsonify({"games": games_list})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Live Voice Game Helpers ──

def _calculate_elo_change(player_elo, opponent_elo, score, k_factor=32):
    """Calculate the rating change using the standard Chess Elo formula."""
    expected = 1.0 / (1.0 + 10.0 ** ((opponent_elo - player_elo) / 400.0))
    new_elo = player_elo + k_factor * (score - expected)
    new_elo_rounded = int(round(new_elo))
    diff = new_elo_rounded - player_elo
    return new_elo_rounded, diff


def _update_game_elo(game, result):
    """Update Elo ratings for user(s) and return rating feedback statement."""
    if not game or result == "*":
        return ""
        
    user = db.session.get(User, game.user_phone)
    if not user:
        return ""
        
    user_color = game.player_color or "white"
    
    if result == "1-0":
        user_score = 1.0 if user_color == "white" else 0.0
    elif result == "0-1":
        user_score = 0.0 if user_color == "white" else 1.0
    elif result == "1/2-1/2":
        user_score = 0.5
    else:
        return ""
        
    if game.source == "voice_bot":
        opponent_elo = game.bot_elo or 1000
        old_elo = user.elo or 1000
        new_elo, diff = _calculate_elo_change(old_elo, opponent_elo, user_score)
        user.elo = new_elo
        db.session.commit()
        
        diff_str = f"+{diff}" if diff >= 0 else f"{diff}"
        return f" Your rating changed by {diff_str} to {new_elo}."
        
    elif game.source == "voice_pvp":
        opponent_phone = game.black_phone if user_color == "white" else game.white_phone
        opponent = db.session.get(User, opponent_phone) if opponent_phone else None
        
        old_elo = user.elo or 1000
        opp_old_elo = opponent.elo or 1000 if opponent else 1000
        
        new_elo, diff = _calculate_elo_change(old_elo, opp_old_elo, user_score)
        user.elo = new_elo
        
        if opponent:
            opp_score = 1.0 - user_score
            opp_new_elo, opp_diff = _calculate_elo_change(opp_old_elo, old_elo, opp_score)
            opponent.elo = opp_new_elo
            
        db.session.commit()
        
        diff_str = f"+{diff}" if diff >= 0 else f"{diff}"
        return f" Your rating changed by {diff_str} to {new_elo}."
        
    return ""


def _san_to_speech(san):
    """Convert chess standard algebraic notation (SAN) to natural speech text."""
    if not san:
        return ""
    if san in ("O-O", "o-o"):
        return "Castles kingside"
    if san in ("O-O-O", "o-o-o"):
        return "Castles queenside"
    
    piece_map = {
        'N': 'Knight ',
        'B': 'Bishop ',
        'R': 'Rook ',
        'Q': 'Queen ',
        'K': 'King '
    }
    
    res = []
    chars = list(san)
    i = 0
    while i < len(chars):
        c = chars[i]
        if c in piece_map:
            res.append(piece_map[c])
        elif c == 'x':
            res.append(' takes ')
        elif c == '+':
            res.append(', check')
        elif c == '#':
            res.append(', checkmate')
        elif c == '=':
            res.append(' promoting to ')
        elif c.isalpha() and c.islower():
            res.append(f"{c} ")
        else:
            res.append(c)
        i += 1
    
    return "".join(res).strip().replace("  ", " ")


def _pieces_to_speech(board, color):
    """List all pieces of a specific color, ordered K/Q/R/B/N/pawns."""
    piece_names = [
        (chess.KING, "King", "Kings"),
        (chess.QUEEN, "Queen", "Queens"),
        (chess.ROOK, "Rook", "Rooks"),
        (chess.BISHOP, "Bishop", "Bishops"),
        (chess.KNIGHT, "Knight", "Knights"),
        (chess.PAWN, "pawn", "pawns"),
    ]
    parts = []
    for piece_type, singular, plural in piece_names:
        squares = sorted(list(board.pieces(piece_type, color)))
        if not squares:
            continue
        sq_names = [chess.square_name(sq) for sq in squares]
        if len(sq_names) == 1:
            parts.append(f"{singular} on {sq_names[0]}")
        elif len(sq_names) == 2:
            parts.append(f"{plural} on {sq_names[0]} and {sq_names[1]}")
        else:
            parts.append(f"{plural} on {', '.join(sq_names[:-1])}, and {sq_names[-1]}")
    return ", ".join(parts) if parts else "No pieces"


def _square_query_to_speech(board, square):
    """Retrieve color and type of the piece on a given square (e.g. 'e4: white pawn')."""
    try:
        sq_idx = chess.parse_square(square.lower().strip())
    except ValueError:
        return f"{square} is not a valid square"
    piece = board.piece_at(sq_idx)
    if not piece:
        return f"{square} is empty"
    color_str = "white" if piece.color == chess.WHITE else "black"
    piece_names = {
        chess.PAWN: "pawn",
        chess.KNIGHT: "knight",
        chess.BISHOP: "bishop",
        chess.ROOK: "rook",
        chess.QUEEN: "queen",
        chess.KING: "king"
    }
    name = piece_names.get(piece.piece_type, "piece")
    return f"{square}: {color_str} {name}"


def _game_status_to_speech(board, game):
    """Summarize whose turn it is, move number, material count difference, and check status."""
    turn_str = "White to move" if board.turn == chess.WHITE else "Black to move"
    move_num = board.fullmove_number
    move_str = f"move {move_num}"
    
    check_str = ""
    if board.is_check():
        check_str = ", in check"
        
    values = {
        chess.PAWN: 1,
        chess.KNIGHT: 3,
        chess.BISHOP: 3,
        chess.ROOK: 5,
        chess.QUEEN: 9,
    }
    w_mat = sum(len(board.pieces(pt, chess.WHITE)) * val for pt, val in values.items())
    b_mat = sum(len(board.pieces(pt, chess.BLACK)) * val for pt, val in values.items())
    
    caller_color = game.player_color or "white"
    if caller_color == "white":
        diff = w_mat - b_mat
    else:
        diff = b_mat - w_mat
        
    if diff > 0:
        mat_str = f"up {diff} in material"
    elif diff < 0:
        mat_str = f"down {abs(diff)} in material"
    else:
        mat_str = "even material"
        
    return f"{turn_str}, {move_str}, {mat_str}{check_str}"


def _last_move_to_speech(board):
    """Return the last played move formatted for speech."""
    if not board.move_stack:
        return "No moves have been played yet."
    temp = board.copy()
    move = temp.pop()
    san = temp.san(move)
    return _san_to_speech(san)


def make_twiml_response(xml_content):
    # Standardize on a smooth, premium female neural voice for Twilio calls
    xml_content = xml_content.replace("<Say>", '<Say voice="Polly.Joanna-Neural">')
    response = app.response_class(
        response=f'<?xml version="1.0" encoding="UTF-8"?><Response>{xml_content}</Response>',
        status=200,
        mimetype='application/xml'
    )
    return response


def _twilio_request_is_valid():
    """Verify the X-Twilio-Signature header against the request Twilio actually sent.

    Returns True (skips verification) if TWILIO_AUTH_TOKEN isn't configured — a startup
    warning already flags that case so it isn't a silent gap.
    """
    if app.config.get("TESTING") or not TWILIO_AUTH_TOKEN:
        return True

    validator = RequestValidator(TWILIO_AUTH_TOKEN)
    signature = request.headers.get("X-Twilio-Signature", "")
    if os.environ.get("BASE_URL"):
        url = BASE_URL.rstrip("/") + request.full_path.rstrip("?")
    else:
        proto = request.headers.get("X-Forwarded-Proto", "https")
        url = f"{proto}://{request.host}{request.full_path.rstrip('?')}"
    params = request.form.to_dict() if request.method == "POST" else {}
    return validator.validate(url, params, signature)


def twilio_webhook(view_func):
    """Reject any request to a Twilio-only webhook route that lacks a valid Twilio signature."""
    @wraps(view_func)
    def wrapper(*args, **kwargs):
        if not _twilio_request_is_valid():
            print(f"⚠️  Rejected request to {request.path} — invalid or missing Twilio signature")
            return make_twiml_response("<Reject/>"), 403
        return view_func(*args, **kwargs)
    return wrapper


# ── Media-stream connection tokens ──
# The <Stream> URL we hand Twilio in TwiML is fetched directly over a WebSocket, which
# Twilio does not sign the way it signs regular webhooks. Without this, anyone who
# connects to /api/voice/stream can claim an arbitrary callSid in the "start" event and
# have the server act on it (see redirect_twilio_call). A random per-process secret is
# fine here — the token only needs to survive from TwiML generation to the WS connect,
# both of which happen within the same running process during a single phone call.
_STREAM_TOKEN_SECRET = os.urandom(32)
_STREAM_TOKEN_TTL_SECONDS = 600


def _make_stream_token(call_sid):
    expiry = int(time.time()) + _STREAM_TOKEN_TTL_SECONDS
    msg = f"{call_sid}:{expiry}".encode()
    sig = hmac.new(_STREAM_TOKEN_SECRET, msg, hashlib.sha256).hexdigest()
    return f"{expiry}.{sig}"


def _verify_stream_token(call_sid, token):
    if not call_sid or not token or "." not in token:
        return False
    expiry_str, _, sig = token.partition(".")
    try:
        expiry = int(expiry_str)
    except ValueError:
        return False
    if time.time() > expiry:
        return False
    msg = f"{call_sid}:{expiry}".encode()
    expected = hmac.new(_STREAM_TOKEN_SECRET, msg, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sig)


def send_postgame_sms(to_phone: str, game_id: str, result_speech: str, move_count: int):
    """Fire a post-game SMS recap to the caller via Twilio REST API.

    Runs in a background thread so it never blocks the TwiML response.
    Silently skips if Twilio credentials are not configured.
    """
    if not all([TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER]):
        print("⚠️  Post-game SMS skipped — Twilio credentials incomplete.")
        return

    # Normalise to E.164 (+1XXXXXXXXXX)
    digits_only = "".join(filter(str.isdigit, to_phone))
    if len(digits_only) == 10:
        digits_only = "1" + digits_only
    to_e164 = f"+{digits_only}"

    review_url = f"{BASE_URL}/?game={game_id}"
    body = (
        f"♟ ChessNow recap — {result_speech.strip()} "
        f"({move_count} move{'s' if move_count != 1 else ''}). "
        f"Review your game: {review_url} "
        f"| Create a free account to track your Elo history: {BASE_URL}/signup"
    )

    def _send():
        try:
            resp = requests.post(
                f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_ACCOUNT_SID}/Messages.json",
                auth=(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN),
                data={"From": TWILIO_PHONE_NUMBER, "To": to_e164, "Body": body},
                timeout=10,
            )
            if resp.status_code == 201:
                print(f"✅  Post-game SMS sent to {to_e164}")
            else:
                print(f"⚠️  Twilio SMS error {resp.status_code}: {resp.text[:200]}")
        except Exception as exc:
            print(f"⚠️  Post-game SMS exception: {exc}")

    threading.Thread(target=_send, daemon=True).start()


# ── Twilio Websocket Streaming & Local STT (Whisper) Helpers ──

_whisper_model = None
_whisper_lock = threading.Lock()

def get_whisper_model():
    """Lazy-load the local faster-whisper model (singleton pattern)."""
    global _whisper_model
    if _whisper_model is None:
        with _whisper_lock:
            if _whisper_model is None:
                from faster_whisper import WhisperModel
                print("⏳ Loading local faster-whisper model (base)...")
                # Using base model since it is small, runs fast on CPU, and is accurate for chess moves.
                _whisper_model = WhisperModel("base", device="cpu", compute_type="float32")
                print("✅ Local faster-whisper model loaded.")
    return _whisper_model


def decode_mulaw_to_wav(mulaw_bytes):
    """Converts 8-bit mulaw 8000Hz mono audio (Twilio format) to 16-bit PCM 16000Hz mono WAV using audioop."""
    # Convert all 8-bit mulaw bytes to 16-bit linear PCM
    linear_pcm = audioop.ulaw2lin(mulaw_bytes, 2)
    # Resample from 8000Hz to 16000Hz
    resampled, _ = audioop.ratecv(linear_pcm, 2, 1, 8000, 16000, None)
    # Write into a WAV file buffer
    wav_io = io.BytesIO()
    with wave.open(wav_io, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(16000)
        wav_file.writeframes(resampled)
    wav_io.seek(0)
    return wav_io


def generate_bot_commentary(bot_elo, player_move, bot_move, evaluation_details="", commentary_style="formal"):
    """
    Calls the Gemini API using requests to generate a personalized spoken comment from Thara,
    reacting in character to the latest chess moves and evaluation.
    """
    if not GEMINI_API_KEY or commentary_style == "minimal":
        return ""
        
    persona_name = "Thara"
    persona_desc = (
        f"You are Thara, a professional, focused, and formal chess companion. "
        f"You have an ELO rating of {bot_elo}. You speak clearly, politely, and formally. "
        f"Avoid any trash talk or distracting personality traits. Focus on the move notation "
        f"and formal, brief chess advice or evaluation comments."
    )

    move_context = f"The human player played '{player_move}'." if player_move else "This is the start of the game."
    bot_context = f"You responded by playing '{bot_move}'."
    eval_context = f"Stockfish evaluations about this position: '{evaluation_details}'." if evaluation_details else ""
    
    prompt = f"""
System Instructions:
{persona_desc}

Rule Constraints:
1. Speak as {persona_name}.
2. React naturally to the current moves and board state.
3. Keep the response under 22 words.
4. Output ONLY your spoken dialogue. No tags, no comments, no 'Thara:' prefix. Just the quote.

Context:
- {move_context}
- {bot_context}
- {eval_context}
"""

    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={GEMINI_API_KEY}"
    payload = {
        "contents": [{
            "parts": [{
                "text": prompt
            }]
        }],
        "generationConfig": {
            "maxOutputTokens": 60,
            "temperature": 0.7
        }
    }
    
    try:
        resp = requests.post(url, json=payload, timeout=4)
        if resp.status_code == 200:
            resp_data = resp.json()
            candidates = resp_data.get("candidates", [])
            if candidates:
                text = candidates[0].get("content", {}).get("parts", [{}])[0].get("text", "").strip()
                if text.startswith('"') and text.endswith('"'):
                    text = text[1:-1]
                elif text.startswith("'") and text.endswith("'"):
                    text = text[1:-1]
                return _xml_escape(text)
        else:
            print(f"⚠️ Gemini API error {resp.status_code}: {resp.text[:200]}")
    except Exception as e:
        print(f"⚠️ Gemini API exception: {e}")
        
    return ""


def get_call_phone(call_sid):
    """Fetch call metadata from Twilio REST API to look up the caller's phone number."""
    if not all([TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN]):
        return ""
    try:
        resp = requests.get(
            f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_ACCOUNT_SID}/Calls/{call_sid}.json",
            auth=(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN),
            timeout=5,
        )
        if resp.status_code == 200:
            return resp.json().get("from", "")
    except Exception as e:
        print(f"⚠️ Error fetching Twilio call info for SID {call_sid}: {e}")
    return ""


def redirect_twilio_call(call_sid, new_url):
    """Updates an active Twilio call with new TwiML instructions by redirecting it to a new URL."""
    if not all([TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN]):
        return
    try:
        resp = requests.post(
            f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_ACCOUNT_SID}/Calls/{call_sid}.json",
            auth=(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN),
            data={"Url": new_url, "Method": "POST"},
            timeout=5,
        )
        if resp.status_code == 200:
            print(f"✅ Redirected Twilio call {call_sid} to {new_url}")
        else:
            print(f"⚠️ Twilio Call Redirect error {resp.status_code}: {resp.text[:200]}")
    except Exception as exc:
        print(f"⚠️ Twilio Call Redirect exception: {exc}")


@sock.route("/api/voice/stream")
def voice_stream(ws):
    """Bi-directional WebSocket streaming handler for Twilio live audio stream."""
    print("📞 Live Twilio Web Socket audio stream connected.")
    call_sid = None
    from_phone = None
    
    # State tracking for local Voice Activity Detection (VAD)
    is_speaking = False
    silence_time = 0.0
    speech_time = 0.0
    audio_buffer = bytearray()
    
    # VAD tuning constants (measured per 20ms frame)
    SILENCE_THRESHOLD = 300    # RMS amplitude threshold for speech (values close to 0 denote silence)
    SILENCE_DURATION = 1.3     # seconds of silence to trigger transcription
    MIN_SPEECH_DURATION = 0.4  # minimum speech duration to consider it a move input
    
    while True:
        message = ws.receive()
        if message is None:
            break
            
        try:
            data = json.loads(message)
            event = data.get("event")
            
            if event == "start":
                start_data = data.get("start", {})
                call_sid = start_data.get("callSid")
                stream_token = request.args.get("t", "")
                if not call_sid or not _verify_stream_token(call_sid, stream_token):
                    print("⚠️  Rejected voice stream connection — invalid or missing stream token")
                    ws.close()
                    break
                from_phone = get_call_phone(call_sid)
                print(f"📞 Active Call SID: {call_sid} | Caller Phone: {from_phone}")
                    
            elif event == "media":
                media_data = data.get("media", {})
                payload = media_data.get("payload")
                if payload:
                    # Base64 decode raw 8-bit 8000Hz mulaw bytes (160 bytes = 20ms chunk)
                    raw_chunk = base64.b64decode(payload)
                    
                    # Convert mulaw to 16-bit linear PCM and compute RMS amplitude
                    linear_pcm = audioop.ulaw2lin(raw_chunk, 2)
                    rms = audioop.rms(linear_pcm, 2)
                    
                    if rms > SILENCE_THRESHOLD:
                        if not is_speaking:
                            is_speaking = True
                            speech_time = 0.0
                        silence_time = 0.0
                        speech_time += 0.02
                        if len(audio_buffer) < 120000:
                            audio_buffer.extend(raw_chunk)
                    else:
                        if is_speaking:
                            silence_time += 0.02
                            if len(audio_buffer) < 120000:
                                audio_buffer.extend(raw_chunk)
                            
                            # User stopped speaking for long enough -> run local transcription
                            if silence_time >= SILENCE_DURATION:
                                if speech_time >= MIN_SPEECH_DURATION:
                                    print(f"🎙️ Speech duration: {speech_time:.2f}s, silence: {silence_time:.2f}s. Transcribing...")
                                    
                                    wav_io = decode_mulaw_to_wav(bytes(audio_buffer))
                                    model = get_whisper_model()
                                    segments, info = model.transcribe(wav_io, beam_size=5, language="en")
                                    transcript = " ".join([seg.text for seg in segments]).strip()
                                    print(f"📝 Transcribed speech: '{transcript}'")
                                    
                                    if transcript:
                                        # Redirect call to process_move with the Whisper transcription result
                                        redirect_url = f"{BASE_URL}/api/voice/process_move?SpeechResult={urllib.parse.quote(transcript)}&From={urllib.parse.quote(from_phone or '')}"
                                        redirect_twilio_call(call_sid, redirect_url)
                                        ws.close()
                                        break
                                
                                # Reset VAD state
                                is_speaking = False
                                audio_buffer = bytearray()
                                speech_time = 0.0
                                silence_time = 0.0
                                
            elif event == "stop":
                print(f"📞 Stream stopped for call: {call_sid}")
                break
                
        except Exception as e:
            print(f"⚠️ Web Socket stream exception: {e}")
            break
            
    print("📞 Live Twilio Web Socket audio stream closed.")


def _board_from_pgn(pgn_text):
    """Reconstruct a chess.Board by replaying a game's stored PGN."""
    board = chess.Board()
    if pgn_text:
        try:
            parsed = chess.pgn.read_game(io.StringIO(pgn_text))
            if parsed:
                board = parsed.board()
                for m in parsed.mainline_moves():
                    board.push(m)
        except Exception:
            pass
    return board


def _save_pgn(game, board):
    """Rebuild PGN from the board's move stack and persist it to the game row."""
    pgn_game = chess.pgn.Game()
    pgn_game.setup(chess.Board())
    node = pgn_game
    for m in board.move_stack:
        node = node.add_variation(m)
    game.pgn = str(pgn_game)
    game.last_activity_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.session.commit()


PVP_CHALLENGE_EXPIRY_HOURS = 24  # a pvp challenge nobody has answered gets auto-aborted after this
LIVE_GAME_IDLE_HOURS = 6         # a game already in progress that's gone quiet gets auto-aborted after this

# Guards the classic check-then-insert race: two near-simultaneous requests from the
# same phone could both see "no active game" and each create their own Game row.
# A per-phone lock is correct for this single-process `threaded=True` Flask deployment
# against SQLite — if this ever moves to multiple worker processes, this needs to become
# a DB-level constraint (e.g. SELECT ... FOR UPDATE on Postgres) instead.
#
# Bounded as an LRU: each unique caller leaves a Lock behind forever otherwise. Evicting
# the least-recently-used entry once we're over the cap is safe here — a thread already
# holding a Lock object keeps its reference even if the dict entry is dropped, so at worst
# a fresh concurrent caller for that same (long-idle) phone briefly gets a new Lock instead
# of contending on the old one, which only matters once the cap is actually being hit.
_ACTIVE_GAME_LOCKS_MAX = 10000
_active_game_locks = OrderedDict()
_active_game_locks_guard = threading.Lock()


def _lock_for_phone(phone_clean):
    with _active_game_locks_guard:
        lock = _active_game_locks.get(phone_clean)
        if lock is None:
            lock = threading.Lock()
            if len(_active_game_locks) >= _ACTIVE_GAME_LOCKS_MAX:
                _active_game_locks.popitem(last=False)
            _active_game_locks[phone_clean] = lock
        else:
            _active_game_locks.move_to_end(phone_clean)
        return lock


def find_active_live_game(phone_clean):
    """Find the caller's in-progress voice game (bot or phone-vs-phone), regardless of color."""
    game = db.session.execute(
        select(Game).filter(
            Game.result == "*",
            Game.source.in_(["voice_bot", "voice_pvp"]),
            or_(Game.white_phone == phone_clean, Game.black_phone == phone_clean)
        ).order_by(Game.created_at.desc())
    ).scalars().first()

    if not game:
        return None

    now = datetime.now(timezone.utc).replace(tzinfo=None)

    # A pvp challenge that never got a single move played and has sat past the expiry
    # window is dead weight — abort it so the challenger isn't stuck unable to start over.
    if game.source == "voice_pvp" and not game.pgn:
        if now - game.created_at > timedelta(hours=PVP_CHALLENGE_EXPIRY_HOURS):
            game.result = "aborted"
            db.session.commit()
            return None
    else:
        # A game (bot or pvp) that already has moves but has gone quiet for too long —
        # nobody called back in — also needs closing out, not just never-started challenges.
        last_seen = game.last_activity_at or game.created_at
        if now - last_seen > timedelta(hours=LIVE_GAME_IDLE_HOURS):
            game.result = "aborted"
            db.session.commit()
            return None

    return game


# ── Twilio Telephony Webhook ──

@app.route("/api/voice/challenge", methods=["POST"])
@token_required
def voice_challenge():
    """Start a live phone-vs-phone game: caller plays White, opponent plays Black."""
    try:
        data = request.json or {}
        phone_clean = "".join(filter(str.isdigit, data.get("phone", "")))
        opponent_clean = "".join(filter(str.isdigit, data.get("opponent_phone", "")))
        if phone_clean != request.phone_clean:
            return jsonify({"error": "Unauthorized user phone"}), 403
            
        if not phone_clean or not opponent_clean:
            return jsonify({"error": "Both phone and opponent_phone are required"}), 400
        if phone_clean == opponent_clean:
            return jsonify({"error": "Cannot challenge yourself"}), 400

        for p in (phone_clean, opponent_clean):
            if not db.session.get(User, p):
                db.session.add(User(phone_number=p))
        db.session.commit()

        with _lock_for_phone(phone_clean):
            # End any of the caller's existing in-progress voice games first
            stale = find_active_live_game(phone_clean)
            if stale:
                stale.result = "aborted"
                db.session.commit()

        with _lock_for_phone(opponent_clean):
            # End any of the invitee's existing in-progress voice games as well
            stale_opp = find_active_live_game(opponent_clean)
            if stale_opp:
                stale_opp.result = "aborted"
                db.session.commit()

        game = Game(
            id=str(uuid.uuid4()),
            user_phone=phone_clean,
            white_phone=phone_clean,
            black_phone=opponent_clean,
            source="voice_pvp",
            white_player="You",
            black_player=f"Player {opponent_clean[-4:]}",
            pgn="",
            result="*",
            last_activity_at=datetime.now(timezone.utc).replace(tzinfo=None)
        )
        db.session.add(game)
        db.session.commit()
        return jsonify({"status": "success", "game_id": game.id})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/voice/pending_challenges", methods=["GET"])
@token_required
def voice_pending_challenges():
    """List incoming pvp challenges (nobody has moved yet) waiting on this phone."""
    try:
        phone_clean = "".join(filter(str.isdigit, request.args.get("phone", "")))
        if phone_clean != request.phone_clean:
            return jsonify({"error": "Unauthorized user phone"}), 403
            
        if not phone_clean:
            return jsonify({"error": "Phone number is required"}), 400

        games = db.session.execute(
            select(Game).filter(
                Game.result == "*",
                Game.source == "voice_pvp",
                Game.black_phone == phone_clean,
                Game.pgn == ""
            ).order_by(Game.created_at.desc())
        ).scalars().all()

        return jsonify({"challenges": [
            {"game_id": g.id, "from_phone": g.white_phone, "created_at": g.created_at.isoformat()}
            for g in games
        ]})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/voice/decline_challenge", methods=["POST"])
@token_required
def voice_decline_challenge():
    """Let the invited player turn down a pending pvp challenge before ever calling in."""
    try:
        data = request.json or {}
        game_id = data.get("game_id", "")
        phone_clean = "".join(filter(str.isdigit, data.get("phone", "")))
        if phone_clean != request.phone_clean:
            return jsonify({"error": "Unauthorized user phone"}), 403
            
        game = db.session.get(Game, game_id)
        if not game or game.black_phone != phone_clean or game.result != "*":
            return jsonify({"error": "Challenge not found"}), 404
        game.result = "aborted"
        db.session.commit()
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


def _finalize_pvp_game_acknowledgment(game, active_phone):
    """Mark the active player as acknowledged and the opponent as unacknowledged when a PvP game ends."""
    if game.source == "voice_pvp":
        if active_phone == game.white_phone:
            game.white_acknowledged = True
            game.black_acknowledged = False
        else:
            game.black_acknowledged = True
            game.white_acknowledged = False


def make_twiml_game_over_response(board, game, prefix=""):
    res = board.result()
    if board.is_checkmate():
        if board.turn == chess.WHITE:
            winner = "Black"
        else:
            winner = "White"
        
        user_color = game.player_color or "white"
        if winner.lower() == user_color:
            result_speech = "Checkmate. Congratulations! You win."
        else:
            result_speech = "Checkmate. Good game, well played. I win."
    elif board.is_stalemate():
        result_speech = "Stalemate. The game is a draw. Good game, well played."
    else:
        result_speech = "The game has ended in a draw. Good game, well played."

    if prefix:
        result_speech = f"{prefix} {result_speech}"

    # Calculate and apply Elo updates statefully
    elo_msg = _update_game_elo(game, res)
    result_speech = f"{result_speech}{elo_msg}"

    # Fire post-game SMS recap to the caller (non-blocking)
    caller_phone = game.user_phone or ""
    move_count = len(board.move_stack)
    # Build a clean result summary for the SMS (strip Elo message which has spoken format)
    sms_result = result_speech.split(".")[0] + "." if "." in result_speech else result_speech
    send_postgame_sms(caller_phone, game.id, sms_result, move_count)

    twiml = f"""
    <Say>{_xml_escape(result_speech)} Would you like to play another game?</Say>
    <Gather input="dtmf speech" numDigits="1" action="/api/voice/play_again" timeout="5" speechTimeout="auto">
        <Say>Say yes or press 1 to play again, or say no or hang up to end the call.</Say>
    </Gather>
    <Say>Thank you for playing ChessNow. Goodbye.</Say>
    <Hangup/>
    """
    return make_twiml_response(twiml)



def _touch_call_log(phone_clean, game_id=None):
    """Upsert the CallLog row for the current Twilio webhook.

    First webhook of a call creates the row; every later webhook bumps ended_at so
    duration can be estimated even if the status callback never fires. Must be
    called inside an app context. No-op for requests without a CallSid (web UI).
    """
    call_sid = request.values.get("CallSid", "")
    if not call_sid:
        return
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    log = db.session.execute(select(CallLog).filter_by(call_sid=call_sid)).scalars().first()
    if not log:
        prior_calls = db.session.execute(
            select(func.count(CallLog.id)).filter_by(phone_number=phone_clean)
        ).scalar() or 0
        log = CallLog(id=str(uuid.uuid4()), call_sid=call_sid, phone_number=phone_clean,
                      started_at=now, call_type="inbound", first_call=(prior_calls == 0))
        db.session.add(log)
    log.ended_at = now
    if game_id and not log.game_id:
        log.game_id = game_id
    db.session.commit()


def _bump_call_stats(moves=0, retries=0, confirms=0):
    """Increment ASR/activation counters on the current call's CallLog.
    Safe no-op for requests without a CallSid (web UI / tests)."""
    call_sid = request.values.get("CallSid", "")
    if not call_sid:
        return
    try:
        log = db.session.execute(select(CallLog).filter_by(call_sid=call_sid)).scalars().first()
        if not log:
            return
        if moves:
            log.moves_played = (log.moves_played or 0) + moves
            if not log.first_move_at:
                log.first_move_at = datetime.now(timezone.utc).replace(tzinfo=None)
        if retries:
            log.speech_retries = (log.speech_retries or 0) + retries
        if confirms:
            log.confirm_prompts = (log.confirm_prompts or 0) + confirms
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        print(f"⚠️  call-stats bump failed: {e}")


@app.route("/api/voice/call_status", methods=["POST"])
@twilio_webhook
def voice_call_status():
    """Twilio 'call status changes' webhook (configured on the phone number).

    Delivers the authoritative CallDuration when the call completes.
    """
    call_sid = request.values.get("CallSid", "")
    if not call_sid:
        return ("", 204)
    from_phone = request.values.get("From", "")
    phone_clean = "".join(filter(str.isdigit, from_phone))
    with app.app_context():
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        log = db.session.execute(select(CallLog).filter_by(call_sid=call_sid)).scalars().first()
        if not log:
            log = CallLog(id=str(uuid.uuid4()), call_sid=call_sid, phone_number=phone_clean or None, started_at=now, call_type="inbound")
            db.session.add(log)
        log.ended_at = now
        log.hangup_reason = request.values.get("CallStatus", "") or None
        duration = request.values.get("CallDuration", "")
        if duration.isdigit():
            log.duration_seconds = int(duration)
        db.session.commit()
    return ("", 204)


@app.route("/api/metrics/event", methods=["POST"])
def log_client_event():
    """Anonymous client-side event beacon (web dial-button clicks etc.).
    Whitelisted event names only; no auth by design — treat counts as soft signals."""
    try:
        data = request.get_json(silent=True) or {}
        event = str(data.get("event", ""))[:40]
        if event not in ("dial_click",):
            return jsonify({"error": "unknown event"}), 400
        db.session.add(EventLog(id=str(uuid.uuid4()), event=event))
        db.session.commit()
        return jsonify({"status": "ok"})
    except Exception as e:
        db.session.rollback()
        return jsonify({"error": str(e)}), 500


@app.route("/api/admin/metrics", methods=["GET"])
def admin_metrics():
    """Retention metrics for the viability question: do people call back, and for how long?

    Runs optimized SQLAlchemy queries for performant analytics.
    """
    token = request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
    if not ADMIN_TOKEN or token != ADMIN_TOKEN:
        return jsonify({"error": "unauthorized"}), 401

    def _percentile(sorted_vals, pct):
        if not sorted_vals:
            return None
        idx = min(len(sorted_vals) - 1, max(0, round(pct / 100 * (len(sorted_vals) - 1))))
        return sorted_vals[idx]

    with app.app_context():
        now_time = datetime.now(timezone.utc).replace(tzinfo=None)

        def _get_metrics_for_period(start_time=None):
            log_filter = []
            game_filter = [Game.source.in_(["voice_bot", "voice_pvp"])]
            if start_time:
                log_filter.append(CallLog.started_at >= start_time)
                game_filter.append(Game.created_at >= start_time)

            # 1. Total calls
            total_calls = db.session.execute(
                select(func.count(CallLog.id)).filter(*log_filter)
            ).scalar() or 0

            # 2. Unique callers
            unique_callers = db.session.execute(
                select(func.count(CallLog.phone_number.distinct()))
                .filter(CallLog.phone_number != None, *log_filter)
            ).scalar() or 0

            # 3. Repeat callers count (callers with >=2 calls)
            repeat_subq = select(CallLog.phone_number)\
                .filter(CallLog.phone_number != None, *log_filter)\
                .group_by(CallLog.phone_number)\
                .having(func.count(CallLog.id) >= 2)\
                .subquery()
            repeat_callers = db.session.execute(
                select(func.count()).select_from(repeat_subq)
            ).scalar() or 0
            repeat_caller_rate = round(repeat_callers / unique_callers, 3) if unique_callers else None

            # 4. Median & p90 call duration
            duration_query = select(CallLog.duration_seconds, CallLog.started_at, CallLog.ended_at)\
                .filter(or_(CallLog.duration_seconds != None, and_(CallLog.started_at != None, CallLog.ended_at != None)), *log_filter)
            duration_rows = db.session.execute(duration_query).all()
            durations = []
            for row in duration_rows:
                if row[0] is not None:
                    durations.append(row[0])
                elif row[1] and row[2]:
                    durations.append(int((row[2] - row[1]).total_seconds()))
            durations.sort()
            median_duration = _percentile(durations, 50)
            p90_duration = _percentile(durations, 90)

            # 5. Games per caller
            voice_games_count = db.session.execute(
                select(func.count(Game.id)).filter(*game_filter)
            ).scalar() or 0
            game_players_count = db.session.execute(
                select(func.count(Game.user_phone.distinct())).filter(Game.user_phone != None, *game_filter)
            ).scalar() or 0
            games_per_caller = round(voice_games_count / game_players_count, 2) if game_players_count else None

            # 6. D7 Return Rate (Relative to the window end)
            w1_start = now_time - timedelta(days=7)
            w2_start = now_time - timedelta(days=14)
            if start_time:
                w1_start = max(w1_start, start_time)
                w2_start = max(w2_start, start_time)
                w1_end = now_time
                w2_end = max(now_time - timedelta(days=7), start_time)
            else:
                w1_end = now_time
                w2_end = now_time - timedelta(days=7)

            prior_week_callers = set(db.session.execute(
                select(CallLog.phone_number)
                .filter(CallLog.phone_number != None, CallLog.started_at >= w2_start, CallLog.started_at < w2_end)
                .distinct()
            ).scalars().all())

            this_week_callers = set(db.session.execute(
                select(CallLog.phone_number)
                .filter(CallLog.phone_number != None, CallLog.started_at >= w1_start, CallLog.started_at < w1_end)
                .distinct()
            ).scalars().all())
            d7_return_rate = round(len(prior_week_callers & this_week_callers) / len(prior_week_callers), 3) if prior_week_callers else None

            # 7. Hangup reasons
            reasons_query = select(CallLog.hangup_reason, func.count(CallLog.id))\
                .filter(CallLog.hangup_reason != None, *log_filter)\
                .group_by(CallLog.hangup_reason)
            reasons_rows = db.session.execute(reasons_query).all()
            hangup_reasons = {row[0]: row[1] for row in reasons_rows}

            finished_games_count = db.session.execute(
                select(func.count(Game.id)).filter(Game.result != '*', Game.result != None, *game_filter)
            ).scalar() or 0

            # 8. Activation: do first-time callers get to a move, and finish a game?
            first_call_rows = db.session.execute(
                select(CallLog.game_id, CallLog.started_at, CallLog.first_move_at)
                .filter(CallLog.first_call == True, *log_filter)
            ).all()
            first_calls = len(first_call_rows)
            fc_game_ids = [r[0] for r in first_call_rows if r[0]]
            fc_completed = 0
            if fc_game_ids:
                fc_completed = db.session.execute(
                    select(func.count(Game.id)).filter(
                        Game.id.in_(fc_game_ids), Game.result != '*', Game.result != 'aborted')
                ).scalar() or 0
            first_call_completed_game_rate = round(fc_completed / first_calls, 3) if first_calls else None

            ttfm = sorted(
                int((r[2] - r[1]).total_seconds())
                for r in first_call_rows if r[1] and r[2]
            )
            median_seconds_to_first_move = _percentile(ttfm, 50)

            # 9. ASR health: retries and confirmation loops per successful move
            total_moves, total_retries, total_confirms = db.session.execute(
                select(func.coalesce(func.sum(CallLog.moves_played), 0),
                       func.coalesce(func.sum(CallLog.speech_retries), 0),
                       func.coalesce(func.sum(CallLog.confirm_prompts), 0))
                .filter(*log_filter)
            ).one()
            retries_per_move = round(total_retries / total_moves, 3) if total_moves else None
            confirm_loop_rate = round(total_confirms / total_moves, 3) if total_moves else None

            # 10. Web dial clicks (acquisition beacon)
            event_filter = []
            if start_time:
                event_filter.append(EventLog.created_at >= start_time)
            dial_clicks = db.session.execute(
                select(func.count(EventLog.id)).filter(EventLog.event == "dial_click", *event_filter)
            ).scalar() or 0

            # 11. Telephony cost per completed voice game (estimate from call durations)
            total_minutes = (sum(durations) / 60.0) if durations else 0.0
            est_cost = total_minutes * TWILIO_VOICE_COST_PER_MIN
            cost_per_completed_game = round(est_cost / finished_games_count, 4) if finished_games_count else None

            return {
                "total_calls": total_calls,
                "unique_callers": unique_callers,
                "repeat_caller_rate": repeat_caller_rate,
                "median_call_duration_seconds": median_duration,
                "p90_call_duration_seconds": p90_duration,
                "d7_return_rate": d7_return_rate,
                "voice_games_total": voice_games_count,
                "voice_games_finished": finished_games_count,
                "games_per_caller": games_per_caller,
                "hangup_reasons": hangup_reasons,
                "first_calls": first_calls,
                "first_call_completed_game_rate": first_call_completed_game_rate,
                "median_seconds_to_first_move": median_seconds_to_first_move,
                "moves_played": int(total_moves),
                "speech_retries_per_move": retries_per_move,
                "confirm_loop_rate": confirm_loop_rate,
                "web_dial_clicks": dial_clicks,
                "est_voice_cost_usd": round(est_cost, 2),
                "cost_per_completed_game_usd": cost_per_completed_game,
            }

        all_time_metrics = _get_metrics_for_period(None)
        last_30_days_metrics = _get_metrics_for_period(now_time - timedelta(days=30))

        return jsonify({
            **all_time_metrics,
            "last_30_days": last_30_days_metrics
        })


@app.route("/api/voice", methods=["GET", "POST"])
@twilio_webhook
def voice_call():
    from_phone = request.values.get("From", "")
    phone_clean = "".join(filter(str.isdigit, from_phone))
    if not phone_clean:
        phone_clean = "test_phone"

    with app.app_context():
        _touch_call_log(phone_clean)

        user = db.session.get(User, phone_clean)
        is_new_user = False
        if not user:
            user = User(phone_number=phone_clean)
            db.session.add(user)
            db.session.commit()
            is_new_user = True

        with _lock_for_phone(phone_clean):
            # Check if there is an unacknowledged completed PvP game involving this user
            unack_game = db.session.execute(
                select(Game).filter(
                    Game.source == "voice_pvp",
                    Game.result != "*",
                    or_(
                        and_(Game.white_phone == phone_clean, Game.white_acknowledged == False),
                        and_(Game.black_phone == phone_clean, Game.black_acknowledged == False)
                    )
                ).order_by(Game.created_at.desc())
            ).scalars().first()

            if unack_game:
                if phone_clean == unack_game.white_phone:
                    unack_game.white_acknowledged = True
                else:
                    unack_game.black_acknowledged = True
                db.session.commit()

                opp_num = unack_game.black_phone if phone_clean == unack_game.white_phone else unack_game.white_phone
                opp_display = f"Player {opp_num[-4:]}" if opp_num else "your opponent"
                
                res_str = unack_game.result
                if res_str == "1-0":
                    winner_msg = "White won."
                elif res_str == "0-1":
                    winner_msg = "Black won."
                else:
                    winner_msg = "It was a draw."
                    
                msg = f"Welcome back. Your recent multiplayer game against {opp_display} has ended. The result was {res_str}. {winner_msg}"
                twiml = f"""
                <Say>{_xml_escape(msg)}</Say>
                <Gather input="dtmf speech" numDigits="1" action="/api/voice/play_again" timeout="5" speechTimeout="auto">
                    <Say>Say yes or press 1 to play again, or say no or hang up to end the call.</Say>
                </Gather>
                <Say>Thank you for playing ChessNow. Goodbye.</Say>
                <Hangup/>
                """
                return make_twiml_response(twiml)

            game = find_active_live_game(phone_clean)
            force_new = request.values.get("force_new") or request.args.get("force_new")
            if force_new and game:
                game.result = "aborted"
                db.session.commit()
                game = None

            if not game:
                total_games = db.session.execute(
                    select(func.count(Game.id)).filter_by(user_phone=phone_clean)
                ).scalar()
                if total_games == 0:
                    is_new_user = True

                elo_raw = request.args.get("elo", request.form.get("elo", ""))
                if elo_raw.isdigit():
                    bot_elo = int(elo_raw)
                else:
                    player_rating = user.elo or 1000
                    bot_elo = player_rating + random.randint(-20, 20)

                bot_name = f"Thara ({bot_elo})"
                personality = request.values.get("personality", request.args.get("personality", "formal"))

                user_color = random.choice(["white", "black"])
                if user_color == "white":
                    white_phone = phone_clean
                    black_phone = None
                    white_player = "You"
                    black_player = bot_name
                else:
                    white_phone = None
                    black_phone = phone_clean
                    white_player = bot_name
                    black_player = "You"

                game = Game(
                    id=str(uuid.uuid4()),
                    user_phone=phone_clean,
                    white_phone=white_phone,
                    black_phone=black_phone,
                    source="voice_bot",
                    bot_elo=bot_elo,
                    commentary_style=personality,
                    white_player=white_player,
                    black_player=black_player,
                    pgn="",
                    result="*",
                    player_color=user_color,
                    last_activity_at=datetime.now(timezone.utc).replace(tzinfo=None)
                )
                db.session.add(game)
                db.session.commit()

        _touch_call_log(phone_clean, game_id=game.id)

        user_color = game.player_color or "white"
        board = _board_from_pgn(game.pgn)
        
        is_start_of_game = (len(board.move_stack) == 0)
        confirm_msg = request.args.get("msg", "")

        if board.move_stack and board.is_game_over():
            res = board.result()
            game.result = res
            _finalize_pvp_game_acknowledgment(game, phone_clean)
            db.session.commit()
            return make_twiml_game_over_response(board, game)

        bot_color = chess.WHITE if user_color == "black" else chess.BLACK
        
        if game.source == "voice_pvp":
            turn_phone = game.white_phone if board.turn == chess.WHITE else game.black_phone
            if turn_phone != phone_clean:
                twiml = """
                <Say>Waiting for your opponent to move. Press 1 to resign, press 2 to offer a draw, or call back shortly.</Say>
                <Gather input="dtmf speech" numDigits="1" action="/api/voice/process_move" timeout="5" speechTimeout="auto" hints="{CHESS_VOCABULARY_HINTS}">
                    <Say>Say anything to check again.</Say>
                </Gather>
                <Redirect>/api/voice</Redirect>
                """
                return make_twiml_response(twiml)

        bot_played_san = None
        bot_commentary = None
        if game.source == "voice_bot" and board.turn == bot_color:
            sf_path = find_stockfish()
            if sf_path:
                try:
                    with chess.engine.SimpleEngine.popen_uci(sf_path) as engine:
                        engine_elo = max(1320, min(3190, game.bot_elo or 1500))
                        try:
                            engine.configure({"UCI_LimitStrength": True})
                        except Exception as e:
                            print(f"⚠️ Stockfish limit strength config warning: {e}")
                        try:
                            engine.configure({"UCI_Elo": engine_elo})
                        except Exception as e:
                            print(f"⚠️ Stockfish Elo config warning: {e}")
                        play_res = engine.play(board, chess.engine.Limit(time=0.15))
                        ai_move = play_res.move
                        bot_played_san = board.san(ai_move)
                        board.push(ai_move)
                        _save_pgn(game, board)

                        # Generate AI commentary for bot persona
                        player_move_san = None
                        if len(board.move_stack) >= 2:
                            temp_board = board.copy()
                            temp_board.pop()  # Undo bot's move
                            player_move_obj = temp_board.move_stack[-1] if temp_board.move_stack else None
                            if player_move_obj:
                                temp_board.pop()  # Undo player's move to get SAN
                                player_move_san = temp_board.san(player_move_obj)
                        
                        bot_commentary = generate_bot_commentary(
                            bot_elo=game.bot_elo or 1500,
                            player_move=player_move_san,
                            bot_move=bot_played_san,
                            commentary_style=game.commentary_style or "formal"
                        )

                        if board.is_game_over():
                            res = board.result()
                            game.result = res
                            db.session.commit()
                            prefix_speech = bot_commentary if bot_commentary else f"I play {_san_to_speech(bot_played_san)}."
                            return make_twiml_game_over_response(board, game, prefix=prefix_speech)
                except Exception as e:
                    print(f"Stockfish engine error: {e}")
            else:
                print("Stockfish backend not found")

        if is_start_of_game:
            total_games = db.session.execute(
                select(func.count(Game.id)).filter_by(user_phone=phone_clean)
            ).scalar()
            if total_games <= 1:
                greeting = "Welcome to ChessNow! I'm Thara, your chess companion. Quick tip: at any point during the game, you can press 1 to resign, press 2 to offer a draw, or press 3 to take back a move."
            else:
                greeting = "Welcome back! I'm Thara, your chess companion."

            opponent_name = game.black_player if user_color == "white" else game.white_player
            if user_color == "white":
                msg = f"{greeting} You are playing White against {opponent_name}. What is your first move?"
            else:
                if bot_played_san:
                    if bot_commentary:
                        msg = f"{greeting} You are playing Black against {opponent_name}. {bot_commentary} What is your first move?"
                    else:
                        bot_move_speech = _san_to_speech(bot_played_san)
                        if board.is_check():
                            bot_move_speech += ", check"
                        msg = f"{greeting} You are playing Black against {opponent_name}. I play {bot_move_speech}. What is your first move?"
                else:
                    msg = f"{greeting} You are playing Black against {opponent_name}. What is your first move?"
        else:
            if bot_played_san:
                if bot_commentary:
                    msg = bot_commentary
                else:
                    bot_move_speech = _san_to_speech(bot_played_san)
                    if board.is_check():
                        bot_move_speech += ", check"
                    msg = f"I play {bot_move_speech}."
            else:
                msg = ""

            if confirm_msg:
                if msg:
                    msg = f"{confirm_msg} {msg} What is your move?"
                else:
                    msg = f"{confirm_msg} What is your move?"
            else:
                if msg:
                    msg = f"{msg} What is your move?"
                else:
                    msg = "It is your turn. What is your move?"

        use_streaming = os.environ.get("TWILIO_USE_LOCAL_WHISPER", "false").lower() == "true"
        if use_streaming:
            call_sid = request.values.get("CallSid", "")
            stream_token = _make_stream_token(call_sid)
            stream_url = (
                BASE_URL.replace("https://", "wss://").replace("http://", "ws://")
                + "/api/voice/stream?t=" + urllib.parse.quote(stream_token)
            )
            twiml = f"""
            <Say>{_xml_escape(msg)}</Say>
            <Connect>
                <Stream url="{stream_url}" />
            </Connect>
            """
        else:
            twiml = f"""
            <Say>{_xml_escape(msg)}</Say>
            <Gather input="dtmf speech" numDigits="1" action="/api/voice/process_move" timeout="5" speechTimeout="auto" hints="{CHESS_VOCABULARY_HINTS}">
                <Say>Speak your move.</Say>
            </Gather>
            <Redirect>/api/voice</Redirect>
            """
        return make_twiml_response(twiml)


def _parse_piece_and_target(speech_clean):
    matches = re.findall(r'([a-h][1-8])', speech_clean)
    if not matches:
        return None, None
    target_sq = matches[-1]
    
    piece = chess.PAWN
    if 'n' in speech_clean:
        piece = chess.KNIGHT
    elif 'b' in speech_clean:
        if speech_clean.startswith('b') and len(speech_clean) >= 3 and speech_clean[1] != 'x':
            piece = chess.BISHOP
    elif 'r' in speech_clean:
        if speech_clean.startswith('r') and len(speech_clean) >= 3:
            piece = chess.ROOK
    elif 'q' in speech_clean:
        piece = chess.QUEEN
    elif 'k' in speech_clean:
        piece = chess.KING
        
    return piece, target_sq


@app.route("/api/voice/process_move", methods=["GET", "POST"])
@twilio_webhook
def process_voice_move():
    from_phone = request.values.get("From", "")
    phone_clean = "".join(filter(str.isdigit, from_phone))
    if not phone_clean:
        phone_clean = "test_phone"

    digits = request.values.get("Digits", "").strip()
    digit_commands = {"1": "resign", "2": "draw", "3": "takeback"}
    if digits:
        if digits not in digit_commands:
            return make_twiml_response("<Say>Invalid key. Press 1 to resign, 2 for a draw, or 3 for a takeback.</Say><Redirect>/api/voice</Redirect>")
        speech = digit_commands[digits]
        raw_clean = speech
        speech_clean = speech
    else:
        speech = request.values.get("SpeechResult", "").strip()
        if not speech:
            _bump_call_stats(retries=1)
            return make_twiml_response("<Say>I didn't hear anything. Let's try again.</Say><Redirect>/api/voice</Redirect>")

        raw_clean = speech.lower().replace(".", "").replace(",", "").replace("-", "").replace(" ", "")

        speech_clean = raw_clean.replace("alpha", "a").replace("bravo", "b").replace("charlie", "c")
        speech_clean = speech_clean.replace("delta", "d").replace("echo", "e").replace("foxtrot", "f")
        speech_clean = speech_clean.replace("golf", "g").replace("hotel", "h")

        speech_clean = speech_clean.replace("pawn", "").replace("move", "").replace("play", "")
        speech_clean = speech_clean.replace("knight", "n").replace("night", "n")
        speech_clean = speech_clean.replace("bishop", "b").replace("rook", "r")
        speech_clean = speech_clean.replace("queen", "q").replace("king", "k")
        speech_clean = speech_clean.replace("captures", "x").replace("capture", "x")
        speech_clean = speech_clean.replace("takes", "x").replace("take", "x")
        speech_clean = speech_clean.replace("to", "")

        speech_clean = speech_clean.replace("seefour", "c4").replace("seefive", "c5").replace("see4", "c4").replace("see5", "c5")
        speech_clean = speech_clean.replace("before", "b4").replace("befour", "b4")
        speech_clean = speech_clean.replace("d.four", "d4").replace("deefour", "d4").replace("deefive", "d5")
        speech_clean = speech_clean.replace("e.four", "e4").replace("efour", "e4").replace("efive", "e5")
        speech_clean = speech_clean.replace("eight", "a8").replace("eighty", "a8").replace("ate", "a8")
        speech_clean = speech_clean.replace("f.four", "f4").replace("ffour", "f4").replace("ffive", "f5")
        speech_clean = speech_clean.replace("g.four", "g4").replace("gfour", "g4")
        speech_clean = speech_clean.replace("h.four", "h4").replace("hfour", "h4")

    with app.app_context():
        _touch_call_log(phone_clean)

        game = find_active_live_game(phone_clean)
        if not game:
            return make_twiml_response("<Say>No active game found. Let's start over.</Say><Redirect>/api/voice</Redirect>")

        board = _board_from_pgn(game.pgn)

        # ── Intent Detection (Package 1) ──
        if not digits:
            intent_clean = speech.lower().replace(".", "").replace(",", "").replace("-", "")
            # Normalize NATO phonetics and number formats for matching
            intent_clean = intent_clean.replace("alpha", "a").replace("bravo", "b").replace("charlie", "c")
            intent_clean = intent_clean.replace("delta", "d").replace("echo", "e").replace("foxtrot", "f")
            intent_clean = intent_clean.replace("golf", "g").replace("hotel", "h")
            intent_clean = intent_clean.replace("seefour", "c4").replace("seefive", "c5").replace("see4", "c4").replace("see5", "c5")
            intent_clean = intent_clean.replace("before", "b4").replace("befour", "b4")
            intent_clean = intent_clean.replace("d.four", "d4").replace("deefour", "d4").replace("deefive", "d5")
            intent_clean = intent_clean.replace("e.four", "e4").replace("efour", "e4").replace("efive", "e5")
            intent_clean = intent_clean.replace("eight", "a8").replace("eighty", "a8").replace("ate", "a8")
            intent_clean = intent_clean.replace("f.four", "f4").replace("ffour", "f4").replace("ffive", "f5")
            intent_clean = intent_clean.replace("g.four", "g4").replace("gfour", "g4")
            intent_clean = intent_clean.replace("h.four", "h4").replace("hfour", "h4")

            # 1. Caller's pieces
            if any(k in intent_clean for k in ("repeat", "position", "read the board", "my pieces")):
                caller_color = chess.WHITE if (game.player_color or "white") == "white" else chess.BLACK
                pieces_str = _pieces_to_speech(board, caller_color)
                res_speech = f"Your pieces: {pieces_str}."
                return make_twiml_response(f"<Redirect>/api/voice?msg={urllib.parse.quote(res_speech)}</Redirect>")

            # 2. Opponent's pieces
            if any(k in intent_clean for k in ("opponent pieces", "opponents pieces", "opponent's pieces", "your pieces")):
                bot_color = chess.BLACK if (game.player_color or "white") == "white" else chess.WHITE
                pieces_str = _pieces_to_speech(board, bot_color)
                res_speech = f"Opponent's pieces: {pieces_str}."
                return make_twiml_response(f"<Redirect>/api/voice?msg={urllib.parse.quote(res_speech)}</Redirect>")

            # 3. Square query (requires interrogative "what" or "which" and a square to avoid move hijacking)
            if "what" in intent_clean or "which" in intent_clean or "whats" in intent_clean:
                m = re.search(r'\b([a-h][1-8])\b', intent_clean)
                if not m:
                    m = re.search(r'([a-h][1-8])', intent_clean.replace(" ", ""))
                if m:
                    sq = m.group(1)
                    res_speech = _square_query_to_speech(board, sq)
                    return make_twiml_response(f"<Redirect>/api/voice?msg={urllib.parse.quote(res_speech)}</Redirect>")

            # 4. Last move
            if any(k in intent_clean for k in ("last move", "previous move", "what did you play", "what did you move")):
                res_speech = _last_move_to_speech(board)
                if board.move_stack:
                    temp = board.copy()
                    temp.pop()
                    player_name = "White" if temp.turn == chess.WHITE else "Black"
                    res_speech = f"Last move: {player_name} played {res_speech}."
                return make_twiml_response(f"<Redirect>/api/voice?msg={urllib.parse.quote(res_speech)}</Redirect>")

            # 5. Game status / material count difference
            if any(k in intent_clean for k in ("whose turn", "status", "score", "material", "who to move")):
                res_speech = _game_status_to_speech(board, game)
                return make_twiml_response(f"<Redirect>/api/voice?msg={urllib.parse.quote(res_speech)}</Redirect>")

            # 6. Spoken help menu
            if any(k in intent_clean for k in ("help", "commands", "what can i say", "what commands")):
                res_speech = "You can say a move like, knight to f3, or castle. You can also ask, repeat position, what's on e4, last move, whose turn, or say resign, draw, or takeback."
                return make_twiml_response(f"<Redirect>/api/voice?msg={urllib.parse.quote(res_speech)}</Redirect>")

        # Check if we are waiting for an ambiguous move resolution
        if game.pending_ambiguous_moves:
            try:
                choices_uci = json.loads(game.pending_ambiguous_moves)
            except Exception:
                choices_uci = []
            
            if choices_uci:
                matched_uci_move = None
                if digits:
                    # A pending disambiguation menu must consume its own digit before it ever
                    # reaches the generic resign(1)/draw(2)/takeback(3) shortcuts below — otherwise
                    # pressing "1" to pick the first listed move instead resigns the game.
                    if digits.isdigit():
                        idx = int(digits) - 1
                        if 0 <= idx < len(choices_uci):
                            matched_uci_move = chess.Move.from_uci(choices_uci[idx])
                    if not matched_uci_move:
                        return make_twiml_response(
                            "<Say>Invalid key for that choice. Please try again.</Say><Redirect>/api/voice</Redirect>"
                        )
                else:
                    for uci in choices_uci:
                        from_sq = uci[:2]
                        if from_sq in speech_clean or uci in speech_clean:
                            matched_uci_move = chess.Move.from_uci(uci)
                            break

                if matched_uci_move and matched_uci_move in board.legal_moves:
                    played_san = board.san(matched_uci_move)
                    board.push(matched_uci_move)
                    _save_pgn(game, board)

                    game.pending_ambiguous_moves = None
                    db.session.commit()
                    _bump_call_stats(moves=1)
                    
                    if board.is_game_over():
                        res = board.result()
                        game.result = res
                        _finalize_pvp_game_acknowledgment(game, phone_clean)
                        db.session.commit()
                        return make_twiml_game_over_response(board, game, prefix=f"Ok, you played {_san_to_speech(played_san)}.")
                    
                    played_san_speech = _san_to_speech(played_san)
                    say_msg = f"Ok, you played {played_san_speech}."
                    if board.is_check():
                        say_msg += ", check"
                    
                    if game.source == "voice_pvp":
                        say_msg += " Waiting for your opponent."
                    
                    return make_twiml_response(f"<Redirect>/api/voice?msg={urllib.parse.quote(say_msg)}</Redirect>")
                else:
                    game.pending_ambiguous_moves = None
                    db.session.commit()

        if "resign" in raw_clean:
            game.result = "0-1" if phone_clean == game.white_phone else "1-0"
            _finalize_pvp_game_acknowledgment(game, phone_clean)
            db.session.commit()
            elo_msg = _update_game_elo(game, game.result)
            res_msg = f"You resigned. The game is over.{elo_msg}"
            send_postgame_sms(phone_clean, game.id, "You resigned.", len(board.move_stack))
            twiml = f"""
            <Say>{_xml_escape(res_msg)} Would you like to play another game?</Say>
            <Gather input="dtmf speech" numDigits="1" action="/api/voice/play_again" timeout="5" speechTimeout="auto">
                <Say>Say yes or press 1 to play again, or say no or hang up to end the call.</Say>
            </Gather>
            <Say>Thank you for playing ChessNow. Goodbye.</Say>
            <Hangup/>
            """
            return make_twiml_response(twiml)

        if "draw" in raw_clean:
            if game.source == "voice_bot":
                game.result = "1/2-1/2"
                db.session.commit()
                elo_msg = _update_game_elo(game, game.result)
                res_msg = f"Draw agreed. The game is over.{elo_msg}"
                send_postgame_sms(phone_clean, game.id, "Draw agreed.", len(board.move_stack))
                twiml = f"""
                <Say>{_xml_escape(res_msg)} Would you like to play another game?</Say>
                <Gather input="dtmf speech" numDigits="1" action="/api/voice/play_again" timeout="5" speechTimeout="auto">
                    <Say>Say yes or press 1 to play again, or say no or hang up to end the call.</Say>
                </Gather>
                <Say>Thank you for playing ChessNow. Goodbye.</Say>
                <Hangup/>
                """
                return make_twiml_response(twiml)
            if not game.draw_offered_by:
                game.draw_offered_by = phone_clean
                db.session.commit()
                return make_twiml_response("<Say>Draw offer sent. Waiting for your opponent to respond.</Say><Redirect>/api/voice</Redirect>")
            if game.draw_offered_by != phone_clean:
                game.result = "1/2-1/2"
                game.draw_offered_by = None
                _finalize_pvp_game_acknowledgment(game, phone_clean)
                db.session.commit()
                elo_msg = _update_game_elo(game, game.result)
                res_msg = f"Draw accepted. The game is over.{elo_msg}"
                send_postgame_sms(phone_clean, game.id, "Draw accepted.", len(board.move_stack))
                twiml = f"""
                <Say>{_xml_escape(res_msg)} Would you like to play another game?</Say>
                <Gather input="dtmf speech" numDigits="1" action="/api/voice/play_again" timeout="5" speechTimeout="auto">
                    <Say>Say yes or press 1 to play again, or say no or hang up to end the call.</Say>
                </Gather>
                <Say>Thank you for playing ChessNow. Goodbye.</Say>
                <Hangup/>
                """
                return make_twiml_response(twiml)
            return make_twiml_response("<Say>You already offered a draw. Waiting for your opponent.</Say><Redirect>/api/voice</Redirect>")

        turn_phone = game.white_phone if board.turn == chess.WHITE else game.black_phone
        if turn_phone and turn_phone != phone_clean:
            return make_twiml_response("<Say>It is not your turn yet.</Say><Redirect>/api/voice</Redirect>")

        if "takeback" in raw_clean or "undo" in raw_clean:
            if game.source == "voice_pvp":
                return make_twiml_response("<Say>Takebacks are not supported in phone versus phone games yet.</Say><Redirect>/api/voice</Redirect>")
            plies_to_undo = min(2, len(board.move_stack))
            for _ in range(plies_to_undo):
                board.pop()
            _save_pgn(game, board)
            game.pending_promotion_uci = None
            game.pending_ambiguous_moves = None
            db.session.commit()
            return make_twiml_response("<Redirect>/api/voice?msg=Move taken back.</Redirect>")

        matched_move = None

        if "castle" in raw_clean or raw_clean in ("oo", "ooo", "o-o", "o-o-o"):
            want_queenside = "queenside" in raw_clean or "long" in raw_clean or raw_clean in ("ooo", "o-o-o")
            for m in board.legal_moves:
                if want_queenside and board.is_queenside_castling(m):
                    matched_move = m
                    break
                if not want_queenside and board.is_kingside_castling(m):
                    matched_move = m
                    break

        if not matched_move:
            loose_clean = re.sub(r'^([a-h])[1-8]x([a-h][1-8]=?[qrbn]?)$', r'\1x\2', speech_clean)
            for m in board.legal_moves:
                san = board.san(m)
                san_clean = san.lower().replace("x", "").replace("+", "").replace("#", "").replace("=", "")
                san_lower = san.lower()
                if speech_clean in (san_clean, san_lower) or loose_clean in (san_clean, san_lower):
                    matched_move = m
                    break

        if not matched_move:
            for m in board.legal_moves:
                uci = m.uci()
                if speech_clean == uci or speech_clean == uci[:4]:
                    matched_move = m
                    break

        # Check for Pawn Promotion candidate (if no move matched yet)
        if not matched_move:
            promotion_candidates = []
            for m in board.legal_moves:
                if m.promotion is not None:
                    uci = m.uci()
                    from_sq = chess.square_name(m.from_square)
                    to_sq = chess.square_name(m.to_square)
                    if speech_clean in (to_sq, f"{from_sq}{to_sq}", uci[:4]):
                        promotion_candidates.append(m)
            
            if len(promotion_candidates) > 0:
                promo_m = promotion_candidates[0]
                game.pending_promotion_uci = promo_m.uci()[:4]
                db.session.commit()
                
                twiml = """
                <Say>Your pawn reached the eighth rank. Which piece would you like? Say queen, rook, bishop, or knight.</Say>
                <Gather input="dtmf speech" numDigits="1" action="/api/voice/process_promotion" timeout="5" speechTimeout="auto">
                    <Say>Say queen, rook, bishop, or knight. Or press 1 for queen, 2 for rook, 3 for bishop, 4 for knight.</Say>
                </Gather>
                <Redirect>/api/voice</Redirect>
                """
                return make_twiml_response(twiml)

        # Check for Ambiguous Moves (if no move matched yet)
        if not matched_move:
            piece, target_sq = _parse_piece_and_target(speech_clean)
            if piece and target_sq:
                matching_moves = []
                for m in board.legal_moves:
                    piece_at = board.piece_at(m.from_square)
                    if piece_at and piece_at.piece_type == piece:
                        dest_sq = chess.square_name(m.to_square)
                        if dest_sq == target_sq:
                            matching_moves.append(m)
                
                if len(matching_moves) > 1:
                    game.pending_ambiguous_moves = json.dumps([m.uci() for m in matching_moves])
                    db.session.commit()
                    
                    sq_names = [chess.square_name(m.from_square) for m in matching_moves]
                    sq_speech = [f"{sq[0]} {sq[1]}" for sq in sq_names]
                    
                    piece_names = {
                        chess.KNIGHT: "knight",
                        chess.BISHOP: "bishop",
                        chess.ROOK: "rook",
                        chess.QUEEN: "queen",
                        chess.KING: "king",
                        chess.PAWN: "pawn"
                    }
                    piece_name = piece_names[piece]
                    choices_str = " or the one on ".join(sq_speech)
                    
                    twiml = f"""
                    <Say>Which {_xml_escape(piece_name)}? The one on {_xml_escape(choices_str)}?</Say>
                    <Gather input="dtmf speech" numDigits="1" action="/api/voice/process_move" timeout="5" speechTimeout="auto" hints="{CHESS_VOCABULARY_HINTS}">
                        <Say>Say the starting square, like {_xml_escape(sq_names[0])} or {_xml_escape(sq_names[1])}.</Say>
                    </Gather>
                    <Redirect>/api/voice</Redirect>
                    """
                    return make_twiml_response(twiml)
                elif len(matching_moves) == 1:
                    candidate_move = matching_moves[0]
                    san = board.san(candidate_move)
                    game.pending_confirmation_uci = candidate_move.uci()
                    db.session.commit()
                    _bump_call_stats(confirms=1)
                    
                    twiml = f"""
                    <Say>I heard {_xml_escape(_san_to_speech(san))}. Press 1 or say yes to play it, or say no to try again.</Say>
                    <Gather input="dtmf speech" numDigits="1" action="/api/voice/confirm_move" timeout="5" speechTimeout="auto" hints="yes, no, play, cancel, try again">
                        <Say>Press 1 or say yes to play it, or say no to try again.</Say>
                    </Gather>
                    <Redirect>/api/voice</Redirect>
                    """
                    return make_twiml_response(twiml)

        if matched_move:
            played_san = board.san(matched_move)
            board.push(matched_move)
            _save_pgn(game, board)
            _bump_call_stats(moves=1)
            if game.draw_offered_by:
                game.draw_offered_by = None
                db.session.commit()

            if board.is_game_over():
                res = board.result()
                game.result = res
                _finalize_pvp_game_acknowledgment(game, phone_clean)
                db.session.commit()
                return make_twiml_game_over_response(board, game, prefix=f"Ok, you played {_san_to_speech(played_san)}.")

            played_san_speech = _san_to_speech(played_san)
            say_msg = f"Ok, you played {played_san_speech}."
            if board.is_check():
                say_msg += ", check"
            
            if game.source == "voice_pvp":
                say_msg += " Waiting for your opponent."
            
            return make_twiml_response(f"<Redirect>/api/voice?msg={urllib.parse.quote(say_msg)}</Redirect>")
        else:
            _bump_call_stats(retries=1)
            say_msg = f"Sorry, {speech} is not a legal move. Let's try again."

        twiml = f"""
        <Say>{_xml_escape(say_msg)}</Say>
        <Redirect>/api/voice</Redirect>
        """
        return make_twiml_response(twiml)


@app.route("/api/voice/process_promotion", methods=["POST"])
@twilio_webhook
def process_voice_promotion():
    from_phone = request.form.get("From", "")
    phone_clean = "".join(filter(str.isdigit, from_phone))
    if not phone_clean:
        phone_clean = "test_phone"

    digits = request.form.get("Digits", "").strip()
    speech = request.form.get("SpeechResult", "").strip().lower()

    choice = None
    if digits == "1" or "queen" in speech or "q" in speech:
        choice = "q"
    elif digits == "2" or "rook" in speech or "r" in speech:
        choice = "r"
    elif digits == "3" or "bishop" in speech or "b" in speech:
        choice = "b"
    elif digits == "4" or "knight" in speech or "n" in speech:
        choice = "n"

    with app.app_context():
        game = find_active_live_game(phone_clean)
        if not game or not game.pending_promotion_uci:
            return make_twiml_response("<Say>Sorry, I couldn't find your pending promotion. Let's try again.</Say><Redirect>/api/voice</Redirect>")

        if not choice:
            twiml = """
            <Say>Invalid choice. Please say queen, rook, bishop, or knight. Or press 1 for queen, 2 for rook, 3 for bishop, 4 for knight.</Say>
            <Gather input="dtmf speech" numDigits="1" action="/api/voice/process_promotion" timeout="5" speechTimeout="auto">
                <Say>Say queen, rook, bishop, or knight.</Say>
            </Gather>
            <Redirect>/api/voice</Redirect>
            """
            return make_twiml_response(twiml)

        full_uci = f"{game.pending_promotion_uci}{choice}"
        board = _board_from_pgn(game.pgn)
        move = chess.Move.from_uci(full_uci)
        
        if move in board.legal_moves:
            played_san = board.san(move)
            board.push(move)
            _save_pgn(game, board)
            _bump_call_stats(moves=1)
            pending_uci = game.pending_promotion_uci
            game.pending_promotion_uci = None
            db.session.commit()
            
            piece_names = {"q": "Queen", "r": "Rook", "b": "Bishop", "n": "Knight"}
            confirm_piece = piece_names[choice]
            
            dest_sq = pending_uci[-2:]
            dest_sq_speech = f"{dest_sq[0]} {dest_sq[1]}"
            say_msg = f"Ok, you promoted to {confirm_piece} on {dest_sq_speech}."
            if board.is_check():
                say_msg += ", check"
            
            return make_twiml_response(f"<Redirect>/api/voice?msg={urllib.parse.quote(say_msg)}</Redirect>")
        else:
            game.pending_promotion_uci = None
            db.session.commit()
            return make_twiml_response("<Say>That move is no longer legal. Let's try again.</Say><Redirect>/api/voice</Redirect>")


@app.route("/api/voice/confirm_move", methods=["POST"])
@twilio_webhook
def voice_confirm_move():
    """Handles confirmation of fallback-parsed moves (low confidence)."""
    from_phone = request.values.get("From", "")
    phone_clean = "".join(filter(str.isdigit, from_phone))
    if not phone_clean:
        phone_clean = "test_phone"

    digits = request.values.get("Digits", "").strip()
    speech = request.values.get("SpeechResult", "").strip().lower()

    is_yes = (digits == "1") or ("yes" in speech) or ("yeah" in speech) or ("sure" in speech) or ("play" in speech)
    is_no = (digits == "2") or ("no" in speech) or ("cancel" in speech) or ("try again" in speech)

    with app.app_context():
        _touch_call_log(phone_clean)
        game = find_active_live_game(phone_clean)
        if not game or not game.pending_confirmation_uci:
            return make_twiml_response("<Say>Sorry, I couldn't find your pending move. Let's try again.</Say><Redirect>/api/voice</Redirect>")

        board = _board_from_pgn(game.pgn)
        move_uci = game.pending_confirmation_uci
        
        # Clear it immediately so it doesn't linger
        game.pending_confirmation_uci = None
        db.session.commit()

        if is_yes:
            move = chess.Move.from_uci(move_uci)
            if move in board.legal_moves:
                played_san = board.san(move)
                board.push(move)
                _save_pgn(game, board)
                _bump_call_stats(moves=1)

                if board.is_game_over():
                    res = board.result()
                    game.result = res
                    _finalize_pvp_game_acknowledgment(game, phone_clean)
                    db.session.commit()
                    return make_twiml_game_over_response(board, game, prefix=f"Ok, you played {_san_to_speech(played_san)}.")

                played_san_speech = _san_to_speech(played_san)
                say_msg = f"Ok, you played {played_san_speech}."
                if board.is_check():
                    say_msg += ", check"
                
                if game.source == "voice_pvp":
                    say_msg += " Waiting for your opponent."
                
                db.session.commit()
                return make_twiml_response(f"<Redirect>/api/voice?msg={urllib.parse.quote(say_msg)}</Redirect>")
            else:
                return make_twiml_response("<Say>That move is no longer legal. Let's try again.</Say><Redirect>/api/voice</Redirect>")
        else:
            # Caller rejected the low-confidence guess — the original parse was wrong.
            _bump_call_stats(retries=1)
            return make_twiml_response("<Say>Okay, let's try again.</Say><Redirect>/api/voice</Redirect>")


@app.route("/api/voice/play_again", methods=["POST"])
@twilio_webhook
def voice_play_again():
    from_phone = request.form.get("From", "")
    phone_clean = "".join(filter(str.isdigit, from_phone))
    if not phone_clean:
        phone_clean = "test_phone"

    digits = request.form.get("Digits", "").strip()
    speech = request.form.get("SpeechResult", "").strip().lower()

    if digits == "1" or "yes" in speech or "yeah" in speech or "sure" in speech or "play" in speech or "again" in speech:
        with app.app_context():
            game = find_active_live_game(phone_clean)
            if game:
                game.result = "aborted"
                db.session.commit()
        return make_twiml_response("<Say>Starting a new game.</Say><Redirect>/api/voice</Redirect>")
    else:
        return make_twiml_response("<Say>Thank you for playing ChessNow. Goodbye.</Say><Hangup/>")


if __name__ == "__main__":
    print("\n♟  Chess Analyzer — Local Edition")
    print("─" * 42)
    # load_cache() is now called at the module level
    sf = find_stockfish()
    if sf:
        print(f"✅  Stockfish: {sf}")
    else:
        print("⚠️   Stockfish not found — install with: brew install stockfish")
    port = int(os.environ.get("PORT", 5174))
    print(f"\n🌐  http://0.0.0.0:{port}")
    print("─" * 42 + "\n")
    app.run(debug=False, host="0.0.0.0", port=port, threaded=True)

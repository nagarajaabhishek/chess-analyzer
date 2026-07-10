from flask_sqlalchemy import SQLAlchemy
from datetime import datetime, timezone

db = SQLAlchemy()

class User(db.Model):
    __tablename__ = "users"
    phone_number = db.Column(db.String(30), primary_key=True)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))
    elo = db.Column(db.Integer, default=1000)
    sms_opt_out = db.Column(db.Boolean, default=False)  # STOP replies / Twilio 21610
    display_name = db.Column(db.String(40), nullable=True)  # friendly name for SMS / PvP labels
    
    # Relationship to games
    games = db.relationship("Game", backref="user", lazy=True, cascade="all, delete-orphan")

    def __init__(self, **kwargs):
        super().__init__(**kwargs)

class CallLog(db.Model):
    """One row per inbound Twilio call — the raw material for retention metrics
    (repeat-caller rate, call duration, games per caller)."""
    __tablename__ = "call_logs"
    id = db.Column(db.String(36), primary_key=True)
    call_sid = db.Column(db.String(64), unique=True, nullable=False, index=True)
    phone_number = db.Column(db.String(30), nullable=True, index=True)
    started_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))
    ended_at = db.Column(db.DateTime, nullable=True)      # best-effort bump on every webhook; exact via status callback
    duration_seconds = db.Column(db.Integer, nullable=True)  # authoritative, from Twilio CallDuration
    game_id = db.Column(db.String(36), db.ForeignKey("games.id"), nullable=True)
    hangup_reason = db.Column(db.String(30), nullable=True)  # CallStatus at completion: completed|busy|failed|no-answer|canceled
    call_type = db.Column(db.String(30), nullable=True)     # type of call e.g. inbound

    # Activation & ASR-health instrumentation (product-expansion-v2 item 3)
    first_call = db.Column(db.Boolean, default=False)       # this phone's first-ever call
    moves_played = db.Column(db.Integer, default=0)         # successful moves in this call
    speech_retries = db.Column(db.Integer, default=0)       # empty/unparseable/illegal inputs
    confirm_prompts = db.Column(db.Integer, default=0)      # low-confidence confirmation loops triggered
    first_move_at = db.Column(db.DateTime, nullable=True)   # when the first successful move landed

    def __init__(self, **kwargs):
        super().__init__(**kwargs)


class EventLog(db.Model):
    """Lightweight client-side event beacon (e.g. web dial-button clicks) so the
    web→phone acquisition step is measurable."""
    __tablename__ = "event_logs"
    id = db.Column(db.String(36), primary_key=True)
    event = db.Column(db.String(40), nullable=False, index=True)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None), index=True)

    def __init__(self, **kwargs):
        super().__init__(**kwargs)

class Game(db.Model):
    __tablename__ = "games"
    id = db.Column(db.String(36), primary_key=True)
    user_phone = db.Column(db.String(30), db.ForeignKey("users.phone_number"), nullable=False)
    white_player = db.Column(db.String(100), default="White")
    black_player = db.Column(db.String(100), default="Black")
    pgn = db.Column(db.Text, default="")
    white_accuracy = db.Column(db.Float, default=0.0)
    black_accuracy = db.Column(db.Float, default=0.0)
    opening = db.Column(db.String(150), default="Unknown Opening")
    result = db.Column(db.String(20), default="*")
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))

    # Live voice/call play (bot or phone-vs-phone)
    source = db.Column(db.String(20), default="analyzed")  # "analyzed" | "voice_bot" | "voice_pvp"
    white_phone = db.Column(db.String(30), nullable=True)  # caller phone playing White (live games only)
    black_phone = db.Column(db.String(30), nullable=True)  # opponent phone playing Black (voice_pvp only)
    bot_elo = db.Column(db.Integer, nullable=True)          # locked in at game creation, doesn't drift per-call
    commentary_style = db.Column(db.String(30), default="formal") # "formal" | "minimal"
    draw_offered_by = db.Column(db.String(30), nullable=True)  # phone of whoever last offered a draw (voice_pvp)
    pending_promotion_uci = db.Column(db.String(5), nullable=True)  # e.g., 'e7e8'
    pending_ambiguous_moves = db.Column(db.Text, nullable=True)  # e.g., JSON list of UCI moves
    pending_confirmation_uci = db.Column(db.String(5), nullable=True) # e.g. 'e2e4' (low confidence fallback)
    player_color = db.Column(db.String(5), nullable=True)  # 'white' or 'black'
    last_activity_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))  # bumped on every real move
    white_acknowledged = db.Column(db.Boolean, default=False)
    black_acknowledged = db.Column(db.Boolean, default=False)
    hints_used = db.Column(db.Integer, default=0)  # engine hints spoken this game (cap 3, bot games)

    def __init__(self, **kwargs):
        super().__init__(**kwargs)


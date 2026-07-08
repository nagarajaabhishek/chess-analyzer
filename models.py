from flask_sqlalchemy import SQLAlchemy
from datetime import datetime, timezone

db = SQLAlchemy()

class User(db.Model):
    __tablename__ = "users"
    phone_number = db.Column(db.String(30), primary_key=True)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))
    elo = db.Column(db.Integer, default=1000)
    
    # Relationship to games
    games = db.relationship("Game", backref="user", lazy=True, cascade="all, delete-orphan")

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
    player_color = db.Column(db.String(5), nullable=True)  # 'white' or 'black'
    last_activity_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))  # bumped on every real move
    white_acknowledged = db.Column(db.Boolean, default=False)
    black_acknowledged = db.Column(db.Boolean, default=False)

    def __init__(self, **kwargs):
        super().__init__(**kwargs)


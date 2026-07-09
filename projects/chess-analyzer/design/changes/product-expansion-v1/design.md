# OpenSpec Design: Product Expansion v1

- Helper functions: `_pieces_to_speech`, `_square_query_to_speech`, `_game_status_to_speech`, `_last_move_to_speech`.
- Custom routes:
  - `POST /api/voice/call_status` for twilio hangup updates.
  - `GET /api/admin/metrics` for administrators.
  - `POST /api/voice/confirm_move` for low-confidence confirmations.
  - Static routing for `/faq`, `/accessibility`, `/guides/blindfold-chess`, `/guides/voice-commands`.

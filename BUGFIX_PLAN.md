# Bug Fix Plan

Source: `bug-hunt` 3-agent adversarial review (Hunter → Skeptic → Referee) of the full codebase, run 2026-07-08. 19 of 20 reported issues confirmed real; 1 dismissed as intentional design (see Dismissed section).

Ordered by priority. Each item includes files/lines and a suggested fix direction.

---

## Phase 1 — Critical security (voice/Twilio surface + XSS)

These are all reachable by any unauthenticated HTTP/WS client and should be fixed before this app is exposed publicly.

- [ ] **Verify Twilio webhook signatures.** No route validates `X-Twilio-Signature`, so `From` and all form params can be forged.
  - Files: `app.py` — all `/api/voice*` routes (~979-1892)
  - Fix: add `twilio.request_validator.RequestValidator` check (reject if signature missing/invalid) as a decorator on every voice webhook route.

- [ ] **Escape text interpolated into TwiML `<Say>`.** `confirm_msg`, `speech`, and Gemini `bot_commentary` are f-string'd unescaped into XML — TwiML injection.
  - Files: `app.py:772-778` (`make_twiml_response`), `1357`, `1456-1465`, `1477-1484`, `1802`
  - Fix: escape all interpolated values with `xml.sax.saxutils.escape` before building the `<Say>` string (or centralize in `make_twiml_response`).

- [ ] **Require real proof of phone ownership for `/api/auth`.** Currently logs in as any phone number supplied in the request body.
  - Files: `app.py:610-630`
  - Fix: add SMS OTP verification step before creating/returning a session for a phone number.

- [ ] **Fix IDOR on `/api/games`.** Returns any user's full game history/PGNs keyed only by an unauthenticated `phone` query param.
  - Files: `app.py:633-663`
  - Fix: gate behind an authenticated session token scoped to the phone number (depends on the auth fix above).

- [ ] **Fix stored XSS via PGN headers.** `White`/`Black` PGN header values are saved unsanitized and later rendered via `innerHTML`.
  - Files: `app.py:204-205, 316-337, 466-531`, `static/app.js:2701-2717`
  - Fix: HTML-escape on render, or switch to `textContent`/DOM node construction instead of `innerHTML`.

- [ ] **Authenticate the voice WebSocket before acting on `callSid`.** A client-supplied `callSid` is used to redirect a live Twilio call with no ownership check.
  - Files: `app.py:979-1052` (`voice_stream`, `redirect_twilio_call`)
  - Fix: require a server-issued signed token (echoed back in the `start` event) tying the WS connection to a specific call, instead of trusting a bare client-supplied SID.

---

## Phase 2 — Medium: correctness, data integrity, deployment

- [ ] **Notify both players when a PvP voice game ends.** Only the player whose move ends the game gets the game-over message; the opponent's next call silently starts a new bot game.
  - Files: `app.py:1115-1146, 1359-1363`
  - Fix: before creating a new game for a caller, check for a recently-concluded PvP game involving their phone that hasn't been acknowledged, and play the result first.

- [ ] **Don't orphan the invitee's active game in `voice_challenge`.** Only the challenger's stale game is aborted; the invitee's in-progress game (if any) is never cleaned up.
  - Files: `app.py:1151-1192`
  - Fix: also run the stale-game-abort check for `opponent_clean` before creating the new challenge row.

- [ ] **Lock the analysis cache file write.** `save_cache()` does an unlocked truncate-write from per-request background threads — concurrent analyses can corrupt `analysis_cache.json`.
  - Files: `app.py:105-110, 312-314, 526-530`
  - Fix: guard with a `threading.Lock()`, or write to a temp file + `os.replace()` for atomicity.

- [ ] **Pin `audioop` replacement for Python 3.13+.** `audioop` was removed from the stdlib in 3.13; no `audioop-lts` backport is pinned.
  - Files: `app.py:22`, `requirements.txt`
  - Fix: add `audioop-lts; python_version>=\"3.13\"` to `requirements.txt`, or pin a Python runtime below 3.13.

- [ ] **Re-sync the iOS Capacitor bundle.** `ios/App/App/public/app.js` is a stale copy missing the `await checkStockfish()` fix in `static/app.js` — iOS always tries the backend path first on load.
  - Files: `static/app.js` (~1787-1801) vs `ios/App/App/public/app.js` (~1774-1785)
  - Fix: re-copy/rebuild the Capacitor bundle from `static/`; ideally wire this into a build step so the two never drift again.

- [ ] **Make `load_cache()` run under any server, not just `python app.py`.** Currently only called inside `if __name__ == "__main__":`.
  - Files: `app.py:95-103, 1895-1898`
  - Fix: move the call to module level (outside the `__main__` guard). Low priority today since the app is run directly, but cheap to fix and removes a latent trap if deployment ever moves to gunicorn/WSGI.

---

## Phase 3 — Low priority / cleanup

- [ ] **iOS bundle missing underpromotion picker** — always auto-queens on iOS. `ios/App/App/public/app.js:~582` vs `static/app.js:582-594`. Fixed by the same re-sync as above.
- [ ] **Voice move parser picks source square instead of destination** when speech states both (e.g. "knight b1 c3"). `app.py:1487-1507` — use `re.findall` and take the last match instead of `re.search`'s first match.
- [ ] **Undefined CSS custom properties** (`--card-1`, `--border-1`, `--text-1`, `--gold`) referenced but never defined in `:root`, silently dropping those style rules. `static/style.css:4-35, 1068-1070, 2168-2200`. Define the missing tokens or rename usages to the ones that exist (`--card`, `--border`, `--text`, `--accent`).
- [ ] **`_active_game_locks` grows unbounded** — one `threading.Lock` per unique phone number, never evicted. `app.py:1106-1112`. Low real-world impact; add eviction if it matters.
- [ ] **VAD `audio_buffer` unbounded** if a caller speaks continuously without a pause. `app.py:990, 1024-1034`. Add a max-size/duration cap.
- [ ] **Chess.com opponent/opening names rendered via unescaped `innerHTML`.** `static/app.js:234-263`. Escape or use `textContent`.
- [ ] **Unused `twilio` dependency** in `requirements.txt` — all Twilio calls go through raw `requests`. Either remove it, or actually use `twilio.request_validator.RequestValidator` to fix the Phase 1 signature-validation item.

---

## Dismissed (not a bug)

- **CPL cap mismatch (1000 for display vs 300 for accuracy calc)** — `app.py:256-266, 280`. This is a deliberate, commented design choice: show the user the true blunder magnitude while capping the accuracy-formula input so one catastrophic blunder doesn't crush the score. No fix needed.

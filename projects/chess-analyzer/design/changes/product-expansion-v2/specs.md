# OpenSpec Specifications: Product Expansion v2

## Wave 0 — Guardrails & measurement
1. **Copy fixes**: no "driving" language anywhere (hero, use-case cards, keyword tags, guide pages); reframe to walking/transit/chores.
2. **Live-games privacy**: `/api/games/live` returns anonymized display names (never phone digits), capped (e.g. 12 most recent), ordered by `last_activity_at`; games private by default with per-game opt-in share flag.
3. **Instrumentation**: extend `CallLog`/metrics with — first-call completed-game rate, time-to-first-successful-move, confirmation-loop trigger rate, speech retries per move, web dial-click event, Twilio cost per completed game. Surface all in `/api/admin/metrics` alongside existing D7/repeat-caller/duration.

## Wave 1 — Growth & activation
4. **Invite SMS**: on challenge creation, one SMS to invitee with challenger display name, hotline number, one-line how-to, and STOP opt-out; never re-sent; suppressed for opted-out numbers.
5. **First-call onboarding**: `is_new_user` branch speaks a ≤15s orientation (move syntax example, "say help anytime"); first-timers assigned White; "help" intent lists 3 context-relevant commands mid-game.
6. **Calibration**: first-call question "new, casual, or rated?" seeds Elo 800/1200/1600; lobby exposes difficulty via existing `elo` param.

## Wave 2 — Forgiveness & retention
7. **Takeback/hint intents**: spoken "take that back" mirrors DTMF-3 takeback; "hint"/"what would you play" speaks engine best move (limited per game).
8. **Rating payoff**: game-end speech includes Elo delta; milestone crossings (every 100) celebrated; same data in recap SMS.
9. **Analysis deep link**: recap SMS links to `/game/<id>?review=1` which opens the analyzer on that game (auth handoff via signed token, no OTP re-entry).

## Wave 3 — Marketing surfaces
10. **Hero audio demo**: play button + 20s caller/Thara exchange with synced transcript; pre-recorded asset, browser-TTS fallback.
11. **Speak-your-first-move demo**: mic button on hero; Web Speech API recognition → existing move parser → board plays move → TTS Thara reply; 3 exchanges then dial CTA; tappable move chips as fallback.
12. **Ambient proof**: anonymized live-game ticker + real counters from metrics aggregates (public-safe subset).
13. **Testimonials** replace visible keyword tags (keywords move to meta only).

## Waves 4–5 — Widening & strategic
14. Lichess username import + paste-a-PGN. 15. Shareable review card image. 16. Weekly digest SMS + streaks + caller display names. 17. "Ask Thara" page concierge (Claude API via Flask proxy, rate-limited, budget-capped, whitelisted actions). 18. WCAG 2.2 AA audit + moderated screen-reader sessions before a11y marketing claims. 19. Monetization experiment gated on cost-per-game + retention data. 20. Browser WebRTC calling for international reach.

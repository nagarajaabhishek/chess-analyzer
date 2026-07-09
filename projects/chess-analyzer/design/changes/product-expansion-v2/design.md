# OpenSpec Design: Product Expansion v2

## Sequencing logic
Order = ICE score (`research/2026-07-09-prioritization.md`) adjusted for hard dependencies:
- **Wave 0 first, always.** Items 1–2 are cheap risk fixes that gate every outward-facing move (press, a11y outreach, ambient-proof marketing). Item 3 (instrumentation) must precede items 4–9 so their impact is measurable — its absence is why onboarding confidence scored only 7.
- **Growth before polish.** The invite SMS (ICE 576, rank 1) ships before retention features: each challenge delivers the phone number to a new user with a friend's endorsement.
- **Marketing surfaces only after guardrails.** Items 10–13 drive traffic to the funnel that items 4–6 fixed and item 3 measures.
- **Strategic items last and data-gated.** Monetization (19) needs cost-per-game from (3); a11y marketing (18) needs the audit; WebRTC (20) needs monetization signal.

## Dependency graph (blocking edges only)
```
1 (copy) ──────────────┬─▶ 10,11,13 (marketing surfaces)      ┌─▶ 18 (a11y audit → outreach)
2 (privacy) ───────────┼─▶ 12 (ambient proof), spectator links┘
3 (instrumentation) ───┼─▶ 4–9 measurable ─▶ 16 (digest uses same data)
                       └─▶ 19 (monetization needs cost-per-game)
4 (invite SMS) ────────▶ 16 (display names reused)
5 (onboarding) ────────▶ 6 (calibration rides the same greeting flow)
10/11 (page voice) ────▶ 17 (concierge gated on proven engagement)
14 (imports) ─ soft ──▶ 15 (share cards benefit from wider input)
```

## Key implementation notes
- **Item 3** extends the existing `CallLog` model + `/api/admin/metrics` (server/models.py, server/app.py) — add per-call move/retry counters bumped in `process_move`/`confirm_move`, a `first_call` flag, and a client-side `dial_click` beacon endpoint.
- **Item 4** reuses the recap-SMS Twilio send path in server/app.py; store an `sms_opt_out` flag on `User`; TCPA copy: single message, STOP honored.
- **Items 5–8** are TwiML-only changes in the `/api/voice*` routes; takeback logic already exists behind DTMF 3 — item 7 adds a speech intent to the existing keyword matcher (Package 1 of v1).
- **Item 11** reuses the client-side move parser and board renderer in client/static/app.js; `webkitSpeechRecognition` with tappable-chip fallback; no build tooling (framework-free constraint).
- **Item 9** needs a signed one-time token in the recap link so the analyzer opens the game without an OTP round trip — do not weaken `token_required` on other routes.

## Explicitly out of scope
Repo split (see `repository_split_analysis.md`), Cloud Run migration, native iOS features beyond the existing Capacitor wrapper.

# OpenSpec Proposal: Product Expansion v2

## Problem Statement
The 2026-07-09 product research (see `projects/chess-analyzer/research/`) found ChessNow's differentiation solid but three seams leaking: the PvP referral loop never notifies the invitee, the first call (the churn moment) has no onboarding and no measurement, and the marketing page sells a voice product silently. Two risk items (driving claims, public live-games feed) gate any press or accessibility-community outreach.

## Proposal
Implement twenty items in five dependency-ordered waves:
- **Wave 0 — Guardrails & measurement** (items 1–3): copy/privacy fixes and funnel + ASR instrumentation. Prerequisites for everything downstream.
- **Wave 1 — Growth & activation** (items 4–6): challenge invite SMS, first-call onboarding script, Elo calibration.
- **Wave 2 — Forgiveness & retention** (items 7–9): voice takeback/hint intents, spoken rating deltas, recap-SMS analysis deep link.
- **Wave 3 — Marketing surfaces** (items 10–13): hero audio demo, speak-your-first-move interactive demo, ambient proof ticker, testimonials.
- **Wave 4/5 — Widening & strategic** (items 14–20): Lichess/PGN import, share cards, digest SMS, Ask-Thara concierge, WCAG audit, monetization, WebRTC/international.

Prioritization basis: ICE scoring in `research/2026-07-09-prioritization.md` (invite SMS #1 at 576), adjusted for hard dependencies (instrumentation before the onboarding work it evaluates; privacy/claims fixes before anything outward-facing).

# OpenSpec Tasks: Product Expansion v2

Ordered execution checklist — one item at a time, top to bottom. Effort: S ≤ half day, M ≈ 1–2 days, L = multi-day. Deps reference item numbers.

## Wave 0 — Guardrails & measurement
- [ ] **1. Remove driving claims** (S, no deps) — sweep index.html hero/use-case copy, keyword tags, guide pages; reframe to walking/transit/chores.
- [ ] **2. Live-feed privacy** (S, no deps) — anonymize `/api/games/live` display names, cap to 12, add per-game share opt-in; games private by default.
- [ ] **3. Funnel + ASR instrumentation** (M, no deps; gates 4–9, 16, 19) — first-call completed-game rate, time-to-first-move, confirm-loop rate, retries/move, dial-click beacon, cost per completed game → `/api/admin/metrics`.

## Wave 1 — Growth & activation
- [ ] **4. Challenge invite SMS** (S, dep 3 for measurement; ICE 576) — invite message + STOP opt-out + challenger display name.
- [ ] **5. First-call onboarding script** (S/M, dep 3) — `is_new_user` orientation ≤15s, "say help anytime", first-timers get White, contextual help intent.
- [ ] **6. Elo calibration + difficulty selector** (S, dep 5) — "new/casual/rated?" seeds 800/1200/1600; lobby exposes existing `elo` param.

## Wave 2 — Forgiveness & retention
- [ ] **7. Voice takeback + hint intents** (M, no hard dep) — speech mirror of DTMF-3; engine-hint intent, limited per game.
- [ ] **8. Spoken rating deltas + milestones** (S, no dep) — Elo change at game end; 100-point milestone celebrations; delta in recap SMS.
- [ ] **9. Recap → analysis deep link** (M, no dep) — signed one-time token opens analyzer on that game, no OTP re-entry.

## Wave 3 — Marketing surfaces (deps: 1, 2)
- [ ] **10. Hero audio demo** (S) — 20s recorded caller/Thara exchange + synced transcript; TTS fallback.
- [ ] **11. "Speak your first move" hero demo** (M) — Web Speech API → existing parser → board + TTS reply; chip fallback; dial CTA.
- [ ] **12. Ambient proof** (S, dep 2) — anonymized ticker + real game counters.
- [ ] **13. Testimonials replace keyword tags** (S, needs real quotes from early outreach).

## Wave 4 — Widening & retention layer
- [ ] **14. Lichess + PGN import** (M).
- [ ] **15. Shareable review cards** (M, soft dep 14).
- [ ] **16. Weekly digest SMS + streaks + caller names** (M, deps 3, 4).
- [ ] **17. "Ask Thara" page concierge** (M/L, dep: engagement data from 10/11; budget-capped Claude proxy).

## Wave 5 — Strategic (data-gated)
- [ ] **18. WCAG 2.2 AA audit + screen-reader sessions → a11y outreach** (L, deps 1, 2).
- [ ] **19. Monetization experiment** (L, dep: 4+ weeks of cost-per-game + retention data from 3).
- [ ] **20. Browser WebRTC calling / international** (L, dep 19 signal).

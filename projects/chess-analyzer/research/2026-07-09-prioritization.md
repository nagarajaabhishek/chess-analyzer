# Prioritization Framework Recommendation — ChessNow

> Produced by executing the `prioritization-advisor` skill (v0.82) from
> [deanpeters/Product-Manager-Skills](https://github.com/deanpeters/Product-Manager-Skills)
> (CC BY-NC-SA 4.0) against the P0/P1 roadmap from the 2026-07-09 product research session.
> Input context supplied as a context dump; the skill's four assessment questions were
> answered from session findings rather than re-asked.

**Based on our context:**
- **Product Stage:** Pre-product/market fit — the admin metrics endpoint literally frames its purpose as "the viability question: do people call back, and for how long?" High uncertainty; speed matters.
- **Team Context:** Small team, limited resources — solo builder plus coding agents; no bandwidth for heavyweight scoring rituals.
- **Decision-Making Need:** Too many ideas, unclear sequencing — a 12-item P0/P1/P2 list spanning growth, onboarding, instrumentation, and risk fixes.
- **Data Availability:** Minimal — call logs and D7 retention exist, but activation and ASR-health metrics (the ones that would feed Reach/Impact estimates) are exactly the gaps on the roadmap.

---

## Recommended Framework: ICE (Impact, Confidence, Ease)

**Why this fits (and why not RICE):**
- No usage data to estimate Reach — RICE's first factor is unanswerable today; the skill's own guidance flags Pre-PMF + minimal data + RICE as a bad match.
- Solo-builder context: 8 items can be ICE-scored in one sitting; RICE's overhead buys nothing.
- Pre-PMF means the goal is learning velocity, not scoring rigor — ICE is honest about being a structured gut-check.

**When to use it:** re-scoring the backlog monthly, or whenever a new idea competes for the next build slot.

**When NOT to use it:** once activation/ASR instrumentation (item 3 below) produces real reach data — graduate to RICE at that point. That instrumentation item is, in effect, the down payment on a better prioritization framework.

---

## ICE Scoring — P0/P1 roadmap items

Scale 1–10 per factor; score = I × C × E (Sean McBride variant). Scored solo; per the skill's pitfall #4, re-score collaboratively if a second contributor joins.

| # | Item | Impact | Confidence | Ease | ICE | Rank |
|---|------|--------|------------|------|-----|------|
| 1 | Challenge invite SMS (+ opt-out copy) | 9 | 8 | 8 | **576** | 1 |
| 4 | Remove "driving" claims; anonymize + cap live-games feed | 6 | 9 | 9 | **486** | 2 |
| 3 | Instrument activation & ASR health (first-move success, confirm-loop rate) | 7 | 9 | 7 | **441** | 3 |
| 2 | First-call onboarding script + "say help anytime" | 8 | 7 | 7 | **392** | 4 |
| 6 | Elo calibration question; expose difficulty in lobby | 6 | 7 | 8 | **336** | 5 |
| 5 | Voice takeback + hint intents; spoken rating deltas | 7 | 7 | 6 | **294** | 6= |
| 7 | Recap SMS deep-link into analysis; "speak your first move" hero demo | 7 | 6 | 7 | **294** | 6= |
| 8 | Lichess + PGN import; shareable review cards | 6 | 6 | 5 | **180** | 8 |

**Scoring rationale (abbreviated):**
- **#1 Invite SMS** — Impact 9: it's the only referral loop and it's already built minus one message. Confidence 8: the identical SMS mechanism (recap) works in prod. Ease 8: one Twilio send + consent template.
- **#4 Risk/privacy fixes** — Ease 9 (copy edits + an endpoint filter) is what pulls a modest-impact item to rank 2; it's also a hard prerequisite for any press push.
- **#3 Instrumentation** — Confidence 9: measurement always pays at pre-PMF; the `CallLog` model and metrics endpoint already exist to extend.
- **#2 Onboarding script** — Highest direct-churn impact, but Confidence 7 because the churn moment is currently *unmeasured* — which is why it ranks below the instrumentation that would confirm it.

**Notable divergence from the gut-feel P0 ordering:** ICE promotes the cheap risk fixes (#4) above onboarding (#2), and makes explicit that instrumentation should land before the onboarding work it will evaluate.

---

## Alternative Framework (Second Choice): Value vs. Effort 2×2

**Why it might work:** even faster; visual; good if roadmap conversations start involving a second stakeholder (e.g., a design collaborator).
**Tradeoffs:** loses the Confidence dimension, which is doing real work above (it's what separates #2 from #3).

---

## Common Pitfalls to Watch

1. **Treating scores as gospel** — #1 vs #4 is a real gap; #5 vs #7 (tied) is judgment territory. Scores are input, not automation.
2. **Framework whiplash** — commit to ICE for ~2 quarters; the single planned graduation is ICE → RICE when instrumentation matures.
3. **Inflated Confidence** — every Confidence ≥ 8 above cites an existing shipped mechanism; keep that discipline.

## Reassess When

- Activation/ASR instrumentation ships and produces 4+ weeks of data → move to RICE.
- A monetization decision enters the backlog → strategic bets need Cost of Delay or Kano, not ICE.
- Team grows beyond solo + agents → collaborative scoring session.

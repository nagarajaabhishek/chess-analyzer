# Elephant-Goldfish Model (EGM) — ChessNow

Design-first workflow for ChessNow Voice (`server/`) and the rest of this repo.
Upstream: [google/elephant-goldfish-model](https://github.com/google/elephant-goldfish-model) ([egm.dev](https://egm.dev)).

**Elephant** = long-context design session (no code).  
**Goldfish** = fresh, zero-history reviewers.  
**You** = trade-offs and approval before implementation.

Cursor support is **experimental** (upstream docs/cursor.md). Goldfish reviews need native Task subagents; do not fake reviewers in the parent chat.

## Artifact layout

```
EGM artifact directory: .dev/docs
```

| Path | Purpose |
| --- | --- |
| `.dev/docs/` | Scratch briefs, drafts, review reports (gitignored) |
| `docs/designs/` | Approved specs that ship with the repo |

## Cursor (this workspace)

Local package (installed by `scripts/setup-egm.sh` into `~/.cursor/plugins/local/egm`):

```text
EGM_ROOT: ~/.cursor/plugins/local/egm
```

1. Reload Cursor → Customize → confirm **egm** (7 skills, 8 reviewers, EGM rule).
2. In Agent chat, set context once (expand `~` to your absolute home path):

```text
EGM_ROOT: <absolute-home>/.cursor/plugins/local/egm
EGM artifact directory: .dev/docs
Read <absolute-home>/.cursor/plugins/local/egm/docs/cursor.md.
```

3. Run skills from the slash menu (`egm-brainstorm`, `egm-draft`, `egm-review`, …).  
   If a skill is missing from the menu, read `EGM_ROOT/skills/<name>/SKILL.md` and follow it in the parent.

Reinstall / refresh:

```bash
./scripts/setup-egm.sh
```

## Core loop (manual or slash)

1. **`egm-brainstorm`** → clarify idea → Goldfish lenses → `.dev/docs/concepts_brief.md`
2. **`egm-draft`** → section-by-section → `.dev/docs/design_draft.md`
3. **`egm-review`** → staged Goldfish review → reports under `.dev/docs/`
4. **Human approve** → move final spec to `docs/designs/`
5. **Implement** from the approved design only

Also useful: `egm-bootstrap` (document existing code), `egm-drift-report` (spec vs code), `egm-resolve` (work findings).

## Other harnesses (same repo)

### Claude Code

```bash
claude plugin marketplace add google/elephant-goldfish-model
claude plugin install egm@egm
```

Then `/egm:egm-brainstorm` (etc.). Add to project instructions if needed:

```text
EGM artifact directory: .dev/docs
```

### Codex CLI

```bash
codex plugin marketplace add google/elephant-goldfish-model
codex plugin add egm@egm
```

Pick EGM skills from the skill picker.

## ChessNow Voice focus

Prefer EGM for changes that touch Twilio call flow, ASR (`/api/voice/stream` + Whisper), move parsing, PvP challenges, SMS, or `server/models.py` live-game fields. Keep product name **ChessNow** in all user-facing copy (voice prompts, SMS, web).

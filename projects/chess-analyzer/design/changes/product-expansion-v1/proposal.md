# OpenSpec Proposal: Product Expansion v1

## Problem Statement
ChessNow needs to expand as an accessibility-first product with blindfold training support. This requires adding board-state voice commands, database-backed retention metrics, speech recognition confidence confirmation flows, and complete website accessibility (A11y) and search engine optimization (SEO).

## Proposal
Implement four packages of improvements:
1. Keyword-based intent matching for board query speech commands (like "repeat", "what is on e4", "last move", "whose turn").
2. Database-backed `CallLog` model and administrative metrics endpoint `/api/admin/metrics`.
3. High-confidence vs low-confidence parsing distinction with a dedicated confirmation route `/api/voice/confirm_move` and voice hints on Twilio gather blocks.
4. Screen reader optimizations, OpenGraph metadata, JSON-LD structured schema, robots.txt, sitemap.xml, and four new static information pages.

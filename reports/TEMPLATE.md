# <Platform> Connector Report

**Date:** YYYY-MM-DD
**Agent:** (e.g., Claude Opus 4.6, Gemini 3.1 Pro, Kimi K2)
**Connector:** `<company>/<name>-playwright.js`
**Iterations:** (how many runs to get a working connector)

## Decision log

What did you try, in what order, and why did you move on?

- (e.g., "Tried in-page fetch to /api/v1/me — got CORS error, moved to httpFetch")
- (e.g., "httpFetch with cookies returned 403 — Cloudflare TLS binding, pivoted to DOM extraction")
- (e.g., "CSV export page timed out after 30s — switched to RSS feeds")

## Surprises

What was unexpected? What would save the next person time?

- (e.g., "Login page has 4 options but all route through Amazon OAuth")
- (e.g., "API was deprecated in 2020, no docs — had to reverse-engineer RSS feed params")

## Friction

What was harder than it should have been? What should the skill or tooling do better?

- (e.g., "Validator flagged missing schema but didn't say which scope")
- (e.g., "Had to run setup.sh twice because SCRIPT_DIR resolved wrong")

## What worked well

- (e.g., "Browser profile persisted across runs — skipped login on retries")

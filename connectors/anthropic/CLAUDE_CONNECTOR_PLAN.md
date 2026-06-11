# Claude Connector Plan

This is a temporary working note for building a new `claude.ai` connector in this repo. It is meant to keep implementation aligned as we go, not to be a polished long-term doc.

## v2.0.0 — production hardening (current)

v1.1.0 worked (379 conversations exported) but had the failure modes we fixed elsewhere (ChatGPT v3): no resume, no rate-limit handling, and "honest reporting" gaps. v2.0.0 rewrites the collection path to the protocol's honest-telemetry contract.

What changed and why:

- **Deterministic org selection.** Conversations live in a `chat`-capable organization. An account can have several orgs (e.g. an API-only "Individual Org"), and the `lastActiveOrg` cookie v1.1.0 relied on can point at the wrong one. v2 calls `GET /api/organizations` and selects by capability (`chat`), falling back to the cookie only if that endpoint fails. Verified live: the test account has a `chat`+`claude_max` org and a separate `api`-only org.
- **Delta resume.** Each conversation is checkpointed to IndexedDB on the claude.ai origin (kept by the persistent profile). The index returns `current_leaf_message_uuid` per conversation; on resume we skip any conversation whose leaf is unchanged and only re-fetch new/changed threads. Verified live: 414/435 conversations carry the leaf key (~95%); the rest fall back to refresh-on-run.
- **Rate-limit politeness.** Modest concurrency (4) that halves on HTTP 429 and eases back up on clean batches; honors `Retry-After`, else exponential backoff with jitter. After several zero-progress throttled batches (or a 20-min wall-clock cap) the run stops, checkpoints, and returns a partial result instead of hammering the API. Claude exposes no batch/bulk conversation endpoint (unlike ChatGPT's `/conversations/batch`), so resumability + politeness — not a faster endpoint — is the throttle strategy.
- **Honest reporting.** Unfetched conversations are NOT emitted as empty successes. The shortfall is reported through `errors[]` (`degraded`, `rate_limited`/`auth_failed`), which classifies the run as `partial` so collected data is still delivered. Persistent non-throttle failures (5xx) are counted as `skipped` (unfetchable), not `pending`. Telemetry lives under `exportSummary.details`, never as a top-level key. Covered by `__tests__/claude-classifier.test.cjs`.
- **Trust boundary.** The IndexedDB checkpoint holds plaintext conversation text in the local profile (the same data the logged-in session already exposes). It is cleared after a fully-complete run and kept only while a run is genuinely incomplete.
- **Message flattening.** Detail messages carry an `index` (linear order) plus structured `content` blocks; an already-flattened `text` field exists but is empty under `rendering_mode=messages` (verified live, 0% populated), so v2 orders by `index` and flattens from `content`, preferring `text` only when present.
- **Login unchanged.** Manual headed-browser login only — no scripted credential entry. Claude login involves third-party identity and anti-bot checks, so manual hand-off is both more robust and avoids ever handling the password.

## Official export path (`claude-export-ingest.cjs`)

Anthropic ships a first-party export (Settings → Privacy → Export data): `POST /api/organizations/:org/export_data` → `{nonce}`, then an emailed download of a ZIP. It is a strict superset of the live-API connector — `users.json`, `conversations.json` (all threads), `projects/*.json`, `design_chats/*.json` — split into `…-batch-NNNN.zip` files for large accounts. Validated against a real export: **442 conversations, 6,317 messages, 10 projects, 2 design chats** in a 33 MB zip; the per-message schema matches the live API (so the connector's normalization is reused verbatim).

**Why it is a Node tool, not a connector collection mode.** The page-API runtime cannot retrieve the archive — confirmed three ways:
- In-browser `fetch()` of the download URL returns the Claude SPA shell regardless of `Accept`; the zip is gated on `Sec-Fetch-Dest: document`, which only a top-level navigation sets and `fetch()` cannot spoof.
- The runner's `page.httpFetch` reads the body via `response.text()` (`data-connect/playwright-runner/index.cjs`), which corrupts binary — and returns no binary field.
- There is no download-capture method in the page API (15 methods; no `page.on('download')`).

So retrieval belongs in the **desktop runner layer** (which can drive the navigation, capture the download, and handle binary). `claude-export-ingest.cjs` is the runtime-independent core that layer calls: `normalizeExport()` is a pure, unit-tested function (export objects → the same honest-telemetry scoped result the connector emits), and the CLI wraps it with system `unzip` + multi-batch merge/dedup. To make this a true in-connector mode later, the smallest unblock is binary support in `page.httpFetch` (return base64 for non-text bodies) plus a pure-JS inflate in the connector — a `data-connect` change, not a `data-connectors` one.

**Tradeoffs vs the live-API connector:** the export is complete and rate-limit-free but asynchronous (POST → wait for the job/email), a full dump each time (no cheap incremental refresh — the live-API path's `current_leaf_message_uuid` delta wins there), and likely throttled to ~once/day. Best used for the initial bulk backfill, with the live-API connector for incremental updates.

Confirmed endpoints (live, 2026-06-10):

- `GET /api/organizations` → `[{uuid, name, capabilities, …}]`
- `GET /api/organizations/:org/chat_conversations_v2?limit&offset&starred` → `{data:[…], has_more}` (no `total`; page on `has_more`)
- `GET /api/organizations/:org/chat_conversations/:id?tree=True&rendering_mode=messages&render_all_tools=true&return_dangling_human_message=true` → `{…, chat_messages:[{uuid,text,content,sender,index,parent_message_uuid,…}]}`
- `GET /api/organizations/:org/projects?include_harmony_projects=true&limit&offset&starred` → bare array of rich project objects

## Goal

Create a new Playwright-based connector for `claude.ai` that follows the repo's documented connector workflow and can be iterated safely as we learn more about the live product.

Initial target:

- platform: `claude.ai`
- connector id: `claude-playwright`
- company directory: `connectors/anthropic/`
- login mode: manual browser login first
- first export priority: conversations
- second export priority: projects
- lower priority: profile/account info, artifacts/files

## Repo Rules We Are Following

Source docs:

- `skills/vana-connect/SKILL.md`
- `skills/vana-connect/CREATE.md`
- `skills/vana-connect/reference/PATTERNS.md`
- `skills/vana-connect/reference/PAGE-API.md`

Important repo constraints:

- use the repo scaffold and validation flow
- connector script must be plain JS with an async IIFE
- use the injected `page` API only
- return scoped result keys
- include `exportSummary`, `timestamp`, `version`, and `platform`
- prefer the documented extraction ladder over ad hoc scraping

## What We Know About Claude So Far

### Login

Observed login page:

- `https://claude.ai/login?from=logout`

Observed login methods:

- Google
- email

For v1 we will support manual login rather than trying to automate all login methods immediately.

### Logged-in Landing Page

Observed logged-in URL:

- `https://claude.ai/new`

### Useful Logged-in DOM Signals

Potential stable selectors from the live app:

- `nav[aria-label="Sidebar"]`
- `a[href="/new"][aria-label="New chat"]`
- `button[data-testid="user-menu-button"]`
- `div[data-testid="chat-input-grid-container"]`
- `div[data-testid="chat-input"]`

These are better candidates than hashed class names.

### Observed Route Families

Visible app routes:

- `/new`
- `/recents`
- `/chat/:id`
- `/projects`
- `/project/:id`
- `/artifacts`
- `/customize`

### Observed API Patterns

From the live network panel:

- `GET /api/organizations/:orgId/projects?include_harmony_projects=true&limit=30&starred=true`
- `GET /api/organizations/:orgId/projects/:projectId`
- `GET /api/organizations/:orgId/skills/list-skills`

This strongly suggests that project data can be collected through authenticated JSON endpoints once session context is understood.

### Confirmed Bundle Findings

From Claude's shipped web bundle:

- `chat_conversation_list`
- `chat_conversation_tree`
- `chat_snapshot_list_all`
- `project_list_v2`
- `project_list_conversations`
- `project_files_list`
- `artifacts_list`

Most useful discovered route patterns:

- `/api/organizations/${orgId}/chat_conversations_v2?...`
- `/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=True&rendering_mode=messages&render_all_tools=true...`
- `/api/organizations/${orgId}/skills/list-skills`

This is enough evidence to treat conversation and project APIs as real implementation targets, not guesses.

### Observed Runtime Details

Useful details seen in requests/DOM:

- site uses Cloudflare
- cookies include session and device identifiers
- request headers include `Anthropic-Device-Id`
- DOM includes `data-testid` attributes and semantic `aria-label`s

Implication:

- we should first try in-page fetch or authenticated browser-context requests
- if browser-origin fetch becomes awkward, try `page.closeBrowser()` plus `page.httpFetch()`

## Implementation Strategy

### Phase 1

Build the connector skeleton:

- `connectors/anthropic/claude-playwright.js`
- `connectors/anthropic/claude-playwright.json`

Metadata should initially point at:

- connect URL: `https://claude.ai/login`
- runtime: `playwright`
- manual-login-first flow

### Phase 2

Implement login detection and session establishment:

- navigate to Claude login/home
- check for logged-in signals
- if not logged in, call `page.showBrowser()`
- use `page.promptUser()` to wait until a logged-in selector is present
- once logged in, switch headless if possible before data collection

### Phase 3

Implement the first export scope:

- `claude.conversations`

Expected first-pass shape:

- conversation id
- title
- URL or route
- timestamps if available
- message list if recoverable from API or page data
- total count

If full message history is not immediately accessible, start with conversation index metadata and iterate.

### Phase 4

Implement the second export scope:

- `claude.projects`

Project endpoints already appear promising from the network data, so this is the most likely next scope after conversations.

### Phase 5

Defer or treat as optional:

- `claude.profile`
- `claude.artifacts`

Artifacts are explicitly lower priority because they may involve more complicated paging, embedded state, or file handling.

## Extraction Ladder

We will follow the repo's documented order:

1. in-page fetch
2. browser login plus `page.httpFetch()`
3. network capture
4. DOM scraping as fallback

Current expectation:

- conversations may require a mix of route discovery plus API inspection
- projects likely have a cleaner API path than chats

## Validation Loop

Once files exist, the working loop is:

1. scaffold or create connector files
2. implement one slice
3. run structure validation
4. run the connector
5. inspect result output
6. generate/enrich schemas
7. validate again
8. iterate

## Current Status

What is working now:

- connector is scaffolded, registered, and runnable through `vana`
- manual-login-first Claude session detection works
- full thread/message export works for conversations via:
  - `GET /api/organizations/:orgId/chat_conversations_v2?...`
  - `GET /api/organizations/:orgId/chat_conversations/:conversationId?tree=True&rendering_mode=messages&render_all_tools=true&return_dangling_human_message=true`
- project list and project detail export work via:
  - `GET /api/organizations/:orgId/projects?...`
  - `GET /api/organizations/:orgId/projects/:projectId`
- result validation now passes end to end against the connector schemas

Latest validated export:

- 379 conversations
- 2395 messages
- 5 projects

## What "Deepen Conversation Payload" Means

We already have the core thing that matters:

- conversation list
- full message threads

So this does not mean "go find some other hidden conversation API" or "keep digging forever."

It only means small optional enrichments inside the payload we already have, for example:

- preserving extra per-message metadata if Claude already returns it
- keeping model or stop-reason fields if they are present and stable
- carrying through safe conversation-level fields that help downstream consumers without expanding scope

This is explicitly lower priority than shipping the current connector. We do not need to do this before opening a PR.

## PR Scope

Good PR scope for now:

- conversation export with full thread messages
- project list export
- project detail export
- schemas
- plan doc / implementation notes

Not required before PR:

- artifacts
- files
- automated Google/email login
- exhaustive payload enrichment
- project-scoped conversation export

## Files Added Or Updated

- `connectors/anthropic/claude-playwright.js`
- `connectors/anthropic/claude-playwright.json`
- `schemas/claude.conversations.json`
- `schemas/claude.projects.json`
- `icons/claude.svg`
- `registry.json`
- `connectors/anthropic/CLAUDE_CONNECTOR_PLAN.md`

## How To Validate

Structural validation:

- `node scripts/validate-connector.cjs connectors/anthropic/claude-playwright.js`

Register updated connector locally:

- `node skills/vana-connect/scripts/register.cjs connectors/anthropic/claude-playwright.js`

Run the real connector:

- `vana connect claude --json --no-input`

Validate the exported result:

- `node scripts/validate-connector.cjs connectors/anthropic/claude-playwright.js --check-result ~/.vana/results/claude.json`

## Next Steps

### Step 1

Open the PR with the current working connector.

Why:

- the main value is already there
- the team can review a real implementation instead of a plan
- we avoid perfectionism and get feedback while the work is still fresh

### Step 2

Add a follow-up todo to investigate project-scoped conversation endpoints.

Goal:

- determine whether Claude exposes project conversations through a dedicated endpoint
- if yes, decide whether that should merge into `claude.conversations`, `claude.projects`, or a new scope later

### Step 3

Only after team feedback, consider small payload enrichments if they are obviously useful and low risk.

Rule:

- no broadening of scope unless it is cheap, stable, and clearly improves downstream use

### Step 4

If auth automation is pursued, do it as a separate fast-follow PR and keep the scope narrow:

- support Claude native email/password only
- keep Google login manual-only
- do not block connector usefulness on multi-provider auth automation

Reason:

- the current connector already works and is mergeable with manual login
- Google automation is a different class of problem from Claude-native email/password
- separating auth automation from the current PR keeps review and rollback risk much lower

## Open Questions

- Does Claude expose project conversations through a distinct project-scoped API route?
- If so, should those conversations stay inside the global `claude.conversations` export or be attached to projects?
- Are artifacts exposed by a usable API or only by UI navigation?
- Is Claude native email/password login stable enough to justify a maintained automated login path?

## Testing Follow-up

- automated tests are not a blocker for the current PR
- the most reasonable fast-follow test work would be helper- and fixture-level coverage for normalization logic
- full end-to-end automated testing against Claude auth and live session flows would be higher-cost and more brittle, so it should not be the first testing investment

## Claude-Specific Learnings

- the local repo can be exercised directly through `vana` when run from the repo root; this is the right execution path for this project
- Claude session state is reusable through the existing local browser profile, which makes manual-login-first iteration practical
- the active organization id is recoverable from `lastActiveOrg` in cookie or storage, and that is enough to unlock the main authenticated API paths
- the conversation-detail API returns message trees under `chat_messages`
- flattening message text requires handling Claude content blocks rather than assuming a single plain-text field
- sidebar DOM scraping is still useful as a fallback, but API collection is the primary path now
- fetching every conversation serially is too slow; batching detail requests is necessary for practical export times
- after changing the connector, re-run the repo registration step so `vana` picks up the new script hash
- prefer validating with a real `vana connect claude --json --no-input` run, not only the structural validator
- if a field may legitimately be `null`, avoid marking it as required in the schema because the current validator can report it as missing
- manual login is an acceptable and common connector tradeoff when auth is brittle or includes anti-bot checks, CAPTCHA, SSO, or third-party identity flows
- for Claude specifically, email/password automation is a reasonable fast-follow candidate; Google automation should be treated as later work unless there is a very strong product reason to take it on

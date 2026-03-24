# Claude Connector Plan

This is a temporary working note for building a new `claude.ai` connector in this repo. It is meant to keep implementation aligned as we go, not to be a polished long-term doc.

## Goal

Create a new Playwright-based connector for `claude.ai` that follows the repo's documented connector workflow and can be iterated safely as we learn more about the live product.

Initial target:

- platform: `claude.ai`
- connector id: `claude-playwright`
- company directory: `anthropic/`
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

- `anthropic/claude-playwright.js`
- `anthropic/claude-playwright.json`

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

- `anthropic/claude-playwright.js`
- `anthropic/claude-playwright.json`
- `schemas/claude.conversations.json`
- `schemas/claude.projects.json`
- `icons/claude.svg`
- `registry.json`
- `anthropic/CLAUDE_CONNECTOR_PLAN.md`

## How To Validate

Structural validation:

- `node scripts/validate-connector.cjs anthropic/claude-playwright.js`

Register updated connector locally:

- `node skills/vana-connect/scripts/register.cjs anthropic/claude-playwright.js`

Run the real connector:

- `vana connect claude --json --no-input`

Validate the exported result:

- `node scripts/validate-connector.cjs anthropic/claude-playwright.js --check-result ~/.vana/results/claude.json`

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

## Open Questions

- Does Claude expose project conversations through a distinct project-scoped API route?
- If so, should those conversations stay inside the global `claude.conversations` export or be attached to projects?
- Are artifacts exposed by a usable API or only by UI navigation?

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

# Slack Connector Plan

Working notes for the Slack Playwright connector. Mirrors the pattern of
`connectors/anthropic/CLAUDE_CONNECTOR_PLAN.md` so this directory tells the
same story as our other reference platforms.

## Goal

A Playwright-based DataConnect connector that exports a user's Slack data from
their currently-active workspace, using the slack.com web client as the auth
surface — no Slack app registration, no OAuth, no Slack API token from the
user.

Initial target:

- platform: `slack.com`
- connector id: `slack-playwright`
- company directory: `connectors/slack/`
- login mode: manual browser login (re-uses existing slack.com session)
- scopes:
  - `slack.profile` — user + workspace identity
  - `slack.conversations` — channel / DM / group-DM index
  - `slack.messages` — message bodies (the bulk), with thread replies

## Why this shape

- **Three scopes, mirroring `export.py`** in `/Users/volod/volod/slack-export/`.
  That script already separated workspace/channel metadata from message bodies
  via separate JSON files; same split here lets a builder request just the
  metadata-grade `slack.conversations` without pulling the whole archive.
- **No channel-ignore UI** — DataConnect doesn't surface free-form text input
  in the consent flow. Instead the connector auto-filters using signals the
  user has already expressed inside Slack:
  - `is_archived: true` — Slack-side archived channel
  - `prefs.muted_channels` — channels the user has muted in their Slack prefs
  - `is_member: false` on public channels — channels the user hasn't joined
- **Per-workspace, single team.** The connector exports whatever workspace
  the user's current slack.com session is on. To export a different team,
  switch teams in Slack and re-run.

## Auth and token extraction

slack.com web app stores its API token in the page bootstrap. Three extraction
paths in order:

1. `window.TS.boot_data.api_token` — modern client surface
2. `window.boot_data.api_token` — legacy surface (still present in some
   sessions / regions)
3. Inline `<script>` text grep for `"api_token":"xox..."` — fallback when both
   namespaces are sandboxed away

The `d` cookie auto-attaches to in-page `fetch()` because the request runs
from the slack.com origin. We don't need to handle it manually.

If extraction fails the connector exits with a `setData('error', ...)` rather
than guessing — failure here means Slack has changed something material and we
want to know.

## Data collection

All API calls run inside `page.evaluate(fetch(...))` so credentials attach
naturally. Endpoints used (same set the `slack-export/export.py` reference
uses):

- `auth.test` — confirm the token, recover canonical user_id + team_id +
  workspace URL
- `team.info` — team display name, domain, icon, enterprise id
- `users.info` — exporter's full profile (email, tz, admin/owner flags)
- `users.list` — paginated workspace member roster (used to resolve DM peer
  names; also useful downstream)
- `conversations.list` — channels + DMs + group DMs (paginated)
- `conversations.history` — messages per channel (paginated, with optional
  `oldest` epoch cutoff)
- `conversations.replies` — thread replies for any parent with `reply_count > 0`

Pagination follows the standard Slack cursor pattern (`response_metadata.next_cursor`).

## Rate limiting

The reference `export.py` runs at ~0.7 calls/sec with 5-way channel
concurrency. We run conservatively similar:

- `API_DELAY_MS = 350` between page requests inside one history loop
- `THREAD_DELAY_MS = 250` between thread-replies fetches
- `MESSAGE_FETCH_CONCURRENCY = 4` channels in flight at a time

These settings are tuned to stay under Slack tier-3 (~50/min) on
`conversations.history`. They can be loosened later if real exports show
headroom.

## History depth

Optional input `oldestDays` (integer, days). The connector asks for it via
`page.requestInput`. Default: unset → all-time history. Internally this
becomes a Slack `oldest` parameter as `floor(now - days*86400)` seconds.

We let the user opt into a narrow window because a multi-year workspace can
produce tens of GB of messages — too much for a casual builder demo.

## Result shape

Three scoped keys, plus the canonical metadata block:

```text
slack.profile        → { user, workspace, bootSource, historyWindowDays }
slack.conversations  → { conversations[], total, exported, filterCounts, teamId }
slack.messages       → { conversations[ { id, name, type, messages[], … } ], totalMessages, totalThreads, oldestTs, oldestDays }
exportSummary        → { count, label, details, details_obj }
errors[]             → unresolved output-affecting problems only (taxonomy)
```

## Honest outcome reporting

Per the repo's error taxonomy:

- **`auth_failed` (degraded, slack.profile)** — when `auth.test` returns a
  Slack error after the token was extracted. Profile payload still ships from
  boot-data fields, but it's degraded relative to a clean run.
- **`upstream_error` (degraded, slack.conversations)** — `users.list`
  pagination failure. DM peer names may be ids instead of names.
- **`upstream_error` (fatal)** — `conversations.list` fails. The run can't
  proceed; we emit `slack.profile` only and bail.
- **`upstream_error` (degraded, slack.messages, channelId=…)** — per-channel
  `conversations.history` failure. Channel still appears in the bucket array
  with `fetchError` set and `messages: []`.

## What this connector does NOT do (v1)

- **Multi-workspace export.** Slack web client maintains one active team at a
  time; we export that one. Multi-team exports require team switching, which
  is its own UX flow.
- **Files / file content.** We capture file metadata that Slack embeds in
  message payloads, but we do not download file blobs.
- **Reactions enrichment.** Reactions are stored as Slack returns them; we
  don't resolve emoji codes or expand user-id arrays.
- **Workspace admin endpoints.** No `admin.*` calls — that surface requires a
  workspace admin token and is out of scope for a personal-data exporter.

## Validation

```bash
# Structural (passes)
node scripts/validate-connector.cjs connectors/slack/slack-playwright.js

# Manifest schema (passes)
node scripts/validate-manifests.mjs

# Scope schema coverage (passes)
node scripts/validate-scope-schemas.mjs

# Full run (needs DataConnect playwright-runner alongside)
node run-connector.cjs ./connectors/slack/slack-playwright.js --pretty
```

Two validator warnings are expected and correct:

- `script_env_credentials` — no `USER_LOGIN_SLACK` / `USER_PASSWORD_SLACK`
  reads. By design: Slack auth comes from the existing browser session, not
  from credentials passed in.
- `script_automated_form_fill` — no automated form fill. Same reason —
  manual-login-first is the right model for Slack (SSO + WebAuthn + magic
  links all live on that page).

## Open questions / fast-follow

- **Scopes vs ignore lists.** If product wants user-controlled exclude
  patterns (specific channel ids or channel-name globs) we need a way to
  surface that in DataConnect's consent UI. Today the only available signals
  are the three Slack-native ones the connector already honors.
- **Enterprise Grid.** This connector uses the active team's token; in an
  Enterprise Grid org the user has multiple teams under one identity. v1
  exports the active team only; multi-team Grid support is a separate effort.
- **Token rotation.** Slack rotates xoxc tokens; we re-extract on every run
  from the live page, so this should not be an issue in practice. If it
  becomes one, the failure mode is a clean "token extraction failed" error,
  not a silent partial export.
- **Files.** Builders that want actual file content will need a `slack.files`
  scope plus a download path. Out of scope for v1.

## Files added

- `connectors/slack/slack-playwright.js`
- `connectors/slack/slack-playwright.json`
- `connectors/slack/schemas/slack.profile.json`
- `connectors/slack/schemas/slack.conversations.json`
- `connectors/slack/schemas/slack.messages.json`
- `connectors/slack/icons/slack.svg`
- `registry.json` (slack-playwright entry)
- `connectors/slack/SLACK_CONNECTOR_PLAN.md` (this file)

# Connector Contract Freeze — Phase 0 Decisions

Date: 2026-04-10
Supersedes: ad-hoc manifest and page API conventions.
Related eval file: `context-gateway/docs/evals/260410-connector-contract-unification.evals.yaml`

This document records the contract decisions that Phase 0 of the connector
unification plan locked in. Subsequent phases consume these as given.

## 1. Canonical manifest shape

The canonical contract is `schemas/manifest.schema.json` in this repository.
Every `*-playwright.json` manifest must validate against it.

Required fields (additive from the pre-migration shape):

| Field | Example | Notes |
| --- | --- | --- |
| `manifest_version` | `"1.0"` | Version of the manifest contract itself. |
| `connector_id` | `"instagram-playwright"` | Globally unique artifact id. |
| `source_id` | `"instagram"` | Stable product-facing source id. Must not change across releases without a versioned migration path. |
| `version` | `"1.0.0"` | Connector version (semver). Independent of the other versions. |
| `name` | `"Instagram"` | Display name. |
| `company` | `"Meta"` | Company / organization. |
| `description` | `"..."` | Human description. |
| `runtime` | `"playwright"` | Enum: `playwright`, `vanilla`, `network-capture`. |
| `page_api_version` | `1` | Major version of the page API this connector targets. Independent of `version`. |
| `connect_url` | `"https://..."` | Login / start URL. |
| `connect_selector` | `"..."` | Logged-in-state detection selector. |
| `scopes` | `[{scope, label, description}, ...]` | Canonical public data units. |

Legacy aliases (`id`, `connectURL`, `connectSelector`, `iconURL`,
`exportFrequency`, `vectorize_config`) are kept in place during migration but
are no longer the source of truth. `scripts/normalize-manifests.mjs` keeps the
canonical and legacy fields in sync.

### `connector_id` vs `source_id`

- `connector_id` is the build/runtime artifact id. It includes runtime
  qualifiers (e.g. `-playwright`) and secondary suffixes (e.g. `-ads`).
- `source_id` is the product-facing source id as users see it (e.g. the CG
  source dropdown). Multiple connectors MAY emit into the same `source_id` if
  they produce scopes under the same platform namespace.

Explicit override: `instagram-ads-playwright` has `source_id: "instagram"`
because it is a second artifact producing `instagram.*` scopes, not a distinct
source.

### Scope id format

Every scope id must match `^[a-z0-9_-]+\.[A-Za-z0-9_.-]+$` and must begin with
the manifest's `source_id` followed by a dot. Historical camelCase scope tails
(`youtube.playlistItems`, `spotify.savedTracks`) are preserved during the
migration.

## 2. Page API minimum surface

`types/connector.d.ts` exposes the canonical page API. Phase 0 decision: the
following methods become canonical (they were missing or de facto only in
Context Gateway's CG proxy, not in the typed contract):

- `click(selector, options?)`
- `fill(selector, value, options?)`
- `press(selector, key, options?)`
- `waitForSelector(selector, options?)`
- `url()`

Rationale: CG connector scripts already rely on these methods, and DataConnect
can implement them as thin pass-throughs to the underlying Playwright page
object. Adding them to the canonical surface is easier than rewriting CG
scripts to the narrower upstream style, and it costs DC only a handful of
one-line method wrappers.

`requestInput` is canonical. `getInput` is a shell-runtime adapter concern
only.

Versioning: `types/page-api-version.ts` exports `PAGE_API_VERSION = 1`. Within
a major version the contract is additive-only. Breaking changes require both a
constant bump and a matching `page_api_version` bump in every manifest. CI
enforces this via `scripts/check-page-api-additive.mjs`.

## 3. Instagram contract decision

CG has historically exposed Instagram via a local script that scraped extra
fields (`following_accounts`, ad `targeting_categories`) and did NOT emit
posts. The canonical `data-connectors` Instagram connector emits profile,
posts, and ads but did not previously emit following.

### `instagram.following` — upstreamed into the canonical script

- `scrapeFollowingAccounts` from CG's `public/automations/instagram-headless.js`
  has been ported into the canonical `connectors/meta/instagram-playwright.js`
  (see `state.followingAccounts` + the `scrapeFollowingAccounts` helper near
  the top of the file).
- The canonical script now emits `instagram.following` alongside profile,
  posts, and ads.
- Schema: `schemas/instagram.following.json`.
- Rationale: keeping CG-only fields in a CG-only fork would perpetuate the
  drift that this whole plan exists to eliminate. The port was mechanical —
  the function only uses `page.evaluate` — so there was no reason to defer.

### Ad targeting categories — open contract gap

- `schemas/instagram.ads.json` declares an optional `categories` field, but
  neither the canonical Instagram script nor the current CG script actually
  emits it under that name. CG collects a similar concept as
  `targeting_categories`, but that is not the canonical field name and is
  not currently exported by either script in this cycle.
- Phase 3 deliberately does NOT attempt to rename or populate `categories`.
  If product wants ad targeting categories on the public contract, that is
  a follow-up task: implement canonical collection and then either populate
  the existing optional `categories` field or declare a new scope.
- The earlier version of this doc incorrectly claimed `categories` was
  "already present" on `instagram.ads`. It is present in the schema as an
  optional field, but no emitter populates it.

### Canonical Instagram script is now activated in CG

Phase 3 replaces CG's `public/automations/instagram-headless.js` with the
canonical `connectors/meta/instagram-playwright.js` (byte-for-byte via the
generator's snapshot emission). CG users gain `instagram.posts` (which they
never had before), retain `instagram.profile`, `instagram.following`, and
`instagram.ads`. The runtime method gap is closed by new `setProgress`,
`showBrowser`, `goHeadless` shims on CG's `PlaywrightPageProxy`.

### GitHub is also activated

Phase 3 replaces `public/automations/github.js` with the canonical
`connectors/github/github-playwright.js`. Same mechanism. The CG proxy shims
also cover GitHub's method surface.

### iCloud Notes is upstreamed but NOT yet runtime-canonical

- The iCloud Notes manifest, schemas, and script are committed to
  `data-connectors`, satisfying HC-PHASE3-ICLOUD-UPSTREAM-001.
- HOWEVER: the script depends on CG-runtime-only page methods that are
  intentionally NOT part of the canonical typed Page API:
    - `page.getInput(inputSchema)` — CG-specific credential prompt primitive
    - `page.frame_click`, `page.frame_fill`, `page.frame_evaluate`,
      `page.frame_waitForSelector` — CG-specific iframe helpers (used for
      Apple's auth widget iframe)
    - `page.keyboard_press`, `page.keyboard_type` — CG-specific keyboard
      primitives (used for 2FA OTP entry)
- These methods are NOT in `types/connector.d.ts`, they are NOT implemented
  in `data-connect/playwright-runner/index.cjs`, and the upstream script
  will NOT run under the canonical DataConnect runtime without further
  convergence.
- The manifest advertises this explicitly via the
  `capabilities: ["cg-legacy-page-api"]` flag. Any runner that checks
  capabilities before activating a connector should reject iCloud Notes
  if it does not implement the CG-legacy surface.
- This is an honest "metadata converged, script runtime pending" state.
  Full canonical convergence requires either (a) rewriting the iCloud Notes
  login flow to use `requestInput` and eliminate the iframe helpers, or
  (b) promoting `frame_*` and `keyboard_*` into the canonical Page API.
  Neither is in scope for this PR set.

### Oura is NOT activated

- The canonical Oura script uses email + password login.
- The existing CG Oura script uses email + OTP-only login.
- Some Oura accounts are OTP-only (no password set); activating the canonical
  script would block them from connecting.
- Phase 3 keeps `public/automations/oura.js` as the existing CG script with
  an exception comment. The canonical script is still pinned in the snapshot
  at `config/data-connectors-snapshot/scripts/oura-playwright.js` so that
  future convergence has a stable baseline to diff against.
- The CG overlay flags this with `activate_canonical_script: false`.
- Runtime convergence follow-up: either add OTP as an option in the canonical
  script, or have CG detect OTP accounts and fall through to a CG-only
  adapter. Not in this cycle.

## 4. Shell overlay scope

Per HC-SHELL-OVERLAY-001, shell overlays (Context Gateway, DataConnect display
registry) own ONLY:

- Availability / whitelist
- Canonical source or connector references (pointers, not definitions)
- Color / theme treatment
- Privacy note copy
- Route config
- Embed copy
- Optional icon override

They do NOT own:

- Source descriptions (live in manifests)
- Public scope or stream definitions (live in manifests)
- Public schema definitions (live in `schemas/`)

## 5. Versioning axes

Per HC-VERSIONING-INDEPENDENT-001, four version dimensions are tracked
independently:

| Axis | Location | Bumps when |
| --- | --- | --- |
| Manifest schema | `manifest_version` field | The manifest contract itself changes. |
| Connector | `version` field | A connector's behavior changes. |
| Page API | `page_api_version` field + `PAGE_API_VERSION` constant | The page API contract changes. |
| Scope schema | `version` field inside each `schemas/*.json` | A public scope schema changes. |

No two of these are allowed to be collapsed into a single field.

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

Two extra fields were being collected by the CG Instagram script outside of
the current canonical contract: `following_accounts` and ad `targeting_categories`.

### `following_accounts` → new public scope `instagram.following`

- New scope: `instagram.following`
- New schema: `schemas/instagram.following.json`
- Manifest: `connectors/meta/instagram-playwright.json` now declares this scope.
- Rationale: following data is a clearly separable public data unit that users
  may want to grant independently of profile or posts. Classifying it as an
  additive field on `instagram.profile` would over-expose it on consent.

### Ad targeting categories → additive field on existing `instagram.ads`

- No schema change required. The existing `schemas/instagram.ads.json`
  already includes a `categories` array field with `name` and `description`
  entries.
- The CG Instagram script refers to this field as `targeting_categories`; the
  CG adapter (Phase 3) is responsible for renaming it to the canonical
  `categories` key before emitting the public scope payload.
- Rationale: categories are already part of the public ads contract. Renaming
  them would be a breaking change; the data is additive and belongs with the
  existing scope.

### Script replacement is NOT part of this decision

Replacing the CG Instagram script with the canonical `data-connectors` script
is explicitly out of scope for Phase 0 and Phase 3. The two scripts have
materially different collection flows (web_info path, ad interest SSR fallback,
captcha handling) and script-level convergence is deferred until Phase 4
page API convergence has landed.

### GitHub + Oura + iCloud Notes script replacement

Phase 3 DOES replace the CG github and oura scripts with the canonical
counterparts. Mechanism: CG commits a pinned copy of the canonical script
under `config/data-connectors-snapshot/scripts/` and the generator emits it
verbatim (with a DO NOT EDIT header) to `public/automations/<name>.js`.

Known divergence the CG runtime must absorb:

- The canonical scripts call `page.requestInput(...)`. CG's runtime exposes
  `getInput(...)` as the credential prompt primitive, so its page proxy
  includes a `requestInput → getInput` shim (`src/lib/playwright-proxy.ts`).
  The shim was audited as part of Phase 3.
- The canonical scripts call `page.setProgress(...)`. CG's runtime previously
  used `page.setData('status', ...)` for progress display; the client-side
  handler accepts both messages. Phase 4 tracks the convergence toward a
  single progress primitive.
- The canonical scripts wrap all logic in `(async () => { ... })()`. CG's
  `new AsyncFunction('page', code)` runner handles both top-level-await and
  IIFE-wrapped scripts.

Regression risk is acknowledged and tracked under the Phase 4 conformance
fixtures (SS-CONFORMANCE-FIXTURES-001).

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

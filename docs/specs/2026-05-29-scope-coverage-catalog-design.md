# Scope Coverage Catalog — Design Spec

**Date:** 2026-05-29
**Author:** Maciej (brainstormed 2026-05-29)
**Status:** Proposal
**Linear:** [BUI-395 — Instagram scope mismatch found in CG lab E2E](https://linear.app/vana-team/issue/BUI-395/instagram-scope-mismatch-found-in-cg-lab-e2e)

---

## 1. Summary

A single, generated **scope coverage catalog** lives in the `data-connectors` repo,
declaring every source's scopes and — per scope — which collection **tier** can
produce it: **desktop** (Playwright connectors) and/or **web** (the ODL-run Data
Pipe API "light" flow).

It is generated from two inputs and consumed downstream so the same fact is never
hand-maintained in more than one place. The immediate goal is to **kill the drift**
behind BUI-395: today, "can the web flow produce scope X?" is asserted by hand in
four independent places that nothing keeps in agreement. This collapses them to one
declared input plus generated views.

## 2. Background — the bug and the drift

During a CG → Vana Web → Personal Server lab E2E, the lab requested Instagram scopes
including `read:ads`. Context Gateway correctly resolved that to `instagram.ads` and
forwarded it to Vana Web. But the **web (light)** flow can only ever produce
`instagram.profile`, so the PS never ingested `instagram.ads` and the read returned a
valid 404. Narrowing the request to `read:profile` / `instagram.profile` made the E2E
pass.

The architecture is two-tier:

- **Desktop / heavy** — Playwright connectors in `data-connectors` (`instagram-playwright`
  produces profile, posts, following, ads). This tier already has a real source of truth.
- **Web / light** — a hosted ODL flow (the Data Pipe API at `data-pipe.vana.org` plus
  Vana Web's data-pipe form and PS writer) that today produces only `*.profile`. This
  tier is **not** a connector and is declared nowhere canonical.

"Which scopes the web flow can produce" is currently hardcoded in four disconnected
places, none of which validates against the others:

| # | Location (repo) | What it asserts |
|---|---|---|
| 1 | `unity-surfaces` `apps/web/src/features/sources/web-writable-scopes.ts` | the allow-list of web-writable scopes per source |
| 2 | `unity-surfaces` `apps/web/src/features/sources/ps-data-writer.ts` (`normalizeBodyForScope`) | which scope bodies get a normalizer (only `instagram.profile`) |
| 3 | `unity-surfaces` `apps/web/src/features/sources/data-pipe-client.ts` | per-source scope arrays the client requests from the Data Pipe API |
| 4 | the Data Pipe API service itself (ODL-run) | the real capability — but it publishes no catalog |

Because the *claim* (#1) is maintained separately from the *implementation*
(#2–#4), a scope can be claimed web-writable with nothing behind it — exactly the
class of bug BUI-395 is.

## 3. Goals / Non-goals

**Goals**
- One authoritative declaration of per-scope, per-tier producibility.
- `unity-surfaces` `web-writable-scopes.ts` becomes **generated**, not hand-maintained.
- A human-readable table documenting every source's scopes across web and desktop —
  answering the issue's open question ("where should requested vs produced/readable
  scopes be documented or surfaced?").

**Non-goals (this spec)**
- CI, automated drift detection, or enforced guards. If the hand-declared web input
  drifts from reality, we fix it manually for now. (Decision: 2026-05-29.)
- A Data Pipe API capabilities endpoint (future; swaps one generator input).
- CG surfacing the tier at request time in its API / lab picker (the "surface early"
  goal — separate follow-on issue).
- Generating (vs. leaving as-is) `data-pipe-client.ts` scope arrays.
- Any change to the desktop tier — it is already canonical.

## 4. Architecture

```
INPUTS (in data-connectors/)
  connectors/**/*.json  (manifests)  ──► DESKTOP column
                                         (union of scopes across a source's connectors)
  web-capabilities.json (hand)       ──► WEB column
                                         (mirrors the Data Pipe API's supported sources/scopes)

GENERATOR
  scripts/generate-scope-coverage.mjs
    reads both inputs → emits:
      catalog/scope-coverage.json   (machine-readable source of truth)
      SCOPES.md                     (human-readable table, generated from the same data)

CONSUMERS
  unity-surfaces  ──► vendors catalog/scope-coverage.json (pinned copy + sync script),
                      generates web-writable-scopes.ts from its WEB column,
                      deletes the hand-maintained map.
  CG (follow-on)  ──► may annotate its catalog/API with the tier.
```

This mirrors the pattern CG already uses: CG pins a `data-connectors` snapshot and
generates its catalog from it via `scripts/generate-connector-catalog.mjs`.

## 5. The `web-capabilities.json` input

Small and reviewable. Authored to mirror what the ODL Data Pipe API actually supports
(the place in the Data Pipe API code where `instagram.profile` etc. are declared as
supported source/scope pairs).

```jsonc
{
  "$comment": "Hand-declared mirror of what the ODL Data Pipe API (data-pipe.vana.org) can produce per source via the web/light flow. Authored from the Data Pipe API's supported-source declarations. Replace with a generated pull from a Data Pipe capabilities endpoint when one exists. If this drifts from the real API capabilities, fix it here manually.",
  "web_capabilities_version": "1.0",
  "sources": {
    "instagram": ["instagram.profile"],
    "spotify":   ["spotify.profile"],
    "youtube":   ["youtube.profile"],
    "linkedin":  ["linkedin.profile"],
    "github":    ["github.profile"]
  }
}
```

Initial contents reflect today's reality: the web flow produces only `*.profile` for
the five sources wired into the Data Pipe client.

## 6. The generator — `scripts/generate-scope-coverage.mjs`

Reads the connector manifests and `web-capabilities.json`; emits two artifacts. Run
manually (e.g. `npm run generate:scope-coverage`) whenever a connector's scopes or the
web capabilities change.

**Logic**
1. Build the **desktop** set per `source_id` = the union of `scopes[].scope` across all
   connector manifests that declare that `source_id`.
2. Read the **web** set per source from `web-capabilities.json`.
3. For each source, for each scope in `desktop ∪ web`, emit a row:
   `{ scope, web: boolean, desktop: boolean, schema?: string }`.
4. **Validation (generation-time, not CI):** every scope listed in
   `web-capabilities.json` must exist in that source's desktop scope set (i.e. be a real
   catalog scope). An unknown web scope is a generation error — it catches typos at
   author time. This is the generator refusing to emit garbage, not a separate check job.

### 6.1 `catalog/scope-coverage.json` (machine-readable SoT)

```jsonc
{
  "scope_coverage_version": "1.0",
  "sources": {
    "instagram": {
      "scopes": [
        { "scope": "instagram.profile",   "web": true,  "desktop": true,  "schema": "schemas/instagram.profile.json" },
        { "scope": "instagram.posts",     "web": false, "desktop": true,  "schema": "schemas/instagram.posts.json" },
        { "scope": "instagram.following", "web": false, "desktop": true },
        { "scope": "instagram.ads",       "web": false, "desktop": true,  "schema": "schemas/instagram.ads.json" }
      ]
    }
    // …other sources
  }
}
```

### 6.2 `SCOPES.md` (human-readable, generated)

A table per source, e.g.:

| Scope | Web | Desktop |
|---|:--:|:--:|
| `instagram.profile` | ✅ | ✅ |
| `instagram.posts` | — | ✅ |
| `instagram.following` | — | ✅ |
| `instagram.ads` | — | ✅ |

A header note states the file is generated and points at the generator and
`web-capabilities.json`.

## 7. Consumer — unity-surfaces

unity-surfaces is fixture-based today and not wired to `data-connectors`, so it adopts
CG's vendoring pattern:

1. **Vendor** a pinned copy of `catalog/scope-coverage.json` into the repo (e.g.
   `apps/web/src/features/sources/generated/scope-coverage.json`) via a small
   `sync-scope-coverage` script that copies from a pinned `data-connectors` ref.
2. **Generate** `web-writable-scopes.ts` from the vendored catalog's WEB column. The
   hand-maintained `publicSourceWriteScopesBySource` map is deleted; `getWebWritableScopes()`
   reads the generated data instead.
3. `normalizeBodyForScope()` is unchanged — a passthrough-by-default transform is fine;
   this spec governs *which scopes are claimed producible*, not how their bodies are shaped.

No automated guard ties the generated web set to the data-pipe-client run-creators or to
the live Data Pipe API. Keeping `web-capabilities.json` truthful is a manual
responsibility for now (§3 non-goals).

## 8. What changes, by file

**data-connectors**
- `web-capabilities.json` — new, hand-authored input.
- `scripts/generate-scope-coverage.mjs` — new generator.
- `catalog/scope-coverage.json` — new, generated.
- `SCOPES.md` — new, generated.
- `package.json` — add `generate:scope-coverage` script.

**unity-surfaces**
- `apps/web/src/features/sources/generated/scope-coverage.json` — new, vendored copy.
- `scripts/sync-scope-coverage.*` — new sync script.
- `apps/web/src/features/sources/web-writable-scopes.ts` — rewritten to read generated data;
  hardcoded `publicSourceWriteScopesBySource` deleted. `getWebWritableScopes()` signature
  unchanged, so `scope-readiness.ts` and `source-public-target-controller.ts` callers are
  untouched.

## 9. Testing

- **data-connectors** — generator unit tests: desktop set is the union across a source's
  connectors; a `web-capabilities.json` entry naming a non-existent scope is rejected;
  `scope-coverage.json` and `SCOPES.md` match expected snapshots for fixture inputs.
- **unity-surfaces** — `getWebWritableScopes()` returns values matching the vendored web
  column; existing `web-writable-scopes` and `scope-readiness` tests updated to consume the
  generated values (behavior for the current profile-only reality is unchanged, so the
  `desktop-required` routing for `instagram.ads` still holds).

## 10. Migration / future

| Phase | Change | Web column source |
|---|---|---|
| **This spec** | Generated catalog in data-connectors; unity-surfaces generates `web-writable-scopes` from it | `web-capabilities.json` (hand, mirrors Data Pipe API) |
| **Later** | Data Pipe API exposes a capabilities endpoint; generator pulls the web column from it | live Data Pipe API |
| **Later** | CG annotates its catalog/API + lab picker with tier so `read:ads` warns "needs Desktop" at request time | the same `scope-coverage.json` |

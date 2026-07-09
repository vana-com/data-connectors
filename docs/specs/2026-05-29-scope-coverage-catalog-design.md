# Scope Coverage Registry — Design Spec

**Date:** 2026-05-29
**Author:** Maciej (brainstormed 2026-05-29)
**Status:** Accepted
**Background:** an Instagram scope mismatch surfaced in an end-to-end test
**Artifact:** `SCOPES.md` (repo root)

---

## 1. Summary

A single, **hand-maintained** reference file — `SCOPES.md` — in the
`data-connectors` repo. Open it and you see every data scope, whether the **web**
(ODL Data Pipe API) and/or **desktop** (Playwright connectors) flow can fulfill
it, and the exact connector(s) behind each scope.

It is documentation, not machinery: no generator, no codegen, no automated sync.

## 2. Background — the bug

During a CG → Vana Web → Personal Server lab E2E, the lab requested `read:ads`
(→ `instagram.ads`). CG forwarded it correctly, but the **web (light)** flow can
only produce `instagram.profile`, so the Personal Server had no `instagram.ads`
data and the read returned a valid 404.

The architecture is two-tier:
- **Desktop / heavy** — Playwright connectors in `data-connectors`. Already canonical.
- **Web / light** — the ODL-run Data Pipe API (`data-pipe.vana.org`) used by the
  Vana Web app. Produces only `*.profile` today, for five wired sources.

"Which tier can fulfill which scope" was undocumented; the only place the web set
existed was a hardcoded list in `unity-surfaces`
(`web-writable-scopes.ts`). The open question was *where* this should
be documented. This spec answers: one file in data-connectors.

## 3. Decision — manual file, deliberately not generated

We considered generating the catalog from the connector manifests + a declared
web-capabilities input, and generating `unity-surfaces`'
`web-writable-scopes.ts` from it. **Rejected for now**: the web app's set of
web-fulfillable scopes changes infrequently, so the cost/complexity of a
generator, a vendored snapshot, and a sync step is not worth it. A single file a
human reads and edits is enough.

Consequences:
- No scripts are added to any repo.
- `unity-surfaces` `web-writable-scopes.ts` is unchanged and stays
  hand-maintained. Keeping it consistent with `SCOPES.md`'s Web column is a
  manual responsibility. If it drifts, we fix it by hand.

## 4. The file

`SCOPES.md` at the `data-connectors` repo root. One table:

| Column | Meaning |
|---|---|
| **Source** | source id (e.g. `instagram`) |
| **Scope** | canonical scope id (e.g. `instagram.ads`) |
| **Web** | ✅ if the ODL Data Pipe API can produce it (today: `*.profile` for instagram, spotify, youtube, linkedin, github) |
| **Desktop** | ✅ if a Playwright connector produces it |
| **Connector(s)** | the exact connector id(s) + status that fulfill the scope |

Plus a header explaining how to read it and a footer explaining how to maintain
it (update Desktop rows when a connector changes scopes; flip Web cells when the
Data Pipe API gains a scope; keep `web-writable-scopes.ts` consistent by hand).

## 5. Out of scope

- Any generator, sync script, or codegen.
- Changes to `unity-surfaces` (`web-writable-scopes.ts` stays as-is).
- A Data Pipe API capabilities endpoint.
- CG surfacing the tier at request time (e.g. warning "ads needs Desktop" in the
  lab) — a separate follow-on if desired.

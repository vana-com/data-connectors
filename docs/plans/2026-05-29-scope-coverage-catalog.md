# Scope Coverage Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate a single scope-coverage catalog in `data-connectors` declaring per-scope web/desktop producibility, and make unity-surfaces' `web-writable-scopes.ts` a generated view over it instead of a hand-maintained list.

**Architecture:** A pure transform (`buildScopeCoverage`) folds two inputs — connector manifests (desktop column) and a hand-declared `web-capabilities.json` (web column) — into `catalog/scope-coverage.json` plus a generated `SCOPES.md`. A thin CLI reads files and calls the pure core. unity-surfaces vendors a pinned copy of the JSON and derives its writable-scopes list from it.

**Tech Stack:** Node ESM (`.mjs`), Node built-in test runner (`node --test`) for data-connectors; TypeScript + vitest for unity-surfaces.

**Spec:** `data-connectors/docs/specs/2026-05-29-scope-coverage-catalog-design.md`

---

## File Structure

**data-connectors (repo root `/Users/maciej/Documents/vana/data-connectors`)**
- Create: `web-capabilities.json` — hand-declared web column (mirrors the Data Pipe API).
- Create: `scripts/scope-coverage-core.mjs` — pure functions: `buildScopeCoverage`, `renderScopesMarkdown`. No filesystem access; fully unit-testable.
- Create: `scripts/scope-coverage-core.test.mjs` — `node --test` unit tests for the pure core.
- Create: `scripts/generate-scope-coverage.mjs` — CLI: reads `registry.json` + manifests + `web-capabilities.json`, resolves schema paths, writes outputs.
- Create: `catalog/scope-coverage.json` — generated machine-readable SoT.
- Create: `SCOPES.md` — generated human-readable table.
- Modify: `package.json` — add `scope-coverage:generate` script.

**unity-surfaces (repo root `/Users/maciej/Documents/vana/unity-surfaces`)**
- Create: `apps/web/src/features/sources/generated/scope-coverage.json` — vendored pinned copy of the data-connectors output.
- Create: `scripts/sync-scope-coverage.mjs` — minimal copy script from a sibling `data-connectors` checkout.
- Modify: `apps/web/src/features/sources/web-writable-scopes.ts` — derive from the vendored JSON; delete the hardcoded map.
- Modify: `apps/web/src/features/sources/web-writable-scopes.test.mjs` — keep existing assertions; they now exercise the generated path.

---

## Phase A — data-connectors catalog

### Task A1: Pure core — `buildScopeCoverage`

**Files:**
- Create: `scripts/scope-coverage-core.mjs`
- Test: `scripts/scope-coverage-core.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/scope-coverage-core.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScopeCoverage } from "./scope-coverage-core.mjs";

const connectors = [
  { sourceId: "instagram", scopes: ["instagram.profile", "instagram.posts", "instagram.following", "instagram.ads"] },
  { sourceId: "instagram", scopes: ["instagram.ads"] },
  { sourceId: "github", scopes: ["github.profile", "github.repositories"] },
];
const webCapabilities = { sources: { instagram: ["instagram.profile"], github: ["github.profile"] } };

test("desktop column is the union of scopes across a source's connectors", () => {
  const coverage = buildScopeCoverage({ connectors, webCapabilities, schemaPaths: {} });
  const instagram = coverage.sources.instagram.scopes;
  assert.deepEqual(instagram.map((s) => s.scope), [
    "instagram.ads", "instagram.following", "instagram.posts", "instagram.profile",
  ]);
  assert.equal(instagram.every((s) => s.desktop), true);
});

test("web flag is true only for scopes declared in web-capabilities", () => {
  const coverage = buildScopeCoverage({ connectors, webCapabilities, schemaPaths: {} });
  const byScope = Object.fromEntries(coverage.sources.instagram.scopes.map((s) => [s.scope, s.web]));
  assert.equal(byScope["instagram.profile"], true);
  assert.equal(byScope["instagram.ads"], false);
});

test("schemaPaths are attached when present", () => {
  const coverage = buildScopeCoverage({
    connectors, webCapabilities,
    schemaPaths: { "instagram.profile": "connectors/meta/schemas/instagram.profile.json" },
  });
  const profile = coverage.sources.instagram.scopes.find((s) => s.scope === "instagram.profile");
  assert.equal(profile.schema, "connectors/meta/schemas/instagram.profile.json");
});

test("a web scope not present in any connector is a build error", () => {
  assert.throws(
    () => buildScopeCoverage({
      connectors,
      webCapabilities: { sources: { instagram: ["instagram.dms"] } },
      schemaPaths: {},
    }),
    /instagram declares web scope "instagram.dms" that is not a known connector scope/,
  );
});

test("version field and sorted source keys", () => {
  const coverage = buildScopeCoverage({ connectors, webCapabilities, schemaPaths: {} });
  assert.equal(coverage.scope_coverage_version, "1.0");
  assert.deepEqual(Object.keys(coverage.sources), ["github", "instagram"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/maciej/Documents/vana/data-connectors && node --test scripts/scope-coverage-core.test.mjs`
Expected: FAIL — `Cannot find module './scope-coverage-core.mjs'` (or `buildScopeCoverage is not a function`).

- [ ] **Step 3: Write minimal implementation**

Create `scripts/scope-coverage-core.mjs`:

```js
/**
 * Pure transforms for the scope-coverage catalog. No filesystem access — the
 * CLI (generate-scope-coverage.mjs) reads files and passes parsed inputs here.
 *
 * Inputs:
 *   connectors:     [{ sourceId: string, scopes: string[] }]
 *   webCapabilities: { sources: { [sourceId]: string[] } }
 *   schemaPaths:    { [scope]: string }  // repo-relative; optional per scope
 */
export function buildScopeCoverage({ connectors, webCapabilities, schemaPaths = {} }) {
  const desktopBySource = new Map();
  for (const connector of connectors) {
    if (!connector.sourceId) continue;
    const set = desktopBySource.get(connector.sourceId) ?? new Set();
    for (const scope of connector.scopes ?? []) set.add(scope);
    desktopBySource.set(connector.sourceId, set);
  }

  const webBySource = webCapabilities.sources ?? {};

  // Validation: every declared web scope must be a real connector scope.
  for (const [sourceId, scopes] of Object.entries(webBySource)) {
    const desktop = desktopBySource.get(sourceId);
    for (const scope of scopes) {
      if (!desktop || !desktop.has(scope)) {
        throw new Error(
          `web-capabilities.json: ${sourceId} declares web scope "${scope}" that is not a known connector scope`,
        );
      }
    }
  }

  const sourceIds = [...new Set([...desktopBySource.keys(), ...Object.keys(webBySource)])].sort();
  const sources = {};
  for (const sourceId of sourceIds) {
    const desktop = desktopBySource.get(sourceId) ?? new Set();
    const web = new Set(webBySource[sourceId] ?? []);
    const allScopes = [...new Set([...desktop, ...web])].sort();
    sources[sourceId] = {
      scopes: allScopes.map((scope) => ({
        scope,
        web: web.has(scope),
        desktop: desktop.has(scope),
        ...(schemaPaths[scope] ? { schema: schemaPaths[scope] } : {}),
      })),
    };
  }

  return { scope_coverage_version: "1.0", sources };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/maciej/Documents/vana/data-connectors && node --test scripts/scope-coverage-core.test.mjs`
Expected: PASS — 5 tests passing.

- [ ] **Step 5: Commit**

```bash
cd /Users/maciej/Documents/vana/data-connectors
git add scripts/scope-coverage-core.mjs scripts/scope-coverage-core.test.mjs
git commit -m "feat(scope-coverage): pure buildScopeCoverage transform"
```

---

### Task A2: Pure core — `renderScopesMarkdown`

**Files:**
- Modify: `scripts/scope-coverage-core.mjs`
- Test: `scripts/scope-coverage-core.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `scripts/scope-coverage-core.test.mjs`:

```js
import { renderScopesMarkdown } from "./scope-coverage-core.mjs";

test("renderScopesMarkdown emits a table per source with web/desktop ticks", () => {
  const coverage = buildScopeCoverage({ connectors, webCapabilities, schemaPaths: {} });
  const md = renderScopesMarkdown(coverage);
  assert.match(md, /^# Scope Coverage/m);
  assert.match(md, /## instagram/);
  assert.match(md, /\| `instagram\.profile` \| ✅ \| ✅ \|/);
  assert.match(md, /\| `instagram\.ads` \| — \| ✅ \|/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/maciej/Documents/vana/data-connectors && node --test scripts/scope-coverage-core.test.mjs`
Expected: FAIL — `renderScopesMarkdown is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/scope-coverage-core.mjs`:

```js
export function renderScopesMarkdown(coverage) {
  const lines = [
    "# Scope Coverage",
    "",
    "> Generated by `scripts/generate-scope-coverage.mjs`. Do not edit by hand.",
    "> Desktop = Playwright connectors. Web = the ODL Data Pipe API light flow",
    "> (declared in `web-capabilities.json`).",
    "",
  ];
  for (const [sourceId, source] of Object.entries(coverage.sources)) {
    lines.push(`## ${sourceId}`, "", "| Scope | Web | Desktop |", "|---|:--:|:--:|");
    for (const entry of source.scopes) {
      const web = entry.web ? "✅" : "—";
      const desktop = entry.desktop ? "✅" : "—";
      lines.push(`| \`${entry.scope}\` | ${web} | ${desktop} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/maciej/Documents/vana/data-connectors && node --test scripts/scope-coverage-core.test.mjs`
Expected: PASS — 6 tests passing.

- [ ] **Step 5: Commit**

```bash
cd /Users/maciej/Documents/vana/data-connectors
git add scripts/scope-coverage-core.mjs scripts/scope-coverage-core.test.mjs
git commit -m "feat(scope-coverage): renderScopesMarkdown table generator"
```

---

### Task A3: Create `web-capabilities.json`

**Files:**
- Create: `web-capabilities.json`

- [ ] **Step 1: Create the file**

Create `/Users/maciej/Documents/vana/data-connectors/web-capabilities.json`:

```json
{
  "$comment": "Hand-declared mirror of what the ODL Data Pipe API (data-pipe.vana.org) can produce per source via the web/light flow. Authored from the Data Pipe API's supported-source declarations. Replace with a generated pull from a Data Pipe capabilities endpoint when one exists. If this drifts from the real API capabilities, fix it here manually.",
  "web_capabilities_version": "1.0",
  "sources": {
    "instagram": ["instagram.profile"],
    "spotify": ["spotify.profile"],
    "youtube": ["youtube.profile"],
    "linkedin": ["linkedin.profile"],
    "github": ["github.profile"]
  }
}
```

- [ ] **Step 2: Verify each declared scope is a real connector scope**

Run (sanity check — lists every scope across manifests so you can confirm the five web scopes above appear):

```bash
cd /Users/maciej/Documents/vana/data-connectors
node -e "const{readFileSync}=require('node:fs');const r=JSON.parse(readFileSync('registry.json','utf8'));const out=new Set();for(const c of r.connectors){const m=JSON.parse(readFileSync('connectors/'+c.files.metadata,'utf8'));const sid=c.consumerMetadata?.sourceId??m.source_id;for(const s of m.scopes??[])out.add(sid+' :: '+(typeof s==='string'?s:s.scope));}console.log([...out].sort().join('\n'));"
```

Expected: output includes `github :: github.profile`, `instagram :: instagram.profile`, `spotify :: spotify.profile`, `youtube :: youtube.profile`, `linkedin :: linkedin.profile`. If any of the five is missing, that source's profile scope is named differently — fix `web-capabilities.json` to match before continuing (the generator in A4 will otherwise throw).

- [ ] **Step 3: Commit**

```bash
cd /Users/maciej/Documents/vana/data-connectors
git add web-capabilities.json
git commit -m "feat(scope-coverage): hand-declared web-capabilities.json"
```

---

### Task A4: CLI generator

**Files:**
- Create: `scripts/generate-scope-coverage.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write the generator**

Create `scripts/generate-scope-coverage.mjs`:

```js
#!/usr/bin/env node
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildScopeCoverage, renderScopesMarkdown } from "./scope-coverage-core.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function main() {
  const registry = readJson(join(repoRoot, "registry.json"));
  const webCapabilities = readJson(join(repoRoot, "web-capabilities.json"));

  const connectors = [];
  const schemaPaths = {};

  for (const entry of registry.connectors) {
    const metadataRel = join("connectors", entry.files.metadata);
    const metadata = readJson(join(repoRoot, metadataRel));
    const sourceId = entry.consumerMetadata?.sourceId ?? metadata.source_id;
    const scopes = (metadata.scopes ?? []).map((s) => (typeof s === "string" ? s : s.scope));
    connectors.push({ sourceId, scopes });

    // Schema lives next to the connector: connectors/<company>/schemas/<scope>.json
    const schemaDirRel = join(dirname(metadataRel), "schemas");
    for (const scope of scopes) {
      if (schemaPaths[scope]) continue;
      const candidate = join(schemaDirRel, `${scope}.json`);
      if (existsSync(join(repoRoot, candidate))) {
        schemaPaths[scope] = candidate;
      }
    }
  }

  const coverage = buildScopeCoverage({ connectors, webCapabilities, schemaPaths });

  mkdirSync(join(repoRoot, "catalog"), { recursive: true });
  writeFileSync(
    join(repoRoot, "catalog", "scope-coverage.json"),
    `${JSON.stringify(coverage, null, 2)}\n`,
  );
  writeFileSync(join(repoRoot, "SCOPES.md"), renderScopesMarkdown(coverage));

  const sourceCount = Object.keys(coverage.sources).length;
  console.log(`Generated catalog/scope-coverage.json and SCOPES.md for ${sourceCount} sources.`);
}

main();
```

- [ ] **Step 2: Add the npm script**

In `/Users/maciej/Documents/vana/data-connectors/package.json`, add to `"scripts"` (after `"connector-index:check"`):

```json
    "scope-coverage:generate": "node ./scripts/generate-scope-coverage.mjs",
```

- [ ] **Step 3: Run the generator**

Run: `cd /Users/maciej/Documents/vana/data-connectors && npm run scope-coverage:generate`
Expected: prints `Generated catalog/scope-coverage.json and SCOPES.md for N sources.` and exits 0. If it throws `declares web scope ... not a known connector scope`, fix `web-capabilities.json` (Task A3).

- [ ] **Step 4: Eyeball the output**

Run: `cd /Users/maciej/Documents/vana/data-connectors && cat SCOPES.md && node -e "const c=require('./catalog/scope-coverage.json');console.log(JSON.stringify(c.sources.instagram,null,2))"`
Expected: `instagram` shows `instagram.profile` with `web: true, desktop: true`; `instagram.ads`, `instagram.posts`, `instagram.following` with `web: false, desktop: true`.

- [ ] **Step 5: Commit**

```bash
cd /Users/maciej/Documents/vana/data-connectors
git add scripts/generate-scope-coverage.mjs package.json catalog/scope-coverage.json SCOPES.md
git commit -m "feat(scope-coverage): generator CLI + generated catalog and SCOPES.md"
```

---

## Phase B — unity-surfaces consumes the catalog

> Phase B depends on `catalog/scope-coverage.json` produced in Phase A.

### Task B1: Vendor the catalog into unity-surfaces

**Files:**
- Create: `apps/web/src/features/sources/generated/scope-coverage.json`
- Create: `scripts/sync-scope-coverage.mjs`

- [ ] **Step 1: Write the sync script**

Create `/Users/maciej/Documents/vana/unity-surfaces/scripts/sync-scope-coverage.mjs`:

```js
#!/usr/bin/env node
// Copies the generated scope-coverage catalog from a sibling data-connectors
// checkout into the vendored location. Override the source with
// DATA_CONNECTORS_DIR. Manual sync for now — re-run when the catalog changes.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const sourceDir = process.env.DATA_CONNECTORS_DIR ?? resolve(repoRoot, "..", "data-connectors");
const source = join(sourceDir, "catalog", "scope-coverage.json");
const dest = join(repoRoot, "apps/web/src/features/sources/generated/scope-coverage.json");

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(source, dest);
console.log(`Synced ${source} -> ${dest}`);
```

- [ ] **Step 2: Run the sync**

Run: `cd /Users/maciej/Documents/vana/unity-surfaces && node scripts/sync-scope-coverage.mjs`
Expected: prints `Synced .../data-connectors/catalog/scope-coverage.json -> .../generated/scope-coverage.json`. The file `apps/web/src/features/sources/generated/scope-coverage.json` now exists.

- [ ] **Step 3: Confirm the vendored file content**

Run: `cd /Users/maciej/Documents/vana/unity-surfaces && node -e "const c=require('./apps/web/src/features/sources/generated/scope-coverage.json');console.log(c.sources.instagram.scopes.filter(s=>s.web).map(s=>s.scope))"`
Expected: `[ 'instagram.profile' ]`.

- [ ] **Step 4: Commit**

```bash
cd /Users/maciej/Documents/vana/unity-surfaces
git add scripts/sync-scope-coverage.mjs apps/web/src/features/sources/generated/scope-coverage.json
git commit -m "chore(sources): vendor data-connectors scope-coverage catalog"
```

---

### Task B2: Derive `web-writable-scopes.ts` from the catalog

**Files:**
- Modify: `apps/web/src/features/sources/web-writable-scopes.ts`
- Test: `apps/web/src/features/sources/web-writable-scopes.test.mjs`

- [ ] **Step 1: Confirm the existing test still expresses the contract**

The current test (`web-writable-scopes.test.mjs`) already asserts the behavior we must preserve:

```js
expect(getWebWritableScopes("instagram")).toEqual(["instagram.profile"]);
expect(getWebWritableScopes("github")).toEqual(["github.profile"]);
expect(getWebWritableScopes("linkedin")).toEqual(["linkedin.profile"]);
expect(getWebWritableScopes("spotify")).toEqual(["spotify.profile"]);
expect(getWebWritableScopes("youtube")).toEqual(["youtube.profile"]);
expect(getWebWritableScopes("amazon")).toEqual([]);
expect(getWebWritableScopes("")).toEqual([]);
```

No new test needed — these become the regression guard for the generated path. Leave the file unchanged.

- [ ] **Step 2: Run the test against the OLD implementation to confirm green baseline**

Run: `cd /Users/maciej/Documents/vana/unity-surfaces/apps/web && npx vitest run src/features/sources/web-writable-scopes.test.mjs`
Expected: PASS (against the current hardcoded map).

- [ ] **Step 3: Replace the implementation**

Overwrite `apps/web/src/features/sources/web-writable-scopes.ts` with:

```ts
/**
 * The exact set of scopes the web (light) connector can write into the user's
 * Personal Server today.
 *
 * Source of truth — generated. This list is DERIVED from the vendored
 * scope-coverage catalog (`generated/scope-coverage.json`), which is produced
 * by data-connectors from `web-capabilities.json`. Do not hand-edit the set of
 * web-writable scopes here; change it in data-connectors and re-run
 * `node scripts/sync-scope-coverage.mjs`.
 */
import scopeCoverageData from "./generated/scope-coverage.json";

interface ScopeCoverageEntry {
  scope: string;
  web: boolean;
  desktop: boolean;
  schema?: string;
}

const sourcesBySourceId = scopeCoverageData.sources as Record<
  string,
  { scopes: ScopeCoverageEntry[] }
>;

export function getWebWritableScopes(sourceId: string): string[] {
  const source = sourcesBySourceId[sourceId];
  if (!source) {
    return [];
  }
  return source.scopes.filter((entry) => entry.web).map((entry) => entry.scope);
}
```

- [ ] **Step 4: Run the test against the NEW implementation**

Run: `cd /Users/maciej/Documents/vana/unity-surfaces/apps/web && npx vitest run src/features/sources/web-writable-scopes.test.mjs`
Expected: PASS — identical results, now sourced from the generated catalog.

- [ ] **Step 5: Run the scope-readiness tests (downstream consumer)**

Run: `cd /Users/maciej/Documents/vana/unity-surfaces/apps/web && npx vitest run src/features/sources/web-writable-scopes.test.mjs src/features/data-connection-requests/scope-readiness.test.mjs`
Expected: PASS — `scope-readiness` is unaffected (it takes `webWritableScopes` as an argument; the `desktop-required` routing for `instagram.ads` is unchanged).

- [ ] **Step 6: Lint the changed file**

Run: `cd /Users/maciej/Documents/vana/unity-surfaces && npm run --prefix apps/web lint`
Expected: PASS (no Biome errors on the new import ordering / formatting). Fix any formatting Biome flags.

- [ ] **Step 7: Commit**

```bash
cd /Users/maciej/Documents/vana/unity-surfaces
git add apps/web/src/features/sources/web-writable-scopes.ts
git commit -m "refactor(sources): derive web-writable scopes from generated catalog"
```

---

## Self-Review (completed during planning)

- **Spec coverage:** §4 architecture → Tasks A1–A4 + B1–B2. §5 `web-capabilities.json` → A3. §6 generator + validation + both outputs → A1 (validation), A2 (`SCOPES.md`), A4 (CLI, `scope-coverage.json`). §7 unity-surfaces vendoring + generated `web-writable-scopes.ts` → B1, B2. §8 file list → matches File Structure. §9 testing → A1/A2 unit tests, B2 regression tests. §3 non-goals (no CI, no automated guard, no Data Pipe endpoint, no CG surfacing, `normalizeBodyScope` untouched) → respected; none introduce tasks.
- **Placeholder scan:** none — every code/command step is concrete.
- **Type/name consistency:** `buildScopeCoverage` / `renderScopesMarkdown` signatures match across A1, A2, A4; `scope-coverage.json` shape (`scope_coverage_version`, `sources[id].scopes[].{scope,web,desktop,schema?}`) consistent across A1, A4, B1, B2; `getWebWritableScopes(sourceId)` signature preserved so callers in `scope-readiness.ts` / `client.tsx` need no change.
- **Manual-drift note:** keeping `web-capabilities.json` and the vendored copy truthful is manual (per spec §3); no guard task by design.

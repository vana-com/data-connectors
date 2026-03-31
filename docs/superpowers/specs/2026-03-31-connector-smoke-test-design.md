# Connector Smoke Test Harness — Design Spec

## Purpose

A batch orchestrator that runs all stable connectors headlessly using pre-existing browser sessions, validates output against declared scopes, and reports per-connector health. Designed for local use with a path to CI.

## Architecture

The harness wraps `run-connector.cjs` — the maintained standalone runner that already handles runner resolution, auth classification, result capture, and process lifecycle. The test harness is a thin loop: resolve connectors from `registry.json`, spawn `run-connector.cjs` once per connector with a unique `--output` path, classify outcomes from exit codes + stdout, validate the result file against metadata scopes, and report.

## Connector Resolution

- Source: root `registry.json` (15 connectors: 6 stable, 5 beta, 4 experimental)
- Default policy: **stable connectors only** (chatgpt, github, instagram, linkedin, spotify, oura)
- `--connectors <id>,<id>` overrides the default set, filtering by connector ID
- `--include-beta` expands default to stable + beta

## Execution Per Connector

1. Delete any previous `test-results/<connector-id>.json` (remove stale results)
2. Resolve connector script path from registry entry's `files.script`
3. Resolve start URL from connector metadata's `connectURL`
4. Spawn: `node run-connector.cjs <script-path> <start-url> --output test-results/<connector-id>.json`
5. Capture stdout (JSON lines) for timeout detection and logging
6. Wait for exit

## Outcome Classification

| Status    | Condition                                                        |
|-----------|------------------------------------------------------------------|
| **PASS**  | Exit 0 + all metadata scopes present in result with non-empty data |
| **WARN**  | Exit 0 + all scopes present but some have empty arrays/objects    |
| **AUTH**  | Exit 2 (need-input) or exit 3 (legacy-auth)                      |
| **FAIL**  | Exit 0 but missing scopes, or exit 1 without timeout message     |
| **TIMEOUT** | Exit 1 + stdout contains `"Timeout after 5 minutes"` error event |

## Validation Rules

- For each scope in the connector's `.json` metadata, check that the result object contains a key matching the full scope (e.g., `github.profile`)
- Non-empty means the value is not `null`, not `undefined`
- Empty arrays (`[]`) or empty objects (`{}`) are **warnings**, not failures — a user could legitimately have zero starred repos
- Only validate result files from exit-0 runs

### Scope Normalization (temporary)

`github-playwright` currently returns bare keys (`profile`, `repositories`, `starred`) instead of scoped keys (`github.profile`, etc.). Until vana-com/data-connectors#52 lands, the harness checks both `<scope>` and the bare suffix (everything after the first dot) when matching result keys. This normalization applies only during validation, not to the result file itself.

## Schema Validation (opt-in)

When `--validate-schemas` is passed, the harness additionally validates each scope's data against the corresponding JSON Schema file in `schemas/<scope>.json`. This is not the default because schemas are strict and may flag acceptable variations in live data.

## Output

### Terminal (colored table)

```
Connector Smoke Test — 2026-03-31T12:00:00Z

  PASS  chatgpt-playwright     2/2 scopes   18.2s
  WARN  instagram-playwright   3/3 scopes   12.1s  (instagram.posts: empty array)
  AUTH  spotify-playwright     —              2.3s  (need-input: session expired)
  FAIL  github-playwright      2/3 scopes    6.4s  (missing: github.starred)
  PASS  linkedin-playwright    6/6 scopes   22.1s
  PASS  oura-playwright        3/3 scopes   14.7s

3 pass · 1 warn · 1 auth · 1 fail · 0 timeout — 75.8s total
```

### JSON report

Written to `test-results/connector-smoke-<timestamp>.json`:

```json
{
  "timestamp": "2026-03-31T12:00:00Z",
  "summary": { "pass": 3, "warn": 1, "auth": 1, "fail": 1, "timeout": 0, "total": 6 },
  "results": [
    {
      "connector": "spotify-playwright",
      "status": "auth",
      "exitCode": 2,
      "duration": 2300,
      "error": "need-input: session expired"
    },
    {
      "connector": "github-playwright",
      "status": "fail",
      "exitCode": 0,
      "duration": 6400,
      "scopesExpected": ["github.profile", "github.repositories", "github.starred"],
      "scopesFound": ["github.profile", "github.repositories"],
      "scopesMissing": ["github.starred"]
    }
  ]
}
```

## Invocation

```bash
# Default: stable connectors only
node scripts/test-connectors.cjs

# Specific connectors
node scripts/test-connectors.cjs --connectors instagram-playwright,spotify-playwright

# Include beta
node scripts/test-connectors.cjs --include-beta

# With schema validation
node scripts/test-connectors.cjs --validate-schemas
```

## Files

- **New:** `scripts/test-connectors.cjs` (the harness)
- **New:** `test-results/` directory (gitignored)
- **Modified:** `.gitignore` (add `test-results/`)

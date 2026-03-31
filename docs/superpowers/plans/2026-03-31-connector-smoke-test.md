# Connector Smoke Test Harness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a batch test harness that runs stable connectors headlessly, validates output against declared scopes, and reports per-connector health as a colored terminal table + JSON report.

**Architecture:** A single CJS script (`scripts/test-connectors.cjs`) that reads `registry.json` and connector metadata, loops over connectors, spawns `run-connector.cjs` for each with a unique `--output` path, classifies outcomes from exit codes + stdout, validates result files against metadata scopes, and prints a summary table + writes a JSON report.

**Tech Stack:** Node.js (CJS), child_process.spawn, fs, path. No external dependencies.

---

## File Structure

| File | Responsibility |
|---|---|
| `scripts/test-connectors.cjs` (create) | CLI entrypoint: arg parsing, connector resolution from registry, orchestration loop, result validation, terminal + JSON reporting |
| `.gitignore` (modify) | Add `test-results/` |

All logic lives in one file. The harness is ~300 lines with no external dependencies.

---

### Task 1: Gitignore and test-results directory

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Add test-results/ to .gitignore**

Add this line to `.gitignore` after the existing `connector-result.json` entry:

```
test-results/
```

The full `# Test runner output` section becomes:

```gitignore
# Test runner output
connector-result.json
test-results/
```

- [ ] **Step 2: Commit**

```bash
git add .gitignore
git commit -m "chore: gitignore test-results directory"
```

---

### Task 2: Arg parsing and connector resolution

**Files:**
- Create: `scripts/test-connectors.cjs`

- [ ] **Step 1: Write the test**

Create `scripts/test-connectors.test.cjs` (we'll run it with `node --test`):

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');

// We'll extract pure functions from the main script for testing.
// For now, test the module by requiring it with a test flag.
// The main script exports { parseArgs, resolveConnectors, classifyOutcome, validateResult }
// when require.main !== module.

const {
  parseArgs,
  resolveConnectors,
  classifyOutcome,
  validateResult,
} = require('./test-connectors.cjs');

describe('parseArgs', () => {
  it('returns stable defaults with no args', () => {
    const result = parseArgs([]);
    assert.strictEqual(result.includeBeta, false);
    assert.strictEqual(result.validateSchemas, false);
    assert.deepStrictEqual(result.connectors, null);
  });

  it('parses --connectors flag', () => {
    const result = parseArgs(['--connectors', 'instagram-playwright,spotify-playwright']);
    assert.deepStrictEqual(result.connectors, ['instagram-playwright', 'spotify-playwright']);
  });

  it('parses --include-beta flag', () => {
    const result = parseArgs(['--include-beta']);
    assert.strictEqual(result.includeBeta, true);
  });

  it('parses --validate-schemas flag', () => {
    const result = parseArgs(['--validate-schemas']);
    assert.strictEqual(result.validateSchemas, true);
  });
});

describe('resolveConnectors', () => {
  const registry = {
    connectors: [
      { id: 'a-playwright', status: 'stable', files: { script: 'a/a.js', metadata: 'a/a.json' } },
      { id: 'b-playwright', status: 'beta', files: { script: 'b/b.js', metadata: 'b/b.json' } },
      { id: 'c-playwright', status: 'experimental', files: { script: 'c/c.js', metadata: 'c/c.json' } },
    ],
  };

  it('returns only stable by default', () => {
    const result = resolveConnectors(registry, { connectors: null, includeBeta: false });
    assert.deepStrictEqual(result.map(c => c.id), ['a-playwright']);
  });

  it('includes beta when flag set', () => {
    const result = resolveConnectors(registry, { connectors: null, includeBeta: true });
    assert.deepStrictEqual(result.map(c => c.id), ['a-playwright', 'b-playwright']);
  });

  it('filters to specific connectors', () => {
    const result = resolveConnectors(registry, { connectors: ['b-playwright'], includeBeta: false });
    assert.deepStrictEqual(result.map(c => c.id), ['b-playwright']);
  });

  it('throws on unknown connector id', () => {
    assert.throws(
      () => resolveConnectors(registry, { connectors: ['nonexistent'], includeBeta: false }),
      /not found in registry: nonexistent/
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/test-connectors.test.cjs`
Expected: FAIL — `Cannot find module './test-connectors.cjs'`

- [ ] **Step 3: Write arg parsing and connector resolution**

Create `scripts/test-connectors.cjs`:

```js
#!/usr/bin/env node
/**
 * test-connectors.cjs — Batch smoke test for data connectors.
 *
 * Wraps run-connector.cjs to run each connector headlessly, validates output
 * against declared scopes, and reports per-connector health.
 *
 * Usage:
 *   node scripts/test-connectors.cjs [options]
 *
 * Options:
 *   --connectors <id>,<id>  Override default connector set (comma-separated IDs)
 *   --include-beta          Include beta connectors (default: stable only)
 *   --validate-schemas      Validate result data against schemas/*.json
 *
 * Exit codes: 0 all pass/warn, 1 any fail/auth/timeout
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REGISTRY_PATH = path.join(ROOT, 'registry.json');
const CONNECTORS_DIR = path.join(ROOT, 'connectors');
const RESULTS_DIR = path.join(ROOT, 'test-results');
const RUN_CONNECTOR = path.join(ROOT, 'run-connector.cjs');

// ─── ANSI Colors ────────────────────────────────────────────

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m',
};

// ─── Arg Parsing ────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { connectors: null, includeBeta: false, validateSchemas: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--connectors' && argv[i + 1]) {
      opts.connectors = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    } else if (argv[i] === '--include-beta') {
      opts.includeBeta = true;
    } else if (argv[i] === '--validate-schemas') {
      opts.validateSchemas = true;
    }
  }
  return opts;
}

// ─── Connector Resolution ───────────────────────────────────

function resolveConnectors(registry, opts) {
  if (opts.connectors) {
    // Explicit list — find each by ID, regardless of status
    return opts.connectors.map(id => {
      const entry = registry.connectors.find(c => c.id === id);
      if (!entry) throw new Error(`Connector not found in registry: ${id}`);
      return entry;
    });
  }
  // Default: stable, or stable + beta
  const allowed = opts.includeBeta ? ['stable', 'beta'] : ['stable'];
  return registry.connectors.filter(c => allowed.includes(c.status));
}

// ─── Exports for testing ────────────────────────────────────

if (require.main !== module) {
  module.exports = { parseArgs, resolveConnectors };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/test-connectors.test.cjs`
Expected: All `parseArgs` and `resolveConnectors` tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/test-connectors.cjs scripts/test-connectors.test.cjs
git commit -m "feat(test-connectors): arg parsing and connector resolution"
```

---

### Task 3: Outcome classification and result validation

**Files:**
- Modify: `scripts/test-connectors.test.cjs`
- Modify: `scripts/test-connectors.cjs`

- [ ] **Step 1: Write the tests**

Append to `scripts/test-connectors.test.cjs`:

```js
describe('classifyOutcome', () => {
  it('returns AUTH for exit code 2', () => {
    const result = classifyOutcome(2, []);
    assert.strictEqual(result.status, 'auth');
    assert.match(result.error, /need-input/);
  });

  it('returns AUTH for exit code 3', () => {
    const result = classifyOutcome(3, []);
    assert.strictEqual(result.status, 'auth');
    assert.match(result.error, /legacy-auth/);
  });

  it('returns TIMEOUT for exit 1 with timeout message', () => {
    const stdout = [
      JSON.stringify({ type: 'error', message: 'Timeout after 5 minutes' }),
    ];
    const result = classifyOutcome(1, stdout);
    assert.strictEqual(result.status, 'timeout');
  });

  it('returns FAIL for exit 1 without timeout', () => {
    const stdout = [
      JSON.stringify({ type: 'error', message: 'Some other error' }),
    ];
    const result = classifyOutcome(1, stdout);
    assert.strictEqual(result.status, 'fail');
  });

  it('returns needs-validation for exit 0', () => {
    const result = classifyOutcome(0, []);
    assert.strictEqual(result.status, 'needs-validation');
  });
});

describe('validateResult', () => {
  const metadata = {
    scopes: [
      { scope: 'test.profile' },
      { scope: 'test.posts' },
      { scope: 'test.likes' },
    ],
  };

  it('returns PASS when all scopes present and non-empty', () => {
    const data = {
      'test.profile': { name: 'Alice' },
      'test.posts': [{ id: 1 }],
      'test.likes': [{ id: 2 }],
      exportSummary: { count: 2 },
    };
    const result = validateResult(data, metadata);
    assert.strictEqual(result.status, 'pass');
    assert.strictEqual(result.scopesFound.length, 3);
    assert.strictEqual(result.scopesMissing.length, 0);
  });

  it('returns WARN when scope has empty array', () => {
    const data = {
      'test.profile': { name: 'Alice' },
      'test.posts': [],
      'test.likes': [{ id: 2 }],
    };
    const result = validateResult(data, metadata);
    assert.strictEqual(result.status, 'warn');
    assert.deepStrictEqual(result.warnings, ['test.posts: empty array']);
  });

  it('returns WARN when scope has empty object', () => {
    const data = {
      'test.profile': {},
      'test.posts': [{ id: 1 }],
      'test.likes': [{ id: 2 }],
    };
    const result = validateResult(data, metadata);
    assert.strictEqual(result.status, 'warn');
    assert.deepStrictEqual(result.warnings, ['test.profile: empty object']);
  });

  it('returns FAIL when scope is missing', () => {
    const data = {
      'test.profile': { name: 'Alice' },
      'test.posts': [{ id: 1 }],
    };
    const result = validateResult(data, metadata);
    assert.strictEqual(result.status, 'fail');
    assert.deepStrictEqual(result.scopesMissing, ['test.likes']);
  });

  it('returns FAIL when scope value is null', () => {
    const data = {
      'test.profile': { name: 'Alice' },
      'test.posts': [{ id: 1 }],
      'test.likes': null,
    };
    const result = validateResult(data, metadata);
    assert.strictEqual(result.status, 'fail');
    assert.deepStrictEqual(result.scopesMissing, ['test.likes']);
  });

  it('normalizes bare keys for github-style connectors', () => {
    const githubMeta = {
      scopes: [
        { scope: 'github.profile' },
        { scope: 'github.repositories' },
      ],
    };
    const data = {
      profile: { name: 'Alice' },
      repositories: [{ name: 'repo1' }],
    };
    const result = validateResult(data, githubMeta);
    assert.strictEqual(result.status, 'pass');
    assert.strictEqual(result.scopesFound.length, 2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/test-connectors.test.cjs`
Expected: FAIL — `classifyOutcome is not a function`, `validateResult is not a function`

- [ ] **Step 3: Implement classifyOutcome and validateResult**

Add to `scripts/test-connectors.cjs`, before the `if (require.main !== module)` block:

```js
// ─── Outcome Classification ─────────────────────────────────

function classifyOutcome(exitCode, stdoutLines) {
  if (exitCode === 2) return { status: 'auth', error: 'need-input: connector requires credentials' };
  if (exitCode === 3) return { status: 'auth', error: 'legacy-auth: connector uses headed login not supported in batch mode' };
  if (exitCode === 1) {
    const isTimeout = stdoutLines.some(line => {
      try {
        const msg = JSON.parse(line);
        return msg.type === 'error' && msg.message && msg.message.includes('Timeout after 5 minutes');
      } catch { return false; }
    });
    return isTimeout
      ? { status: 'timeout', error: 'Timed out after 5 minutes' }
      : { status: 'fail', error: 'Connector exited with error' };
  }
  if (exitCode === 0) return { status: 'needs-validation' };
  return { status: 'fail', error: `Unknown exit code: ${exitCode}` };
}

// ─── Result Validation ──────────────────────────────────────

function validateResult(data, metadata) {
  const expectedScopes = (metadata.scopes || []).map(s => s.scope);
  const scopesFound = [];
  const scopesMissing = [];
  const warnings = [];

  for (const scope of expectedScopes) {
    // Try exact scoped key first, then bare suffix (for github-style connectors)
    const bareSuffix = scope.includes('.') ? scope.split('.').slice(1).join('.') : null;
    const value = scope in data ? data[scope] : (bareSuffix && bareSuffix in data ? data[bareSuffix] : undefined);

    if (value === undefined || value === null) {
      scopesMissing.push(scope);
      continue;
    }

    scopesFound.push(scope);

    if (Array.isArray(value) && value.length === 0) {
      warnings.push(`${scope}: empty array`);
    } else if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) {
      warnings.push(`${scope}: empty object`);
    }
  }

  if (scopesMissing.length > 0) {
    return { status: 'fail', scopesFound, scopesMissing, warnings };
  }
  if (warnings.length > 0) {
    return { status: 'warn', scopesFound, scopesMissing, warnings };
  }
  return { status: 'pass', scopesFound, scopesMissing, warnings };
}
```

Update the exports block:

```js
if (require.main !== module) {
  module.exports = { parseArgs, resolveConnectors, classifyOutcome, validateResult };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/test-connectors.test.cjs`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/test-connectors.cjs scripts/test-connectors.test.cjs
git commit -m "feat(test-connectors): outcome classification and result validation"
```

---

### Task 4: Orchestration loop and reporting

**Files:**
- Modify: `scripts/test-connectors.cjs`

- [ ] **Step 1: Implement the main function and connector runner**

Add to `scripts/test-connectors.cjs`, replacing the `if (require.main !== module)` block with:

```js
// ─── Run a single connector via run-connector.cjs ───────────

function runConnector(connectorEntry, opts) {
  return new Promise((resolve) => {
    const scriptPath = path.join(CONNECTORS_DIR, '..', connectorEntry.files.script);
    const metadataPath = scriptPath.replace(/\.js$/, '.json');
    const outputPath = path.join(RESULTS_DIR, `${connectorEntry.id}.json`);

    // Load metadata for connectURL and scope info
    let metadata = {};
    try { metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8')); } catch {}
    const startUrl = metadata.connectURL || 'about:blank';

    // Delete stale result file
    try { fs.unlinkSync(outputPath); } catch {}

    const startTime = Date.now();
    const stdoutLines = [];

    const child = spawn(process.execPath, [
      RUN_CONNECTOR, scriptPath, startUrl, '--output', outputPath,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    child.stdout.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) stdoutLines.push(line.trim());
      }
    });

    // Suppress stderr (runner debug output)
    child.stderr.on('data', () => {});

    child.on('close', (exitCode) => {
      const duration = Date.now() - startTime;
      const outcome = classifyOutcome(exitCode || 0, stdoutLines);

      if (outcome.status === 'needs-validation') {
        // Read and validate result file
        let data = null;
        try { data = JSON.parse(fs.readFileSync(outputPath, 'utf-8')); } catch {}

        if (!data) {
          resolve({ connector: connectorEntry.id, status: 'fail', exitCode: 0, duration, error: 'No result file produced' });
          return;
        }

        const validation = validateResult(data, metadata);
        resolve({
          connector: connectorEntry.id,
          status: validation.status,
          exitCode: 0,
          duration,
          scopesExpected: (metadata.scopes || []).map(s => s.scope),
          scopesFound: validation.scopesFound,
          scopesMissing: validation.scopesMissing,
          warnings: validation.warnings.length > 0 ? validation.warnings : undefined,
        });
      } else {
        resolve({
          connector: connectorEntry.id,
          status: outcome.status,
          exitCode: exitCode || 0,
          duration,
          error: outcome.error,
        });
      }
    });
  });
}

// ─── Reporting ──────────────────────────────────────────────

function printResults(results) {
  const timestamp = new Date().toISOString();
  console.log(`\n${c.bold}Connector Smoke Test${c.reset} ${c.dim}— ${timestamp}${c.reset}\n`);

  for (const r of results) {
    const dur = (r.duration / 1000).toFixed(1) + 's';
    const scopeCount = r.scopesExpected
      ? `${r.scopesFound.length}/${r.scopesExpected.length} scopes`
      : '—';

    let detail = '';
    if (r.warnings && r.warnings.length > 0) detail = `  (${r.warnings.join(', ')})`;
    if (r.scopesMissing && r.scopesMissing.length > 0) detail = `  (missing: ${r.scopesMissing.join(', ')})`;
    if (r.error) detail = `  (${r.error})`;

    let statusStr;
    switch (r.status) {
      case 'pass':    statusStr = `${c.green}PASS${c.reset}   `; break;
      case 'warn':    statusStr = `${c.yellow}WARN${c.reset}   `; break;
      case 'auth':    statusStr = `${c.magenta}AUTH${c.reset}   `; break;
      case 'fail':    statusStr = `${c.red}FAIL${c.reset}   `; break;
      case 'timeout': statusStr = `${c.red}TIMEOUT${c.reset}`; break;
      default:        statusStr = `${c.gray}???${c.reset}    `;
    }

    const id = r.connector.padEnd(28);
    const sc = scopeCount.padEnd(14);
    console.log(`  ${statusStr} ${id} ${sc} ${dur}${c.dim}${detail}${c.reset}`);
  }

  const counts = { pass: 0, warn: 0, auth: 0, fail: 0, timeout: 0 };
  let totalDuration = 0;
  for (const r of results) {
    counts[r.status] = (counts[r.status] || 0) + 1;
    totalDuration += r.duration;
  }

  const parts = [];
  if (counts.pass) parts.push(`${c.green}${counts.pass} pass${c.reset}`);
  if (counts.warn) parts.push(`${c.yellow}${counts.warn} warn${c.reset}`);
  if (counts.auth) parts.push(`${c.magenta}${counts.auth} auth${c.reset}`);
  if (counts.fail) parts.push(`${c.red}${counts.fail} fail${c.reset}`);
  if (counts.timeout) parts.push(`${c.red}${counts.timeout} timeout${c.reset}`);

  console.log(`\n${parts.join(' · ')} — ${(totalDuration / 1000).toFixed(1)}s total\n`);

  return counts;
}

function writeJsonReport(results) {
  const timestamp = new Date().toISOString();
  const counts = { pass: 0, warn: 0, auth: 0, fail: 0, timeout: 0 };
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;

  const report = {
    timestamp,
    summary: { ...counts, total: results.length },
    results,
  };

  const reportPath = path.join(RESULTS_DIR, `connector-smoke-${timestamp.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`${c.dim}Report: ${reportPath}${c.reset}\n`);
  return reportPath;
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // Load registry
  if (!fs.existsSync(REGISTRY_PATH)) {
    console.error(`${c.red}Registry not found: ${REGISTRY_PATH}${c.reset}`);
    process.exit(1);
  }
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));

  // Resolve connectors
  const connectors = resolveConnectors(registry, opts);
  if (connectors.length === 0) {
    console.error(`${c.red}No connectors matched.${c.reset}`);
    process.exit(1);
  }

  // Ensure results directory
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  // Verify run-connector.cjs exists
  if (!fs.existsSync(RUN_CONNECTOR)) {
    console.error(`${c.red}run-connector.cjs not found: ${RUN_CONNECTOR}${c.reset}`);
    process.exit(1);
  }

  // Run connectors sequentially (each needs its own browser)
  const results = [];
  for (const entry of connectors) {
    const label = `${c.cyan}${entry.name}${c.reset} ${c.dim}(${entry.id})${c.reset}`;
    process.stdout.write(`  Running ${label}...`);
    const result = await runConnector(entry, opts);
    // Clear the "Running..." line
    process.stdout.write('\r\x1b[K');
    results.push(result);
  }

  // Report
  const counts = printResults(results);
  writeJsonReport(results);

  // Exit 1 if any fail/auth/timeout
  const hasFailure = counts.fail > 0 || counts.auth > 0 || counts.timeout > 0;
  process.exit(hasFailure ? 1 : 0);
}

// ─── Exports for testing ────────────────────────────────────

if (require.main !== module) {
  module.exports = { parseArgs, resolveConnectors, classifyOutcome, validateResult };
} else {
  main().catch((err) => {
    console.error(`${c.red}Fatal: ${err.message}${c.reset}`);
    process.exit(1);
  });
}
```

- [ ] **Step 2: Run existing tests to verify nothing broke**

Run: `node --test scripts/test-connectors.test.cjs`
Expected: All previous tests still PASS

- [ ] **Step 3: Manual smoke test**

Run the harness against a single connector you have cookies for:

```bash
node scripts/test-connectors.cjs --connectors github-playwright
```

Expected: A single-row result table showing PASS, WARN, AUTH, or FAIL with timing.

- [ ] **Step 4: Commit**

```bash
git add scripts/test-connectors.cjs
git commit -m "feat(test-connectors): orchestration loop and reporting"
```

---

### Task 5: Schema validation (opt-in)

**Files:**
- Modify: `scripts/test-connectors.test.cjs`
- Modify: `scripts/test-connectors.cjs`

- [ ] **Step 1: Write the test**

Append to `scripts/test-connectors.test.cjs`:

```js
describe('validateSchema', () => {
  it('returns pass for data matching schema', () => {
    const schema = {
      type: 'object',
      properties: {
        username: { type: 'string' },
        followers: { type: 'number' },
      },
      required: ['username'],
    };
    const data = { username: 'alice', followers: 42 };
    const errors = validateSchema(data, schema);
    assert.deepStrictEqual(errors, []);
  });

  it('returns error for missing required field', () => {
    const schema = {
      type: 'object',
      properties: {
        username: { type: 'string' },
      },
      required: ['username'],
    };
    const data = { followers: 42 };
    const errors = validateSchema(data, schema);
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /required.*username/i);
  });

  it('returns error for wrong type', () => {
    const schema = {
      type: 'object',
      properties: {
        username: { type: 'string' },
      },
      required: ['username'],
    };
    const data = { username: 123 };
    const errors = validateSchema(data, schema);
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /username.*string/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/test-connectors.test.cjs`
Expected: FAIL — `validateSchema is not a function`

- [ ] **Step 3: Implement lightweight schema validator**

Add to `scripts/test-connectors.cjs`, before the `classifyOutcome` function:

```js
// ─── Lightweight JSON Schema Validator ──────────────────────
// Validates required fields and basic types. Not a full JSON Schema
// implementation — just enough for smoke testing connector output.

function validateSchema(data, schema) {
  const errors = [];
  if (!schema || schema.type !== 'object' || !schema.properties) return errors;

  // Check required fields
  for (const field of (schema.required || [])) {
    if (!(field in data) || data[field] === undefined || data[field] === null) {
      errors.push(`Required field missing: ${field}`);
    }
  }

  // Check types of present fields
  for (const [field, spec] of Object.entries(schema.properties)) {
    if (!(field in data) || data[field] === null || data[field] === undefined) continue;
    const value = data[field];
    const expectedType = spec.type;
    if (!expectedType) continue;

    let actual;
    if (Array.isArray(value)) actual = 'array';
    else actual = typeof value;

    if (expectedType === 'array' && actual !== 'array') {
      errors.push(`${field}: expected array, got ${actual}`);
    } else if (expectedType !== 'array' && actual !== expectedType) {
      errors.push(`${field}: expected ${expectedType}, got ${actual}`);
    }
  }

  return errors;
}
```

Update the exports:

```js
if (require.main !== module) {
  module.exports = { parseArgs, resolveConnectors, classifyOutcome, validateResult, validateSchema };
}
```

- [ ] **Step 4: Wire schema validation into runConnector**

In the `runConnector` function's `needs-validation` branch, after the `const validation = validateResult(data, metadata);` line, add:

```js
        // Optional schema validation
        let schemaErrors = [];
        if (opts.validateSchemas) {
          const schemasDir = path.join(ROOT, 'schemas');
          for (const scope of validation.scopesFound) {
            const schemaPath = path.join(schemasDir, `${scope}.json`);
            if (!fs.existsSync(schemaPath)) continue;
            try {
              const schemaFile = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
              const scopeKey = scope in data ? scope : scope.split('.').slice(1).join('.');
              const errs = validateSchema(data[scopeKey], schemaFile.schema);
              schemaErrors.push(...errs.map(e => `${scope}: ${e}`));
            } catch {}
          }
        }
```

Add `schemaErrors` to the resolved result object:

```js
          schemaErrors: schemaErrors.length > 0 ? schemaErrors : undefined,
```

- [ ] **Step 5: Run tests to verify all pass**

Run: `node --test scripts/test-connectors.test.cjs`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/test-connectors.cjs scripts/test-connectors.test.cjs
git commit -m "feat(test-connectors): opt-in schema validation"
```

---

### Task 6: Final integration test and cleanup

**Files:**
- Modify: `scripts/test-connectors.cjs` (if any issues found)

- [ ] **Step 1: Run full harness with --connectors flag**

Pick one connector you have valid cookies for:

```bash
node scripts/test-connectors.cjs --connectors github-playwright
```

Verify:
- Terminal output shows a single-row result table
- `test-results/github-playwright.json` exists and contains valid connector output
- `test-results/connector-smoke-*.json` exists with the summary report
- Exit code is 0 for pass/warn, 1 for fail/auth/timeout

- [ ] **Step 2: Run harness with no args to verify default set**

```bash
node scripts/test-connectors.cjs
```

Verify it attempts all 6 stable connectors. (Some will AUTH if you don't have sessions — that's expected.)

- [ ] **Step 3: Run harness with --validate-schemas**

```bash
node scripts/test-connectors.cjs --connectors github-playwright --validate-schemas
```

Verify schema validation output appears in the report.

- [ ] **Step 4: Final commit**

```bash
git add scripts/test-connectors.cjs scripts/test-connectors.test.cjs
git commit -m "feat(test-connectors): batch connector smoke test harness"
```

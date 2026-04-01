const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  parseArgs,
  resolveConnectors,
  classifyOutcome,
  validateResult,
  validateSchema,
} = require('./test-connectors.cjs');

const ROOT = path.resolve(__dirname, '..');
const REGISTRY = JSON.parse(fs.readFileSync(path.join(ROOT, 'registry.json'), 'utf-8'));
const RESULTS_DIR = path.join(ROOT, 'test-results');

// Helper: load connector metadata by ID
function loadMetadata(connectorId) {
  const entry = REGISTRY.connectors.find(c => c.id === connectorId);
  if (!entry) throw new Error(`Connector not in registry: ${connectorId}`);
  const metadataPath = path.join(ROOT, entry.files.metadata);
  return JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
}

// Helper: load cached result by ID (may not exist)
function loadCachedResult(connectorId) {
  const resultPath = path.join(RESULTS_DIR, `${connectorId}.json`);
  if (!fs.existsSync(resultPath)) return null;
  return JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
}

// Helper: load schema file by scope
function loadSchema(scope) {
  const schemaPath = path.join(ROOT, 'schemas', `${scope}.json`);
  if (!fs.existsSync(schemaPath)) return null;
  return JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
}

// ─── parseArgs ──────────────────────────────────────────────

describe('parseArgs', () => {
  it('returns stable defaults with no args', () => {
    const result = parseArgs([]);
    assert.strictEqual(result.includeBeta, false);
    assert.strictEqual(result.validateSchemas, false);
    assert.strictEqual(result.useCached, false);
    assert.deepStrictEqual(result.connectors, null);
  });

  it('parses --connectors flag', () => {
    const result = parseArgs(['--connectors', 'instagram-playwright,spotify-playwright']);
    assert.deepStrictEqual(result.connectors, ['instagram-playwright', 'spotify-playwright']);
  });

  it('parses all flags together', () => {
    const result = parseArgs(['--include-beta', '--validate-schemas', '--use-cached']);
    assert.strictEqual(result.includeBeta, true);
    assert.strictEqual(result.validateSchemas, true);
    assert.strictEqual(result.useCached, true);
  });
});

// ─── resolveConnectors (real registry) ──────────────────────

describe('resolveConnectors', () => {
  it('resolves only stable connectors by default', () => {
    const result = resolveConnectors(REGISTRY, { connectors: null, includeBeta: false });
    assert.ok(result.length > 0, 'Should find at least one stable connector');
    for (const c of result) {
      assert.strictEqual(c.status, 'stable', `${c.id} should be stable`);
    }
  });

  it('includes beta connectors when flag set', () => {
    const result = resolveConnectors(REGISTRY, { connectors: null, includeBeta: true });
    const statuses = new Set(result.map(c => c.status));
    assert.ok(statuses.has('stable'), 'Should include stable');
    // beta may or may not exist, but no experimental
    assert.ok(!statuses.has('experimental'), 'Should not include experimental');
  });

  it('resolves specific connectors by ID', () => {
    const ids = ['github-playwright', 'spotify-playwright'];
    const result = resolveConnectors(REGISTRY, { connectors: ids, includeBeta: false });
    assert.deepStrictEqual(result.map(c => c.id), ids);
  });

  it('throws on unknown connector id', () => {
    assert.throws(
      () => resolveConnectors(REGISTRY, { connectors: ['nonexistent'], includeBeta: false }),
      /not found in registry/
    );
  });
});

// ─── classifyOutcome ────────────────────────────────────────

describe('classifyOutcome', () => {
  it('exit 0 → needs-validation', () => {
    assert.strictEqual(classifyOutcome(0, []).status, 'needs-validation');
  });
  it('exit 2 → auth (need-input)', () => {
    assert.strictEqual(classifyOutcome(2, []).status, 'auth');
  });
  it('exit 3 → auth (legacy-auth)', () => {
    assert.strictEqual(classifyOutcome(3, []).status, 'auth');
  });
  it('exit 1 + timeout message → timeout', () => {
    const stdout = [JSON.stringify({ type: 'error', message: 'Timeout after 5 minutes' })];
    assert.strictEqual(classifyOutcome(1, stdout).status, 'timeout');
  });
  it('exit 1 without timeout → fail', () => {
    assert.strictEqual(classifyOutcome(1, []).status, 'fail');
  });
});

// ─── Every connector metadata is valid ──────────────────────

describe('connector metadata', () => {
  for (const entry of REGISTRY.connectors) {
    it(`${entry.id}: metadata file exists and has scopes`, () => {
      const metadataPath = path.join(ROOT, entry.files.metadata);
      assert.ok(fs.existsSync(metadataPath), `Missing: ${metadataPath}`);
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
      assert.ok(metadata.scopes && metadata.scopes.length > 0, `${entry.id}: no scopes declared`);
      for (const s of metadata.scopes) {
        assert.ok(s.scope, `${entry.id}: scope entry missing .scope field`);
        assert.ok(s.scope.includes('.'), `${entry.id}: scope "${s.scope}" should be dotted (platform.name)`);
      }
    });

    it(`${entry.id}: script file exists`, () => {
      const scriptPath = path.join(ROOT, entry.files.script);
      assert.ok(fs.existsSync(scriptPath), `Missing: ${scriptPath}`);
    });
  }
});

// ─── Every schema file is valid JSON with correct structure ─

describe('schema files', () => {
  const schemaFiles = fs.readdirSync(path.join(ROOT, 'schemas')).filter(f => f.endsWith('.json'));

  for (const file of schemaFiles) {
    it(`${file}: valid JSON with scope and schema fields`, () => {
      const schemaDoc = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', file), 'utf-8'));
      assert.ok(schemaDoc.scope, `${file}: missing .scope`);
      assert.ok(schemaDoc.schema, `${file}: missing .schema`);
      assert.ok(schemaDoc.schema.type, `${file}: .schema missing .type`);
    });
  }
});

// ─── Cached results (opt-in: VALIDATE_CACHED=1) ────────────
// These suites require test-results/ from a prior connector run.
// Skipped by default so `node --test` works on a clean checkout.
// Run: VALIDATE_CACHED=1 node --test scripts/test-connectors.test.cjs

const RUN_CACHED = process.env.VALIDATE_CACHED === '1';

describe('validateResult against real cached data', { skip: !RUN_CACHED && 'set VALIDATE_CACHED=1 to enable' }, () => {
  const stableConnectors = REGISTRY.connectors.filter(c => c.status === 'stable');

  const missing = stableConnectors.filter(e => !loadCachedResult(e.id));
  if (missing.length > 0) {
    it('FAIL: missing cached results — run connectors first', () => {
      assert.fail(
        `Missing cached results for: ${missing.map(e => e.id).join(', ')}.\n` +
        `Run: node scripts/test-connectors.cjs`
      );
    });
  } else {
    for (const entry of stableConnectors) {
      it(`${entry.id}: all declared scopes present in cached result`, () => {
        const cached = loadCachedResult(entry.id);
        const metadata = loadMetadata(entry.id);
        const result = validateResult(cached, metadata);
        assert.ok(
          result.status === 'pass' || result.status === 'warn',
          `Expected pass/warn, got ${result.status}. Missing: ${result.scopesMissing.join(', ')}`
        );
      });
    }
  }
});

describe('validateSchema against real cached data', { skip: !RUN_CACHED && 'set VALIDATE_CACHED=1 to enable' }, () => {
  const stableConnectors = REGISTRY.connectors.filter(c => c.status === 'stable');

  const missing = stableConnectors.filter(e => !loadCachedResult(e.id));
  if (missing.length > 0) {
    it('FAIL: missing cached results — run connectors first', () => {
      assert.fail(
        `Missing cached results for: ${missing.map(e => e.id).join(', ')}.\n` +
        `Run: node scripts/test-connectors.cjs`
      );
    });
  } else {
    for (const entry of stableConnectors) {
      const cached = loadCachedResult(entry.id);
      const metadata = loadMetadata(entry.id);

      for (const scopeDef of metadata.scopes) {
        const schemaDoc = loadSchema(scopeDef.scope);
        if (!schemaDoc) continue;

        it(`${entry.id} → ${scopeDef.scope}: data matches schema`, () => {
          const scopeData = cached[scopeDef.scope];
          assert.ok(scopeData !== undefined && scopeData !== null, `Scope ${scopeDef.scope} missing from result`);
          const errors = validateSchema(scopeData, schemaDoc.schema);
          assert.deepStrictEqual(errors, [], `Schema errors:\n  ${errors.join('\n  ')}`);
        });
      }
    }
  }
});

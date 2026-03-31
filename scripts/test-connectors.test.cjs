const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  parseArgs,
  resolveConnectors,
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

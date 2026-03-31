const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  parseArgs,
  resolveConnectors,
  classifyOutcome,
  validateResult,
  validateSchema,
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

const assert = require('node:assert/strict');

const { classifyConnectorResult } = require('./result-classifier.cjs');

function makeResult(overrides = {}) {
  return {
    requestedScopes: ['chatgpt.conversations'],
    timestamp: '2026-04-14T12:00:00.000Z',
    version: '1.2.3',
    platform: 'chatgpt',
    exportSummary: {
      count: 1,
      label: '1 conversation',
    },
    errors: [],
    'chatgpt.conversations': [{ id: 'conv-1' }],
    ...overrides,
  };
}

function run() {
  const success = classifyConnectorResult(makeResult(), {
    expectedRequestedScopes: ['chatgpt.conversations'],
  });
  assert.equal(success.outcome, 'success');
  assert.deepEqual(success.scopeSummary, {
    requested: 1,
    produced: 1,
    degraded: 0,
    omitted: 0,
  });

  const partial = classifyConnectorResult(
    makeResult({
      requestedScopes: ['chatgpt.conversations', 'chatgpt.memories'],
      errors: [
        {
          errorClass: 'selector_error',
          reason: 'Memories selector drifted',
          disposition: 'omitted',
          scope: 'chatgpt.memories',
        },
      ],
    }),
    {
      expectedRequestedScopes: ['chatgpt.conversations', 'chatgpt.memories'],
    },
  );
  assert.equal(partial.outcome, 'partial');
  assert.equal(partial.errorClass, 'selector_error');
  assert.deepEqual(partial.scopeSummary, {
    requested: 2,
    produced: 1,
    degraded: 0,
    omitted: 1,
  });

  const fatalFailure = classifyConnectorResult(
    makeResult({
      errors: [
        {
          errorClass: 'auth_failed',
          reason: 'Auth expired',
          disposition: 'fatal',
        },
      ],
    }),
    {
      expectedRequestedScopes: ['chatgpt.conversations'],
    },
  );
  assert.equal(fatalFailure.outcome, 'failure');
  assert.equal(fatalFailure.errorClass, 'auth_failed');

  const legacyWrapper = classifyConnectorResult({
    success: true,
    data: makeResult(),
  });
  assert.equal(legacyWrapper.outcome, 'failure');
  assert.equal(legacyWrapper.errorClass, 'protocol_violation');
  assert.match(legacyWrapper.debug || '', /legacy \{ success, data \} wrapper/i);

  const overProduced = classifyConnectorResult(
    makeResult({
      'chatgpt.memories': [{ id: 'memory-1' }],
    }),
    {
      expectedRequestedScopes: ['chatgpt.conversations'],
    },
  );
  assert.equal(overProduced.outcome, 'failure');
  assert.equal(overProduced.errorClass, 'protocol_violation');
  assert.match(overProduced.debug || '', /outside requestedScopes/i);

  const malformedErrors = classifyConnectorResult(
    makeResult({
      errors: [{ errorClass: 'selector_error', reason: 'bad', disposition: 'omitted' }],
    }),
    {
      expectedRequestedScopes: ['chatgpt.conversations'],
    },
  );
  assert.equal(malformedErrors.outcome, 'failure');
  assert.equal(malformedErrors.errorClass, 'protocol_violation');
  assert.match(malformedErrors.debug || '', /must include a scope/i);

  const scopeMismatch = classifyConnectorResult(makeResult(), {
    expectedRequestedScopes: ['chatgpt.memories'],
  });
  assert.equal(scopeMismatch.outcome, 'failure');
  assert.equal(scopeMismatch.errorClass, 'protocol_violation');
  assert.match(scopeMismatch.debug || '', /resolved execution scope set/i);
}

run();
console.log('result-classifier tests passed');

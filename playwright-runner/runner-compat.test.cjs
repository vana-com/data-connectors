const assert = require('node:assert/strict');

const { classifyConnectorResult } = require('./result-classifier.cjs');
const {
  normalizeConnectorResult,
  resolveHeadlessResumeUrl,
} = require('./runner-compat.cjs');

function makeLegacyPayload(overrides = {}) {
  return {
    timestamp: '2026-04-21T18:00:00.000Z',
    version: '1.0.0-playwright',
    platform: 'linkedin',
    exportSummary: {
      count: 1,
      label: 'items',
    },
    'linkedin.profile': {
      headline: 'Builder',
    },
    ...overrides,
  };
}

function run() {
  assert.equal(
    resolveHeadlessResumeUrl({
      resumeUrl: 'https://github.com/settings/profile',
      currentUrl: 'https://github.com/',
    }),
    'https://github.com/settings/profile',
  );

  assert.equal(
    resolveHeadlessResumeUrl({
      resumeUrl: 'about:blank',
      currentUrl: 'https://www.instagram.com/example/',
    }),
    'https://www.instagram.com/example/',
  );

  assert.equal(
    resolveHeadlessResumeUrl({
      currentUrl: 'chrome://settings',
    }),
    'about:blank',
  );

  const normalizedWrappedSuccess = normalizeConnectorResult(
    {
      success: true,
      data: makeLegacyPayload(),
    },
    {
      requestedScopes: ['linkedin.profile'],
    },
  );
  assert.deepEqual(normalizedWrappedSuccess.requestedScopes, ['linkedin.profile']);
  assert.deepEqual(normalizedWrappedSuccess.errors, []);
  assert.equal(
    classifyConnectorResult(normalizedWrappedSuccess, {
      expectedRequestedScopes: ['linkedin.profile'],
    }).outcome,
    'success',
  );

  const normalizedStringDetails = normalizeConnectorResult(
    makeLegacyPayload({
      exportSummary: {
        count: 1,
        label: 'items',
        details: 'x',
      },
    }),
    {
      requestedScopes: ['linkedin.profile'],
    },
  );
  assert.deepEqual(normalizedStringDetails.requestedScopes, ['linkedin.profile']);
  assert.deepEqual(normalizedStringDetails.errors, []);
  assert.equal(
    classifyConnectorResult(normalizedStringDetails, {
      expectedRequestedScopes: ['linkedin.profile'],
    }).outcome,
    'success',
  );
  assert.deepEqual(normalizedStringDetails.exportSummary.details, { text: 'x' });

  const normalizedArrayDetails = normalizeConnectorResult(
    makeLegacyPayload({
      exportSummary: {
        count: 2,
        label: 'items',
        details: ['2 orders', '1 refund'],
      },
    }),
    {
      requestedScopes: ['linkedin.profile'],
    },
  );
  assert.deepEqual(normalizedArrayDetails.exportSummary.details, {
    items: ['2 orders', '1 refund'],
  });
  assert.equal(
    classifyConnectorResult(normalizedArrayDetails, {
      expectedRequestedScopes: ['linkedin.profile'],
    }).outcome,
    'success',
  );

  const normalizedFailure = normalizeConnectorResult(
    {
      success: false,
      error: 'Login requires a headed browser or requestInput support.',
    },
    {
      requestedScopes: ['instagram.profile'],
    },
  );
  const failureClassification = classifyConnectorResult(normalizedFailure, {
    expectedRequestedScopes: ['instagram.profile'],
  });
  assert.equal(failureClassification.outcome, 'failure');
  assert.equal(failureClassification.errorClass, 'auth_failed');

  const malformedLegacySuccess = normalizeConnectorResult(
    {
      success: true,
      data: null,
    },
    {
      requestedScopes: ['github.profile'],
    },
  );
  const malformedClassification = classifyConnectorResult(malformedLegacySuccess, {
    expectedRequestedScopes: ['github.profile'],
  });
  assert.equal(malformedClassification.outcome, 'failure');
  assert.equal(malformedClassification.errorClass, 'runtime_error');
}

run();
console.log('runner-compat tests passed');

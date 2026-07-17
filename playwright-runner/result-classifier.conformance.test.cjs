const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const { classifyConnectorResult } = require('./result-classifier.cjs');

const corpusDir = join(__dirname, 'conformance', 'honest-telemetry');
const corpus = JSON.parse(readFileSync(join(corpusDir, 'corpus.json'), 'utf8'));

for (const testCase of corpus.cases) {
  const fixture = JSON.parse(
    readFileSync(join(corpusDir, testCase.fixture), 'utf8'),
  );
  const classification = classifyConnectorResult(fixture, {
    expectedRequestedScopes: fixture.requestedScopes,
  });

  assert.equal(
    classification.outcome,
    testCase.expected.classification.outcome,
    `${testCase.id}: outcome mismatch`,
  );

  if (testCase.expected.classification.errorClass) {
    assert.equal(
      classification.errorClass,
      testCase.expected.classification.errorClass,
      `${testCase.id}: errorClass mismatch`,
    );
  }

  if (testCase.expected.classification.scopeSummary) {
    assert.deepEqual(
      classification.scopeSummary,
      testCase.expected.classification.scopeSummary,
      `${testCase.id}: scopeSummary mismatch`,
    );
  }

  if (testCase.expected.validity === 'protocol_violation') {
    assert.equal(
      classification.errorClass,
      'protocol_violation',
      `${testCase.id}: expected protocol violation`,
    );
  }
}

console.log(
  `honest telemetry conformance passed (${corpus.cases.length} cases)`,
);

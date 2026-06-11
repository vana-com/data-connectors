#!/usr/bin/env node
/**
 * Classifier regression test for the Claude connector result shape.
 *
 * Locks in the honest-telemetry contract the connector must satisfy:
 *   - telemetry lives inside `exportSummary.details` (a permitted object), and
 *   - an incomplete run reports the shortfall through `errors[]` (degraded),
 *     which classifies as `partial` so the collected data IS delivered, rather
 *     than emitting empty conversations as fake successes.
 *
 * Uses the in-repo classifier so the test is self-contained (no external runner
 * checkout required).
 */

const assert = require('assert');
const {
  classifyConnectorResult,
} = require('../../../scripts/validate-honest-telemetry-conformance.cjs');

const REQUESTED = ['claude.conversations', 'claude.projects'];

function baseResult(overrides = {}) {
  return Object.assign(
    {
      requestedScopes: REQUESTED,
      timestamp: new Date(0).toISOString(),
      version: '2.0.0-playwright',
      platform: 'claude',
      exportSummary: {
        count: 1,
        label: 'items',
        details: { conversations: 1, messages: 2, projects: 0, pending: 0 },
      },
      errors: [],
      'claude.conversations': {
        profile: { name: null, plan: null },
        organizationId: 'org',
        conversations: [{ id: 'a' }],
        total: 1,
        messageTotal: 2,
        source: 'api',
      },
      'claude.projects': {
        profile: { name: null, plan: null },
        organizationId: 'org',
        projects: [],
        total: 0,
        source: 'api',
      },
    },
    overrides,
  );
}

const cases = [];
function test(name, fn) {
  try {
    fn();
    cases.push({ name, ok: true });
  } catch (err) {
    cases.push({ name, ok: false, err: err.message });
  }
}

test('clean run classifies as success and delivers data', () => {
  const c = classifyConnectorResult(baseResult());
  assert.strictEqual(c.validity, 'valid');
  assert.strictEqual(c.classification.outcome, 'success');
});

test('rate-limited shortfall classifies as partial (data delivered)', () => {
  const c = classifyConnectorResult(
    baseResult({
      errors: [
        {
          errorClass: 'rate_limited',
          reason: '3 of 10 conversations were not retrieved (rate limited). Checkpointed.',
          disposition: 'degraded',
          scope: 'claude.conversations',
          phase: 'conversations',
        },
      ],
    }),
  );
  assert.strictEqual(c.validity, 'valid');
  assert.strictEqual(c.classification.outcome, 'partial');
  assert.strictEqual(c.classification.errorClass, 'rate_limited');
});

test('hard auth failure classifies as failure with no scope payloads', () => {
  const c = classifyConnectorResult({
    requestedScopes: REQUESTED,
    timestamp: new Date(0).toISOString(),
    version: '2.0.0-playwright',
    platform: 'claude',
    exportSummary: { count: 0, label: 'items', details: {} },
    errors: [
      {
        errorClass: 'auth_failed',
        reason: 'No active Claude organization could be resolved from the session.',
        disposition: 'fatal',
        phase: 'session',
      },
    ],
  });
  assert.strictEqual(c.validity, 'valid');
  assert.strictEqual(c.classification.outcome, 'failure');
  assert.strictEqual(c.classification.errorClass, 'auth_failed');
});

test('telemetry in a non-canonical top-level key is a protocol violation', () => {
  // Guards the production incident: stray top-level keys discard the whole run.
  const c = classifyConnectorResult(baseResult({ instrumentation: { pending: 3 } }));
  assert.strictEqual(c.validity, 'protocol_violation');
});

test('single requested scope produces only that scope', () => {
  const c = classifyConnectorResult({
    requestedScopes: ['claude.conversations'],
    timestamp: new Date(0).toISOString(),
    version: '2.0.0-playwright',
    platform: 'claude',
    exportSummary: { count: 1, label: 'items', details: { conversations: 1 } },
    errors: [],
    'claude.conversations': {
      profile: { name: null, plan: null },
      organizationId: 'org',
      conversations: [{ id: 'a' }],
      total: 1,
      messageTotal: 1,
      source: 'api',
    },
  });
  assert.strictEqual(c.validity, 'valid');
  assert.strictEqual(c.classification.outcome, 'success');
});

const failed = cases.filter((c) => !c.ok);
for (const c of cases) {
  console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok ? '' : ' — ' + c.err}`);
}
console.log(`\n${cases.length - failed.length}/${cases.length} passed.`);
process.exit(failed.length === 0 ? 0 : 1);

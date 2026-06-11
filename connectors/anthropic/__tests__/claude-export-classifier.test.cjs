#!/usr/bin/env node
/**
 * Classifier regression test for the Claude export connector's result envelopes.
 * Locks the resumable contract: a complete run is `success`, an export that is
 * still preparing is a `partial` (degraded, data delivered when the re-run
 * completes), and a missing-capability run is a `failure`.
 */

const assert = require('assert');
const {
  classifyConnectorResult,
} = require('../../../scripts/validate-honest-telemetry-conformance.cjs');

const REQUESTED = ['claude.conversations', 'claude.projects'];

function envelope(over = {}) {
  return Object.assign(
    {
      requestedScopes: REQUESTED,
      timestamp: new Date(0).toISOString(),
      version: '1.0.0-export',
      platform: 'claude',
      exportSummary: { count: 0, label: 'items', details: { source: 'official-export', pending: false } },
      errors: [],
    },
    over,
  );
}

const cases = [];
function test(name, fn) {
  try { fn(); cases.push({ name, ok: true }); }
  catch (err) { cases.push({ name, ok: false, err: err.message }); }
}

test('complete export classifies as success', () => {
  const r = envelope({
    exportSummary: { count: 2, label: 'items', details: { conversations: 1, projects: 1, pending: false, source: 'official-export' } },
    'claude.conversations': { profile: { name: 'V', plan: null }, organizationId: 'o', conversations: [{ id: 'c' }], total: 1, messageTotal: 3, source: 'official-export' },
    'claude.projects': { profile: { name: 'V', plan: null }, organizationId: 'o', projects: [{ id: 'p' }], total: 1, source: 'official-export' },
  });
  const c = classifyConnectorResult(r);
  assert.strictEqual(c.validity, 'valid');
  assert.strictEqual(c.classification.outcome, 'success');
});

test('export still preparing classifies as partial (resumable)', () => {
  const r = envelope({
    exportSummary: { count: 0, label: 'items', details: { conversations: 0, projects: 0, pending: true, source: 'official-export' } },
    errors: [
      { errorClass: 'upstream_error', reason: 'Claude is still preparing the export. Re-run in a few minutes.', disposition: 'degraded', scope: 'claude.conversations', phase: 'export' },
      { errorClass: 'upstream_error', reason: 'Claude is still preparing the export. Re-run in a few minutes.', disposition: 'degraded', scope: 'claude.projects', phase: 'export' },
    ],
    'claude.conversations': { profile: { name: null, plan: null }, organizationId: 'o', conversations: [], total: 0, messageTotal: 0, source: 'official-export' },
    'claude.projects': { profile: { name: null, plan: null }, organizationId: 'o', projects: [], total: 0, source: 'official-export' },
  });
  const c = classifyConnectorResult(r);
  assert.strictEqual(c.validity, 'valid');
  assert.strictEqual(c.classification.outcome, 'partial');
  assert.strictEqual(c.classification.errorClass, 'upstream_error');
});

test('missing runner capability classifies as failure', () => {
  const r = envelope({
    errors: [{ errorClass: 'runtime_error', reason: 'Runner lacks page.captureDownload / page.extractZipEntries.', disposition: 'fatal', phase: 'capability' }],
  });
  const c = classifyConnectorResult(r);
  assert.strictEqual(c.validity, 'valid');
  assert.strictEqual(c.classification.outcome, 'failure');
  assert.strictEqual(c.classification.errorClass, 'runtime_error');
});

const failed = cases.filter((c) => !c.ok);
for (const c of cases) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok ? '' : ' — ' + c.err}`);
console.log(`\n${cases.length - failed.length}/${cases.length} passed.`);
process.exit(failed.length === 0 ? 0 : 1);

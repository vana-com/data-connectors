#!/usr/bin/env node
/**
 * Classifier regression test for the ChatGPT connector result shape.
 *
 * Locks in the production incident root cause: a connector that put telemetry in
 * a NON-CANONICAL top-level key (`instrumentation`) was classified as a hard
 * `failure` (`protocol_violation`) and the runner therefore delivered NO data —
 * even though 73 conversations had been collected. The fix:
 *   - telemetry lives inside `exportSummary.details` (a permitted object), and
 *   - an incomplete run reports the shortfall through `errors[]` (degraded),
 *     which classifies as `partial` so the collected data IS delivered.
 *
 * This test asserts the real runner classifier agrees, and is skipped (with a
 * clear notice) if the runner isn't checked out alongside this repo.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

function loadClassifier() {
  const candidates = [
    process.env.PLAYWRIGHT_RUNNER_DIR,
    path.resolve(__dirname, '..', '..', '..', '..', 'data-connect', 'playwright-runner'),
    path.resolve(__dirname, '..', '..', '..', '..', 'data-dt-app', 'playwright-runner'),
  ].filter(Boolean);
  for (const dir of candidates) {
    const cls = path.join(dir, 'result-classifier.cjs');
    const compat = path.join(dir, 'runner-compat.cjs');
    if (fs.existsSync(cls) && fs.existsSync(compat)) {
      return { classify: require(cls).classifyConnectorResult, normalize: require(compat).normalizeConnectorResult, dir };
    }
  }
  return null;
}

const REQUESTED = ['chatgpt.conversations', 'chatgpt.memories'];

function classifyOutcome(C, result) {
  const normalized = C.normalize(result, { requestedScopes: REQUESTED });
  return C.classify(normalized, { expectedRequestedScopes: REQUESTED });
}

function baseResult() {
  return {
    requestedScopes: REQUESTED,
    timestamp: new Date(0).toISOString(),
    version: '3.0.0-playwright',
    platform: 'chatgpt',
    exportSummary: { count: 2, label: 'conversations', details: { messages: 4, pending: 0, statusCounts: { '200': 2 } } },
    errors: [],
    'chatgpt.conversations': { conversations: [{ id: 'c1', messages: [] }, { id: 'c2', messages: [] }], total: 2 },
    'chatgpt.memories': { memories: [{ id: 'm1', content: 'x' }], total: 1 },
  };
}

(async () => {
  const C = loadClassifier();
  if (!C) {
    console.warn('⚠  runner classifier not found (set PLAYWRIGHT_RUNNER_DIR) — skipping classifier regression test');
    return;
  }
  console.log('• using classifier from', C.dir);

  // 1. Clean, complete run → success.
  {
    const r = baseResult();
    const c = classifyOutcome(C, r);
    assert.strictEqual(c.outcome, 'success', `clean run should be success, got ${c.outcome} (${c.debug || ''})`);
    console.log('  ✓ complete run → success');
  }

  // 2. Rate-limited run: partial conversations + degraded error → partial (data delivered).
  {
    const r = baseResult();
    r.exportSummary.details.pending = 8;
    r.errors = [{ errorClass: 'rate_limited', reason: '8 of 10 conversations not retrieved (rate limited)', disposition: 'degraded', scope: 'chatgpt.conversations', phase: 'conversations' }];
    const c = classifyOutcome(C, r);
    assert.strictEqual(c.outcome, 'partial', `rate-limited run should be partial, got ${c.outcome} (${c.debug || ''})`);
    console.log('  ✓ rate-limited run (degraded) → partial → data delivered');
  }

  // 3. THE REGRESSION: a non-canonical top-level key → protocol_violation failure.
  //    This is exactly what discarded 73 collected conversations in production.
  {
    const bad = baseResult();
    bad.instrumentation = { statuses: { '429': 2410, '200': 73 }, failures: 2411 }; // the offending key
    const c = classifyOutcome(C, bad);
    assert.strictEqual(c.outcome, 'failure', 'a stray top-level key must be a failure (documents the incident)');
    assert.strictEqual(c.errorClass, 'protocol_violation', `should be protocol_violation, got ${c.errorClass}`);
    console.log('  ✓ stray top-level `instrumentation` key → failure/protocol_violation (the bug we fixed)');
  }

  // 4. The same telemetry, correctly placed under exportSummary.details, is fine.
  {
    const ok = baseResult();
    ok.exportSummary.details.statusCounts = { '429': 2410, '200': 73 };
    ok.exportSummary.details.pending = 0;
    const c = classifyOutcome(C, ok);
    assert.strictEqual(c.outcome, 'success', 'telemetry under exportSummary.details must not break classification');
    console.log('  ✓ same telemetry under exportSummary.details → still success');
  }

  console.log('\nALL CLASSIFIER REGRESSION TESTS PASSED');
})().catch((err) => {
  console.error('\nTEST FAILED:', err.stack || err.message);
  process.exit(1);
});

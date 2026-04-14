/**
 * Page API Conformance Fixture
 *
 * Probes every method in the canonical page API minimum surface
 * (types/connector.d.ts: PageAPI) and emits a conformance.result payload.
 *
 * This fixture is designed to run identically in:
 *   - DataConnect's playwright-runner (Node, sidecar process)
 *   - Context Gateway's client-side runtime (browser, via playwright-proxy)
 *
 * Use: drive it against a trivial test page (example.com works) and verify
 * that every `present: true` method also has `ok: true`.
 *
 * Acceptance targets:
 *   HC-PAGE-API-002 (typed minimum surface) — detects missing methods.
 *   SS-CONFORMANCE-FIXTURES-001 — cross-runtime conformance harness.
 */

(async () => {
  const methods = {};
  function record(name, present, tried, ok, error) {
    methods[name] = { present, tried, ok, error: error || null };
  }

  async function probe(name, fn) {
    const present = typeof page?.[name] === 'function';
    if (!present) {
      record(name, false, false, false, null);
      return;
    }
    try {
      await fn();
      record(name, true, true, true, null);
    } catch (err) {
      record(name, true, true, false, err?.message || String(err));
    }
  }

  // Probe every minimum-surface method with a minimal invocation that should
  // succeed against any sane runtime pointed at example.com.
  await probe('goto', () => page.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }));
  await probe('url', async () => {
    const u = await page.url();
    if (typeof u !== 'string') throw new Error(`url() returned non-string: ${typeof u}`);
  });
  await probe('evaluate', async () => {
    const title = await page.evaluate('document.title');
    if (typeof title !== 'string') throw new Error(`evaluate() returned non-string: ${typeof title}`);
  });
  await probe('waitForSelector', () => page.waitForSelector('body', { timeout: 5000 }));
  await probe('click', async () => {
    // body is always clickable; this is a no-op side effect.
    await page.click('body');
  });
  await probe('fill', async () => {
    // example.com has no input fields, so this is expected to fail — we
    // record that as a runtime limitation, not a contract violation. The
    // probe function treats a thrown error as ok=false but present=true.
    throw new Error('skipped: no form fields on example.com');
  });
  await probe('press', async () => {
    throw new Error('skipped: no form fields on example.com');
  });
  await probe('sleep', () => page.sleep(50));
  await probe('setData', () => page.setData('conformance_ping', 1));
  await probe('setProgress', () => page.setProgress({ message: 'probing', phase: { step: 1, total: 1, label: 'conformance' } }));
  await probe('captureNetwork', () => page.captureNetwork({ key: 'conformance_capture', urlPattern: 'example.com' }));
  await probe('getCapturedResponse', async () => {
    const r = await page.getCapturedResponse('conformance_capture');
    // null is acceptable (nothing captured yet).
    if (r !== null && typeof r !== 'object') throw new Error('getCapturedResponse returned unexpected type');
  });
  await probe('clearNetworkCaptures', () => page.clearNetworkCaptures());

  // requestInput / promptUser require a human in the loop — check only presence.
  record('requestInput', typeof page?.requestInput === 'function', false, typeof page?.requestInput === 'function', null);
  record('promptUser',   typeof page?.promptUser   === 'function', false, typeof page?.promptUser   === 'function', null);

  const result = {
    'conformance.result': {
      page_api_version: 1,
      checked_at: new Date().toISOString(),
      methods,
    },
    exportSummary: {
      count: Object.keys(methods).length,
      label: 'page API methods probed',
    },
    timestamp: new Date().toISOString(),
    version: '1.0.0-playwright',
    platform: 'conformance',
  };

  await page.setData('result', result);
})();

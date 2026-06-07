#!/usr/bin/env node
/**
 * End-to-end resume / rate-limit test for the ChatGPT connector.
 *
 * Runs the ACTUAL connector script (chatgpt-playwright.js) against a real
 * Chromium, with a mock `page` API and Playwright route mocks standing in for
 * chatgpt.com. No OpenAI traffic. This reproduces the production failure
 * (a 429 storm — 2410/2484 conversations rate limited) at small scale and
 * proves:
 *
 *   1. Rate-limited conversations are NOT emitted as empty successes.
 *   2. Whatever was fetched is checkpointed to IndexedDB and survives a full
 *      browser-context teardown (the cross-run scenario).
 *   3. A second run reopens the same profile, RESUMES, and only fetches the
 *      conversations that are still missing — no redundant re-downloads.
 *   4. Run 1 classifies as `partial` (data delivered); run 2 as `success`.
 *
 * Run from a checkout that has playwright installed, e.g.:
 *   NODE_PATH=/path/to/data-connectors/node_modules \
 *     node connectors/openai/__tests__/chatgpt-resume.browser.test.cjs
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');

const CONNECTOR = path.resolve(__dirname, '..', 'chatgpt-playwright.js');

// ── Locate the real runner classifier (optional; skipped if not present) ──
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
      return {
        classify: require(cls).classifyConnectorResult,
        normalize: require(compat).normalizeConnectorResult,
        dir,
      };
    }
  }
  return null;
}

// ── Load the connector main IIFE exactly like the runner does ──
function loadConnectorFn() {
  const code = fs.readFileSync(CONNECTOR, 'utf-8');
  const iifePattern = /(?:^|\n)\(async\s*\(\)\s*=>\s*\{/g;
  const matches = [...code.matchAll(iifePattern)];
  assert(matches.length > 0, 'connector must contain a main IIFE');
  const last = matches[matches.length - 1];
  const leadingNewline = last[0].startsWith('\n');
  const pos = last.index;
  const replacement = leadingNewline ? '\nreturn (async () => {' : 'return (async () => {';
  const modified = code.substring(0, pos) + replacement + code.substring(pos + last[0].length);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return new AsyncFunction('page', modified);
}

// ── Stub page served for every chatgpt.com navigation (a "logged in" shell) ──
const STUB_HTML = `<!doctype html><html><head><title>ChatGPT</title></head><body>
<nav aria-label="Chat history"><a href="/c/seed">seed chat</a></nav>
<script id="client-bootstrap" type="application/json">{"session":{"accessToken":"TESTTOKEN"}}</script>
<script>document.cookie = "oai-did=DEVICE123";</script>
<script>window.__profile = {"email":"anna@example.com","padding":"${'x'.repeat(160)}"};</script>
</body></html>`;

function convPayload(id) {
  return {
    title: 'Conversation ' + id,
    create_time: 1000,
    update_time: 2000,
    current_node: 'n2',
    mapping: {
      n0: { id: 'n0', parent: null, children: ['n1'], message: null },
      n1: {
        id: 'n1', parent: 'n0', children: ['n2'],
        message: { id: 'm1-' + id, author: { role: 'user' }, content: { content_type: 'text', parts: ['hello ' + id] }, create_time: 1, metadata: {} },
      },
      n2: {
        id: 'n2', parent: 'n1', children: [],
        message: { id: 'm2-' + id, author: { role: 'assistant' }, content: { content_type: 'text', parts: ['hi ' + id] }, create_time: 2, metadata: { model_slug: 'gpt-test' } },
      },
    },
  };
}

function makeList(n) {
  const list = [];
  for (let i = 1; i <= n; i++) list.push({ id: 'c' + i, title: 'C' + i, create_time: 100 + i, update_time: 200 + i });
  return list;
}

async function installRoutes(context, plan) {
  await context.route('https://chatgpt.com/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/backend-api/memories')) {
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ memories: [{ id: 'mem1', content: 'remember the demo', created_at: 't0', type: 'memory' }] }),
      });
    }
    if (url.includes('/backend-api/conversations')) {
      const u = new URL(url);
      const offset = Number(u.searchParams.get('offset')) || 0;
      const limit = Number(u.searchParams.get('limit')) || 100;
      const items = plan.list.slice(offset, offset + limit);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items, total: plan.list.length }) });
    }
    const m = url.match(/\/backend-api\/conversation\/([^/?]+)/);
    if (m) {
      const id = m[1];
      plan.hits[id] = (plan.hits[id] || 0) + 1;
      const verdict = plan.detail(id);
      if (verdict.status !== 200) {
        const headers = verdict.retryAfter != null ? { 'retry-after': String(verdict.retryAfter) } : {};
        return route.fulfill({ status: verdict.status, headers, contentType: 'application/json', body: JSON.stringify({ detail: 'too many requests' }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(convPayload(id)) });
    }
    return route.fulfill({ status: 200, contentType: 'text/html', body: STUB_HTML });
  });
}

// ── Mock `page` API bound to a real Chromium page ──
function makePageApi(realPage) {
  const captured = { results: [], data: {}, progress: [] };
  const api = {
    evaluate: (script) => realPage.evaluate(script),
    goto: async () => { await realPage.goto('https://chatgpt.com/', { waitUntil: 'load' }); },
    url: async () => realPage.url(),
    sleep: async () => {}, // tests don't wait on backoff timers
    goHeadless: async () => {},
    setData: async (key, value) => { captured.data[key] = value; if (key === 'result') captured.results.push(value); },
    setProgress: async (p) => { captured.progress.push(p); },
    requestedScopes: async () => ['chatgpt.conversations', 'chatgpt.memories'],
  };
  return { api, captured };
}

async function runConnectorOnce(userDataDir, plan) {
  const context = await chromium.launchPersistentContext(userDataDir, { headless: true });
  try {
    await installRoutes(context, plan);
    const realPage = context.pages()[0] || (await context.newPage());
    await realPage.goto('https://chatgpt.com/', { waitUntil: 'load' });
    const { api, captured } = makePageApi(realPage);
    const connectorFn = loadConnectorFn();
    const returned = await connectorFn.call(null, api);
    // Read the on-disk checkpoint back the same way the connector does.
    const ckpt = await realPage.evaluate(`(async () => {
      const db = await new Promise((res, rej) => { const r = indexedDB.open('vana_chatgpt_ckpt', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const ids = await new Promise((res) => { const out = []; const cur = db.transaction('conversations').objectStore('conversations').openCursor(); cur.onsuccess = (e) => { const c = e.target.result; if (!c) return res(out); out.push(c.value.id); c.continue(); }; });
      const meta = await new Promise((res) => { const g = db.transaction('meta').objectStore('meta').get('state'); g.onsuccess = () => res(g.result && g.result.v ? g.result.v : {}); });
      return { ids: ids.sort(), meta };
    })()`);
    return { returned, captured, ckpt };
  } finally {
    await context.close();
  }
}

function summarize(result) {
  const d = result.exportSummary.details;
  return {
    convs: (result['chatgpt.conversations'] || {}).total,
    memories: (result['chatgpt.memories'] || {}).total,
    pending: d.pending,
    newlyFetched: d.newlyFetched,
    resumed: d.resumedFromCheckpoint,
    stoppedReason: d.stoppedReason,
    errorClasses: result.errors.map((e) => e.errorClass + ':' + e.disposition),
  };
}

(async () => {
  const classifier = loadClassifier();
  if (!classifier) console.warn('⚠  runner classifier not found — classifier assertions skipped');
  else console.log('• using classifier from', classifier.dir);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-resume-'));
  const N = 12;
  const list = makeList(N);

  // ── RUN 1: rate-limit storm. c1–c4 succeed; c5–c12 always 429. ──
  const plan1 = {
    list,
    hits: {},
    detail: (id) => {
      const n = Number(id.slice(1));
      return n <= 4 ? { status: 200 } : { status: 429, retryAfter: 1 };
    },
  };
  const run1 = await runConnectorOnce(userDataDir, plan1);
  const r1 = run1.captured.results[run1.captured.results.length - 1];
  console.log('RUN1', JSON.stringify(summarize(r1)));

  assert(r1, 'run1 should emit a result');
  assert.strictEqual(r1['chatgpt.conversations'].total, 4, 'run1 should save exactly the 4 reachable conversations');
  assert.deepStrictEqual(r1['chatgpt.conversations'].conversations.map((c) => c.id).sort(), ['c1', 'c2', 'c3', 'c4']);
  assert.strictEqual(r1.exportSummary.details.pending, 8, 'run1 should report 8 pending');
  assert(['rate_limited_no_recovery', 'run_time_budget'].includes(r1.exportSummary.details.stoppedReason),
    `run1 should defer after patient waiting (got ${r1.exportSummary.details.stoppedReason})`);
  assert(r1.errors.some((e) => e.errorClass === 'rate_limited' && e.disposition === 'degraded' && e.scope === 'chatgpt.conversations'),
    'run1 must report the shortfall via errors[] (degraded), not silently');
  // No empty-success pollution: checkpoint holds only the 4 real ones.
  assert.deepStrictEqual(run1.ckpt.ids, ['c1', 'c2', 'c3', 'c4'], 'only fetched convs are checkpointed (no empty c5–c12)');
  // Patient mode must converge/defer, not hammer every conv unboundedly.
  const totalDetailHits1 = Object.values(plan1.hits).reduce((a, b) => a + b, 0);
  assert(totalDetailHits1 < N * 5, `should cap request volume when throttled (got ${totalDetailHits1} detail hits)`);
  console.log(`  ✓ run1 partial-saved 4/12, ${totalDetailHits1} detail requests (no storm), reported degraded`);

  if (classifier) {
    const c1 = classifier.classify(classifier.normalize(r1, { requestedScopes: r1.requestedScopes }), { expectedRequestedScopes: r1.requestedScopes });
    assert.strictEqual(c1.outcome, 'partial', `run1 must classify partial, got ${c1.outcome} (${c1.debug || ''})`);
    console.log('  ✓ run1 classifies as partial → data IS delivered');
  }

  // ── RUN 2: same profile, recovery. Everything returns 200 now. ──
  const plan2 = { list, hits: {}, detail: () => ({ status: 200 }) };
  const run2 = await runConnectorOnce(userDataDir, plan2);
  const r2 = run2.captured.results[run2.captured.results.length - 1];
  console.log('RUN2', JSON.stringify(summarize(r2)));

  assert.strictEqual(r2['chatgpt.conversations'].total, 12, 'run2 should end with all 12 conversations');
  assert.strictEqual(r2.exportSummary.details.resumedFromCheckpoint, 4, 'run2 should resume the 4 from run1');
  assert.strictEqual(r2.exportSummary.details.newlyFetched, 8, 'run2 should fetch only the 8 missing');
  assert.strictEqual(r2.exportSummary.details.pending, 0, 'run2 should have nothing pending');
  assert.strictEqual(r2.errors.length, 0, 'run2 should have no errors');
  // Proof of "no redundant work": the 4 already-saved convs are NOT re-requested.
  for (const id of ['c1', 'c2', 'c3', 'c4']) {
    assert(!plan2.hits[id], `run2 must NOT re-fetch already-saved ${id}`);
  }
  assert.strictEqual(run2.ckpt.ids.length, 12, 'checkpoint should now hold all 12');
  assert.strictEqual(run2.ckpt.meta.fullSyncDone, true, 'run2 should mark the sync complete');
  console.log('  ✓ run2 resumed 4, fetched only the missing 8, completed without re-downloading');

  if (classifier) {
    const c2 = classifier.classify(classifier.normalize(r2, { requestedScopes: r2.requestedScopes }), { expectedRequestedScopes: r2.requestedScopes });
    assert.strictEqual(c2.outcome, 'success', `run2 must classify success, got ${c2.outcome} (${c2.debug || ''})`);
    console.log('  ✓ run2 classifies as success');
  }

  fs.rmSync(userDataDir, { recursive: true, force: true });
  console.log('\nALL BROWSER RESUME TESTS PASSED');
})().catch((err) => {
  console.error('\nTEST FAILED:', err.stack || err.message);
  process.exit(1);
});

/**
 * Claude Connector — Official Export (Playwright)
 *
 * An alternative to the live-API `claude-playwright` connector that uses
 * Anthropic's first-party data export (Settings → Privacy → Export data):
 *   POST /api/organizations/:org/export_data  → { nonce }
 *   then a navigation download of /export/:org/download/:nonce → a ZIP.
 *
 * The ZIP is a strict superset of the live-API collection (all conversations
 * with full threads, projects, profile), retrieved in one shot with no
 * per-conversation rate limiting. It is produced by an async job, so this
 * connector is resumable: run 1 requests the export and checkpoints the nonce;
 * if the archive is not ready yet the run returns `partial` and a later run
 * captures it. Output is the same honest-telemetry scoped result the live-API
 * connector emits (claude.conversations / claude.projects), so the two are
 * interchangeable downstream.
 *
 * Requires runner page methods: page.captureDownload(url) and
 * page.extractZipEntries(path) (DataConnect playwright-runner). The page-API
 * runtime cannot otherwise retrieve the binary ZIP (in-browser fetch is
 * Sec-Fetch-gated to the SPA shell; httpFetch reads text and corrupts binary).
 */

const CLAUDE_HOME_URL = 'https://claude.ai/new';
const CLAUDE_LOGIN_URL = 'https://claude.ai/login';
const CKPT_DB = 'vana_claude_export_ckpt';
// The export is an async job; poll within the run so it completes in one click.
const POLL_ATTEMPT_TIMEOUT_MS = 25000;     // per attempt: navigate + wait for the download to fire
const POLL_INTERVAL_MS = 8000;             // pause between attempts while the job is still preparing
const MAX_WAIT_MS = 15 * 60 * 1000;        // overall cap before falling back to a resumable partial
const ALL_SCOPES = ['claude.conversations', 'claude.projects'];

// ─── Scope resolution ────────────────────────────────────────────────
const resolveRequestedScopes = async () => {
  try {
    if (typeof page.requestedScopes === 'function') {
      const s = await page.requestedScopes();
      if (Array.isArray(s) && s.length > 0) return s;
    }
  } catch (err) { /* older runner */ }
  return ALL_SCOPES.slice();
};

// ─── Minimal checkpoint: persist the pending export nonce across runs ─
const CKPT_INPAGE = `
const __ckpt = (function () {
  const DB = ${JSON.stringify(CKPT_DB)};
  function open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' }); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  async function get() {
    let db; try { db = await open(); } catch (e) { return {}; }
    return await new Promise((res) => { const g = db.transaction('meta').objectStore('meta').get('export'); g.onsuccess = () => res(g.result && g.result.v ? g.result.v : {}); g.onerror = () => res({}); });
  }
  async function set(v) {
    const db = await open(); const tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').put({ k: 'export', v });
    return await new Promise((res) => { tx.oncomplete = () => res(true); tx.onerror = () => res(false); });
  }
  async function clear() {
    const db = await open(); const tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').delete('export');
    return await new Promise((res) => { tx.oncomplete = () => res(true); tx.onerror = () => res(false); });
  }
  return { get, set, clear };
})();
`;
const ckptGet = async () => {
  try { return await page.evaluate(`(async () => { ${CKPT_INPAGE} try { return await __ckpt.get(); } catch (e) { return {}; } })()`); }
  catch (e) { return {}; }
};
const ckptSet = async (v) => {
  try { return await page.evaluate(`(async () => { ${CKPT_INPAGE} try { return await __ckpt.set(${JSON.stringify(v)}); } catch (e) { return false; } })()`); }
  catch (e) { return false; }
};
const ckptClear = async () => {
  try { return await page.evaluate(`(async () => { ${CKPT_INPAGE} try { return await __ckpt.clear(); } catch (e) { return false; } })()`); }
  catch (e) { return false; }
};

// ─── Login / session ─────────────────────────────────────────────────
const checkLoginStatus = async () => {
  try {
    return await page.evaluate(`
      (() => {
        const hasLogin = !!document.querySelector('button[type="submit"]') &&
          !!document.querySelector('input[type="email"], input[name="email"]');
        if (hasLogin) return false;
        return !!document.querySelector('button[data-testid="user-menu-button"]') ||
          !!document.querySelector('nav[aria-label="Sidebar"]') ||
          !!document.querySelector('a[href="/new"][aria-label="New chat"]');
      })()
    `);
  } catch (e) { return false; }
};

const readProfile = async () => {
  try {
    return await page.evaluate(`
      (() => {
        const t = (v) => (v || '').replace(/\\s+/g, ' ').trim();
        const b = document.querySelector('button[data-testid="user-menu-button"]');
        const name = t(b?.querySelector('span')?.textContent);
        const plan = t((b ? Array.from(b.querySelectorAll('span')) : []).map(n => n.textContent || '').find(x => x && x !== name) || '');
        return { name: name || null, plan: plan || null };
      })()
    `);
  } catch (e) { return { name: null, plan: null }; }
};

// Run an in-page JSON request (cookies + TLS fingerprint).
const apiGet = async (url) => {
  try {
    return await page.evaluate(`
      (async () => {
        try {
          const r = await fetch(${JSON.stringify(url)}, { credentials: 'include', headers: { accept: 'application/json' } });
          let json = null; try { json = await r.json(); } catch (_) {}
          return { ok: r.ok, status: r.status, json };
        } catch (e) { return { ok: false, status: 0, error: e.message }; }
      })()
    `);
  } catch (e) { return { ok: false, status: 0, error: e.message }; }
};

const resolveOrganizationId = async () => {
  const r = await apiGet('https://claude.ai/api/organizations');
  if (r.ok && Array.isArray(r.json) && r.json.length) {
    const org = r.json.find(o => Array.isArray(o.capabilities) && o.capabilities.includes('chat'))
      || r.json.find(o => Array.isArray(o.capabilities) && o.capabilities.includes('claude_pro'))
      || r.json[0];
    if (org && org.uuid) return org.uuid;
  }
  return null;
};

const requestExport = async (organizationId) => {
  try {
    return await page.evaluate(`
      (async () => {
        try {
          const r = await fetch('https://claude.ai/api/organizations/' + ${JSON.stringify(organizationId)} + '/export_data', {
            method: 'POST', credentials: 'include',
            headers: { 'content-type': 'application/json', accept: '*/*' }, body: '{}'
          });
          let json = null; try { json = await r.json(); } catch (_) {}
          return { ok: r.ok, status: r.status, nonce: json && json.nonce ? json.nonce : null };
        } catch (e) { return { ok: false, status: 0, error: e.message }; }
      })()
    `);
  } catch (e) { return { ok: false, status: 0, error: e.message }; }
};

// ─── Normalization (mirrors claude-export-ingest.cjs / the live connector) ──
const flattenMessageText = (m) => {
  if (typeof m?.text === 'string' && m.text.length > 0) return m.text;
  const c = m?.content;
  if (!c) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(p => !p ? '' : (typeof p === 'string' ? p : (typeof p.text === 'string' ? p.text : (typeof p.content === 'string' ? p.content : '')))).filter(Boolean).join('\n');
  if (typeof c.text === 'string') return c.text;
  return '';
};

const normalizeConversation = (conv) => {
  const id = conv?.uuid || conv?.id || null;
  const raw = Array.isArray(conv?.chat_messages) ? conv.chat_messages.slice() : [];
  raw.sort((a, b) => (Date.parse(a?.created_at || '') || 0) - (Date.parse(b?.created_at || '') || 0));
  const messages = raw.map(m => ({
    id: m?.uuid || null,
    sender: m?.sender || null,
    parentId: m?.parent_message_uuid || null,
    createdAt: m?.created_at || null,
    updatedAt: m?.updated_at || null,
    content: flattenMessageText(m),
    rawContent: m?.content ?? null,
    attachments: Array.isArray(m?.attachments) ? m.attachments : [],
  }));
  return {
    id,
    title: conv?.name || conv?.summary || 'Untitled',
    href: id ? `/chat/${id}` : null,
    createdAt: conv?.created_at || null,
    updatedAt: conv?.updated_at || null,
    starred: typeof conv?.is_starred === 'boolean' ? conv.is_starred : null,
    projectId: conv?.project_uuid || null,
    messageCount: messages.length,
    messages,
    fetchError: null,
  };
};

const normalizeProject = (p) => {
  const id = p?.uuid || p?.id || null;
  return {
    id,
    title: p?.name || 'Untitled project',
    href: id ? `/project/${id}` : null,
    label: p?.name ? `Project, ${p.name}` : null,
    createdAt: p?.created_at || null,
    updatedAt: p?.updated_at || null,
    archived: Boolean(p?.archived_at),
    detail: p || null,
  };
};

const buildResult = (requestedScopes, ctx) => {
  const wantsC = requestedScopes.includes('claude.conversations');
  const wantsP = requestedScopes.includes('claude.projects');
  const conversations = ctx.conversations || [];
  const projects = ctx.projects || [];
  const totalMessages = conversations.reduce((s, c) => s + (c.messageCount || 0), 0);
  const profile = ctx.profile || { name: null, plan: null };

  const errors = [];
  if (ctx.pending) {
    const reason = ctx.pendingReason ||
      'Claude is still preparing the export. The request is checkpointed — re-run in a few minutes to finish.';
    if (wantsC) errors.push({ errorClass: 'upstream_error', reason, disposition: 'degraded', scope: 'claude.conversations', phase: 'export' });
    if (wantsP) errors.push({ errorClass: 'upstream_error', reason, disposition: 'degraded', scope: 'claude.projects', phase: 'export' });
  }

  const result = {
    requestedScopes,
    timestamp: new Date().toISOString(),
    version: '1.0.0-export',
    platform: 'claude',
    exportSummary: {
      count: conversations.length + projects.length,
      label: 'items',
      details: {
        conversations: conversations.length,
        messages: totalMessages,
        projects: projects.length,
        designChats: ctx.designChats || 0,
        pending: Boolean(ctx.pending),
        source: 'official-export',
        organizationId: ctx.organizationId || null,
      },
    },
    errors,
  };
  const payloads = {
    'claude.conversations': { profile, organizationId: ctx.organizationId || null, conversations, total: conversations.length, messageTotal: totalMessages, source: 'official-export' },
    'claude.projects': { profile, organizationId: ctx.organizationId || null, projects, total: projects.length, source: 'official-export' },
  };
  for (const scope of Object.keys(payloads)) {
    if (requestedScopes.includes(scope)) result[scope] = payloads[scope];
  }
  return result;
};

// ─── Main ────────────────────────────────────────────────────────────
(async () => {
  const requestedScopes = await resolveRequestedScopes();

  // Capability check — this connector needs the runner download/zip methods.
  if (typeof page.captureDownload !== 'function' || typeof page.extractZipEntries !== 'function') {
    await page.setData('result', {
      requestedScopes,
      timestamp: new Date().toISOString(),
      version: '1.0.0-export',
      platform: 'claude',
      exportSummary: { count: 0, label: 'items', details: {} },
      errors: [{ errorClass: 'runtime_error', reason: 'This runner lacks page.captureDownload / page.extractZipEntries required for the Claude export flow. Update DataConnect.', disposition: 'fatal', phase: 'capability' }],
    });
    await page.setData('error', 'Runner missing export capabilities (captureDownload/extractZipEntries).');
    return;
  }

  // Phase 1: login.
  await page.setData('status', 'Checking Claude session...');
  await page.goto(CLAUDE_HOME_URL);
  await page.sleep(2000);
  let isLoggedIn = await checkLoginStatus();
  if (!isLoggedIn) {
    await page.setData('status', 'Claude needs a live login. Opening a browser so you can sign in.');
    const { headed } = await page.showBrowser(CLAUDE_LOGIN_URL);
    if (!headed) { await page.setData('error', 'Could not open a browser window for Claude login.'); return; }
    await page.promptUser('Log in to Claude, then click Done once you can see the sidebar or new chat screen.', async () => await checkLoginStatus(), 2000);
    await page.goto(CLAUDE_HOME_URL);
    await page.sleep(2000);
    isLoggedIn = await checkLoginStatus();
    if (!isLoggedIn) { await page.setData('error', 'Claude login was not detected after manual sign-in.'); return; }
  }

  await page.goHeadless();
  await page.goto(CLAUDE_HOME_URL);
  await page.sleep(1500);

  const profile = await readProfile();
  const organizationId = await resolveOrganizationId();
  if (!organizationId) {
    await page.setData('result', {
      requestedScopes, timestamp: new Date().toISOString(), version: '1.0.0-export', platform: 'claude',
      exportSummary: { count: 0, label: 'items', details: {} },
      errors: [{ errorClass: 'auth_failed', reason: 'No active Claude organization could be resolved from the session.', disposition: 'fatal', phase: 'session' }],
    });
    await page.setData('status', 'Could not resolve a Claude organization. Re-run after signing in.');
    return;
  }

  // Phase 2: ensure an export exists (resume a checkpointed nonce, else request).
  const ckpt = await ckptGet();
  let nonce = ckpt && ckpt.organizationId === organizationId ? ckpt.nonce : null;

  if (!nonce) {
    await page.setProgress({ phase: { step: 1, total: 3, label: 'Requesting export' }, message: 'Asking Claude to prepare your data export...' });
    const req = await requestExport(organizationId);
    if (!req.ok || !req.nonce) {
      const ctx = { organizationId, profile, conversations: [], projects: [], pending: true,
        pendingReason: `Could not start the export (HTTP ${req.status || 0}${req.error ? ': ' + req.error : ''}). Claude may rate-limit exports — try again later.` };
      await page.setData('result', buildResult(requestedScopes, ctx));
      await page.setData('status', 'Could not start the Claude export. Re-run later.');
      return;
    }
    nonce = req.nonce;
    await ckptSet({ organizationId, nonce, requestedAt: new Date().toISOString() });
  }

  // Phase 3: wait for the async export to finish, then capture it — all in one
  // run. Each attempt navigates to the download URL; when the job is ready the
  // page triggers the download and captureDownload returns it, otherwise it
  // times out and we poll again until the overall cap.
  const downloadUrl = `https://claude.ai/export/${organizationId}/download/${nonce}`;
  const waitStart = Date.now();
  let dl = null;
  while (true) {
    const elapsed = Math.round((Date.now() - waitStart) / 1000);
    await page.setProgress({
      phase: { step: 2, total: 3, label: 'Preparing export' },
      message: elapsed === 0
        ? 'Waiting for Claude to prepare your export...'
        : `Still preparing your export (${elapsed}s elapsed)...`,
    });
    dl = await page.captureDownload(downloadUrl, { timeout: POLL_ATTEMPT_TIMEOUT_MS });
    if (dl && dl.ok && dl.ready) break;
    if (Date.now() - waitStart > MAX_WAIT_MS) break;
    await page.sleep(POLL_INTERVAL_MS);
  }

  if (!dl || !dl.ok || !dl.ready) {
    // Exceeded the wait budget — keep the nonce checkpointed so a re-run resumes
    // (the job will be ready by then) rather than discarding progress.
    const waited = Math.round((Date.now() - waitStart) / 60000);
    const ctx = { organizationId, profile, conversations: [], projects: [], pending: true,
      pendingReason: `Claude's export was still not ready after ${waited} min. The request is checkpointed — re-run to finish.` };
    await page.setData('result', buildResult(requestedScopes, ctx));
    await page.setData('status', 'Export is taking longer than usual to prepare. Re-run shortly to finish.');
    return;
  }

  await page.setProgress({ phase: { step: 3, total: 3, label: 'Reading export' }, message: `Unpacking ${dl.name} (${Math.round((dl.size || 0) / 1048576)} MB)...` });
  const extracted = await page.extractZipEntries(dl.path, { include: ['conversations.json', 'projects/', 'users.json', 'design_chats/'] });
  if (!extracted || !extracted.ok) {
    const ctx = { organizationId, profile, conversations: [], projects: [], pending: true,
      pendingReason: `The export archive could not be read (${extracted && extracted.error ? extracted.error : 'unknown'}). Re-run to retry.` };
    await page.setData('result', buildResult(requestedScopes, ctx));
    await page.setData('status', 'Could not read the downloaded export. Re-run to retry.');
    return;
  }

  const json = extracted.json || {};
  const wantsC = requestedScopes.includes('claude.conversations');
  const wantsP = requestedScopes.includes('claude.projects');

  const conversations = wantsC && Array.isArray(json['conversations.json'])
    ? json['conversations.json'].map(normalizeConversation).filter(c => c.id) : [];
  const projects = wantsP
    ? Object.keys(json).filter(k => k.startsWith('projects/')).map(k => normalizeProject(json[k])).filter(p => p.id) : [];
  const designChats = Object.keys(json).filter(k => k.startsWith('design_chats/')).length;
  const exportProfile = Array.isArray(json['users.json']) && json['users.json'][0]
    ? { name: json['users.json'][0].full_name || profile.name || null, plan: profile.plan || null }
    : profile;

  const ctx = { organizationId, profile: exportProfile, conversations, projects, designChats, pending: false };
  const result = buildResult(requestedScopes, ctx);
  await page.setData('result', result);

  // Success — the export was consumed; drop the checkpointed nonce.
  await ckptClear();

  const d = result.exportSummary.details;
  await page.setData('status', `Complete! Imported ${d.conversations} conversations (${d.messages} messages) and ${d.projects} projects from the Claude export.`);
})();

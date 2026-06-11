/**
 * Claude Connector (Playwright) — Resumable, rate-limit-aware, honest
 *
 * Exports:
 *   - claude.conversations — conversation index + full message threads
 *   - claude.projects      — project index + project detail
 *
 * Login (Phase 1, visible only when needed):
 *   - Reuses the runner's persistent claude.ai session when present.
 *   - When a fresh login is required, opens a headed browser and waits for the
 *     user to finish (Google / email / SSO). There is deliberately NO scripted
 *     credential entry: Claude login involves third-party identity flows and
 *     anti-bot checks, so a manual hand-off is both more robust and avoids ever
 *     handling the user's password. Once logged in we switch to headless.
 *
 * Collection (Phase 2, headless):
 *   - All requests run inside page.evaluate(fetch) so they carry Chrome's real
 *     TLS fingerprint and first-party cookies past Cloudflare.
 *   - The active organization is chosen from /api/organizations by capability
 *     ('chat'), NOT from the lastActiveOrg cookie — an account can have several
 *     orgs (e.g. an API-only org) and the cookie can point at one with no chats.
 *
 * Durability + delta resume:
 *   - Each fetched conversation is checkpointed to IndexedDB on the claude.ai
 *     origin (kept across runs by the persistent profile). A crash / stop / rate
 *     limit mid-run loses nothing.
 *   - On resume we only re-fetch conversations that are new or whose
 *     current_leaf_message_uuid changed since the checkpoint; unchanged threads
 *     are served from the checkpoint, so a routine re-run costs ~one index walk,
 *     not a full re-download.
 *   - Partial results are flushed to the host incrementally as they arrive.
 *   - Trust boundary: the checkpoint holds plaintext conversation text in the
 *     local browser profile (the same data the logged-in session already
 *     exposes). It is CLEARED after a fully-complete run so plaintext does not
 *     linger; it persists only while a run is genuinely incomplete and needs it.
 *
 * Rate-limit politeness:
 *   - Modest concurrency that halves on any HTTP 429 and eases back up on clean
 *     batches. Honors Retry-After; otherwise exponential backoff with jitter.
 *   - If the limit goes fully dead (several consecutive zero-progress batches) or
 *     a generous wall-clock budget is hit, the run stops, checkpoints, and
 *     returns a partial result rather than hammering the API.
 *
 * Honest reporting (protocol contract):
 *   - Conversations that could not be fetched are NOT emitted as empty
 *     successes. The shortfall is reported through errors[] (degraded), which
 *     classifies the run as `partial` (data delivered) rather than `failure`
 *     (data discarded). Telemetry lives inside exportSummary.details — never as
 *     a non-canonical top-level key.
 */

// ─── Tunables ────────────────────────────────────────────────────────
const CKPT_DB = 'vana_claude_ckpt';
const CKPT_FORMAT = 1;

const INDEX_PAGE_SIZE = 30;          // claude.ai chat_conversations_v2 page size
const PROJECT_PAGE_SIZE = 30;

const MAX_CONCURRENCY = 4;           // ceiling when healthy
const MIN_CONCURRENCY = 1;
const BASE_BATCH_DELAY_MS = 250;     // polite pacing between healthy batches
const CONV_FETCH_TIMEOUT_MS = 30000;
const MAX_ATTEMPTS = 6;              // per-conversation budget for NON-throttle errors (5xx/network)

const RL_BACKOFF_START_MS = 2000;    // first wait when throttled with no Retry-After
const RL_BACKOFF_MAX_MS = 60000;
const STALL_BATCHES = 8;             // consecutive zero-progress throttled batches → defer to next run
const MAX_RUN_MS = 20 * 60 * 1000;   // generous overall safety cap before deferring

const FLUSH_EVERY_CONVS = 25;        // incremental host flush cadence (by new convs)
const FLUSH_INTERVAL_MS = 15000;     // …or by time

const CLAUDE_HOME_URL = 'https://claude.ai/new';
const CLAUDE_LOGIN_URL = 'https://claude.ai/login';

const ALL_SCOPES = ['claude.conversations', 'claude.projects'];

// ─── Small utilities ─────────────────────────────────────────────────
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

const resolveRequestedScopes = async () => {
  try {
    if (typeof page.requestedScopes === 'function') {
      const scopes = await page.requestedScopes();
      if (Array.isArray(scopes) && scopes.length > 0) return scopes;
    }
  } catch (err) {
    // older runner — fall through to the default
  }
  return ALL_SCOPES.slice();
};

// ─── In-page checkpoint (IndexedDB on the claude.ai origin) ──────────
const CHECKPOINT_INPAGE = `
const __ckpt = (function () {
  const DB_NAME = ${JSON.stringify(CKPT_DB)};
  const FORMAT = ${CKPT_FORMAT};
  function openDb() {
    return new Promise(function (resolve, reject) {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        const db = req.result;
        if (!db.objectStoreNames.contains('conversations')) {
          db.createObjectStore('conversations', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'k' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function txDone(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error); };
    });
  }
  async function loadAll() {
    let db;
    try { db = await openDb(); } catch (e) { return { ok: false, conversations: {}, meta: {} }; }
    const meta = await new Promise(function (resolve) {
      const g = db.transaction('meta').objectStore('meta').get('state');
      g.onsuccess = function () { resolve(g.result && g.result.v ? g.result.v : {}); };
      g.onerror = function () { resolve({}); };
    });
    if (meta && meta.format && meta.format !== FORMAT) {
      return { ok: true, conversations: {}, meta: {}, reset: true };
    }
    const conversations = await new Promise(function (resolve) {
      const out = {};
      const cur = db.transaction('conversations').objectStore('conversations').openCursor();
      cur.onsuccess = function (e) {
        const c = e.target.result;
        if (!c) { resolve(out); return; }
        out[c.value.id] = c.value;
        c.continue();
      };
      cur.onerror = function () { resolve(out); };
    });
    return { ok: true, conversations: conversations, meta: meta || {} };
  }
  async function putBatch(records, metaPatch) {
    const db = await openDb();
    const tx = db.transaction(['conversations', 'meta'], 'readwrite');
    const convStore = tx.objectStore('conversations');
    for (let i = 0; i < records.length; i++) convStore.put(records[i]);
    if (metaPatch) {
      const metaStore = tx.objectStore('meta');
      const existing = await new Promise(function (resolve) {
        const g = metaStore.get('state');
        g.onsuccess = function () { resolve(g.result && g.result.v ? g.result.v : {}); };
        g.onerror = function () { resolve({}); };
      });
      const merged = Object.assign({ format: FORMAT }, existing, metaPatch);
      metaStore.put({ k: 'state', v: merged });
    }
    await txDone(tx);
    return { ok: true, wrote: records.length };
  }
  async function clearAll() {
    const db = await openDb();
    const tx = db.transaction(['conversations', 'meta'], 'readwrite');
    tx.objectStore('conversations').clear();
    tx.objectStore('meta').clear();
    await txDone(tx);
    return { ok: true };
  }
  return { loadAll: loadAll, putBatch: putBatch, clearAll: clearAll };
})();
`;

const ckptLoad = async () => {
  try {
    return await page.evaluate(`(async () => { ${CHECKPOINT_INPAGE}
      try { return await __ckpt.loadAll(); } catch (e) { return { ok:false, conversations:{}, meta:{} }; }
    })()`);
  } catch (err) {
    return { ok: false, conversations: {}, meta: {} };
  }
};

const ckptPutBatch = async (records, metaPatch) => {
  try {
    return await page.evaluate(`(async () => { ${CHECKPOINT_INPAGE}
      try { return await __ckpt.putBatch(${JSON.stringify(records)}, ${JSON.stringify(metaPatch || null)}); }
      catch (e) { return { ok:false, error:String(e) }; }
    })()`);
  } catch (err) {
    return { ok: false, error: err.message };
  }
};

const ckptClear = async () => {
  try {
    return await page.evaluate(`(async () => { ${CHECKPOINT_INPAGE}
      try { return await __ckpt.clearAll(); } catch (e) { return { ok:false }; }
    })()`);
  } catch (err) {
    return { ok: false };
  }
};

// ─── Login / session helpers ─────────────────────────────────────────
const checkLoginStatus = async () => {
  try {
    return await page.evaluate(`
      (() => {
        const hasLoginControls =
          !!document.querySelector('button[type="submit"]') &&
          !!document.querySelector('input[type="email"], input[name="email"]');
        if (hasLoginControls) return false;
        return (
          !!document.querySelector('button[data-testid="user-menu-button"]') ||
          !!document.querySelector('nav[aria-label="Sidebar"]') ||
          !!document.querySelector('a[href="/new"][aria-label="New chat"]')
        );
      })()
    `);
  } catch (err) {
    return false;
  }
};

const readProfile = async () => {
  try {
    return await page.evaluate(`
      (() => {
        const readText = (v) => (v || '').replace(/\\s+/g, ' ').trim();
        const userButton = document.querySelector('button[data-testid="user-menu-button"]');
        const userName = readText(userButton?.querySelector('span')?.textContent);
        const planNodes = userButton ? Array.from(userButton.querySelectorAll('span')) : [];
        const plan = readText(
          planNodes.map((n) => n.textContent || '').find((t) => t && t !== userName) || ''
        );
        return { name: userName || null, plan: plan || null };
      })()
    `);
  } catch (err) {
    return { name: null, plan: null };
  }
};

// Generic authenticated GET, run in-page to preserve cookies + TLS fingerprint.
const apiGet = async (url) => {
  const urlStr = JSON.stringify(url);
  try {
    return await page.evaluate(`
      (async () => {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), ${CONV_FETCH_TIMEOUT_MS});
          const resp = await fetch(${urlStr}, {
            method: 'GET', credentials: 'include',
            headers: { accept: 'application/json' }, signal: controller.signal,
          });
          clearTimeout(timer);
          const retryAfter = resp.headers.get('retry-after');
          const text = await resp.text();
          let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) {}
          return { ok: resp.ok, status: resp.status, retryAfter, json, text: text ? text.slice(0, 300) : '' };
        } catch (err) {
          return { ok: false, status: 0, error: err.message };
        }
      })()
    `);
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
};

// Resolve the active org by capability. Conversations live in a 'chat'-capable
// org; an account may also have API-only orgs the cookie could point at.
const resolveOrganizationId = async () => {
  const resp = await apiGet('https://claude.ai/api/organizations');
  if (resp.ok && Array.isArray(resp.json) && resp.json.length > 0) {
    const orgs = resp.json;
    const chatOrg =
      orgs.find((o) => Array.isArray(o.capabilities) && o.capabilities.includes('chat')) ||
      orgs.find((o) => Array.isArray(o.capabilities) && o.capabilities.includes('claude_pro')) ||
      orgs[0];
    if (chatOrg && chatOrg.uuid) return { organizationId: chatOrg.uuid, source: 'organizations-api' };
  }
  // Fallback: lastActiveOrg cookie / storage (best-effort).
  try {
    const cookieOrg = await page.evaluate(`
      (() => {
        const map = {};
        for (const c of document.cookie.split(';')) {
          const [k, ...rest] = c.trim().split('=');
          if (k) map[k] = rest.join('=');
        }
        return map.lastActiveOrg ||
          window.localStorage.getItem('lastActiveOrg') ||
          window.sessionStorage.getItem('lastActiveOrg') || null;
      })()
    `);
    if (cookieOrg) return { organizationId: cookieOrg, source: 'cookie-fallback' };
  } catch (err) {
    // ignore
  }
  return { organizationId: null, source: 'unavailable' };
};

// ─── Conversation index + normalization ──────────────────────────────
const indexEntryFrom = (item) => ({
  id: item?.uuid || item?.id || null,
  title: item?.name || item?.summary || 'Untitled',
  href: (item?.uuid || item?.id) ? `/chat/${item.uuid || item.id}` : null,
  createdAt: item?.created_at || null,
  updatedAt: item?.updated_at || null,
  starred: Boolean(item?.is_starred),
  projectId: item?.project_uuid || null,
  // change-detection key: the conversation's current leaf moves when new
  // messages are added, so a stable leaf means the thread is unchanged.
  leaf: item?.current_leaf_message_uuid || item?.updated_at || null,
});

const fetchConversationIndex = async (organizationId) => {
  const byId = new Map();
  for (const starred of [false, true]) {
    let offset = 0;
    while (true) {
      const query = new URLSearchParams({
        limit: String(INDEX_PAGE_SIZE), offset: String(offset), starred: String(starred),
      }).toString();
      const resp = await apiGet(
        `https://claude.ai/api/organizations/${organizationId}/chat_conversations_v2?${query}`
      );
      if (resp.status === 401 || resp.status === 403) {
        return { ok: false, authFailed: true, entries: Array.from(byId.values()), error: `HTTP ${resp.status}` };
      }
      if (!resp.ok || !resp.json) {
        return { ok: false, entries: Array.from(byId.values()), error: resp.error || resp.text || `HTTP ${resp.status || 0}` };
      }
      const data = Array.isArray(resp.json) ? resp.json : (resp.json.data || []);
      for (const entry of data.map(indexEntryFrom)) {
        if (entry.id && !byId.has(entry.id)) byId.set(entry.id, entry);
      }
      const hasMore = typeof resp.json.has_more === 'boolean' ? resp.json.has_more : data.length === INDEX_PAGE_SIZE;
      if (!hasMore || data.length === 0) break;
      offset += INDEX_PAGE_SIZE;
      await page.sleep(200);
    }
  }
  return { ok: true, entries: Array.from(byId.values()) };
};

const flattenMessageText = (message) => {
  // Claude returns an already-flattened `text` plus structured `content` blocks.
  // Prefer `text`; fall back to joining text out of the content blocks.
  if (typeof message?.text === 'string' && message.text.length > 0) return message.text;
  const content = message?.content;
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part) return '';
        if (typeof part === 'string') return part;
        if (typeof part.text === 'string') return part.text;
        if (typeof part.content === 'string') return part.content;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content.text === 'string') return content.text;
  return '';
};

const normalizeConversation = (entry, treeData) => {
  const rawMessages = Array.isArray(treeData?.chat_messages) ? treeData.chat_messages.slice() : [];
  // Order by the server-provided index when present; it is the linear reading order.
  rawMessages.sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0));
  const messages = rawMessages.map((m) => ({
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
    id: entry.id,
    title: treeData?.name || entry.title || 'Untitled',
    href: entry.href || `/chat/${entry.id}`,
    createdAt: treeData?.created_at || entry.createdAt || null,
    updatedAt: treeData?.updated_at || entry.updatedAt || null,
    starred: entry.starred ?? null,
    projectId: entry.projectId || null,
    messageCount: messages.length,
    messages,
    fetchError: null,
    // internal bookkeeping (stripped before the conversation reaches the result)
    __leaf: entry.leaf || treeData?.current_leaf_message_uuid || null,
  };
};

// Fetch a batch of conversation details concurrently inside one page.evaluate.
const fetchDetailBatch = async (organizationId, ids) => {
  const idsStr = JSON.stringify(ids);
  const orgStr = JSON.stringify(organizationId);
  const result = await page.evaluate(`
    (async () => {
      const ids = ${idsStr};
      const org = ${orgStr};
      const q = 'tree=True&rendering_mode=messages&render_all_tools=true&return_dangling_human_message=true';
      const fetchOne = async (id) => {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), ${CONV_FETCH_TIMEOUT_MS});
          const resp = await fetch('https://claude.ai/api/organizations/' + org + '/chat_conversations/' + id + '?' + q, {
            method: 'GET', credentials: 'include',
            headers: { accept: 'application/json' }, signal: controller.signal,
          });
          clearTimeout(timer);
          const retryAfter = resp.headers.get('retry-after');
          if (!resp.ok) return { id, ok: false, status: resp.status, retryAfter };
          const json = await resp.json();
          return { id, ok: true, status: resp.status, json };
        } catch (err) {
          return { id, ok: false, status: 0, error: err.message };
        }
      };
      return await Promise.all(ids.map(fetchOne));
    })()
  `);
  return Array.isArray(result) ? result : [];
};

// ─── Projects ────────────────────────────────────────────────────────
const normalizeProject = (item) => ({
  id: item?.uuid || item?.id || null,
  title: item?.name || 'Untitled project',
  href: (item?.uuid || item?.id) ? `/project/${item.uuid || item.id}` : null,
  label: item?.name ? `Project, ${item.name}` : null,
  createdAt: item?.created_at || null,
  updatedAt: item?.updated_at || null,
  archived: Boolean(item?.archived_at),
  detail: item || null,
});

const fetchProjects = async (organizationId) => {
  const byId = new Map();
  let authFailed = false;
  for (const starred of [true, false]) {
    let offset = 0;
    while (true) {
      const query = new URLSearchParams({
        include_harmony_projects: 'true', limit: String(PROJECT_PAGE_SIZE),
        offset: String(offset), starred: String(starred),
      }).toString();
      const resp = await apiGet(
        `https://claude.ai/api/organizations/${organizationId}/projects?${query}`
      );
      if (resp.status === 401 || resp.status === 403) { authFailed = true; break; }
      if (!resp.ok || !resp.json) break;
      const list = Array.isArray(resp.json) ? resp.json : (resp.json.data || resp.json.projects || []);
      for (const project of list.map(normalizeProject)) {
        if (project.id) byId.set(project.id, project);
      }
      const hasMore = typeof resp.json.has_more === 'boolean' ? resp.json.has_more : list.length === PROJECT_PAGE_SIZE;
      if (!hasMore || list.length === 0) break;
      offset += PROJECT_PAGE_SIZE;
      await page.sleep(200);
    }
    if (authFailed) break;
  }
  return { projects: Array.from(byId.values()), authFailed, ok: byId.size > 0 || !authFailed };
};

// ─── Result builder (protocol-conformant) ───────────────────────────
const stripInternal = (conversation) => {
  const { __leaf, ...rest } = conversation;
  return rest;
};

const buildResult = (requestedScopes, ctx) => {
  const wantsConversations = requestedScopes.includes('claude.conversations');
  const wantsProjects = requestedScopes.includes('claude.projects');

  const conversations = Array.from(ctx.convMap.values()).map(stripInternal);
  const totalMessages = conversations.reduce((sum, c) => sum + (c.messageCount || 0), 0);
  const projects = ctx.projects || [];

  const errors = [];

  if (wantsConversations) {
    if (ctx.conversationsAuthFailed && conversations.length === 0) {
      errors.push({
        errorClass: 'auth_failed',
        reason: 'Claude session was not authenticated, so no conversations could be collected.',
        disposition: 'degraded',
        scope: 'claude.conversations',
        phase: 'conversations',
      });
    } else if (ctx.conversationsPending > 0) {
      errors.push({
        errorClass: ctx.conversationsAuthFailed ? 'auth_failed' : 'rate_limited',
        reason:
          `${ctx.conversationsPending} of ${ctx.conversationsTotal} conversations were not retrieved` +
          (ctx.conversationsAuthFailed ? ' (session expired mid-run)' : ' (rate limited)') +
          '. They are checkpointed and will be fetched on the next run.',
        disposition: 'degraded',
        scope: 'claude.conversations',
        phase: 'conversations',
      });
    } else if (ctx.conversationsIndexError && conversations.length === 0) {
      errors.push({
        errorClass: 'upstream_error',
        reason: `Conversation index could not be read: ${ctx.conversationsIndexError}`,
        disposition: 'degraded',
        scope: 'claude.conversations',
        phase: 'conversations',
      });
    }
  }

  if (wantsProjects && ctx.projectsAuthFailed && projects.length === 0) {
    errors.push({
      errorClass: 'auth_failed',
      reason: 'Claude session was not authenticated, so no projects could be collected.',
      disposition: 'degraded',
      scope: 'claude.projects',
      phase: 'projects',
    });
  }

  const result = {
    requestedScopes,
    timestamp: new Date().toISOString(),
    version: '2.0.0-playwright',
    platform: 'claude',
    exportSummary: {
      count: conversations.length + projects.length,
      label: 'items',
      details: {
        conversations: conversations.length,
        messages: totalMessages,
        projects: projects.length,
        newlyFetched: ctx.newlyFetched || 0,
        resumedFromCheckpoint: ctx.resumed || 0,
        unchanged: ctx.unchanged || 0,
        pending: ctx.conversationsPending || 0,
        skipped: ctx.skipped || 0,
        totalConversations: ctx.conversationsTotal || conversations.length,
        statusCounts: ctx.statusCounts || {},
        errorSamples: ctx.errorSamples || [],
        stoppedReason: ctx.stoppedReason || null,
        organizationSource: ctx.organizationSource || null,
      },
    },
    errors,
  };

  const profile = ctx.profile || { name: null, plan: null };
  const scopePayloads = {
    'claude.conversations': {
      profile,
      organizationId: ctx.organizationId || null,
      conversations,
      total: conversations.length,
      messageTotal: totalMessages,
      source: 'api',
    },
    'claude.projects': {
      profile,
      organizationId: ctx.organizationId || null,
      projects,
      total: projects.length,
      source: 'api',
    },
  };
  for (const scope of Object.keys(scopePayloads)) {
    if (requestedScopes.includes(scope)) result[scope] = scopePayloads[scope];
  }

  return result;
};

// ─── Main ────────────────────────────────────────────────────────────
(async () => {
  const requestedScopes = await resolveRequestedScopes();
  const wantsConversations = requestedScopes.includes('claude.conversations');
  const wantsProjects = requestedScopes.includes('claude.projects');

  // ── Phase 1: session / login ──
  await page.setData('status', 'Checking Claude session...');
  await page.goto(CLAUDE_HOME_URL);
  await page.sleep(2000);

  let isLoggedIn = await checkLoginStatus();
  if (!isLoggedIn) {
    await page.setData('status', 'Claude needs a live login. Opening a browser so you can sign in.');
    const { headed } = await page.showBrowser(CLAUDE_LOGIN_URL);
    if (!headed) {
      await page.setData('error', 'Could not open a browser window for Claude login.');
      return;
    }
    await page.promptUser(
      'Log in to Claude, then click Done once you can see the Claude sidebar or new chat screen.',
      async () => await checkLoginStatus(),
      2000
    );
    await page.goto(CLAUDE_HOME_URL);
    await page.sleep(2000);
    isLoggedIn = await checkLoginStatus();
    if (!isLoggedIn) {
      await page.setData('error', 'Claude login was not detected after the manual sign-in step.');
      return;
    }
  }

  await page.goHeadless();
  await page.goto(CLAUDE_HOME_URL);
  await page.sleep(1500);

  const profile = await readProfile();
  const { organizationId, source: organizationSource } = await resolveOrganizationId();

  // Hard auth/session failure: nothing collectable. Report as failure (fatal),
  // produce no scope payloads, leave any checkpoint intact for the next run.
  if (!organizationId) {
    await page.setData('result', {
      requestedScopes,
      timestamp: new Date().toISOString(),
      version: '2.0.0-playwright',
      platform: 'claude',
      exportSummary: { count: 0, label: 'items', details: { organizationSource } },
      errors: [{
        errorClass: 'auth_failed',
        reason: 'No active Claude organization could be resolved from the session.',
        disposition: 'fatal',
        phase: 'session',
      }],
    });
    await page.setData('status', 'Could not resolve a Claude organization. Please re-run after signing in.');
    return;
  }

  // ── Load checkpoint ──
  const checkpoint = await ckptLoad();
  const checkpointConvs = checkpoint.conversations || {};

  const ctx = {
    organizationId,
    organizationSource,
    profile,
    convMap: new Map(),
    projects: [],
    conversationsTotal: 0,
    conversationsPending: 0,
    conversationsAuthFailed: false,
    conversationsIndexError: null,
    projectsAuthFailed: false,
    newlyFetched: 0,
    resumed: 0,
    unchanged: 0,
    skipped: 0,
    statusCounts: {},
    errorSamples: [],
    stoppedReason: null,
  };

  const bumpStatus = (s) => {
    const key = String(s);
    ctx.statusCounts[key] = (ctx.statusCounts[key] || 0) + 1;
  };
  const noteError = (status, msg) => {
    const sample = `HTTP ${status}${msg ? ': ' + String(msg).slice(0, 120) : ''}`;
    if (ctx.errorSamples.length < 5 && !ctx.errorSamples.includes(sample)) ctx.errorSamples.push(sample);
  };

  // ── Conversations ──
  if (wantsConversations) {
    await page.setProgress({
      phase: { step: 1, total: 3, label: 'Reading conversation index' },
      message: 'Listing Claude conversations...',
    });

    const indexResult = await fetchConversationIndex(organizationId);
    if (indexResult.authFailed) ctx.conversationsAuthFailed = true;
    if (!indexResult.ok && !indexResult.authFailed) ctx.conversationsIndexError = indexResult.error || 'unknown';

    const entries = indexResult.entries || [];
    ctx.conversationsTotal = entries.length;

    // Seed unchanged conversations straight from the checkpoint (delta resume).
    const toFetch = [];
    for (const entry of entries) {
      const cached = checkpointConvs[entry.id];
      if (cached && cached.__leaf && entry.leaf && cached.__leaf === entry.leaf) {
        ctx.convMap.set(entry.id, cached);
        ctx.resumed += 1;
        ctx.unchanged += 1;
      } else if (cached && !entry.leaf) {
        // No change key available — keep the cached copy but refresh it.
        ctx.convMap.set(entry.id, cached);
        ctx.resumed += 1;
        toFetch.push(entry);
      } else {
        toFetch.push(entry);
      }
    }

    await page.setProgress({
      phase: { step: 2, total: 3, label: 'Downloading conversations' },
      message: `${ctx.unchanged} unchanged from checkpoint, ${toFetch.length} to fetch...`,
      count: ctx.convMap.size,
    });

    // Adaptive, resumable fetch loop.
    const queue = toFetch.map((entry) => ({ entry, attempts: 0 }));
    const entryById = new Map(toFetch.map((e) => [e.id, e]));
    let concurrency = MAX_CONCURRENCY;
    let backoff = RL_BACKOFF_START_MS;
    let stall = 0;
    const runStart = Date.now();
    let pendingFlush = [];
    let convsSinceFlush = 0;
    let lastFlushAt = Date.now();

    const flush = async (force) => {
      const due = convsSinceFlush >= FLUSH_EVERY_CONVS || (Date.now() - lastFlushAt) >= FLUSH_INTERVAL_MS;
      if (!force && !due) return;
      if (pendingFlush.length > 0) {
        await ckptPutBatch(pendingFlush, { listKnownAt: new Date().toISOString() });
        pendingFlush = [];
      }
      convsSinceFlush = 0;
      lastFlushAt = Date.now();
      // Snapshot to the host so partial data is delivered even if the run dies.
      ctx.conversationsPending = queue.length;
      if (wantsProjects) ctx.projects = ctx.projects; // projects fetched later; ok if empty mid-run
      await page.setData('result', buildResult(requestedScopes, ctx));
    };

    while (queue.length > 0) {
      if (Date.now() - runStart > MAX_RUN_MS) { ctx.stoppedReason = 'time_budget'; break; }

      const slice = queue.splice(0, concurrency);
      const results = await fetchDetailBatch(organizationId, slice.map((w) => w.entry.id));
      const resultById = new Map(results.map((r) => [r.id, r]));

      let progressed = 0;
      let throttled = 0;
      let retryAfterMs = 0;

      for (const work of slice) {
        const r = resultById.get(work.entry.id) || { ok: false, status: 0 };
        bumpStatus(r.status);

        if (r.ok && r.json) {
          const normalized = normalizeConversation(work.entry, r.json);
          ctx.convMap.set(work.entry.id, normalized);
          ctx.newlyFetched += 1;
          pendingFlush.push(normalized);
          convsSinceFlush += 1;
          progressed += 1;
        } else if (r.status === 429) {
          throttled += 1;
          if (r.retryAfter) {
            const secs = parseInt(r.retryAfter, 10);
            if (Number.isFinite(secs)) retryAfterMs = Math.max(retryAfterMs, secs * 1000);
          }
          queue.push(work); // requeue; throttling does not consume the retry budget
        } else if (r.status === 401 || r.status === 403) {
          ctx.conversationsAuthFailed = true;
          ctx.stoppedReason = 'auth_failed';
          noteError(r.status, r.error);
          queue.length = 0; // session is gone; stop and defer the rest
          break;
        } else {
          work.attempts += 1;
          noteError(r.status, r.error);
          if (work.attempts < MAX_ATTEMPTS) {
            queue.push(work);
          } else {
            // Persistent non-throttle failure: unfetchable, not "pending".
            ctx.skipped += 1;
          }
        }
      }

      await flush(false);

      if (throttled > 0 && progressed === 0) {
        stall += 1;
        if (stall >= STALL_BATCHES) { ctx.stoppedReason = 'rate_limited_stall'; break; }
        concurrency = clamp(Math.floor(concurrency / 2), MIN_CONCURRENCY, MAX_CONCURRENCY);
        const wait = retryAfterMs || backoff;
        backoff = clamp(Math.floor(backoff * 2), RL_BACKOFF_START_MS, RL_BACKOFF_MAX_MS);
        await page.setProgress({
          phase: { step: 2, total: 3, label: 'Downloading conversations' },
          message: `Rate limited — waiting ${Math.round(wait / 1000)}s (${ctx.convMap.size}/${ctx.conversationsTotal})...`,
          count: ctx.convMap.size,
        });
        await page.sleep(wait);
      } else {
        if (progressed > 0) { stall = 0; backoff = RL_BACKOFF_START_MS; }
        if (throttled === 0) concurrency = clamp(concurrency + 1, MIN_CONCURRENCY, MAX_CONCURRENCY);
        await page.setProgress({
          phase: { step: 2, total: 3, label: 'Downloading conversations' },
          message: `Downloaded ${ctx.convMap.size}/${ctx.conversationsTotal} conversations...`,
          count: ctx.convMap.size,
        });
        await page.sleep(BASE_BATCH_DELAY_MS);
      }
    }

    // Whatever remains unfetched (and not skipped) is genuinely pending.
    ctx.conversationsPending = queue.length;
    await flush(true);
  }

  // ── Projects ──
  if (wantsProjects) {
    await page.setProgress({
      phase: { step: 3, total: 3, label: 'Fetching projects' },
      message: 'Loading Claude projects...',
    });
    const projectResult = await fetchProjects(organizationId);
    ctx.projects = projectResult.projects;
    ctx.projectsAuthFailed = projectResult.authFailed;
  }

  // ── Finalize ──
  const result = buildResult(requestedScopes, ctx);
  await page.setData('result', result);

  // Clear the plaintext checkpoint once the run is genuinely complete, so it
  // does not linger in the browser profile. Keep it only when work remains.
  const incomplete = ctx.conversationsPending > 0 || ctx.conversationsAuthFailed || ctx.stoppedReason;
  if (!incomplete) {
    await ckptClear();
  }

  const summary = result.exportSummary.details;
  const tail = ctx.conversationsPending > 0 ? ` (${ctx.conversationsPending} pending — re-run to finish)` : '';
  await page.setData(
    'status',
    `Complete! ${summary.conversations} conversations (${summary.messages} messages), ${summary.projects} projects${tail}.`
  );
})();

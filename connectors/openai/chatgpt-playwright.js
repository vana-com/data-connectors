/**
 * ChatGPT Connector (Playwright) — Resumable, rate-limit-aware
 *
 * Phase 1 (Browser, visible if login needed):
 *   - Detects login via persistent browser session (headless)
 *   - If not logged in, shows browser for user to log in
 *   - Extracts auth credentials (token + deviceId + email)
 *
 * Phase 2 (Browser, headless — invisible to user):
 *   - Switches to headless mode so browser window disappears
 *   - Fetches memories, conversation list, and conversation details
 *   - Uses page.evaluate() with fetch() to preserve Cloudflare TLS fingerprint
 *
 * Durability + resume (NEW):
 *   - Every fetched conversation is written to an IndexedDB checkpoint store on
 *     the chatgpt.com origin. The runner's persistent browser profile keeps that
 *     store across runs, so a crash/stop/rate-limit mid-run loses nothing: the
 *     next run reloads the checkpoint and only fetches what's missing or changed.
 *   - The accumulated result is flushed to the host incrementally
 *     (page.setData('result', ...)) so partial data is persisted/delivered as it
 *     arrives, not only at the very end.
 *
 * Rate-limit politeness (NEW):
 *   - Adaptive concurrency (AIMD): starts low, eases up on clean batches, halves
 *     on any HTTP 429.
 *   - Honors the Retry-After header; exponential backoff with jitter.
 *   - Circuit breaker: after several consecutive fully-rate-limited batches it
 *     stops, checkpoints, and returns a `partial` result instead of hammering the
 *     API thousands of times (the failure mode seen in production: 2410/2484
 *     conversations returned 429).
 *
 * Honest reporting (NEW):
 *   - Conversations that couldn't be fetched are NOT emitted as empty successes.
 *     They are left out of the result and reported via the protocol `errors[]`
 *     array with disposition `degraded`, which classifies the run as `partial`
 *     (data delivered) rather than `failure` (data discarded). Telemetry lives
 *     inside exportSummary.details — never as a non-canonical top-level key.
 */

// ─── Tunables ────────────────────────────────────────────────────────
const CKPT_DB = 'vana_chatgpt_ckpt';
const CKPT_FORMAT = 1;

const START_CONCURRENCY = 2;       // conservative cold start
const MAX_CONCURRENCY = 4;         // ceiling even when healthy
const MIN_CONCURRENCY = 1;
const BASE_BATCH_DELAY_MS = 700;   // polite pacing between batches
const MAX_BATCH_DELAY_MS = 8000;
const BACKOFF_BASE_MS = 2000;      // 429 backoff floor
const BACKOFF_MAX_MS = 60000;
const MAX_ATTEMPTS = 5;            // per-conversation retry budget within a run
const BREAKER_RL_BATCHES = 4;      // consecutive all-429 batches → stop & resume later
const FLUSH_EVERY_CONVS = 25;      // incremental host flush cadence (by new convs)
const FLUSH_INTERVAL_MS = 15000;   // …or by time
const LIST_PAGE_DELAY_MS = 400;
const CONV_FETCH_TIMEOUT_MS = 30000;

// State management
const state = {
  email: null,
  accessToken: null,
  deviceId: null,
  isComplete: false
};

// ─── Browser-Phase Helpers ───────────────────────────────────────────

// Dismiss interrupting popups
const dismissInterruptingDialogs = async () => {
  try {
    await page.evaluate(`
      (() => {
        const buttonElements = document.querySelectorAll('button, a');
        const maybeLaterButton = Array.from(buttonElements).find(el =>
          el.textContent?.toLowerCase().includes('maybe later')
        );
        const rejectNonEssentialButton = Array.from(buttonElements).find(el =>
          el.textContent?.toLowerCase().includes('reject non-essential')
        );

        if (maybeLaterButton && typeof maybeLaterButton.click === 'function') {
          maybeLaterButton.click();
          return 'clicked maybe later';
        }
        if (rejectNonEssentialButton && typeof rejectNonEssentialButton.click === 'function') {
          rejectNonEssentialButton.click();
          return 'clicked reject non-essential';
        }
        return 'no dialogs found';
      })()
    `);
  } catch (err) {
    // Ignore errors
  }
};

// Extract email from page
const extractEmail = async () => {
  try {
    const result = await page.evaluate(`
      (() => {
        const scripts = document.querySelectorAll('script');
        for (let script of scripts) {
          const content = script.textContent || script.innerText || '';
          if (content.length > 100) {
            const emailMatch = content.match(/"email":"([^"]+)"/);
            if (emailMatch) {
              return { success: true, email: emailMatch[1] };
            }
          }
        }
        return { success: false };
      })()
    `);

    if (result?.success) return result.email;
    return null;
  } catch (err) {
    return null;
  }
};

// Get authentication credentials from page
const getAuthCredentials = async () => {
  try {
    const result = await page.evaluate(`
      (() => {
        let userToken = null;
        let deviceId = null;

        const bootstrapScript = document.getElementById('client-bootstrap');
        if (bootstrapScript) {
          try {
            const bootstrapData = JSON.parse(bootstrapScript.textContent);
            userToken = bootstrapData?.session?.accessToken;
          } catch (e) {}
        }

        if (!userToken && window.CLIENT_BOOTSTRAP) {
          userToken = window.CLIENT_BOOTSTRAP?.session?.accessToken;
        }

        const cookies = document.cookie.split(';');
        for (const cookie of cookies) {
          const [name, value] = cookie.trim().split('=');
          if (name === 'oai-did') {
            deviceId = value;
            break;
          }
        }

        return { userToken, deviceId };
      })()
    `);

    return result || { userToken: null, deviceId: null };
  } catch (err) {
    return { userToken: null, deviceId: null };
  }
};

// Check if logged in
const checkLoginStatus = async () => {
  try {
    const result = await page.evaluate(`
      (() => {
        const allButtons = document.querySelectorAll('button, a');
        const hasLoginButton = Array.from(allButtons).some(el => {
          const text = el.textContent?.toLowerCase() || '';
          return text.includes('log in') || text.includes('sign up');
        });
        if (hasLoginButton) return false;

        const hasSidebar = !!document.querySelector('nav[aria-label="Chat history"]') ||
                          !!document.querySelector('nav a[href^="/c/"]') ||
                          document.querySelectorAll('nav').length > 0;
        const hasUserMenu = !!document.querySelector('[data-testid="profile-button"]') ||
                           !!document.querySelector('button[aria-label*="User menu"]');

        return hasSidebar || hasUserMenu;
      })()
    `);
    return result;
  } catch (err) {
    return false;
  }
};

// ─── Checkpoint store (IndexedDB on the chatgpt.com origin) ──────────
// Persists across runs via the runner's persistent browser profile. The block
// between the sentinels below is extracted verbatim by the connector tests, so
// keep it self-contained (no closures over outer scope, no arrow IIFEs at the
// start of a line — the runner detects the main IIFE by a line-leading
// `(async () => {`).
//
// <inpage-checkpoint>
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
    try { db = await openDb(); } catch (e) { return { ok: false, conversations: {}, memories: [], meta: {} }; }
    const meta = await new Promise(function (resolve) {
      const g = db.transaction('meta').objectStore('meta').get('state');
      g.onsuccess = function () { resolve(g.result && g.result.v ? g.result.v : {}); };
      g.onerror = function () { resolve({}); };
    });
    // A format bump invalidates the old store.
    if (meta && meta.format && meta.format !== FORMAT) {
      return { ok: true, conversations: {}, memories: [], meta: {}, reset: true };
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
    return { ok: true, conversations: conversations, memories: (meta && meta.memories) || [], meta: meta || {} };
  }
  async function putBatch(records, memories, metaPatch) {
    const db = await openDb();
    const stores = ['conversations', 'meta'];
    const tx = db.transaction(stores, 'readwrite');
    const convStore = tx.objectStore('conversations');
    for (let i = 0; i < records.length; i++) convStore.put(records[i]);
    if (memories || metaPatch) {
      const metaStore = tx.objectStore('meta');
      const existing = await new Promise(function (resolve) {
        const g = metaStore.get('state');
        g.onsuccess = function () { resolve(g.result && g.result.v ? g.result.v : {}); };
        g.onerror = function () { resolve({}); };
      });
      const merged = Object.assign({ format: FORMAT }, existing, metaPatch || {});
      if (memories) merged.memories = memories;
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
// </inpage-checkpoint>

const ckptLoad = async () =>
  page.evaluate(`(async () => { ${CHECKPOINT_INPAGE}; return await __ckpt.loadAll(); })()`);

const ckptPutBatch = async (records, memories, metaPatch) =>
  page.evaluate(
    `(async () => { ${CHECKPOINT_INPAGE}; return await __ckpt.putBatch(` +
      `${JSON.stringify(records || [])}, ${JSON.stringify(memories || null)}, ${JSON.stringify(metaPatch || null)}); })()`
  );

const ckptClear = async () =>
  page.evaluate(`(async () => { ${CHECKPOINT_INPAGE}; return await __ckpt.clearAll(); })()`);

// ─── Data Fetch Helpers (use page.evaluate for Cloudflare compat) ────

// Fetch memories. Returns { ok, status, memories }.
const fetchMemories = async (accessToken, deviceId) => {
  try {
    const result = await page.evaluate(`
      (async () => {
        const token = ${JSON.stringify(accessToken)};
        const device = ${JSON.stringify(deviceId)};
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 15000);
          const response = await fetch("https://chatgpt.com/backend-api/memories?include_memory_entries=true", {
            headers: { accept: "*/*", authorization: "Bearer " + token, "oai-device-id": device, "oai-language": "en-US" },
            method: "GET", credentials: "include", signal: controller.signal,
          });
          clearTimeout(timeout);
          if (!response.ok) return { ok: false, status: response.status };
          const data = await response.json();
          return { ok: true, status: 200, memories: data.memories || [] };
        } catch (err) {
          return { ok: false, status: 0, error: err.message };
        }
      })()
    `);
    return result || { ok: false, status: 0 };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
};

// Fetch one page of the conversation list. Returns { ok, status, items, total }.
const fetchConversationsPage = async (accessToken, deviceId, offset, limit) => {
  const result = await page.evaluate(`
    (async () => {
      const token = ${JSON.stringify(accessToken)};
      const device = ${JSON.stringify(deviceId)};
      const offset = ${offset};
      const limit = ${limit};
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const response = await fetch(
          "https://chatgpt.com/backend-api/conversations?offset=" + offset + "&limit=" + limit + "&order=updated",
          { headers: { accept: "*/*", authorization: "Bearer " + token, "oai-device-id": device, "oai-language": "en-US" },
            method: "GET", credentials: "include", signal: controller.signal }
        );
        clearTimeout(timeout);
        if (!response.ok) return { ok: false, status: response.status };
        const data = await response.json();
        return {
          ok: true, status: 200,
          items: (data.items || []).map(item => ({ id: item.id, title: item.title, create_time: item.create_time, update_time: item.update_time })),
          total: data.total,
        };
      } catch (err) {
        return { ok: false, status: 0, error: err.message };
      }
    })()
  `);
  return result || { ok: false, status: 0 };
};

// Fetch a batch of conversation details in parallel (inside browser via Promise.all).
// Each entry: { id, ok, status, retryAfter, title?, create_time?, update_time?, messages? }.
const fetchConversationBatch = async (accessToken, deviceId, convIds) => {
  const result = await page.evaluate(`
    (async () => {
      const token = ${JSON.stringify(accessToken)};
      const device = ${JSON.stringify(deviceId)};
      const ids = ${JSON.stringify(convIds)};

      const parseRetryAfter = (resp) => {
        const h = resp.headers && resp.headers.get ? resp.headers.get('retry-after') : null;
        if (!h) return null;
        const secs = Number(h);
        if (!isNaN(secs)) return Math.max(0, secs);
        const when = Date.parse(h);
        if (!isNaN(when)) return Math.max(0, Math.round((when - Date.now()) / 1000));
        return null;
      };

      const fetchOne = async (convId) => {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), ${CONV_FETCH_TIMEOUT_MS});
          const response = await fetch(
            "https://chatgpt.com/backend-api/conversation/" + convId,
            { headers: { accept: "*/*", authorization: "Bearer " + token, "oai-device-id": device, "oai-language": "en-US" },
              method: "GET", credentials: "include", signal: controller.signal }
          );
          clearTimeout(timeout);
          if (!response.ok) {
            return { id: convId, ok: false, status: response.status, retryAfter: parseRetryAfter(response) };
          }
          const data = await response.json();

          // Walk the message tree along the path to current_node.
          const mapping = data.mapping || {};
          const currentNode = data.current_node;

          let rootId = null;
          for (const [nodeId, node] of Object.entries(mapping)) {
            if (!node.parent || !mapping[node.parent]) { rootId = nodeId; break; }
          }

          const ancestorsOfCurrent = new Set();
          let walkUp = currentNode;
          while (walkUp && mapping[walkUp]) {
            ancestorsOfCurrent.add(walkUp);
            walkUp = mapping[walkUp].parent;
          }

          const messages = [];
          let cursor = rootId;
          while (cursor && mapping[cursor]) {
            const node = mapping[cursor];
            if (node.message) {
              const msg = node.message;
              const role = msg.author?.role;
              const contentType = msg.content?.content_type;
              if ((role === 'user' || role === 'assistant') &&
                  (contentType === 'text' || contentType === 'multimodal_text')) {
                const textParts = (msg.content?.parts || []).filter(p => typeof p === 'string').join('\\n');
                if (textParts.length > 0) {
                  messages.push({
                    id: msg.id, role, content: textParts, content_type: contentType,
                    create_time: msg.create_time ? new Date(msg.create_time * 1000).toISOString() : null,
                    model: msg.metadata?.model_slug || null,
                  });
                }
              }
            }
            const children = node.children || [];
            let nextCursor = null;
            for (const childId of children) {
              if (ancestorsOfCurrent.has(childId)) { nextCursor = childId; break; }
            }
            if (!nextCursor && children.length > 0) nextCursor = children[children.length - 1];
            cursor = nextCursor;
          }

          return { id: convId, ok: true, status: 200, title: data.title, create_time: data.create_time, update_time: data.update_time, messages };
        } catch (err) {
          return { id: convId, ok: false, status: 0, error: err.message };
        }
      };

      return await Promise.all(ids.map(id => fetchOne(id)));
    })()
  `);

  return result || [];
};

// ─── Pure helpers (Node side) ────────────────────────────────────────

const sleep = (ms) => page.sleep(ms);
const jitter = (ms) => Math.floor(Math.random() * ms);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const isRateLimited = (status) => status === 429;
const isAuthError = (status) => status === 401 || status === 403;

const toConversationRecord = (listed, fetched) => ({
  id: fetched.id,
  title: fetched.title || listed?.title || 'Untitled',
  create_time: listed?.create_time ?? fetched.create_time ?? null,
  update_time: listed?.update_time ?? fetched.update_time ?? null,
  message_count: fetched.messages.length,
  messages: fetched.messages,
  fetched_at: new Date().toISOString(),
});

const resolveRequestedScopes = async () => {
  const fallback = ['chatgpt.conversations', 'chatgpt.memories'];
  try {
    if (typeof page.requestedScopes === 'function') {
      const scopes = await page.requestedScopes();
      if (Array.isArray(scopes) && scopes.length > 0) return scopes;
    }
  } catch (err) {
    // older runner — fall back
  }
  return fallback;
};

// Build the protocol-compliant result. Telemetry goes under exportSummary.details
// (a permitted object), NEVER as a top-level key — a non-canonical top-level key
// is a protocol_violation that discards the entire run.
const buildResult = (requestedScopes, convMap, memories, telemetry) => {
  const conversations = Array.from(convMap.values());
  const totalMessages = conversations.reduce((sum, c) => sum + (c.message_count || 0), 0);

  const transformedMemories = (memories || []).map((memory) => ({
    id: memory.id || '',
    content: memory.content || '',
    created_at: memory.created_at || memory.createdAt || new Date().toISOString(),
    updated_at: memory.updated_at || memory.updatedAt,
    type: memory.type || 'memory',
  }));

  const wantsConversations = requestedScopes.includes('chatgpt.conversations');
  const wantsMemories = requestedScopes.includes('chatgpt.memories');

  const errors = [];
  const pending = telemetry.pending || 0;
  if (wantsConversations && pending > 0) {
    errors.push({
      errorClass: telemetry.authFailed ? 'auth_failed' : 'rate_limited',
      reason:
        `${pending} of ${telemetry.totalConversations} conversations were not retrieved` +
        (telemetry.authFailed ? ' (session expired mid-run)' : ' (rate limited)') +
        '. They are checkpointed as missing and will be fetched on the next run.',
      disposition: 'degraded',
      scope: 'chatgpt.conversations',
      phase: 'conversations',
    });
  }
  if (wantsMemories && telemetry.memoriesFailed && transformedMemories.length === 0) {
    errors.push({
      errorClass: telemetry.authFailed ? 'auth_failed' : 'rate_limited',
      reason: 'Memories could not be retrieved this run.',
      disposition: 'degraded',
      scope: 'chatgpt.memories',
      phase: 'memories',
    });
  }

  const result = {
    requestedScopes,
    timestamp: new Date().toISOString(),
    version: '3.0.0-playwright',
    platform: 'chatgpt',
    exportSummary: {
      count: conversations.length,
      label: conversations.length === 1 ? 'conversation' : 'conversations',
      details: {
        memories: transformedMemories.length,
        conversations: conversations.length,
        messages: totalMessages,
        // resume/rate-limit telemetry — diagnostic only, lives inside details
        newlyFetched: telemetry.newlyFetched || 0,
        resumedFromCheckpoint: telemetry.resumed || 0,
        pending,
        totalConversations: telemetry.totalConversations || conversations.length,
        statusCounts: telemetry.statusCounts || {},
        stoppedReason: telemetry.stoppedReason || null,
      },
    },
    errors,
  };

  // Attach only the requested scopes. Keys are written as literals so the
  // produced scope surface is statically obvious.
  const scopePayloads = {
    'chatgpt.conversations': { conversations, total: conversations.length },
    'chatgpt.memories': { memories: transformedMemories, total: transformedMemories.length },
  };
  for (const scope of Object.keys(scopePayloads)) {
    if (requestedScopes.includes(scope)) result[scope] = scopePayloads[scope];
  }

  return result;
};

// ─── Main Export Flow ─────────────────────────────────────────────────

(async () => {
  // ═══ PHASE 1: Browser — Login & Credential Extraction ═══

  await page.setData('status', 'Checking login status...');
  await page.goto('https://chatgpt.com/');
  await page.sleep(3000);

  // Dismiss any interrupting dialogs
  await dismissInterruptingDialogs();
  await page.sleep(1000);

  // Check if logged in (persistent session from previous run)
  let isLoggedIn = await checkLoginStatus();

  if (!isLoggedIn) {
    await page.sleep(2000);
    isLoggedIn = await checkLoginStatus();
  }

  if (!isLoggedIn) {
    // Navigate to ChatGPT login page
    await page.goto('https://chatgpt.com/auth/login');
    await page.sleep(3000);
    await dismissInterruptingDialogs();
    await page.sleep(1000);

    // Click "Log in" button to reach auth.openai.com
    await page.evaluate(`
      (() => {
        const buttons = document.querySelectorAll('button, a');
        for (const btn of buttons) {
          const text = (btn.textContent || '').trim().toLowerCase();
          if (text === 'log in') { btn.click(); return true; }
        }
        return false;
      })()
    `);
    await page.sleep(3000);

    // Check if we're on the OpenAI auth page with email field
    const hasEmailField = await page.evaluate(`
      !!document.querySelector('input[name="email"]') ||
      !!document.querySelector('input[type="email"]') ||
      !!document.querySelector('#email-input')
    `);

    const supportsRequestInput = typeof page.requestInput === 'function';

    if (supportsRequestInput && hasEmailField) {
      const { email } = await page.requestInput({
        message: "Log in to ChatGPT — enter your OpenAI account email",
        schema: {
          type: "object",
          properties: {
            email: { type: "string", description: "OpenAI account email address" },
          },
          required: ["email"],
        },
      });

      await page.evaluate(`
        (() => {
          const emailInput = document.querySelector('input[name="email"]') ||
                             document.querySelector('input[type="email"]') ||
                             document.querySelector('#email-input');
          if (emailInput) {
            emailInput.value = ${JSON.stringify(email)};
            emailInput.dispatchEvent(new Event('input', {bubbles:true}));
            emailInput.dispatchEvent(new Event('change', {bubbles:true}));
          }
        })()
      `);
      await page.sleep(500);
      await page.evaluate(`
        (() => {
          const btn = document.querySelector('button[type="submit"]') ||
                      document.querySelector('button._button-login-id');
          if (btn) btn.click();
        })()
      `);
      await page.sleep(3000);

      // Password page
      const hasPasswordField = await page.evaluate(`
        !!document.querySelector('input[type="password"]') ||
        !!document.querySelector('input[name="password"]')
      `);

      if (hasPasswordField) {
        const { password } = await page.requestInput({
          message: "Enter your OpenAI account password",
          schema: {
            type: "object",
            properties: {
              password: { type: "string", format: "password" },
            },
            required: ["password"],
          },
        });

        await page.evaluate(`
          (() => {
            const passwordInput = document.querySelector('input[type="password"]') ||
                                  document.querySelector('input[name="password"]');
            if (passwordInput) {
              passwordInput.value = ${JSON.stringify(password)};
              passwordInput.dispatchEvent(new Event('input', {bubbles:true}));
              passwordInput.dispatchEvent(new Event('change', {bubbles:true}));
            }
          })()
        `);
        await page.sleep(500);
        await page.evaluate(`
          (() => {
            const btn = document.querySelector('button[type="submit"]') ||
                        document.querySelector('button._button-login-password');
            if (btn) btn.click();
          })()
        `);
        await page.sleep(5000);

        // Handle 2FA if present
        const needs2fa = await page.evaluate(`
          !!document.querySelector('input[name="code"]') ||
          !!document.querySelector('input[type="tel"]') ||
          !!document.querySelector('input[inputmode="numeric"]')
        `);
        if (needs2fa) {
          const { code } = await page.requestInput({
            message: "Enter your OpenAI 2FA verification code",
            schema: {
              type: "object",
              properties: { code: { type: "string", description: "6-digit verification code" } },
              required: ["code"],
            },
          });
          await page.evaluate(`
            (() => {
              const input = document.querySelector('input[name="code"]') ||
                            document.querySelector('input[type="tel"]') ||
                            document.querySelector('input[inputmode="numeric"]');
              if (input) {
                input.value = ${JSON.stringify(code)};
                input.dispatchEvent(new Event('input', {bubbles:true}));
              }
            })()
          `);
          await page.evaluate(`document.querySelector('button[type="submit"]')?.click()`);
          await page.sleep(5000);
        }
      }

      await dismissInterruptingDialogs();
      await page.sleep(2000);
      isLoggedIn = await checkLoginStatus();
    }

    // Fallback to headed browser if programmatic login failed
    // (needed for SSO flows: Google, Microsoft, Apple)
    if (!isLoggedIn) {
      const { headed } = await page.showBrowser('https://chatgpt.com/');
      if (headed) {
        await page.setData('status', 'Please complete login in the browser (SSO or remaining verification)...');
        await page.promptUser(
          'Complete login in the browser, then click "Done".',
          async () => {
            await dismissInterruptingDialogs();
            return await checkLoginStatus();
          },
          2000
        );
        await page.goHeadless();
      }
    }

    await page.setData('status', 'Login completed');
    await page.sleep(2000);
    await dismissInterruptingDialogs();
    await page.sleep(1000);
  } else {
    await page.setData('status', 'Session restored from previous login');
  }

  await dismissInterruptingDialogs();
  await page.sleep(500);

  // Extract email
  await page.setData('status', 'Extracting credentials...');
  let email = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    email = await extractEmail();
    if (email) break;
    await page.sleep(1500);
  }

  if (!email) {
    await page.setData('error', 'Could not extract email');
    return { error: 'Could not extract email' };
  }

  state.email = email;
  await page.setData('email', email);

  // Get auth credentials
  const { userToken, deviceId } = await getAuthCredentials();
  if (!userToken || !deviceId) {
    await page.setData('error', 'Could not get authentication credentials');
    return { error: 'Could not get authentication credentials' };
  }

  state.accessToken = userToken;
  state.deviceId = deviceId;

  // ═══ Switch to headless — browser window disappears ═══
  await page.setData('status', `Credentials captured for ${email}. Switching to background mode...`);
  await page.goHeadless();

  // ═══ PHASE 2: Headless Browser — Resumable Data Collection ═══

  const requestedScopes = await resolveRequestedScopes();

  // Load checkpoint from a previous (possibly interrupted) run.
  let checkpoint = { ok: false, conversations: {}, memories: [], meta: {} };
  try {
    checkpoint = await ckptLoad();
  } catch (err) {
    await page.setData('status', `Checkpoint unavailable (${err.message}); starting fresh.`);
  }

  // Conversation map: id -> record. Seed with whatever we already have.
  const convMap = new Map();
  for (const id of Object.keys(checkpoint.conversations || {})) {
    convMap.set(id, checkpoint.conversations[id]);
  }
  const resumedCount = convMap.size;
  if (resumedCount > 0) {
    await page.setData('status', `Resuming: ${resumedCount} conversations already saved from a previous run.`);
  }

  const telemetry = {
    statusCounts: {},
    newlyFetched: 0,
    resumed: resumedCount,
    pending: 0,
    totalConversations: 0,
    memoriesFailed: false,
    authFailed: false,
    stoppedReason: null,
  };
  const bumpStatus = (s) => {
    const key = String(s);
    telemetry.statusCounts[key] = (telemetry.statusCounts[key] || 0) + 1;
  };

  // Step 1: Memories (cheap, single request). Fall back to checkpointed copy.
  await page.setProgress({ phase: { step: 1, total: 3, label: 'Fetching memories' }, message: 'Downloading memories...' });
  let memories = checkpoint.memories || [];
  const memResult = await fetchMemories(userToken, deviceId);
  if (memResult.ok) {
    memories = memResult.memories;
  } else {
    telemetry.memoriesFailed = memories.length === 0;
  }
  await page.setProgress({
    phase: { step: 1, total: 3, label: 'Fetching memories' },
    message: `Fetched ${memories.length} memories${memResult.ok ? '' : ' (from checkpoint)'}`,
    count: memories.length,
  });

  // Step 2: Conversation list (paginated). The list endpoint is rarely rate
  // limited; if it fails entirely we fall back to the checkpointed ids.
  await page.setProgress({ phase: { step: 2, total: 3, label: 'Fetching conversation list' }, message: 'Loading conversations list...', count: 0 });

  const listMap = new Map();    // id -> { id, title, create_time, update_time }
  const limit = 100;
  let offset = 0;
  let listOk = true;
  const fullSyncDone = !!(checkpoint.meta && checkpoint.meta.fullSyncDone);
  while (true) {
    const pageRes = await fetchConversationsPage(userToken, deviceId, offset, limit);
    if (!pageRes.ok) {
      // Couldn't page the list. If we have checkpointed convs, proceed with those.
      if (offset === 0 && convMap.size === 0) {
        listOk = false;
      }
      break;
    }
    let allKnownUnchanged = pageRes.items.length > 0;
    for (const item of pageRes.items) {
      listMap.set(item.id, item);
      const have = convMap.get(item.id);
      if (!have || have.update_time !== item.update_time) allKnownUnchanged = false;
    }
    await page.setProgress({
      phase: { step: 2, total: 3, label: 'Fetching conversation list' },
      message: `Loaded ${listMap.size.toLocaleString()} of ${typeof pageRes.total === 'number' ? pageRes.total.toLocaleString() : '?'} conversations...`,
      count: listMap.size,
    });
    // Incremental fast-path: on a completed prior sync, the list is updated-desc,
    // so once we hit a full page we already have unchanged, older pages are too.
    if (fullSyncDone && allKnownUnchanged) break;
    if (typeof pageRes.total === 'number' && listMap.size >= pageRes.total) break;
    if (pageRes.items.length < limit) break;
    offset += limit;
    await sleep(LIST_PAGE_DELAY_MS + jitter(200));
  }

  if (!listOk) {
    // Nothing to work with at all.
    telemetry.stoppedReason = 'conversation_list_unavailable';
    const result = buildResult(requestedScopes, convMap, memories, telemetry);
    result.errors.push({ errorClass: 'upstream_error', reason: 'Could not load the conversation list.', disposition: 'fatal', phase: 'conversations' });
    await page.setData('result', result);
    await page.setData('status', 'Could not load conversation list — try again later.');
    return result;
  }

  // Determine the work set: conversations we don't have, or whose update_time changed.
  const work = [];
  for (const [id, listed] of listMap.entries()) {
    const have = convMap.get(id);
    if (!have || have.update_time !== listed.update_time) {
      work.push({ id, attempts: 0, listed });
    }
  }
  telemetry.totalConversations = listMap.size > 0 ? listMap.size : convMap.size;

  await page.setProgress({
    phase: { step: 3, total: 3, label: 'Downloading conversations' },
    message: work.length === 0
      ? `Up to date — ${convMap.size} conversations already saved`
      : `Downloading ${work.length} new/updated of ${telemetry.totalConversations} conversations...`,
    count: convMap.size,
  });

  // Persist memories + list snapshot early so even a list-only run checkpoints.
  await ckptPutBatch([], memories, { lastListAt: new Date().toISOString() }).catch(() => {});

  // Step 3: Adaptive, resumable conversation download.
  const queue = work.slice();
  let concurrency = START_CONCURRENCY;
  let batchDelay = BASE_BATCH_DELAY_MS;
  let backoffMs = BACKOFF_BASE_MS;
  let rlStreak = 0;
  let pendingBuffer = [];          // records to flush to the checkpoint
  let convsSinceFlush = 0;
  let lastFlush = Date.now();

  const flush = async (force) => {
    if (pendingBuffer.length > 0) {
      const toWrite = pendingBuffer;
      pendingBuffer = [];
      await ckptPutBatch(toWrite, memories, null).catch(() => {});
    }
    if (force || convsSinceFlush >= FLUSH_EVERY_CONVS || Date.now() - lastFlush >= FLUSH_INTERVAL_MS) {
      telemetry.pending = queue.length + work.filter(w => w.attempts >= MAX_ATTEMPTS && !convMap.has(w.id)).length;
      const partial = buildResult(requestedScopes, convMap, memories, telemetry);
      await page.setData('result', partial);   // host persists + delivers progressively
      convsSinceFlush = 0;
      lastFlush = Date.now();
    }
  };

  while (queue.length > 0) {
    const slice = queue.splice(0, concurrency);
    const results = await fetchConversationBatch(userToken, deviceId, slice.map(s => s.id));
    const byId = new Map(results.map(r => [r.id, r]));

    let okInBatch = 0;
    let rlInBatch = 0;
    let maxRetryAfter = 0;

    for (const item of slice) {
      const r = byId.get(item.id) || { ok: false, status: 0 };
      bumpStatus(r.ok ? 200 : (r.status || 'no_status'));

      if (r.ok) {
        const record = toConversationRecord(item.listed, r);
        convMap.set(item.id, record);
        pendingBuffer.push(record);
        okInBatch++;
        telemetry.newlyFetched++;
        convsSinceFlush++;
      } else if (isAuthError(r.status)) {
        telemetry.authFailed = true;
      } else if (isRateLimited(r.status)) {
        rlInBatch++;
        if (typeof r.retryAfter === 'number') maxRetryAfter = Math.max(maxRetryAfter, r.retryAfter);
        item.attempts++;
        if (item.attempts < MAX_ATTEMPTS) queue.push(item);  // retry later (not an empty success!)
      } else {
        // 5xx / network / timeout — retry with budget.
        item.attempts++;
        if (item.attempts < MAX_ATTEMPTS) queue.push(item);
      }
    }

    await page.setProgress({
      phase: { step: 3, total: 3, label: 'Downloading conversations' },
      message: `Saved ${convMap.size}/${telemetry.totalConversations} conversations` +
        (rlInBatch > 0 ? ` (easing off — rate limited)` : ''),
      count: convMap.size,
    });

    // Stop immediately on auth expiry — token is dead, nothing more to do this run.
    if (telemetry.authFailed) {
      telemetry.stoppedReason = 'auth_expired';
      break;
    }

    if (okInBatch > 0) {
      // Healthy: ease concurrency up, relax pacing, reset backoff.
      rlStreak = 0;
      backoffMs = BACKOFF_BASE_MS;
      concurrency = clamp(concurrency + 1, MIN_CONCURRENCY, MAX_CONCURRENCY);
      batchDelay = clamp(Math.floor(batchDelay * 0.8), BASE_BATCH_DELAY_MS, MAX_BATCH_DELAY_MS);
      await flush(false);
      await sleep(batchDelay + jitter(250));
    } else if (rlInBatch > 0) {
      // Throttled: back off hard, shrink concurrency, respect Retry-After.
      rlStreak++;
      concurrency = clamp(concurrency >> 1, MIN_CONCURRENCY, MAX_CONCURRENCY);
      batchDelay = clamp(Math.floor(batchDelay * 1.5), BASE_BATCH_DELAY_MS, MAX_BATCH_DELAY_MS);
      const waitMs = Math.max(maxRetryAfter * 1000, backoffMs);
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
      await flush(false);

      if (rlStreak >= BREAKER_RL_BATCHES) {
        // Sustained rate limiting — stop and let the next run resume. Hammering
        // is what produced 2410/2484 × 429 in the wild.
        telemetry.stoppedReason = 'rate_limited_circuit_breaker';
        break;
      }
      await page.setData('status', `Rate limited — pausing ${Math.round(waitMs / 1000)}s before continuing...`);
      await sleep(waitMs + jitter(500));
    } else {
      // Transient errors only — modest pause.
      await flush(false);
      await sleep(batchDelay + jitter(250));
    }
  }

  // Final checkpoint write + classification.
  await flush(true);
  telemetry.pending = Math.max(0, telemetry.totalConversations - convMap.size);

  // Mark a full sync complete only when nothing is outstanding.
  if (telemetry.pending === 0 && !telemetry.authFailed) {
    await ckptPutBatch([], memories, { fullSyncDone: true, lastFullSyncAt: new Date().toISOString() }).catch(() => {});
  }

  const result = buildResult(requestedScopes, convMap, memories, telemetry);

  state.isComplete = telemetry.pending === 0;
  await page.setData('result', result);

  const totalMessages = result.exportSummary.details.messages;
  const pendingSuffix = telemetry.pending > 0
    ? ` — ${telemetry.pending} still pending (will resume next run)`
    : '';
  await page.setProgress({
    phase: { step: 3, total: 3, label: 'Downloading conversations' },
    message: `Saved ${convMap.size}/${telemetry.totalConversations} conversations${pendingSuffix}`,
    count: convMap.size,
  });
  await page.setData('status',
    `${telemetry.pending === 0 ? 'Complete' : 'Partial'}! ${result.exportSummary.details.memories} memories and ` +
    `${convMap.size} conversations (${totalMessages} messages) saved for ${state.email}${pendingSuffix}`
  );

  return result;
})();

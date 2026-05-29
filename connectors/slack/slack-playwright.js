/**
 * Slack Connector (Playwright)
 *
 * Exports your Slack profile, conversations (channels + DMs), and messages
 * from the currently-active Slack workspace.
 *
 * Auth: browser session + xoxc API token scraped from the slack.com web client
 * bootstrap. The d-cookie auto-attaches to in-page fetch() calls because they
 * run in the slack.com origin context.
 *
 * Auto-filtering of "noisy" channels (no UI surface for an ignore list):
 *   - is_archived → skipped
 *   - muted_channels in user prefs → skipped
 *   - public channels where is_member is false → skipped
 *
 * Optional input: oldestDays (number) — limit history depth. Default: all-time.
 */

const SLACK_CLIENT_URL = 'https://app.slack.com/client';
const SLACK_SIGNIN_URL = 'https://slack.com/signin';
const MSG_PAGE_SIZE = 200;
const LIST_PAGE_SIZE = 200;
const USER_PAGE_SIZE = 200;
const API_DELAY_MS = 350;
const THREAD_DELAY_MS = 250;
const MESSAGE_FETCH_CONCURRENCY = 4;

const isLoggedIn = async () => {
  try {
    return await page.evaluate(`
      (() => {
        if (/\\/signin/i.test(window.location.pathname)) return false;
        if (/\\/sso/i.test(window.location.pathname)) return false;
        return Boolean(
          document.querySelector('div.p-client_container') ||
          document.querySelector('div[data-qa="client_app"]') ||
          document.querySelector('div[data-qa="channel_sidebar"]') ||
          document.querySelector('div.p-workspace__primary_view')
        );
      })()
    `);
  } catch (_) {
    return false;
  }
};

const extractBootstrap = async () => {
  try {
    return await page.evaluate(`
      (() => {
        const result = {
          token: null,
          teamId: null,
          teamName: null,
          teamDomain: null,
          teamUrl: null,
          userId: null,
          userName: null,
          enterpriseId: null,
          mutedChannels: [],
          source: null,
          diagnostic: {
            url: window.location.href,
            title: document.title,
            scriptCount: document.querySelectorAll('script').length,
            scriptsOver100Chars: 0,
            localStorageKeys: [],
            sessionStorageKeys: [],
            cookieKeys: [],
            sampleTokenMatches: 0,
            sampleTeamIdMatches: 0,
            hasWindowTS: false,
            hasWindowBootData: false,
          },
        };

        const TOKEN_RE = /(xox[a-z]-[a-zA-Z0-9-]+)/g;
        const API_TOKEN_KV_RE = /"api_token":"(xox[a-z]-[a-zA-Z0-9-]+)"/;
        const TEAM_ID_RE = /"team_id":"(T[A-Z0-9]+)"/;
        const USER_ID_RE = /"user_id":"(U[A-Z0-9]+)"/;

        const captureFromBoot = (boot) => {
          if (!boot || typeof boot !== 'object') return false;
          if (typeof boot.api_token === 'string' && boot.api_token.startsWith('xox')) {
            result.token = boot.api_token;
          }
          if (boot.team) {
            result.teamId = result.teamId || boot.team.id || null;
            result.teamName = result.teamName || boot.team.name || null;
            result.teamDomain = result.teamDomain || boot.team.domain || null;
            result.teamUrl = result.teamUrl || boot.team.url || null;
          }
          if (boot.self) {
            result.userId = result.userId || boot.self.id || null;
            result.userName = result.userName || boot.self.name || null;
          }
          if (boot.enterprise) {
            result.enterpriseId = result.enterpriseId || boot.enterprise.id || null;
          }
          if (boot.prefs && typeof boot.prefs.muted_channels === 'string') {
            result.mutedChannels = boot.prefs.muted_channels.split(',').filter(Boolean);
          }
          return Boolean(result.token);
        };

        // 1) Window namespaces (legacy)
        try {
          if (window.TS) {
            result.diagnostic.hasWindowTS = true;
            if (captureFromBoot(window.TS.boot_data)) result.source = 'TS.boot_data';
          }
        } catch (_) {}
        try {
          if (window.boot_data) {
            result.diagnostic.hasWindowBootData = true;
            if (!result.token && captureFromBoot(window.boot_data)) {
              result.source = 'window.boot_data';
            }
          }
        } catch (_) {}

        // 2) Inline script tag scan
        try {
          const scripts = Array.from(document.querySelectorAll('script'));
          for (const script of scripts) {
            const text = script.textContent || '';
            if (!text || text.length < 100) continue;
            result.diagnostic.scriptsOver100Chars += 1;

            const kvMatch = text.match(API_TOKEN_KV_RE);
            if (kvMatch && !result.token) {
              result.token = kvMatch[1];
              result.source = result.source || 'inline-script(api_token)';
            }
            if (!result.token) {
              const looseMatch = text.match(TOKEN_RE);
              if (looseMatch && looseMatch[0]) {
                result.diagnostic.sampleTokenMatches += looseMatch.length;
                // Prefer xoxc (user-facing API tokens)
                const preferred = looseMatch.find((t) => t.startsWith('xoxc-')) || looseMatch[0];
                if (preferred && preferred.startsWith('xox')) {
                  result.token = preferred;
                  result.source = result.source || 'inline-script(loose)';
                }
              }
            }
            const teamMatch = !result.teamId ? text.match(TEAM_ID_RE) : null;
            if (teamMatch) {
              result.teamId = teamMatch[1];
              result.diagnostic.sampleTeamIdMatches += 1;
            }
            const userMatch = !result.userId ? text.match(USER_ID_RE) : null;
            if (userMatch) result.userId = userMatch[1];
          }
        } catch (_) {}

        // 3) localStorage / sessionStorage scan
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key) continue;
            result.diagnostic.localStorageKeys.push(key);
            if (result.token) continue;
            try {
              const val = localStorage.getItem(key) || '';
              if (val.length < 20) continue;
              const m = val.match(TOKEN_RE);
              if (m && m.length) {
                const preferred = m.find((t) => t.startsWith('xoxc-')) || m[0];
                if (preferred && preferred.startsWith('xox')) {
                  result.token = preferred;
                  result.source = 'localStorage:' + key;
                }
              }
              if (!result.teamId) {
                const tm = val.match(TEAM_ID_RE);
                if (tm) result.teamId = tm[1];
              }
              if (!result.userId) {
                const um = val.match(USER_ID_RE);
                if (um) result.userId = um[1];
              }
            } catch (_) {}
          }
        } catch (_) {}

        try {
          for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i);
            if (key) result.diagnostic.sessionStorageKeys.push(key);
          }
        } catch (_) {}

        // 4) Cookie scan (for diagnostics; xoxc isn't in cookies but xoxd is)
        try {
          for (const chunk of document.cookie.split(';')) {
            const [k] = chunk.trim().split('=');
            if (k) result.diagnostic.cookieKeys.push(k);
          }
        } catch (_) {}

        return result;
      })()
    `);
  } catch (err) {
    return {
      token: null,
      teamId: null,
      teamName: null,
      teamDomain: null,
      teamUrl: null,
      userId: null,
      userName: null,
      enterpriseId: null,
      mutedChannels: [],
      source: null,
      diagnostic: { evaluateThrew: err && err.message ? err.message : String(err) },
    };
  }
};

// Poll extractBootstrap up to `attempts` times, waiting `waitMs` between tries.
// Slack's web client loads bootstrap asynchronously, so a token may not be
// available immediately after navigation.
const extractBootstrapWithRetry = async (attempts, waitMs) => {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    last = await extractBootstrap();
    if (last && last.token) return last;
    if (i < attempts - 1) await page.sleep(waitMs);
  }
  return last;
};

// Slack API calls run in-page from slack.com origin. Key constraints:
//   - app.slack.com has a service worker that intercepts and breaks our
//     fetches to slack.com/api/*, so we navigate to slack.com (any path,
//     /help is convenient) before making calls.
//   - From slack.com, fetch() with credentials:'include' is same-origin and
//     the browser injects the (HttpOnly) `d` cookie + the xoxc token in the
//     body authenticates the call. No Node-side cookie wrangling needed.
//   - The token is held by the caller and threaded into every call.
let activeToken = null;

const slackApi = async (method, params) => {
  if (!activeToken) {
    return { ok: false, status: 0, slackError: 'no_active_token', json: null, preview: '' };
  }
  const cleanParams = { token: activeToken };
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    cleanParams[k] = String(v);
  }
  const paramsStr = JSON.stringify(cleanParams);
  const methodStr = JSON.stringify(method);
  try {
    return await page.evaluate(`
      (async () => {
        const out = { ok: false, status: 0, slackError: null, json: null, preview: '' };
        try {
          const body = new URLSearchParams(${paramsStr}).toString();
          const r = await fetch('https://slack.com/api/' + ${methodStr}, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
          });
          const text = await r.text();
          let j = null; try { j = text ? JSON.parse(text) : null; } catch (_) {}
          out.status = r.status;
          out.json = j;
          out.preview = text ? text.slice(0, 300) : '';
          out.ok = r.ok && j && j.ok === true;
          out.slackError = j && j.error ? j.error : (r.ok ? null : ('http_' + r.status));
          return out;
        } catch (err) {
          out.slackError = 'fetch_threw:' + (err && err.name || 'Error') + ':' + (err && err.message || String(err));
          out.preview = err && err.message ? err.message : String(err);
          return out;
        }
      })()
    `);
  } catch (err) {
    return {
      ok: false,
      status: 0,
      slackError: 'evaluate_threw:' + (err && err.message ? err.message : String(err)),
      json: null,
      preview: err && err.message ? err.message : String(err),
    };
  }
};

const sleep = (ms) => page.sleep(ms);

const paginate = async (method, baseParams, listKey, onPage) => {
  const items = [];
  let cursor = '';
  let pageNumber = 0;

  while (true) {
    const params = { ...baseParams, limit: String(LIST_PAGE_SIZE) };
    if (cursor) params.cursor = cursor;
    const resp = await slackApi(method, params);
    if (!resp.ok) {
      return { ok: false, error: resp.slackError || ('http_' + resp.status), items };
    }
    const batch = Array.isArray(resp.json && resp.json[listKey]) ? resp.json[listKey] : [];
    items.push(...batch);
    pageNumber += 1;
    if (onPage) await onPage(items.length, pageNumber);
    cursor = resp.json && resp.json.response_metadata && resp.json.response_metadata.next_cursor;
    if (!cursor) break;
    await sleep(API_DELAY_MS);
  }

  return { ok: true, items };
};

const fetchUsers = async () => paginate('users.list', { limit: String(USER_PAGE_SIZE) }, 'members');

const fetchAllConversations = async () => {
  return paginate(
    'conversations.list',
    { types: 'public_channel,private_channel,im,mpim', exclude_archived: 'true' },
    'channels',
  );
};

const fetchHistory = async (channelId, oldest, fetchThreads) => {
  const messages = [];
  let cursor = '';
  let threadFetches = 0;

  while (true) {
    const params = { channel: channelId, limit: String(MSG_PAGE_SIZE) };
    if (cursor) params.cursor = cursor;
    if (oldest) params.oldest = oldest;
    const resp = await slackApi('conversations.history', params);
    if (!resp.ok) {
      return { ok: false, error: resp.slackError || ('http_' + resp.status), messages, threadFetches };
    }
    const batch = Array.isArray(resp.json && resp.json.messages) ? resp.json.messages : [];

    if (fetchThreads) {
      for (const msg of batch) {
        if (msg && msg.reply_count && msg.reply_count > 0 && msg.thread_ts) {
          const threadParams = { channel: channelId, ts: msg.thread_ts, limit: String(MSG_PAGE_SIZE) };
          const tResp = await slackApi('conversations.replies', threadParams);
          if (tResp.ok && tResp.json && Array.isArray(tResp.json.messages)) {
            msg.thread_replies = tResp.json.messages.slice(1);
          } else {
            msg.thread_error = tResp.slackError || ('http_' + tResp.status);
          }
          threadFetches += 1;
          await sleep(THREAD_DELAY_MS);
        }
      }
    }

    messages.push(...batch);
    cursor = resp.json && resp.json.response_metadata && resp.json.response_metadata.next_cursor;
    if (!cursor) break;
    await sleep(API_DELAY_MS);
  }

  return { ok: true, messages, threadFetches };
};

const classifyConversation = (ch) => {
  if (ch.is_im) return 'dm';
  if (ch.is_mpim) return 'group_dm';
  if (ch.is_private) return 'private';
  return 'public';
};

const describeConversation = (ch, usersById) => {
  const kind = classifyConversation(ch);
  let displayName = ch.name || null;
  if (kind === 'dm') {
    const peer = ch.user && usersById[ch.user];
    displayName = peer
      ? (peer.profile?.display_name || peer.profile?.real_name || peer.name || ch.user)
      : (ch.user || ch.id);
  }
  if (kind === 'group_dm' && Array.isArray(ch.members)) {
    displayName = ch.name || `group-dm-${ch.id}`;
  }
  return {
    id: ch.id,
    name: displayName,
    type: kind,
    isPrivate: Boolean(ch.is_private),
    isArchived: Boolean(ch.is_archived),
    isMember: Boolean(ch.is_member),
    purpose: ch.purpose?.value || '',
    topic: ch.topic?.value || '',
    numMembers: typeof ch.num_members === 'number' ? ch.num_members : null,
    created: typeof ch.created === 'number' ? ch.created : null,
    user: ch.user || null,
    contextTeamId: ch.context_team_id || null,
  };
};

const shouldSkipForExport = (raw, mutedSet) => {
  if (raw.is_archived) return 'archived';
  if (mutedSet.has(raw.id)) return 'muted';
  // For public channels, skip if the user is not a member — they're "joinable but
  // not joined", which means the user has not engaged with them.
  if (raw.is_channel && !raw.is_private && !raw.is_member) return 'not_member';
  return null;
};

(async () => {
  const REQUESTED_SCOPES = ['slack.profile', 'slack.conversations', 'slack.messages'];
  const VERSION = '0.1.0-playwright';

  const emitFatal = async (errorClass, reason, phase, status) => {
    if (status) await page.setData('status', status);
    await page.setData('error', reason);
    await page.setData('result', {
      requestedScopes: REQUESTED_SCOPES,
      timestamp: new Date().toISOString(),
      version: VERSION,
      platform: 'slack',
      exportSummary: { count: 0, label: 'items', details: reason },
      errors: [{ errorClass, reason, disposition: 'fatal', phase }],
    });
  };

  // ── Auth gate ──────────────────────────────────────────────────────
  //   1. Navigate to app.slack.com and DOM-check the session.
  //   2. If logged-out → showBrowser → promptUser → re-check.
  //   3. Extract the xoxc token from app.slack.com's localStorage.
  //   4. Navigate to slack.com (no service worker — in-page fetch works).
  //   5. Validate via auth.test. From here on every API call is in-page
  //      fetch with the browser handling cookies natively.

  await page.setData('status', 'Checking Slack session...');
  await page.goto(SLACK_CLIENT_URL);
  await sleep(2500);

  let loggedIn = await isLoggedIn();
  if (!loggedIn) {
    await page.setData(
      'status',
      'Slack needs a live login. Opening a browser so you can sign in.'
    );
    const { headed } = await page.showBrowser(SLACK_SIGNIN_URL);
    if (!headed) {
      await emitFatal(
        'auth_failed',
        'Slack session was not detected and a login window could not be opened. ' +
          'Sign in to Slack in your normal Chrome browser, then try again.',
        'auth',
        'Slack login could not be started — browser window unavailable.'
      );
      return;
    }
    await page.promptUser(
      'Sign in to Slack and pick the workspace you want to export. Click Done once you can see channels in the sidebar.',
      async () => await isLoggedIn(),
      2000
    );
    await page.goto(SLACK_CLIENT_URL);
    await sleep(2500);
    loggedIn = await isLoggedIn();
    if (!loggedIn) {
      await emitFatal(
        'auth_failed',
        'Slack login was not detected after the manual sign-in step.',
        'auth',
        'Slack login check failed after manual sign-in.'
      );
      return;
    }
  }

  // Extract bootstrap (still on app.slack.com).
  await page.setProgress({
    phase: { step: 1, total: 5, label: 'Reading session' },
    message: 'Reading Slack workspace bootstrap...',
  });
  const boot = await extractBootstrapWithRetry(8, 1500);
  if (!boot.token) {
    const diag = boot.diagnostic || {};
    const summary =
      'url=' + (diag.url || '?') + ' | title=' + (diag.title || '?') +
      ' | scripts=' + (diag.scriptCount || 0) +
      ' | xoxc-in-scripts=' + (diag.sampleTokenMatches || 0) +
      ' | window.TS=' + (diag.hasWindowTS ? 'yes' : 'no') +
      ' | localStorage=' + (diag.localStorageKeys || []).slice(0, 12).join(',');
    await emitFatal(
      'auth_failed',
      'Could not extract a Slack API token from the page. Diagnostic: ' + summary,
      'auth',
      'Slack session bootstrap could not be read.'
    );
    return;
  }
  activeToken = boot.token;

  // Move to slack.com so subsequent in-page fetch() bypasses the SW on
  // app.slack.com. Cookies still apply because the .slack.com domain covers
  // both subdomains.
  await page.setData('status', 'Switching to slack.com origin for API calls…');
  await page.goto('https://slack.com/help');
  await sleep(1500);

  const verify = await slackApi('auth.test', {});
  const verifyJson = verify.json || {};
  await page.setData(
    'status',
    'auth.test → ok=' + verify.ok +
      ' status=' + verify.status +
      ' slackError=' + (verify.slackError || 'none') +
      ' team_id=' + (verifyJson.team_id || 'none') +
      ' user=' + (verifyJson.user || 'none')
  );
  if (!verify.ok) {
    await emitFatal(
      'auth_failed',
      'Slack auth.test failed (' + (verify.slackError || ('http_' + verify.status)) + '). ' +
        'The page shows you as logged-in but Slack rejected the session. ' +
        'Try signing out of Slack in your normal Chrome browser and signing back in, then retry. ' +
        (verify.preview ? 'Slack returned: ' + verify.preview.slice(0, 200) : ''),
      'auth',
      'Slack session is invalid — see error for details.'
    );
    return;
  }
  if (!verifyJson.user_id || !verifyJson.team_id) {
    await emitFatal(
      'auth_failed',
      'Slack auth.test returned ok but with no user_id/team_id — the page token is a visitor/noauth token. ' +
        'Make sure your real Chrome browser is signed in to Slack with the workspace you want to export.',
      'auth',
      'Slack session is a noauth/visitor token — cannot read user data.'
    );
    return;
  }
  if (!boot.teamId) boot.teamId = verifyJson.team_id;
  if (!boot.userName && verifyJson.user) boot.userName = verifyJson.user;

  // Optional input — message history window.
  let oldestDays = null;
  try {
    const envVal = process && process.env && process.env.USER_OLDEST_DAYS_SLACK;
    if (envVal) {
      const parsed = Number.parseInt(envVal, 10);
      if (Number.isFinite(parsed) && parsed > 0) oldestDays = parsed;
    }
  } catch (_) {}

  if (oldestDays === null) {
    try {
      const opts = await page.requestInput({
        message: 'Slack message history window (optional). Leave empty for all-time history.',
        schema: {
          type: 'object',
          properties: {
            oldestDays: {
              type: ['integer', 'null'],
              minimum: 1,
              title: 'How many days of history?',
              description: 'Skip messages older than this many days. Leave empty for everything.'
            }
          }
        }
      });
      if (opts && typeof opts.oldestDays === 'number' && opts.oldestDays > 0) {
        oldestDays = opts.oldestDays;
      }
    } catch (_) {
      oldestDays = null;
    }
  }

  const oldestTs = oldestDays
    ? String(Math.floor((Date.now() - oldestDays * 24 * 60 * 60 * 1000) / 1000))
    : null;

  const errors = [];
  const mutedSet = new Set(boot.mutedChannels || []);

  // Profile + team info via auth.test + team.info.
  await page.setProgress({
    phase: { step: 2, total: 5, label: 'Fetching profile' },
    message: 'Loading workspace + profile info...',
  });

  // We already validated auth.test above; reuse that response.
  const authResp = verify;
  const teamResp = await slackApi('team.info', {});
  let selfUser = null;
  if (boot.userId) {
    const userResp = await slackApi('users.info', { user: boot.userId });
    if (userResp.ok && userResp.json && userResp.json.user) selfUser = userResp.json.user;
  }

  const profileScope = {
    user: selfUser
      ? {
          id: selfUser.id || boot.userId,
          name: selfUser.name || boot.userName,
          realName: selfUser.real_name || selfUser.profile?.real_name || null,
          displayName: selfUser.profile?.display_name || null,
          email: selfUser.profile?.email || null,
          tz: selfUser.tz || null,
          tzLabel: selfUser.tz_label || null,
          isAdmin: Boolean(selfUser.is_admin),
          isOwner: Boolean(selfUser.is_owner),
          isBot: Boolean(selfUser.is_bot),
        }
      : {
          id: boot.userId,
          name: boot.userName,
          realName: null,
          displayName: null,
          email: null,
          tz: null,
          tzLabel: null,
          isAdmin: false,
          isOwner: false,
          isBot: false,
        },
    workspace: {
      teamId: (authResp.ok && authResp.json?.team_id) || boot.teamId,
      teamName: (teamResp.ok && teamResp.json?.team?.name) || boot.teamName,
      teamDomain: (teamResp.ok && teamResp.json?.team?.domain) || boot.teamDomain,
      teamUrl: (authResp.ok && authResp.json?.url) || boot.teamUrl,
      enterpriseId: (teamResp.ok && teamResp.json?.team?.enterprise_id) || boot.enterpriseId,
      icon: teamResp.ok ? teamResp.json?.team?.icon || null : null,
    },
    bootSource: boot.source,
    historyWindowDays: oldestDays,
  };

  if (!authResp.ok) {
    errors.push({
      errorClass: 'auth_failed',
      reason: `auth.test failed: ${authResp.slackError || 'http_' + authResp.status}`,
      disposition: 'degraded',
      scope: 'slack.profile',
      phase: 'auth',
    });
  }

  // Users (for DM name resolution + member objects).
  await page.setProgress({
    phase: { step: 3, total: 5, label: 'Fetching users' },
    message: 'Loading workspace members...',
  });
  const usersResult = await fetchUsers();
  const usersById = {};
  if (usersResult.ok) {
    for (const u of usersResult.items) usersById[u.id] = u;
  } else {
    errors.push({
      errorClass: 'upstream_error',
      reason: `users.list failed: ${usersResult.error}`,
      disposition: 'degraded',
      scope: 'slack.conversations',
      phase: 'collection',
    });
  }

  // Conversations index.
  await page.setProgress({
    phase: { step: 4, total: 5, label: 'Fetching conversations' },
    message: 'Loading channels + DMs...',
  });
  const convResult = await fetchAllConversations();
  if (!convResult.ok) {
    // Run is now fatal — promote any prior degraded errors to fatal so the
    // runtime doesn't reject the result for "degraded scope must be present"
    // when we're emitting nothing past slack.profile.
    const promoted = errors.map((e) =>
      e.disposition === 'degraded'
        ? { ...e, disposition: 'fatal', scope: undefined }
        : e
    );
    promoted.push({
      errorClass: 'upstream_error',
      reason: `conversations.list failed: ${convResult.error}`,
      disposition: 'fatal',
      phase: 'collection',
    });
    await page.setData('log', 'conversations.list failed: ' + convResult.error);
    await page.setData('result', {
      requestedScopes: REQUESTED_SCOPES,
      timestamp: new Date().toISOString(),
      version: VERSION,
      platform: 'slack',
      'slack.profile': profileScope,
      exportSummary: { count: 0, label: 'items', details: 'Conversation list fetch failed: ' + convResult.error },
      errors: promoted,
    });
    return;
  }

  const rawChannels = convResult.items;
  const conversationsForExport = [];
  const filterCounts = { archived: 0, muted: 0, not_member: 0, kept: 0 };

  const conversations = rawChannels.map((ch) => {
    const summary = describeConversation(ch, usersById);
    const skip = shouldSkipForExport(ch, mutedSet);
    summary.skipReason = skip;
    if (skip) {
      filterCounts[skip] = (filterCounts[skip] || 0) + 1;
    } else {
      filterCounts.kept += 1;
      conversationsForExport.push({ summary, raw: ch });
    }
    return summary;
  });

  const conversationsScope = {
    conversations,
    total: conversations.length,
    exported: conversationsForExport.length,
    filterCounts,
    teamId: profileScope.workspace.teamId,
  };

  // Messages — fetch history per surviving conversation, batched.
  await page.setProgress({
    phase: { step: 5, total: 5, label: 'Fetching messages' },
    message: `Loading messages for ${conversationsForExport.length} conversations...`,
    count: 0,
  });

  const messagesByConversation = {};
  let totalMessages = 0;
  let totalThreads = 0;
  const messageErrors = [];

  for (let i = 0; i < conversationsForExport.length; i += MESSAGE_FETCH_CONCURRENCY) {
    const batch = conversationsForExport.slice(i, i + MESSAGE_FETCH_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async ({ summary }) => {
        const hist = await fetchHistory(summary.id, oldestTs, true);
        return { summary, hist };
      })
    );

    for (const { summary, hist } of results) {
      if (!hist.ok) {
        messageErrors.push({
          errorClass: 'upstream_error',
          reason: `conversations.history failed for ${summary.id}: ${hist.error}`,
          disposition: 'degraded',
          scope: 'slack.messages',
          phase: 'collection',
          channelId: summary.id,
        });
        messagesByConversation[summary.id] = {
          id: summary.id,
          name: summary.name,
          type: summary.type,
          messageCount: 0,
          messages: [],
          fetchError: hist.error,
        };
      } else {
        messagesByConversation[summary.id] = {
          id: summary.id,
          name: summary.name,
          type: summary.type,
          messageCount: hist.messages.length,
          messages: hist.messages,
        };
        totalMessages += hist.messages.length;
        totalThreads += hist.threadFetches;
      }
    }

    await page.setProgress({
      phase: { step: 5, total: 5, label: 'Fetching messages' },
      message: `Loaded ${Math.min(i + batch.length, conversationsForExport.length)} of ${conversationsForExport.length} conversations (${totalMessages} messages so far)...`,
      count: totalMessages,
    });
  }

  errors.push(...messageErrors);

  const messagesScope = {
    teamId: profileScope.workspace.teamId,
    oldestTs,
    oldestDays,
    fetchThreads: true,
    conversations: Object.values(messagesByConversation),
    totalMessages,
    totalThreads,
  };

  await page.setData('result', {
    requestedScopes: REQUESTED_SCOPES,
    timestamp: new Date().toISOString(),
    version: VERSION,
    platform: 'slack',
    'slack.profile': profileScope,
    'slack.conversations': conversationsScope,
    'slack.messages': messagesScope,
    exportSummary: {
      count: conversations.length + totalMessages,
      label: 'items',
      details:
        `${conversations.length} conversations (${filterCounts.kept} exported, ` +
        `${filterCounts.archived} archived, ${filterCounts.muted} muted, ${filterCounts.not_member} non-member), ` +
        `${totalMessages} messages, ${totalThreads} threads`,
      details_obj: {
        conversationsTotal: conversations.length,
        conversationsExported: filterCounts.kept,
        conversationsSkipped: {
          archived: filterCounts.archived,
          muted: filterCounts.muted,
          not_member: filterCounts.not_member,
        },
        totalMessages,
        totalThreads,
      },
    },
    errors,
  });

  await page.setData(
    'status',
    `Complete! Exported ${filterCounts.kept} Slack conversations and ${totalMessages} messages.`
  );
})();

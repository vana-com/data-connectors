/**
 * ChatGPT Connector (Playwright) — Two-Phase Architecture
 *
 * Phase 1 (Browser, visible if login needed):
 *   - Detects login via persistent browser session (headless)
 *   - If not logged in, shows browser for user to log in
 *   - Extracts auth credentials (token + deviceId + email)
 *
 * Phase 2 (Browser, headless — invisible to user):
 *   - Switches to headless mode so browser window disappears
 *   - Fetches memories, conversations list, and conversation details
 *   - Uses page.evaluate() with fetch() to preserve Cloudflare TLS fingerprint
 *   - Parallel conversation fetching (5 concurrent) for ~8x speedup
 *   - Reports structured progress to the UI
 */

// State management
const state = {
  email: null,
  memories: [],
  conversations: [],
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

// ─── Data Fetch Helpers (use page.evaluate for Cloudflare compat) ────

// Fetch memories
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
          if (!response.ok) return { success: false, error: 'HTTP ' + response.status };
          const data = await response.json();
          return { success: true, memories: data.memories || [] };
        } catch (err) {
          return { success: false, error: err.message };
        }
      })()
    `);
    if (result?.success) return result.memories;
    return [];
  } catch (err) {
    return [];
  }
};

// Fetch conversations list (paginated)
const fetchConversationsList = async (accessToken, deviceId) => {
  const allConversations = [];
  let offset = 0;
  const limit = 100;

  while (true) {
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
          if (!response.ok) return { success: false, error: 'HTTP ' + response.status };
          const data = await response.json();
          return {
            success: true,
            items: (data.items || []).map(item => ({ id: item.id, title: item.title, create_time: item.create_time, update_time: item.update_time })),
            total: data.total,
          };
        } catch (err) {
          return { success: false, error: err.message };
        }
      })()
    `);

    if (!result?.success) break;
    allConversations.push(...result.items);

    // Report pagination progress
    const total = result.total || '?';
    await page.setProgress({
      phase: { step: 2, total: 3, label: 'Fetching conversation list' },
      message: `Loaded ${allConversations.length.toLocaleString()} of ${typeof total === 'number' ? total.toLocaleString() : total} conversations...`,
      count: allConversations.length,
    });

    if (allConversations.length >= result.total || result.items.length < limit) break;
    offset += limit;
    await page.sleep(300);
  }

  return allConversations;
};

// Fetch a batch of conversation details in parallel (inside browser via Promise.all)
const fetchConversationBatch = async (accessToken, deviceId, convIds) => {
  const result = await page.evaluate(`
    (async () => {
      const token = ${JSON.stringify(accessToken)};
      const device = ${JSON.stringify(deviceId)};
      const ids = ${JSON.stringify(convIds)};

      const fetchOne = async (convId) => {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 30000);
          const response = await fetch(
            "https://chatgpt.com/backend-api/conversation/" + convId,
            { headers: { accept: "*/*", authorization: "Bearer " + token, "oai-device-id": device, "oai-language": "en-US" },
              method: "GET", credentials: "include", signal: controller.signal }
          );
          clearTimeout(timeout);
          if (!response.ok) return { id: convId, success: false, error: 'HTTP ' + response.status };
          const data = await response.json();

          // Walk the message tree
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

          return { id: convId, success: true, title: data.title, create_time: data.create_time, update_time: data.update_time, messages };
        } catch (err) {
          return { id: convId, success: false, error: err.message };
        }
      };

      return await Promise.all(ids.map(id => fetchOne(id)));
    })()
  `);

  return result || [];
};

// ─── Main Export Flow ─────────────────────────────────────────────────

(async () => {
  // ═══ PHASE 1: Browser — Login & Credential Extraction ═══

  await page.setData('status', 'Checking login status...');
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
    // Need user interaction — ensure browser is visible (headed mode)
    await page.showBrowser('https://chatgpt.com/');
    await page.setData('status', 'Please log in to ChatGPT...');
    await page.sleep(3000);

    await dismissInterruptingDialogs();
    await page.sleep(1000);

    isLoggedIn = await checkLoginStatus();

    if (!isLoggedIn) {
      await page.promptUser(
        'Please log in to ChatGPT. Click "Done" when you see the chat interface.',
        async () => {
          await dismissInterruptingDialogs();
          return await checkLoginStatus();
        },
        2000
      );
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

  // ═══ PHASE 2: Headless Browser — Data Collection ═══

  // Step 1: Fetch memories
  await page.setProgress({
    phase: { step: 1, total: 3, label: 'Fetching memories' },
    message: 'Downloading memories...',
  });

  const memories = await fetchMemories(userToken, deviceId);
  state.memories = memories;

  await page.setProgress({
    phase: { step: 1, total: 3, label: 'Fetching memories' },
    message: `Fetched ${memories.length} memories`,
    count: memories.length,
  });

  // Step 2: Fetch conversations list
  await page.setProgress({
    phase: { step: 2, total: 3, label: 'Fetching conversation list' },
    message: 'Loading conversations list...',
    count: 0,
  });

  const conversationsList = await fetchConversationsList(userToken, deviceId);

  await page.setProgress({
    phase: { step: 2, total: 3, label: 'Fetching conversation list' },
    message: `Found ${conversationsList.length} conversations`,
    count: conversationsList.length,
  });

  // Step 3: Fetch conversation details — PARALLEL BATCHES
  await page.setProgress({
    phase: { step: 3, total: 3, label: 'Downloading conversations' },
    message: `Downloading 0 of ${conversationsList.length} conversations...`,
    count: 0,
  });

  const conversations = [];
  let fetchErrors = 0;
  const BATCH_SIZE = 5;

  for (let i = 0; i < conversationsList.length; i += BATCH_SIZE) {
    const batch = conversationsList.slice(i, i + BATCH_SIZE);
    const batchIds = batch.map(c => c.id);

    const results = await fetchConversationBatch(userToken, deviceId, batchIds);

    for (const result of results) {
      const conv = conversationsList.find(c => c.id === result.id);
      if (result?.success) {
        conversations.push({
          id: result.id,
          title: result.title || conv?.title || 'Untitled',
          create_time: conv?.create_time,
          update_time: conv?.update_time,
          message_count: result.messages.length,
          messages: result.messages,
        });
      } else {
        fetchErrors++;
        conversations.push({
          id: result.id,
          title: conv?.title || 'Untitled',
          create_time: conv?.create_time,
          update_time: conv?.update_time,
          message_count: 0,
          messages: [],
        });
      }
    }

    // Report progress
    await page.setProgress({
      phase: { step: 3, total: 3, label: 'Downloading conversations' },
      message: `Downloaded ${conversations.length}/${conversationsList.length} conversations`,
      count: conversations.length,
    });

    // Small delay between batches to avoid rate limiting
    if (i + BATCH_SIZE < conversationsList.length) {
      await page.sleep(200);
    }
  }

  state.conversations = conversations;

  const errorSuffix = fetchErrors > 0 ? ` (${fetchErrors} had errors)` : '';
  await page.setProgress({
    phase: { step: 3, total: 3, label: 'Downloading conversations' },
    message: `Fetched ${conversations.length} conversations${errorSuffix}`,
    count: conversations.length,
  });

  // ═══ Build Result ═══
  const totalMessages = conversations.reduce((sum, c) => sum + c.message_count, 0);

  const transformedMemories = (state.memories || []).map((memory) => ({
    id: memory.id || '',
    content: memory.content || '',
    created_at: memory.created_at || memory.createdAt || new Date().toISOString(),
    updated_at: memory.updated_at || memory.updatedAt,
    type: memory.type || 'memory'
  }));

  const result = {
    email: state.email,
    memories: transformedMemories,
    conversations: conversations,
    exportSummary: {
      count: conversations.length,
      label: conversations.length === 1 ? 'conversation' : 'conversations',
      details: `${transformedMemories.length} memories, ${conversations.length} conversations (${totalMessages} messages)`
    },
    timestamp: new Date().toISOString(),
    version: "2.0.0-playwright",
    platform: "chatgpt"
  };

  state.isComplete = true;
  await page.setData('result', result);
  await page.setData('status',
    `Complete! ${transformedMemories.length} memories and ${conversations.length} conversations (${totalMessages} messages) collected for ${state.email}`
  );

  return { success: true, data: result };
})();

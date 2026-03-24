/**
 * Claude Connector (Playwright)
 *
 * Current export:
 * - claude.conversations — Conversation index plus full thread data when API access succeeds
 * - claude.projects — Project index plus project detail when API access succeeds
 *
 * Extraction method:
 * - manual browser login fallback
 * - in-page fetch against Claude's authenticated JSON APIs
 * - DOM fallback when an API path is unavailable
 */

const CLAUDE_HOME_URL = 'https://claude.ai/new';
const CLAUDE_LOGIN_URL = 'https://claude.ai/login';
const PAGE_SIZE = 30;

const readTextValue = `
  const readTextValue = (value) => (value || '').replace(/\\s+/g, ' ').trim();
`;

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

const extractSidebarData = async () => {
  try {
    return await page.evaluate(`
      (() => {
        ${readTextValue}

        const userButton = document.querySelector('button[data-testid="user-menu-button"]');
        const userName = readTextValue(userButton?.querySelector('span')?.textContent);
        const planNodes = userButton ? Array.from(userButton.querySelectorAll('span')) : [];
        const plan = readTextValue(
          planNodes.map((node) => node.textContent || '').find((text) => text && text !== userName) || ''
        );

        const conversations = Array.from(document.querySelectorAll('[data-dd-action-name="sidebar-chat-item"]'))
          .map((anchor) => {
            const title = readTextValue(anchor.textContent);
            const href = anchor.getAttribute('href') || '';
            const idMatch = href.match(/\\/chat\\/([^/?#]+)/);

            return {
              id: idMatch ? idMatch[1] : null,
              title: title || 'Untitled',
              href,
            };
          })
          .filter((item) => item.href);

        const projects = Array.from(document.querySelectorAll('[data-dd-action-name="sidebar-project-item"]'))
          .map((anchor) => {
            const title = readTextValue(anchor.textContent);
            const href = anchor.getAttribute('href') || '';
            const label = readTextValue(anchor.getAttribute('aria-label'));
            const idMatch = href.match(/\\/project\\/([^/?#]+)/);

            return {
              id: idMatch ? idMatch[1] : null,
              title: title || label.replace(/^Project,\\s*/, '') || 'Untitled project',
              href,
              label: label || null,
            };
          })
          .filter((item) => item.href);

        return {
          profile: {
            name: userName || null,
            plan: plan || null,
          },
          conversations,
          projects,
          currentUrl: window.location.href,
        };
      })()
    `);
  } catch (err) {
    return {
      profile: { name: null, plan: null },
      conversations: [],
      projects: [],
      currentUrl: null,
    };
  }
};

const fetchSessionContext = async () => {
  try {
    return await page.evaluate(`
      (() => {
        ${readTextValue}

        const cookieMap = {};
        for (const chunk of document.cookie.split(';')) {
          const [rawKey, ...rest] = chunk.trim().split('=');
          if (!rawKey) continue;
          cookieMap[rawKey] = rest.join('=');
        }

        const userButton = document.querySelector('button[data-testid="user-menu-button"]');
        const userName = readTextValue(userButton?.querySelector('span')?.textContent);
        const planNodes = userButton ? Array.from(userButton.querySelectorAll('span')) : [];
        const plan = readTextValue(
          planNodes.map((node) => node.textContent || '').find((text) => text && text !== userName) || ''
        );

        const localOrg =
          window.localStorage.getItem('lastActiveOrg') ||
          window.sessionStorage.getItem('lastActiveOrg') ||
          null;

        return {
          organizationId: cookieMap.lastActiveOrg || localOrg || null,
          profile: {
            name: userName || null,
            plan: plan || null,
          },
        };
      })()
    `);
  } catch (err) {
    return {
      organizationId: null,
      profile: { name: null, plan: null },
    };
  }
};

const fetchJson = async (endpoint) => {
  const endpointStr = JSON.stringify(endpoint);
  try {
    return await page.evaluate(`
      (async () => {
        try {
          const resp = await fetch(${endpointStr}, {
            method: 'GET',
            credentials: 'include',
            headers: { accept: 'application/json' }
          });
          const text = await resp.text();
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch (_) {}

          return {
            ok: resp.ok,
            status: resp.status,
            json,
            text: text ? text.slice(0, 1000) : ''
          };
        } catch (err) {
          return { ok: false, status: 0, error: err.message };
        }
      })()
    `);
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
};

const normalizeConversationEntry = (item) => {
  const uuid = item?.uuid || item?.id || item?.chat_uuid || null;
  const title =
    item?.name ||
    item?.title ||
    item?.chat_title ||
    item?.display_name ||
    item?.summary ||
    'Untitled';

  return {
    id: uuid,
    title,
    href: uuid ? `/chat/${uuid}` : null,
    createdAt: item?.created_at || item?.createdAt || null,
    updatedAt: item?.updated_at || item?.updatedAt || null,
    starred: Boolean(item?.is_starred || item?.starred),
    projectId: item?.project_uuid || item?.projectId || null,
  };
};

const extractMessageText = (content) => {
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
  if (typeof content.content === 'string') return content.content;
  return '';
};

const normalizeConversationTree = (conversationId, treeData, fallbackEntry) => {
  const rawMessages = Array.isArray(treeData?.chat_messages) ? treeData.chat_messages : [];

  const messages = rawMessages.map((message) => ({
    id: message?.uuid || null,
    sender: message?.sender || message?.role || null,
    parentId: message?.parent_message_uuid || null,
    createdAt: message?.created_at || message?.updated_at || null,
    updatedAt: message?.updated_at || null,
    content: extractMessageText(message?.content),
    rawContent: message?.content || null,
    attachments: Array.isArray(message?.attachments) ? message.attachments : [],
  }));

  return {
    id: conversationId,
    title:
      treeData?.name ||
      treeData?.title ||
      fallbackEntry?.title ||
      'Untitled',
    href: fallbackEntry?.href || `/chat/${conversationId}`,
    createdAt: treeData?.created_at || fallbackEntry?.createdAt || null,
    updatedAt: treeData?.updated_at || fallbackEntry?.updatedAt || null,
    starred: fallbackEntry?.starred ?? null,
    projectId: fallbackEntry?.projectId || null,
    messageCount: messages.length,
    messages,
    fetchError: null,
  };
};

const fetchConversationIndex = async (organizationId) => {
  const seen = new Set();
  const all = [];

  for (const starred of [false, true]) {
    let offset = 0;

    while (true) {
      const query = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(offset),
        starred: String(starred),
      }).toString();

      const response = await fetchJson(
        `https://claude.ai/api/organizations/${organizationId}/chat_conversations_v2?${query}`
      );

      if (!response?.ok || !response?.json) {
        return {
          ok: false,
          error: response?.error || response?.text || `HTTP ${response?.status || 0}`,
          conversations: all,
        };
      }

      const pageData = Array.isArray(response.json?.data)
        ? response.json.data
        : Array.isArray(response.json)
          ? response.json
          : [];

      const normalized = pageData.map(normalizeConversationEntry).filter((item) => item.id);
      for (const item of normalized) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        all.push(item);
      }

      const hasMore = Boolean(response.json?.has_more) || normalized.length === PAGE_SIZE;
      if (!hasMore || normalized.length === 0) break;

      offset += PAGE_SIZE;
      await page.sleep(200);
    }
  }

  return { ok: true, conversations: all };
};

const fetchConversationDetail = async (organizationId, conversation) => {
  const query = new URLSearchParams({
    tree: 'True',
    rendering_mode: 'messages',
    render_all_tools: 'true',
    return_dangling_human_message: 'true',
  }).toString();

  const response = await fetchJson(
    `https://claude.ai/api/organizations/${organizationId}/chat_conversations/${conversation.id}?${query}`
  );

  if (!response?.ok || !response?.json) {
    return {
      id: conversation.id,
      title: conversation.title,
      href: conversation.href,
      createdAt: conversation.createdAt || null,
      updatedAt: conversation.updatedAt || null,
      starred: conversation.starred ?? null,
      projectId: conversation.projectId || null,
      messageCount: 0,
      messages: [],
      fetchError: response?.error || response?.text || `HTTP ${response?.status || 0}`,
    };
  }

  return normalizeConversationTree(conversation.id, response.json, conversation);
};

const fetchConversationDetails = async (organizationId, conversations) => {
  const detailed = [];
  const batchSize = 8;

  for (let start = 0; start < conversations.length; start += batchSize) {
    const batch = conversations.slice(start, start + batchSize);

    await page.setProgress({
      phase: { step: 2, total: 4, label: 'Fetching conversations' },
      message: `Loading conversations ${start + 1}-${start + batch.length} of ${conversations.length}...`,
      count: Math.min(start + batch.length, conversations.length),
    });

    const results = await Promise.all(
      batch.map((conversation) => fetchConversationDetail(organizationId, conversation))
    );

    detailed.push(...results);
    await page.sleep(100);
  }

  return detailed;
};

const normalizeProjectEntry = (item) => ({
  id: item?.uuid || item?.id || null,
  title: item?.name || item?.title || 'Untitled project',
  href: item?.uuid ? `/project/${item.uuid}` : null,
  label: item?.name ? `Project, ${item.name}` : null,
  createdAt: item?.created_at || item?.createdAt || null,
  updatedAt: item?.updated_at || item?.updatedAt || null,
  archived: Boolean(item?.archived_at || item?.is_archived),
});

const fetchProjects = async (organizationId, sidebarProjects) => {
  const seen = new Map();

  for (const starred of [true, false]) {
    const query = new URLSearchParams({
      include_harmony_projects: 'true',
      limit: String(PAGE_SIZE),
      starred: String(starred),
    }).toString();

    const response = await fetchJson(
      `https://claude.ai/api/organizations/${organizationId}/projects?${query}`
    );

    if (!response?.ok || !response?.json) continue;

    const list = Array.isArray(response.json?.data)
      ? response.json.data
      : Array.isArray(response.json?.projects)
        ? response.json.projects
        : Array.isArray(response.json)
          ? response.json
          : [];

    for (const item of list.map(normalizeProjectEntry)) {
      if (item.id) seen.set(item.id, item);
    }
  }

  for (const project of sidebarProjects) {
    if (project.id && !seen.has(project.id)) {
      seen.set(project.id, project);
    }
  }

  const projects = Array.from(seen.values());
  const detailed = [];

  for (let index = 0; index < projects.length; index++) {
    const project = projects[index];

    await page.setProgress({
      phase: { step: 3, total: 4, label: 'Fetching projects' },
      message: `Loading project ${index + 1} of ${projects.length}...`,
      count: index + 1,
    });

    if (!project.id) {
      detailed.push(project);
      continue;
    }

    const response = await fetchJson(
      `https://claude.ai/api/organizations/${organizationId}/projects/${project.id}`
    );

    if (!response?.ok || !response?.json) {
      detailed.push({
        ...project,
        fetchError: response?.error || response?.text || `HTTP ${response?.status || 0}`,
      });
      continue;
    }

    detailed.push({
      ...project,
      detail: response.json,
    });
    await page.sleep(100);
  }

  return detailed;
};

(async () => {
  await page.setData('status', 'Checking Claude session...');
  await page.goto(CLAUDE_HOME_URL);
  await page.sleep(2000);

  let isLoggedIn = await checkLoginStatus();

  if (!isLoggedIn) {
    await page.setData(
      'status',
      'Claude needs a live login. Opening a browser so you can sign in with Google or email.'
    );

    const { headed } = await page.showBrowser(CLAUDE_LOGIN_URL);
    if (!headed) {
      await page.setData('error', 'Could not open a browser window for Claude login.');
      return;
    }

    await page.promptUser(
      'Log in to Claude, then click Done once you can see the Claude sidebar or new chat screen.',
      async () => {
        return await checkLoginStatus();
      },
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

  await page.setProgress({
    phase: { step: 1, total: 4, label: 'Reading session' },
    message: 'Loading Claude home and session context...',
  });
  await page.goto(CLAUDE_HOME_URL);
  await page.sleep(2000);

  const sidebarData = await extractSidebarData();
  const sessionContext = await fetchSessionContext();
  const organizationId = sessionContext.organizationId;
  const profile = {
    name: sessionContext.profile.name || sidebarData.profile.name,
    plan: sessionContext.profile.plan || sidebarData.profile.plan,
  };

  let conversations = sidebarData.conversations.map((item) => ({
    ...item,
    messageCount: null,
    messages: [],
  }));

  let conversationSource = 'sidebar-index';
  let conversationApiError = null;

  if (organizationId) {
    const conversationIndexResult = await fetchConversationIndex(organizationId);
    if (conversationIndexResult.ok && conversationIndexResult.conversations.length > 0) {
      conversations = await fetchConversationDetails(
        organizationId,
        conversationIndexResult.conversations
      );
      conversationSource = 'api';
    } else if (!conversationIndexResult.ok) {
      conversationApiError = conversationIndexResult.error || null;
    }
  } else {
    conversationApiError = 'No active Claude organization id found in session state.';
  }

  let projects = sidebarData.projects;
  let projectSource = 'sidebar-index';
  let projectApiError = null;

  if (organizationId) {
    const projectResults = await fetchProjects(organizationId, sidebarData.projects);
    if (projectResults.length > 0) {
      projects = projectResults;
      projectSource = 'api';
    } else {
      projectApiError = 'Project API returned no usable data.';
    }
  } else {
    projectApiError = 'No active Claude organization id found in session state.';
  }

  const totalMessages = conversations.reduce(
    (sum, conversation) => sum + (conversation.messageCount || 0),
    0
  );

  await page.setProgress({
    phase: { step: 4, total: 4, label: 'Finalizing export' },
    message: 'Building Claude export payload...',
    count: conversations.length + projects.length + totalMessages,
  });

  const result = {
    'claude.conversations': {
      profile,
      organizationId,
      conversations,
      total: conversations.length,
      messageTotal: totalMessages,
      source: conversationSource,
      apiError: conversationApiError,
    },
    'claude.projects': {
      profile,
      organizationId,
      projects,
      total: projects.length,
      source: projectSource,
      apiError: projectApiError,
    },
    exportSummary: {
      count: conversations.length + projects.length + totalMessages,
      label: 'items',
      details:
        `${conversations.length} conversations, ` +
        `${totalMessages} messages, ` +
        `${projects.length} projects`,
    },
    timestamp: new Date().toISOString(),
    version: '1.1.0-playwright',
    platform: 'claude',
  };

  await page.setData('result', result);
  await page.setData(
    'status',
    'Complete! Exported ' + result.exportSummary.details + ' from Claude.'
  );
})();

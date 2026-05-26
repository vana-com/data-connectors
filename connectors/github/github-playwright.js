/**
 * GitHub Connector
 *
 * Exports:
 * - Profile
 * - Repositories (all pages)
 * - Starred repositories (all pages)
 */

const state = {
  username: null,
  profile: null,
  repositories: [],
  starred: [],
  events: [],
  contributions: null,
  history: null,
  isComplete: false,
};

const PLATFORM = "github";
const VERSION = "1.3.0";
const CANONICAL_SCOPES = [
  "github.profile",
  "github.repositories",
  "github.starred",
  "github.events",
  "github.contributions",
  "github.history",
];

const makeConnectorError = (
  errorClass,
  reason,
  disposition,
  extras = {},
) => ({
  errorClass,
  reason,
  disposition,
  ...extras,
});

const makeFatalRunError = (errorClass, reason, phase = "collect") => {
  const error = new Error(reason);
  error.telemetryError = makeConnectorError(errorClass, reason, "fatal", {
    phase,
  });
  return error;
};

const inferErrorClass = (message, fallback = "runtime_error") => {
  const text = String(message || "").toLowerCase();
  if (text.includes("auth") || text.includes("login") || text.includes("credential")) {
    return "auth_failed";
  }
  if (text.includes("timeout") || text.includes("timed out")) {
    return "timeout";
  }
  if (
    text.includes("network") ||
    text.includes("fetch") ||
    text.includes("net::")
  ) {
    return "network_error";
  }
  return fallback;
};

const formatExportSummaryDetails = (
  repositories,
  starred,
  events = 0,
  contributions = 0,
) => ({
  repositories,
  starred,
  events,
  contributions,
});

const buildResult = ({ requestedScopes, scopes, errors, exportSummary }) => ({
  requestedScopes: [...requestedScopes],
  timestamp: new Date().toISOString(),
  version: VERSION,
  platform: PLATFORM,
  exportSummary,
  errors,
  ...scopes,
});

const buildEmptyResult = (requestedScopes, errors) =>
  buildResult({
    requestedScopes,
    scopes: {},
    errors,
    exportSummary: {
      count: 0,
      label: "items",
      details: formatExportSummaryDetails(0, 0, 0, 0),
    },
  });

const resolveRequestedScopes = () => {
  const raw =
    typeof page.requestedScopes === "function" ? page.requestedScopes() : null;
  if (raw == null) {
    return [...CANONICAL_SCOPES];
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw makeFatalRunError(
      "protocol_violation",
      "GitHub connector received an empty or invalid requestedScopes array.",
      "init",
    );
  }
  const deduped = Array.from(new Set(raw));
  const invalid = deduped.filter((scope) => !CANONICAL_SCOPES.includes(scope));
  if (invalid.length > 0) {
    throw makeFatalRunError(
      "protocol_violation",
      `GitHub connector received unsupported requestedScopes: ${invalid.join(", ")}.`,
      "init",
    );
  }
  return deduped;
};

const withTimeout = async (promise, ms, label) => {
  let timeoutId = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

const safeGoto = async (url, options = {}) => {
  const { attempts = 3, timeout = 15000, betweenMs = 2000 } = options;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await withTimeout(
        page.goto(url, { timeout }),
        timeout + 5000,
        `goto ${url}`,
      );
      return true;
    } catch (error) {
      const message = error?.message || String(error);
      console.error(
        `[github] Navigation attempt ${attempt}/${attempts} failed for ${url}: ${message}`,
      );
      if (attempt < attempts) {
        await page.sleep(betweenMs);
      }
    }
  }
  return false;
};

const GITHUB_USERNAME_REGEX = /^[a-zA-Z0-9-]+$/;

const isValidGitHubUsername = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  GITHUB_USERNAME_REGEX.test(value);

const TO_INT_HELPER = `
const toInt = (raw) => {
  const text = (raw || "").toLowerCase().replace(/,/g, "").replace(/\\s+/g, "").trim();
  if (!text) return 0;

  const compact = text.match(/^([0-9]+(?:[.][0-9]+)?)([km])?$/);
  if (compact) {
    let value = parseFloat(compact[1]);
    if (Number.isNaN(value)) return 0;
    if (compact[2] === "k") value *= 1_000;
    if (compact[2] === "m") value *= 1_000_000;
    return Math.round(value);
  }

  const digits = text.replace(/[^0-9]/g, "");
  if (!digits) return 0;
  return parseInt(digits, 10);
};
`;

const checkLoginStatus = async () => {
  try {
    return await page.evaluate(`
      (() => {
        const userMeta = document.querySelector("meta[name='user-login']");
        const username = userMeta?.getAttribute("content")?.trim() || "";
        const signedOut = !!document.querySelector('a[href="/login"], form[action="/session"]');
        const hasAvatarMenu = !!document.querySelector('summary[aria-label*="View profile and more"]');
        return Boolean(username) || (!signedOut && hasAvatarMenu);
      })()
    `);
  } catch {
    return false;
  }
};

const readLoggedInUsername = async () => {
  try {
    return await page.evaluate(`
      (() => {
        const userMeta = document.querySelector("meta[name='user-login']");
        const username = userMeta?.getAttribute("content")?.trim() || "";
        return username || null;
      })()
    `);
  } catch {
    return null;
  }
};

const resolveUsername = async () => {
  const current = await readLoggedInUsername();
  if (isValidGitHubUsername(current)) return current;

  if (!(await safeGoto("https://github.com/settings/profile"))) return null;
  await page.sleep(1500);

  const fromSettings = await readLoggedInUsername();
  return isValidGitHubUsername(fromSettings) ? fromSettings : null;
};

const extractProfile = async (username) => {
  if (!isValidGitHubUsername(username)) {
    return {
      ok: false,
      error: makeConnectorError(
        "runtime_error",
        "Could not resolve a valid GitHub username for profile collection.",
        "omitted",
        { scope: "github.profile", phase: "collect" },
      ),
    };
  }

  if (!(await safeGoto(`https://github.com/${username}`))) {
    return {
      ok: false,
      error: makeConnectorError(
        "navigation_error",
        `Could not reach the GitHub profile page for @${username}.`,
        "omitted",
        { scope: "github.profile", phase: "collect" },
      ),
    };
  }
  await page.sleep(1500);

  try {
    const profile = await page.evaluate(`
      (() => {
        ${TO_INT_HELPER}

        const username = (document.querySelector('span.p-nickname')?.textContent || '').trim();
        const fullName = (document.querySelector('span.p-name')?.textContent || '').trim();
        const bio = (document.querySelector('div.p-note')?.textContent || '').trim();
        const company = (document.querySelector('[itemprop="worksFor"]')?.textContent || '').trim();
        const location = (document.querySelector('[itemprop="homeLocation"]')?.textContent || '').trim();
        const website = document.querySelector('[itemprop="url"]')?.getAttribute('href') || '';
        const avatarUrl = document.querySelector('img.avatar-user')?.getAttribute('src') || '';
        const followersRaw = (document.querySelector('a[href$="?tab=followers"] span, a[href$="?tab=followers"]')?.textContent || '').trim();
        const followingRaw = (document.querySelector('a[href$="?tab=following"] span, a[href$="?tab=following"]')?.textContent || '').trim();
        const reposNode = document.querySelector('[data-tab-item="repositories"] .Counter, a[href*="tab=repositories"] .Counter') || document.querySelector('[data-tab-item="repositories"], a[href*="tab=repositories"]');
        const reposRaw = (reposNode?.textContent || '').trim();

        // Pinned repositories — what the user curates on their profile
        const pinnedItems = Array.from(document.querySelectorAll('.js-pinned-items-reorder-container li, ol.pinned-items-reorder-list li')).map((li) => {
          const link = li.querySelector('a[href*="/"]');
          const href = link?.getAttribute('href') || '';
          const full = href.startsWith('/') ? href.slice(1) : href;
          const description = (li.querySelector('p.pinned-item-desc')?.textContent || '').trim();
          const language = (li.querySelector('[itemprop="programmingLanguage"]')?.textContent || '').trim();
          const stars = (li.querySelector('a[href$="/stargazers"]')?.textContent || '').trim();
          return {
            fullName: full,
            url: full ? \`https://github.com/\${full}\` : null,
            description,
            language: language || null,
            stars: toInt(stars),
          };
        }).filter((p) => p.fullName);

        // Organization memberships — visible avatars under "Organizations"
        const organizations = Array.from(document.querySelectorAll('a.avatar-group-item[href^="/"]')).map((a) => {
          const href = a.getAttribute('href') || '';
          const name = href.replace(/^\\//, '').split('/')[0];
          const label = a.getAttribute('aria-label') || a.querySelector('img')?.getAttribute('alt') || name;
          const avatar = a.querySelector('img')?.getAttribute('src') || null;
          return name ? { login: name, label, url: \`https://github.com\${href}\`, avatarUrl: avatar } : null;
        }).filter(Boolean);

        // Achievement badges — title attributes on the achievement images
        const achievements = Array.from(document.querySelectorAll('.js-achievement-card img, a[href*="/achievements/"] img')).map((img) => {
          const alt = img.getAttribute('alt') || '';
          // alt is typically "Achievement: <Name>"
          const name = alt.replace(/^Achievement:\\s*/i, '').trim();
          const src = img.getAttribute('src') || null;
          return name ? { name, iconUrl: src } : null;
        }).filter(Boolean);

        // "N contributions in the last year" counter on profile
        const contribCounter = document.querySelector('h2.f4.text-normal.mb-2');
        const contribText = (contribCounter?.textContent || '').trim();
        const contribMatch = contribText.match(/([\\d,]+)\\s+contribution/i);
        const contributionsLastYear = contribMatch ? toInt(contribMatch[1]) : null;

        return {
          username,
          fullName,
          bio,
          company,
          location,
          website,
          avatarUrl,
          followers: toInt(followersRaw),
          following: toInt(followingRaw),
          repositoryCount: toInt(reposRaw),
          profileUrl: window.location.href,
          pinnedRepositories: pinnedItems,
          organizations,
          achievements,
          contributionsLastYear,
        };
      })()
    `);
    if (!profile || !isValidGitHubUsername(profile.username)) {
      return {
        ok: false,
        error: makeConnectorError(
          "selector_error",
          `Could not extract a trustworthy GitHub profile payload for @${username}.`,
          "omitted",
          { scope: "github.profile", phase: "collect" },
        ),
      };
    }
    return { ok: true, data: profile };
  } catch {
    return {
      ok: false,
      error: makeConnectorError(
        "selector_error",
        `Could not read the GitHub profile DOM for @${username}.`,
        "omitted",
        { scope: "github.profile", phase: "collect" },
      ),
    };
  }
};

const extractRepositories = async (username) => {
  if (!isValidGitHubUsername(username)) {
    return {
      ok: false,
      data: [],
      error: makeConnectorError(
        "runtime_error",
        "Could not resolve a valid GitHub username for repositories collection.",
        "omitted",
        { scope: "github.repositories", phase: "collect" },
      ),
    };
  }

  const all = [];
  const seen = new Set();
  const maxPages = 60;
  let unresolvedError = null;

  for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
    if (!(await safeGoto(`https://github.com/${username}?page=${pageIndex}&tab=repositories`))) {
      unresolvedError = makeConnectorError(
        "navigation_error",
        `Could not reach repositories page ${pageIndex} for @${username}.`,
        all.length > 0 ? "degraded" : "omitted",
        { scope: "github.repositories", phase: "collect" },
      );
      break;
    }
    await page.sleep(1000);

    try {
      const pageResult = await page.evaluate(`
        (() => {
          ${TO_INT_HELPER}

          const list = [];
          const rows = document.querySelectorAll('#user-repositories-list li');
          for (const row of rows) {
            const link = row.querySelector('h3 a');
            if (!link) continue;

            const name = (link.textContent || '').replace(/\\s+/g, ' ').trim();
            const description = (row.querySelector('p[itemprop="description"]')?.textContent || '').trim();
            const language = (row.querySelector('[itemprop="programmingLanguage"]')?.textContent || '').trim();
            const starsRaw = (row.querySelector('a[href$="/stargazers"]')?.textContent || '').trim();
            const forksRaw = (row.querySelector('a[href$="/forks"]')?.textContent || '').trim();
            const updatedAt = row.querySelector('relative-time')?.getAttribute('datetime') || null;
            const visibility = (row.querySelector('span.Label')?.textContent || 'Public').trim();
            const topics = Array.from(row.querySelectorAll('a.topic-tag')).map((t) => (t.textContent || '').trim()).filter(Boolean);

            list.push({
              name,
              url: link.href,
              description,
              language,
              stars: toInt(starsRaw),
              forks: toInt(forksRaw),
              visibility,
              topics,
              updatedAt
            });
          }

          const hasNext = !!document.querySelector('a.next_page[rel="next"]');
          return { list, hasNext };
        })()
      `);

      const pageItems = Array.isArray(pageResult?.list) ? pageResult.list : [];
      for (const repo of pageItems) {
        if (!repo?.url || seen.has(repo.url)) continue;
        seen.add(repo.url);
        all.push(repo);
      }

      await page.setData('status', `Fetching repositories... (${all.length} found${pageResult?.hasNext ? ', loading more' : ''})`);

      if (!pageResult?.hasNext || pageItems.length === 0) {
        break;
      }
    } catch {
      unresolvedError = makeConnectorError(
        "selector_error",
        `Could not read repositories page ${pageIndex} for @${username}.`,
        all.length > 0 ? "degraded" : "omitted",
        { scope: "github.repositories", phase: "collect" },
      );
      break;
    }
  }

  return {
    ok: unresolvedError === null || all.length > 0,
    data: all,
    error: unresolvedError,
  };
};

const extractStarred = async (username) => {
  if (!isValidGitHubUsername(username)) {
    return {
      ok: false,
      data: [],
      error: makeConnectorError(
        "runtime_error",
        "Could not resolve a valid GitHub username for starred repositories collection.",
        "omitted",
        { scope: "github.starred", phase: "collect" },
      ),
    };
  }

  const all = [];
  const seen = new Set();
  const maxPages = 60;
  let unresolvedError = null;

  for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
    let pageResult = { list: [], hasNext: false };
    let reachedStarredPage = false;
    const pageUrls = [
      `https://github.com/${username}?page=${pageIndex}&tab=stars`,
      `https://github.com/stars/${username}?page=${pageIndex}`,
    ];

    try {
      for (const pageUrl of pageUrls) {
        if (!(await safeGoto(pageUrl))) {
          continue;
        }
        reachedStarredPage = true;
        await page.sleep(1500);

        const candidate = await page.evaluate(`
          (() => {
            ${TO_INT_HELPER}

            const repoPathFromHref = (href) => {
              try {
                const url = new URL(href, window.location.origin);
                const parts = url.pathname.split('/').filter(Boolean);
                if (parts.length !== 2) return null;
                const blocked = new Set([
                  "features", "topics", "collections", "organizations", "orgs",
                  "users", "marketplace", "settings", "login", "logout",
                  "notifications", "explore", "stars"
                ]);
                if (blocked.has(parts[0].toLowerCase())) return null;
                return { owner: parts[0], repo: parts[1] };
              } catch {
                return null;
              }
            };

            const list = [];
            const rowSelectors = [
              "#user-starred-repos li",
              "#user-profile-frame li",
              "main li"
            ];
            const rows = Array.from(
              new Set(
                rowSelectors.flatMap((selector) =>
                  Array.from(document.querySelectorAll(selector))
                )
              )
            );

            for (const row of rows) {
              const linkCandidates = Array.from(
                row.querySelectorAll("h3 a[href], a[href]")
              );
              let repoInfo = null;
              let repoLink = null;
              for (const link of linkCandidates) {
                const parsed = repoPathFromHref(link.getAttribute("href") || "");
                if (parsed) {
                  repoInfo = parsed;
                  repoLink = link;
                  break;
                }
              }
              if (!repoInfo || !repoLink) continue;

              const fullName =
                (repoLink.textContent || "")
                  .replace(/\\s+/g, " ")
                  .trim() || (repoInfo.owner + "/" + repoInfo.repo);
              const canonicalUrl =
                "https://github.com/" + repoInfo.owner + "/" + repoInfo.repo;
              const description =
                (row.querySelector("p")?.textContent || "").trim();
              const language = (
                row.querySelector('[itemprop="programmingLanguage"], [data-ga-click*="Repository, language"]')
                  ?.textContent || ""
              ).trim();
              const starsRaw = (
                row.querySelector('a[href$="/stargazers"]')?.textContent || ""
              ).trim();
              const updatedAt =
                row.querySelector("relative-time")?.getAttribute("datetime") || null;

              list.push({
                fullName,
                url: canonicalUrl,
                description,
                language,
                stars: toInt(starsRaw),
                updatedAt
              });
            }

            const hasNext = !!document.querySelector(
              'a.next_page[rel="next"], a[rel="next"][href*="page="]'
            );
            return { list, hasNext };
          })()
        `);

        const candidateItems = Array.isArray(candidate?.list)
          ? candidate.list
          : [];
        if (candidateItems.length > 0 || candidate?.hasNext) {
          pageResult = {
            list: candidateItems,
            hasNext: Boolean(candidate?.hasNext),
          };
          break;
        }
      }

      if (!reachedStarredPage) {
        unresolvedError = makeConnectorError(
          "navigation_error",
          `Could not reach a starred repositories page for @${username}.`,
          all.length > 0 ? "degraded" : "omitted",
          { scope: "github.starred", phase: "collect" },
        );
        break;
      }

      const pageItems = Array.isArray(pageResult?.list) ? pageResult.list : [];
      for (const repo of pageItems) {
        if (!repo?.url || seen.has(repo.url)) continue;
        seen.add(repo.url);
        all.push(repo);
      }

      await page.setData('status', `Fetching starred repos... (${all.length} found${pageResult?.hasNext ? ', loading more' : ''})`);

      if (!pageResult?.hasNext || pageItems.length === 0) {
        break;
      }
    } catch {
      unresolvedError = makeConnectorError(
        "selector_error",
        `Could not read starred repositories page ${pageIndex} for @${username}.`,
        all.length > 0 ? "degraded" : "omitted",
        { scope: "github.starred", phase: "collect" },
      );
      break;
    }
  }

  return {
    ok: unresolvedError === null || all.length > 0,
    data: all,
    error: unresolvedError,
  };
};

const EVENT_TYPE_FORMATTERS = {
  PushEvent: (payload) => {
    const commits = Array.isArray(payload?.commits) ? payload.commits : [];
    const first = commits[0];
    const ref = typeof payload?.ref === "string" ? payload.ref : "";
    const branch = ref.replace(/^refs\/heads\//, "") || null;
    return {
      action: "pushed",
      title:
        first && typeof first.message === "string"
          ? first.message.split("\n")[0]
          : null,
      branch,
      commits: commits.length || (typeof payload?.size === "number" ? payload.size : null),
    };
  },
  PullRequestEvent: (payload) => {
    const pr = payload?.pull_request || {};
    const num = typeof pr.number === "number" ? pr.number : null;
    const branch = pr.head && typeof pr.head.ref === "string" ? pr.head.ref : null;
    const titleFallback = num != null ? `PR #${num}${branch ? ` (${branch})` : ""}` : null;
    return {
      action: typeof payload?.action === "string" ? payload.action : null,
      title: typeof pr.title === "string" && pr.title ? pr.title : titleFallback,
      body: typeof pr.body === "string" ? pr.body.slice(0, 280) : null,
      url:
        typeof pr.html_url === "string"
          ? pr.html_url
          : typeof pr.url === "string"
            ? pr.url.replace("api.github.com/repos", "github.com")
            : null,
      branch,
    };
  },
  PullRequestReviewEvent: (payload) => {
    const pr = payload?.pull_request || {};
    const review = payload?.review || {};
    return {
      action: typeof review.state === "string" ? review.state.toLowerCase() : null,
      title: typeof pr.title === "string" ? pr.title : null,
      body: typeof review.body === "string" ? review.body.slice(0, 280) : null,
      url: typeof review.html_url === "string" ? review.html_url : null,
    };
  },
  PullRequestReviewCommentEvent: (payload) => {
    const c = payload?.comment || {};
    return {
      action: "review_comment",
      body: typeof c.body === "string" ? c.body.slice(0, 280) : null,
      url: typeof c.html_url === "string" ? c.html_url : null,
    };
  },
  IssuesEvent: (payload) => {
    const issue = payload?.issue || {};
    const num = typeof issue.number === "number" ? issue.number : null;
    return {
      action: typeof payload?.action === "string" ? payload.action : null,
      title:
        typeof issue.title === "string" && issue.title
          ? issue.title
          : num != null
            ? `Issue #${num}`
            : null,
      body: typeof issue.body === "string" ? issue.body.slice(0, 280) : null,
      url: typeof issue.html_url === "string" ? issue.html_url : null,
    };
  },
  IssueCommentEvent: (payload) => {
    const c = payload?.comment || {};
    const issue = payload?.issue || {};
    return {
      action: "commented",
      title: typeof issue.title === "string" ? issue.title : null,
      body: typeof c.body === "string" ? c.body.slice(0, 280) : null,
      url: typeof c.html_url === "string" ? c.html_url : null,
    };
  },
  CreateEvent: (payload) => ({
    action: typeof payload?.ref_type === "string" ? `created_${payload.ref_type}` : "created",
    title: typeof payload?.ref === "string" ? payload.ref : null,
    body: typeof payload?.description === "string" ? payload.description : null,
    branch: payload?.ref_type === "branch" && typeof payload?.ref === "string" ? payload.ref : null,
  }),
  DeleteEvent: (payload) => ({
    action: typeof payload?.ref_type === "string" ? `deleted_${payload.ref_type}` : "deleted",
    title: typeof payload?.ref === "string" ? payload.ref : null,
    branch: payload?.ref_type === "branch" && typeof payload?.ref === "string" ? payload.ref : null,
  }),
  ForkEvent: (payload) => {
    const forkee = payload?.forkee || {};
    return {
      action: "forked",
      title: typeof forkee.full_name === "string" ? forkee.full_name : null,
      url: typeof forkee.html_url === "string" ? forkee.html_url : null,
    };
  },
  WatchEvent: (payload) => ({
    action: typeof payload?.action === "string" ? payload.action : "starred",
  }),
  ReleaseEvent: (payload) => {
    const r = payload?.release || {};
    return {
      action: typeof payload?.action === "string" ? payload.action : null,
      title: typeof r.name === "string" ? r.name : typeof r.tag_name === "string" ? r.tag_name : null,
      body: typeof r.body === "string" ? r.body.slice(0, 280) : null,
      url: typeof r.html_url === "string" ? r.html_url : null,
    };
  },
  GollumEvent: (payload) => {
    const pages = Array.isArray(payload?.pages) ? payload.pages : [];
    return {
      action: "wiki_edit",
      title: pages[0] && typeof pages[0].title === "string" ? pages[0].title : null,
      body: pages.length > 1 ? `${pages.length} pages edited` : null,
      url: pages[0] && typeof pages[0].html_url === "string" ? pages[0].html_url : null,
    };
  },
  CommitCommentEvent: (payload) => {
    const c = payload?.comment || {};
    return {
      action: "commit_comment",
      body: typeof c.body === "string" ? c.body.slice(0, 280) : null,
      url: typeof c.html_url === "string" ? c.html_url : null,
    };
  },
};

const normalizeEvent = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  const type = typeof raw.type === "string" ? raw.type : null;
  const id = typeof raw.id === "string" ? raw.id : null;
  const createdAt = typeof raw.created_at === "string" ? raw.created_at : null;
  const repoName = raw.repo && typeof raw.repo.name === "string" ? raw.repo.name : null;
  if (!type || !id || !createdAt || !repoName) return null;

  const formatter = EVENT_TYPE_FORMATTERS[type];
  const extras = formatter ? formatter(raw.payload || {}) : {};

  return {
    id,
    type,
    createdAt,
    repo: repoName,
    repoUrl: `https://github.com/${repoName}`,
    action: extras.action ?? null,
    title: extras.title ?? null,
    body: extras.body ?? null,
    url: extras.url ?? null,
    branch: extras.branch ?? null,
    commits: typeof extras.commits === "number" ? extras.commits : null,
    isPublic: raw.public !== false,
  };
};

const extractEvents = async (username) => {
  if (!isValidGitHubUsername(username)) {
    return {
      ok: false,
      data: [],
      error: makeConnectorError(
        "runtime_error",
        "Could not resolve a valid GitHub username for events collection.",
        "omitted",
        { scope: "github.events", phase: "collect" },
      ),
    };
  }

  // GitHub's events API: up to 300 events from the past 90 days, anonymous
  // access permitted (60 req/hr). Three pages × 100 events = full window.
  const all = [];
  let unresolvedError = null;
  for (let pageIndex = 1; pageIndex <= 3; pageIndex++) {
    try {
      const pageResult = await page.evaluate(`
        (async () => {
          try {
            const res = await fetch('https://api.github.com/users/${username}/events/public?per_page=100&page=${pageIndex}', {
              headers: { 'accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
            });
            if (!res.ok) return { ok: false, status: res.status, body: await res.text() };
            const data = await res.json();
            return { ok: true, items: Array.isArray(data) ? data : [] };
          } catch (err) {
            return { ok: false, status: 0, body: String(err && err.message || err) };
          }
        })()
      `);

      if (!pageResult || !pageResult.ok) {
        unresolvedError = makeConnectorError(
          pageResult?.status === 0 ? "network_error" : "runtime_error",
          `GitHub events API page ${pageIndex} returned status ${pageResult?.status ?? "unknown"}.`,
          all.length > 0 ? "degraded" : "omitted",
          { scope: "github.events", phase: "collect" },
        );
        break;
      }

      const items = pageResult.items;
      for (const raw of items) {
        const normalized = normalizeEvent(raw);
        if (normalized) all.push(normalized);
      }

      await page.setData(
        "status",
        `Fetching activity... (${all.length} events${items.length === 100 ? ", loading more" : ""})`,
      );

      if (items.length < 100) break;
    } catch {
      unresolvedError = makeConnectorError(
        "runtime_error",
        `Could not read events page ${pageIndex} for @${username}.`,
        all.length > 0 ? "degraded" : "omitted",
        { scope: "github.events", phase: "collect" },
      );
      break;
    }
  }

  return {
    ok: unresolvedError === null || all.length > 0,
    data: all,
    error: unresolvedError,
  };
};

// Full-lifetime authored PRs + Issues via Search API (anonymous, 1000-result
// cap per type — far more than the 90-day Events window and covers any repo
// the user has authored in, including org-owned and forks).
const normalizeSearchItem = (raw, type) => {
  if (!raw || typeof raw !== "object") return null;
  const repoUrl = typeof raw.repository_url === "string" ? raw.repository_url : "";
  const repo = repoUrl.replace("https://api.github.com/repos/", "");
  const pr = raw.pull_request || null;
  return {
    id: typeof raw.id === "number" ? `gh-${type}-${raw.id}` : `gh-${type}-${raw.number}`,
    type,
    number: typeof raw.number === "number" ? raw.number : null,
    title: typeof raw.title === "string" ? raw.title : null,
    body: typeof raw.body === "string" ? raw.body.slice(0, 500) : null,
    state: typeof raw.state === "string" ? raw.state : null,
    createdAt: typeof raw.created_at === "string" ? raw.created_at : null,
    updatedAt: typeof raw.updated_at === "string" ? raw.updated_at : null,
    closedAt: typeof raw.closed_at === "string" ? raw.closed_at : null,
    mergedAt: pr && typeof pr.merged_at === "string" ? pr.merged_at : null,
    url: typeof raw.html_url === "string" ? raw.html_url : null,
    repo,
    repoUrl: repo ? `https://github.com/${repo}` : null,
    labels: Array.isArray(raw.labels)
      ? raw.labels.map((l) => (l && typeof l.name === "string" ? l.name : null)).filter(Boolean)
      : [],
    comments: typeof raw.comments === "number" ? raw.comments : 0,
    reactionsTotal:
      raw.reactions && typeof raw.reactions.total_count === "number" ? raw.reactions.total_count : 0,
    isDraft: pr && pr.merged_at == null && raw.state === "open" && raw.draft === true ? true : false,
  };
};

const fetchSearchPaged = async (username, type) => {
  // GitHub caps Search API at 1000 results per query — 10 pages × 100.
  const items = [];
  const MAX_PAGES = 10;
  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
    const q = `author:${username}+type:${type}`;
    const url = `https://api.github.com/search/issues?q=${q}&sort=created&order=desc&per_page=100&page=${pageNum}`;
    const result = await page.evaluate(`
      (async () => {
        try {
          const res = await fetch('${url}', {
            headers: { 'accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
          });
          if (!res.ok) return { ok: false, status: res.status, body: (await res.text()).slice(0, 200) };
          const j = await res.json();
          return { ok: true, items: Array.isArray(j.items) ? j.items : [], total: j.total_count || 0 };
        } catch (err) {
          return { ok: false, status: 0, body: String(err && err.message || err) };
        }
      })()
    `);

    if (!result || !result.ok) {
      return {
        items,
        error: makeConnectorError(
          result?.status === 0 ? "network_error" : "runtime_error",
          `GitHub Search API (${type}) page ${pageNum} returned ${result?.status ?? "unknown"}: ${result?.body ?? ""}`,
          items.length > 0 ? "degraded" : "omitted",
          { scope: "github.history", phase: "collect" },
        ),
      };
    }

    for (const raw of result.items) {
      const n = normalizeSearchItem(raw, type);
      if (n) items.push(n);
    }

    await page.setData(
      "status",
      `Fetching ${type} history... (${items.length} found${result.items.length === 100 ? ", loading more" : ""})`,
    );

    // Search API anonymous rate limit: 10 req/min. Pause between pages to stay under.
    if (result.items.length < 100) break;
    if (pageNum < MAX_PAGES) await page.sleep(6500);
  }

  return { items, error: null };
};

const extractHistory = async (username) => {
  if (!isValidGitHubUsername(username)) {
    return {
      ok: false,
      data: null,
      error: makeConnectorError(
        "runtime_error",
        "Could not resolve a valid GitHub username for history collection.",
        "omitted",
        { scope: "github.history", phase: "collect" },
      ),
    };
  }

  const errors = [];

  const prResult = await fetchSearchPaged(username, "pr");
  if (prResult.error) errors.push(prResult.error);

  const issuesResult = await fetchSearchPaged(username, "issue");
  if (issuesResult.error) errors.push(issuesResult.error);

  return {
    ok: prResult.items.length > 0 || issuesResult.items.length > 0 || errors.length === 0,
    data: {
      pullRequests: prResult.items,
      issues: issuesResult.items,
      fetchedAt: new Date().toISOString(),
      windowDescription: "Full lifetime authored PRs and Issues from /search/issues, up to 1000 per type.",
    },
    error: errors.length > 0 ? errors[0] : null,
    extraErrors: errors.slice(1),
  };
};

const CONTRIB_YEARS_BACK = 4; // current year + 3 prior

const scrapeContributionGraphForYear = async (username, year) => {
  // Profile-page contribution graph filtered to a specific calendar year.
  // The ?from/to query params drive the heatmap; current year defaults to
  // the rolling 12-month window so we only pass them when going back.
  const isCurrentYear = year === new Date().getFullYear();
  const url = isCurrentYear
    ? `https://github.com/${username}`
    : `https://github.com/${username}?from=${year}-01-01&to=${year}-12-31`;

  if (!(await safeGoto(url))) {
    return { ok: false, error: `navigation failed for ${year}` };
  }
  await page.sleep(1500);

  try {
    const graph = await page.evaluate(`
      (() => {
        ${TO_INT_HELPER}
        const cells = Array.from(document.querySelectorAll('td.ContributionCalendar-day[data-date], rect.day[data-date]'));
        const days = cells.map((cell) => {
          const date = cell.getAttribute('data-date');
          const level = cell.getAttribute('data-level');
          const dataCount = cell.getAttribute('data-count');
          let count = 0;
          if (dataCount != null) {
            count = toInt(dataCount);
          } else {
            const id = cell.getAttribute('id');
            const tip = id ? document.querySelector(\`tool-tip[for="\${id}"]\`) : null;
            const text = tip?.textContent || cell.getAttribute('aria-label') || '';
            const m = text.match(/(\\d+|No)\\s+contribution/i);
            if (m) count = /no/i.test(m[1]) ? 0 : toInt(m[1]);
          }
          return { date, count, level: level != null ? Number(level) : null };
        }).filter((d) => d.date);

        // Year header: "N contributions in YYYY" (or "in the last year" for current view)
        const heading = document.querySelector('h2.f4.text-normal.mb-2');
        const headingText = (heading?.textContent || '').trim();
        const totalMatch = headingText.match(/([\\d,]+)\\s+contribution/i);
        const total = totalMatch ? toInt(totalMatch[1]) : days.reduce((a, d) => a + d.count, 0);

        return { days, total, headingText };
      })()
    `);
    if (!graph || !Array.isArray(graph.days) || graph.days.length === 0) {
      return { ok: false, error: `selector miss for ${year}` };
    }
    return { ok: true, ...graph };
  } catch (err) {
    return { ok: false, error: `evaluate failed for ${year}: ${String(err)}` };
  }
};

const extractContributions = async (username) => {
  if (!isValidGitHubUsername(username)) {
    return {
      ok: false,
      data: null,
      error: makeConnectorError(
        "runtime_error",
        "Could not resolve a valid GitHub username for contributions collection.",
        "omitted",
        { scope: "github.contributions", phase: "collect" },
      ),
    };
  }

  // Loop years backward — the default profile view is a 12-month rolling window,
  // so to get N full calendar years we navigate ?from=YYYY-01-01&to=YYYY-12-31 per year.
  const currentYear = new Date().getFullYear();
  const yearTotals = []; // [{ year, total }]
  const allDays = new Map(); // date string -> { count, level }
  let lastErr = null;

  for (let offset = 0; offset < CONTRIB_YEARS_BACK; offset++) {
    const year = currentYear - offset;
    await page.setData("status", `Fetching contribution graph for ${year}...`);
    const r = await scrapeContributionGraphForYear(username, year);
    if (!r.ok) {
      lastErr = r.error;
      // First-year miss is fatal; later-year misses are tolerable
      if (offset === 0) {
        return {
          ok: false,
          data: null,
          error: makeConnectorError(
            "selector_error",
            `Could not read contribution graph for @${username}: ${r.error}`,
            "omitted",
            { scope: "github.contributions", phase: "collect" },
          ),
        };
      }
      continue;
    }
    yearTotals.push({ year, total: r.total });
    for (const d of r.days) {
      // De-dupe across overlapping windows (the current-year rolling view may
      // include a few days of last year; keep the earliest scrape's value).
      if (!allDays.has(d.date)) allDays.set(d.date, { count: d.count, level: d.level });
    }
  }

  const days = [...allDays.entries()]
    .map(([date, { count, level }]) => ({ date, count, level }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  // Roll up monthly totals across the full multi-year span
  const monthly = {};
  for (const d of days) {
    const m = d.date.slice(0, 7);
    monthly[m] = (monthly[m] || 0) + d.count;
  }
  const monthlyTotals = Object.entries(monthly)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([month, count]) => ({ month, count }));

  const topDay = days.reduce((best, d) => (best == null || d.count > best.count ? d : best), null);
  const totalContributionsLastYear =
    yearTotals.find((y) => y.year === currentYear)?.total ?? days.reduce((a, d) => a + d.count, 0);

  try {
    return {
      ok: true,
      data: {
        totalContributionsLastYear,
        yearTotals,
        days,
        monthlyTotals,
        topDay: topDay && topDay.count > 0 ? { date: topDay.date, count: topDay.count } : null,
        fetchedAt: new Date().toISOString(),
      },
      error: lastErr ? makeConnectorError("partial", `Some year scrapes failed: ${lastErr}`, "degraded", { scope: "github.contributions" }) : null,
    };
  } catch {
    return {
      ok: false,
      data: null,
      error: makeConnectorError(
        "selector_error",
        `Could not parse contribution graph DOM for @${username}.`,
        "omitted",
        { scope: "github.contributions", phase: "collect" },
      ),
    };
  }
};

// ── Main Flow ────────────────────────────────────────────────────────
(async () => {
  let requestedScopes = [...CANONICAL_SCOPES];
  let initError = null;
  try {
    requestedScopes = resolveRequestedScopes();
  } catch (error) {
    initError = error;
  }

  try {
    if (initError) {
      throw initError;
    }
    const wantsScope = (scope) => requestedScopes.includes(scope);
    const errors = [];
    const scopes = {};

    await page.setData("status", "Checking GitHub login...");
    if (!(await safeGoto("https://github.com/"))) {
      throw makeFatalRunError(
        "navigation_error",
        "Could not reach GitHub after multiple attempts.",
      );
    }
    await page.sleep(1500);

    let loggedIn = await checkLoginStatus();

    if (!loggedIn) {
      if (!(await safeGoto("https://github.com/login"))) {
        throw makeFatalRunError(
          "navigation_error",
          "Could not reach the GitHub login page after multiple attempts.",
          "auth",
        );
      }
      await page.sleep(2000);

      if (typeof page.requestInput === "function") {
        let attempts = 0;
        const maxAttempts = 3;
        let lastError = null;
        let credentials = null;

        while (!loggedIn && attempts < maxAttempts) {
          attempts++;

          const hasLoginForm = await page.evaluate(`
            !!document.querySelector('#login_field') && !!document.querySelector('#password')
          `);

          if (!hasLoginForm) {
            lastError = "Login form not found. Retrying...";
            await safeGoto("https://github.com/login");
            await page.sleep(2000);
            continue;
          }

          if (!credentials || lastError) {
            credentials = await page.requestInput({
              message: lastError
                ? `Log in to GitHub — ${lastError}`
                : "Log in to GitHub",
              schema: {
                type: "object",
                required: ["username", "password"],
                properties: {
                  username: {
                    type: "string",
                    description: "GitHub username or email",
                  },
                  password: { type: "string", format: "password" },
                },
              },
            });
          }

          await page.setData("status", "Signing in...");

          try {
            await page.fill("#login_field", credentials.username);
            await page.sleep(300);
            await page.fill("#password", credentials.password);
            await page.sleep(300);
            await page.press("#password", "Enter");
          } catch {
            lastError = "Login form error. Retrying...";
            continue;
          }

          await page.sleep(5000);

          const currentUrl = await page.url();
          const onPasskeyPage = currentUrl.includes("/sessions/two-factor/webauthn");
          const onDeviceVerify = currentUrl.includes("/sessions/verified-device");

          if (onPasskeyPage) {
            await page.setData("status", "Navigating to authenticator app...");
            try {
              await page.click('a[href*="/sessions/two-factor/app"]', {
                timeout: 5000,
              });
              await page.sleep(2000);
            } catch {
              await safeGoto("https://github.com/sessions/two-factor/app");
              await page.sleep(2000);
            }
          }

          const urlAfterNav = await page.url();
          const needs2fa = urlAfterNav.includes("/sessions/two-factor");
          const needsDeviceVerify =
            onDeviceVerify || urlAfterNav.includes("/sessions/verified-device");

          if (needsDeviceVerify) {
            await page.setData(
              "status",
              "Device verification required — check your email",
            );
            const deviceResult = await page.requestInput({
              message:
                "GitHub sent a 6-digit verification code to your email. Enter it below.",
              schema: {
                type: "object",
                required: ["code"],
                properties: {
                  code: {
                    type: "string",
                    description: "Verification code from email",
                    minLength: 6,
                    maxLength: 6,
                  },
                },
              },
            });

            const deviceSelector =
              'input[placeholder="XXXXXX"], input[type="text"]';
            try {
              await page.fill(deviceSelector, deviceResult.code);
              await page.sleep(500);
              await page.click('button:has-text("Verify"), button[type="submit"]', {
                timeout: 5000,
              });
            } catch {
              await page.press(deviceSelector, "Enter");
            }
            await page.sleep(5000);
          } else if (needs2fa) {
            await page.setData("status", "Two-factor authentication required");
            const otpResult = await page.requestInput({
              message: "Enter the 6-digit code from your authenticator app",
              schema: {
                type: "object",
                required: ["code"],
                properties: {
                  code: {
                    type: "string",
                    description: "6-digit authenticator code",
                    minLength: 6,
                    maxLength: 8,
                  },
                },
              },
            });

            const otpSelector =
              '#app_totp, #sms_totp, [name="otp"], input[type="text"]';
            try {
              await page.fill(otpSelector, otpResult.code);
              await page.sleep(500);
              await page.click('button:has-text("Verify"), button[type="submit"]', {
                timeout: 5000,
              });
            } catch {
              await page.press(otpSelector, "Enter");
            }
            await page.sleep(5000);
          }

          const errorMsg = await page.evaluate(`
            (() => {
              const flash = document.querySelector('.flash-error, .js-flash-alert');
              if (!flash || flash.hidden || flash.offsetParent === null) return null;
              return flash.textContent.trim() || null;
            })()
          `);

          if (errorMsg) {
            lastError = `Login failed: ${errorMsg}`;
            await safeGoto("https://github.com/login");
            await page.sleep(2000);
            continue;
          }

          loggedIn = await checkLoginStatus();
          if (!loggedIn) {
            lastError = "Login failed. Please check your credentials.";
          }
        }
      }

      if (!loggedIn) {
        const { headed } = await page.showBrowser("https://github.com/login");
        if (headed) {
          await page.setData(
            "status",
            "Please sign in manually in the browser below.",
          );
          await page.promptUser(
            "Automatic sign-in failed. Please sign in to GitHub manually, including any 2FA. The process will continue automatically once you are signed in.",
            async () => await checkLoginStatus(),
            5000,
          );
          await page.goHeadless();
          loggedIn = await checkLoginStatus();
        } else {
          throw makeFatalRunError(
            "auth_failed",
            "GitHub login requires a headed browser or requestInput support.",
            "auth",
          );
        }
      }
    }

    if (!loggedIn) {
      throw makeFatalRunError(
        "auth_failed",
        "GitHub login could not be confirmed.",
        "auth",
      );
    }

    await page.setData("status", "Login confirmed. Resolving account...");

    const username = await resolveUsername();
    if (!isValidGitHubUsername(username)) {
      throw makeFatalRunError(
        "runtime_error",
        "Could not resolve a valid GitHub username after login.",
      );
    }
    state.username = username;

    if (wantsScope("github.profile")) {
      await page.setData("status", `Fetching profile for @${username}...`);
      const profileResult = await extractProfile(username);
      if (profileResult.ok) {
        state.profile = profileResult.data;
        scopes["github.profile"] = state.profile;
      } else if (profileResult.error) {
        errors.push(profileResult.error);
      }
    }

    if (wantsScope("github.repositories")) {
      await page.setData("status", "Fetching repositories...");
      const repositoriesResult = await extractRepositories(username);
      state.repositories = repositoriesResult.data;
      if (repositoriesResult.ok) {
        scopes["github.repositories"] = {
          repositories: state.repositories,
        };
      }
      if (repositoriesResult.error) {
        errors.push(repositoriesResult.error);
      }
    }

    if (state.profile) {
      state.profile.repositoryCount = state.repositories.length;
    }

    if (wantsScope("github.starred")) {
      await page.setData("status", "Fetching starred repositories...");
      const starredResult = await extractStarred(username);
      state.starred = starredResult.data;
      if (starredResult.ok) {
        scopes["github.starred"] = {
          starred: state.starred,
        };
      }
      if (starredResult.error) {
        errors.push(starredResult.error);
      }
    }

    if (wantsScope("github.events")) {
      await page.setData("status", "Fetching activity...");
      const eventsResult = await extractEvents(username);
      state.events = eventsResult.data;
      if (eventsResult.ok) {
        scopes["github.events"] = {
          events: state.events,
          fetchedAt: new Date().toISOString(),
          windowDescription:
            "Up to 300 most recent public events across all repositories (≈90 days, GitHub API limit)",
        };
      }
      if (eventsResult.error) {
        errors.push(eventsResult.error);
      }
    }

    if (wantsScope("github.contributions")) {
      await page.setData("status", "Fetching contribution graph...");
      const contribResult = await extractContributions(username);
      state.contributions = contribResult.data;
      if (contribResult.ok && state.contributions) {
        scopes["github.contributions"] = state.contributions;
      }
      if (contribResult.error) {
        errors.push(contribResult.error);
      }
    }

    if (wantsScope("github.history")) {
      await page.setData("status", "Fetching authored PR + issue history...");
      const historyResult = await extractHistory(username);
      state.history = historyResult.data;
      if (historyResult.ok && state.history) {
        scopes["github.history"] = state.history;
      }
      if (historyResult.error) {
        errors.push(historyResult.error);
      }
      if (Array.isArray(historyResult.extraErrors)) {
        errors.push(...historyResult.extraErrors);
      }
    }

    const totalItems =
      state.repositories.length + state.starred.length + state.events.length;
    const result = buildResult({
      requestedScopes,
      scopes,
      errors,
      exportSummary: {
        count: totalItems,
        label: totalItems === 1 ? "item" : "items",
        details: formatExportSummaryDetails(
          state.repositories.length,
          state.starred.length,
          state.events.length,
          state.contributions?.totalContributionsLastYear ?? 0,
        ),
      },
    });

    state.isComplete = true;
    await page.setData("result", result);
    await page.setData(
      "status",
      `Complete! ${state.repositories.length} repos, ${state.starred.length} starred, ${state.events.length} events collected.`,
    );

    return result;
  } catch (error) {
    const telemetryError =
      error?.telemetryError ||
      makeConnectorError(
        inferErrorClass(error?.message || String(error)),
        error?.message || String(error),
        "fatal",
        { phase: "collect" },
      );
    const result = buildEmptyResult(requestedScopes, [telemetryError]);
    await page.setData("result", result);
    await page.setData("error", telemetryError.reason);
    return result;
  }
})();

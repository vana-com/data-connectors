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
  isComplete: false,
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

const checkLoggedIn = async () => {
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
  if (!isValidGitHubUsername(username)) return null;

  if (!(await safeGoto(`https://github.com/${username}`))) return null;
  await page.sleep(1500);

  try {
    return await page.evaluate(`
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
          profileUrl: window.location.href
        };
      })()
    `);
  } catch {
    return null;
  }
};

const extractRepositories = async (username) => {
  if (!isValidGitHubUsername(username)) return [];

  const all = [];
  const seen = new Set();
  const maxPages = 60;

  for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
    if (!(await safeGoto(`https://github.com/${username}?page=${pageIndex}&tab=repositories`))) break;
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
      break;
    }
  }

  return all;
};

const extractStarred = async (username) => {
  if (!isValidGitHubUsername(username)) return [];

  const all = [];
  const seen = new Set();
  const maxPages = 60;

  for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
    let pageResult = { list: [], hasNext: false };
    const pageUrls = [
      `https://github.com/${username}?page=${pageIndex}&tab=stars`,
      `https://github.com/stars/${username}?page=${pageIndex}`,
    ];

    try {
      for (const pageUrl of pageUrls) {
        if (!(await safeGoto(pageUrl))) continue;
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
      break;
    }
  }

  return all;
};

// ── Main Flow ────────────────────────────────────────────────────────

await page.setData('status', 'Checking GitHub login...');
if (!(await safeGoto('https://github.com/'))) {
  return { success: false, error: 'Could not reach GitHub after multiple attempts.' };
}
await page.sleep(1500);

let loggedIn = await checkLoggedIn();

if (!loggedIn) {
  if (!(await safeGoto('https://github.com/login'))) {
    return { success: false, error: 'Could not reach GitHub login page after multiple attempts.' };
  }
  await page.sleep(2000);

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
      lastError = 'Login form not found. Retrying...';
      await safeGoto('https://github.com/login');
      await page.sleep(2000);
      continue;
    }

    if (!credentials || lastError) {
      credentials = await page.requestInput({
        message: lastError
          ? `Log in to GitHub — ${lastError}`
          : 'Log in to GitHub',
        schema: {
          type: 'object',
          required: ['username', 'password'],
          properties: {
            username: { type: 'string', description: 'GitHub username or email' },
            password: { type: 'string', format: 'password' },
          },
        },
      });
    }

    await page.setData('status', 'Signing in...');

    try {
      await page.fill('#login_field', credentials.username);
      await page.sleep(300);
      await page.fill('#password', credentials.password);
      await page.sleep(300);
      await page.press('#password', 'Enter');
    } catch (e) {
      lastError = 'Login form error. Retrying...';
      continue;
    }

    await page.sleep(5000);

    // Handle 2FA — GitHub may show a passkey/webauthn page first, or go
    // directly to the authenticator app page. Not all accounts have 2FA.
    // Some accounts get a "device verification" email code instead.
    const currentUrl = await page.url();
    const onPasskeyPage = currentUrl.includes('/sessions/two-factor/webauthn');
    const onDeviceVerify = currentUrl.includes('/sessions/verified-device');

    if (onPasskeyPage) {
      // Click "Authenticator app" link to skip passkeys
      await page.setData('status', 'Navigating to authenticator app...');
      try {
        await page.click('a[href*="/sessions/two-factor/app"]', { timeout: 5000 });
        await page.sleep(2000);
      } catch (e) {
        // Fallback: navigate directly
        await safeGoto('https://github.com/sessions/two-factor/app');
        await page.sleep(2000);
      }
    }

    // Check if we're now on any 2FA or device verification page
    const urlAfterNav = await page.url();
    const needs2fa = urlAfterNav.includes('/sessions/two-factor');
    const needsDeviceVerify = onDeviceVerify || urlAfterNav.includes('/sessions/verified-device');

    if (needsDeviceVerify) {
      await page.setData('status', 'Device verification required — check your email');
      const deviceResult = await page.requestInput({
        message: 'GitHub sent a 6-digit verification code to your email. Enter it below.',
        schema: {
          type: 'object',
          required: ['code'],
          properties: {
            code: { type: 'string', description: 'Verification code from email', minLength: 6, maxLength: 6 },
          },
        },
      });

      const deviceSelector = 'input[placeholder="XXXXXX"], input[type="text"]';
      try {
        await page.fill(deviceSelector, deviceResult.code);
        await page.sleep(500);
        await page.click('button:has-text("Verify"), button[type="submit"]', { timeout: 5000 });
      } catch (e) {
        await page.press(deviceSelector, 'Enter');
      }
      await page.sleep(5000);
    } else if (needs2fa) {
      await page.setData('status', 'Two-factor authentication required');
      const otpResult = await page.requestInput({
        message: 'Enter the 6-digit code from your authenticator app',
        schema: {
          type: 'object',
          required: ['code'],
          properties: {
            code: { type: 'string', description: '6-digit authenticator code', minLength: 6, maxLength: 8 },
          },
        },
      });

      const otpSelector = '#app_totp, #sms_totp, [name="otp"], input[type="text"]';
      try {
        await page.fill(otpSelector, otpResult.code);
        await page.sleep(500);
        await page.click('button:has-text("Verify"), button[type="submit"]', { timeout: 5000 });
      } catch (e) {
        await page.press(otpSelector, 'Enter');
      }
      await page.sleep(5000);
    }

    // Check for login errors — only match visible flash elements.
    // GitHub's base template includes a hidden #ajax-error-message with
    // class flash-error and non-empty text on every page. Matching hidden
    // elements causes false positives on the authenticated dashboard.
    const errorMsg = await page.evaluate(`
      (() => {
        const flash = document.querySelector('.flash-error, .js-flash-alert');
        if (!flash || flash.hidden || flash.offsetParent === null) return null;
        return flash.textContent.trim() || null;
      })()
    `);

    if (errorMsg) {
      lastError = `Login failed: ${errorMsg}`;
      await safeGoto('https://github.com/login');
      await page.sleep(2000);
      continue;
    }

    loggedIn = await checkLoggedIn();
    if (!loggedIn) {
      lastError = 'Login failed. Please check your credentials.';
    }
  }

  // Fallback: manual login via browser takeover — only if the runtime
  // can surface a headed browser to the user.
  if (!loggedIn) {
    let canShowHeaded = false;
    if (typeof page.showBrowser === 'function') {
      try {
        const result = await page.showBrowser('https://github.com/login');
        canShowHeaded = !!(result && result.headed);
      } catch {
        canShowHeaded = false;
      }
    }

    if (canShowHeaded) {
      await page.setData('status', 'Please sign in manually in the browser below.');
      await page.promptUser(
        'Automatic sign-in failed. Please sign in to GitHub manually, including any 2FA. The process will continue automatically once you are signed in.',
        async () => await checkLoggedIn(),
        5000
      );
      loggedIn = await checkLoggedIn();
    } else {
      return {
        success: false,
        error: 'Automatic GitHub sign-in failed. ' +
          (lastError || 'Please check your credentials and try again.'),
      };
    }
  }
}

if (!loggedIn) {
  return { success: false, error: 'GitHub login could not be confirmed.' };
}

await page.setData('status', 'Login confirmed. Resolving account...');

const username = await resolveUsername();
if (!isValidGitHubUsername(username)) {
  return { success: false, error: 'Could not resolve a valid GitHub username after login.' };
}
state.username = username;

await page.setData('status', `Fetching profile for @${username}...`);
state.profile = await extractProfile(username);

await page.setData('status', 'Fetching repositories...');
state.repositories = await extractRepositories(username);
if (state.profile) {
  state.profile.repositoryCount = state.repositories.length;
}

await page.setData('status', 'Fetching starred repositories...');
state.starred = await extractStarred(username);

const totalItems = state.repositories.length + state.starred.length;
const result = {
  'github.profile': state.profile,
  'github.repositories': { repositories: state.repositories },
  'github.starred': { starred: state.starred },
  exportSummary: {
    count: totalItems,
    label: totalItems === 1 ? 'item' : 'items',
    details: `${state.repositories.length} repositories, ${state.starred.length} starred`,
  },
  timestamp: new Date().toISOString(),
  version: '1.1.3',
  platform: 'github',
};

state.isComplete = true;
await page.setData('result', result);
await page.setData('status',
  `Complete! ${state.repositories.length} repositories and ${state.starred.length} starred repos collected.`
);

return { success: true, data: result };

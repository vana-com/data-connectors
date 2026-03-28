/**
 * GitHub Connector (Playwright)
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

const isLoggedIn = async () => {
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

  await page.goto("https://github.com/settings/profile");
  await page.sleep(1500);

  const fromSettings = await readLoggedInUsername();
  return isValidGitHubUsername(fromSettings) ? fromSettings : null;
};

const extractProfile = async (username) => {
  if (!isValidGitHubUsername(username)) return null;

  await page.goto(`https://github.com/${username}`);
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
    await page.goto(`https://github.com/${username}?page=${pageIndex}&tab=repositories`);
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

      await page.setProgress({
        phase: { step: 2, total: 3, label: "Repositories" },
        message: `Fetched ${all.length} repositories${pageResult?.hasNext ? "..." : ""}`,
        count: all.length,
      });

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
        await page.goto(pageUrl);
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
                  "features",
                  "topics",
                  "collections",
                  "organizations",
                  "orgs",
                  "users",
                  "marketplace",
                  "settings",
                  "login",
                  "logout",
                  "notifications",
                  "explore",
                  "stars"
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

      await page.setProgress({
        phase: { step: 3, total: 3, label: "Starred" },
        message: `Fetched ${all.length} starred repositories${pageResult?.hasNext ? "..." : ""}`,
        count: all.length,
      });

      if (!pageResult?.hasNext || pageItems.length === 0) {
        break;
      }
    } catch {
      break;
    }
  }

  return all;
};

(async () => {
  await page.setData("status", "Checking GitHub login...");
  await page.goto("https://github.com/");
  await page.sleep(1500);

  let loggedIn = await isLoggedIn();

  if (!loggedIn) {
    await page.goto("https://github.com/login");
    await page.sleep(2000);

    // Only attempt programmatic login if the form is present
    const hasLoginForm = await page.evaluate(`
      !!document.querySelector('#login_field') && !!document.querySelector('#password')
    `);

    if (hasLoginForm) {
      const credResult = await page.requestData({
        message: "Log in to GitHub",
        schema: {
          type: "object",
          properties: {
            username: { type: "string", description: "GitHub username or email" },
            password: { type: "string", format: "password" },
          },
          required: ["username", "password"],
        },
      });
      if (credResult.status === 'skipped') {
        await page.setData('error', 'Login credentials required but not available in automated mode.');
        return;
      }
      const { username: loginUser, password } = credResult.data;

      await page.evaluate(`document.querySelector('#login_field').value = ${JSON.stringify(loginUser)}`);
      await page.evaluate(`document.querySelector('#login_field').dispatchEvent(new Event('input', {bubbles:true}))`);
      await page.evaluate(`document.querySelector('#password').value = ${JSON.stringify(password)}`);
      await page.evaluate(`document.querySelector('#password').dispatchEvent(new Event('input', {bubbles:true}))`);
      await page.evaluate(`document.querySelector('input[type="submit"], button[type="submit"]').click()`);
      await page.sleep(3000);

      // Handle 2FA if present
      const needs2fa = await page.evaluate(`!!document.querySelector('#app_totp, #sms_totp, [name="otp"]')`);
      if (needs2fa) {
        const codeResult = await page.requestData({
          message: "Enter your GitHub 2FA code",
          schema: {
            type: "object",
            properties: { code: { type: "string" } },
            required: ["code"],
          },
        });
        if (codeResult.status === 'skipped') {
          await page.setData('error', '2FA code required but not available in automated mode.');
          return;
        }
        const { code } = codeResult.data;
        await page.evaluate(`
          (() => {
            const input = document.querySelector('#app_totp, #sms_totp, [name="otp"]');
            if (input) {
              input.value = ${JSON.stringify(code)};
              input.dispatchEvent(new Event('input', {bubbles:true}));
            }
          })()
        `);
        await page.evaluate(`document.querySelector('button[type="submit"]')?.click()`);
        await page.sleep(3000);
      }

      loggedIn = await isLoggedIn();
    }

    // If programmatic login failed or form wasn't found, fall back to headed
    if (!loggedIn) {
      await page.setData("status", "Please complete login in the browser...");
      const manualResult = await page.requestManualAction(
        "Complete any remaining verification, then click 'Done'.",
        async () => await isLoggedIn(),
        { url: "https://github.com/login", interval: 2000 },
      );
      if (manualResult.status === 'skipped') {
        await page.setData('error', 'Login required but not available in automated mode.');
        return;
      }
    }

    loggedIn = await isLoggedIn();
  }

  if (!loggedIn) {
    await page.setData("error", "GitHub login could not be confirmed.");
    return;
  }

  await page.setData("status", "Login confirmed. Collecting data in background...");

  await page.setProgress({
    phase: { step: 1, total: 3, label: "Profile" },
    message: "Resolving account...",
  });

  const username = await resolveUsername();
  if (!isValidGitHubUsername(username)) {
    await page.setData("error", "Could not resolve a valid GitHub username after login.");
    return;
  }
  state.username = username;

  await page.setProgress({
    phase: { step: 1, total: 3, label: "Profile" },
    message: "Fetching profile...",
  });

  state.profile = await extractProfile(username);

  await page.setProgress({
    phase: { step: 2, total: 3, label: "Repositories" },
    message: "Fetching repositories...",
  });

  state.repositories = await extractRepositories(username);
  if (state.profile) {
    state.profile.repositoryCount = state.repositories.length;
  }

  await page.setProgress({
    phase: { step: 3, total: 3, label: "Starred" },
    message: "Fetching starred repositories...",
  });

  state.starred = await extractStarred(username);

  const totalItems = state.repositories.length + state.starred.length;
  const result = {
    profile: state.profile,
    repositories: state.repositories,
    starred: state.starred,
    exportSummary: {
      count: totalItems,
      label: totalItems === 1 ? "item" : "items",
      details: `${state.repositories.length} repositories, ${state.starred.length} starred`,
    },
    timestamp: new Date().toISOString(),
    version: "1.1.3-playwright",
    platform: "github",
  };

  state.isComplete = true;
  await page.setData("result", result);
  await page.setData(
    "status",
    `Complete! ${state.repositories.length} repositories and ${state.starred.length} starred repos collected.`,
  );

  return { success: true, data: result };
})();

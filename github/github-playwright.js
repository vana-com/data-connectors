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

const checkLoginStatus = async () => {
  try {
    const result = await page.evaluate(`
      (() => {
        const userMeta = document.querySelector('meta[name="user-login"]');
        const username = userMeta?.getAttribute('content')?.trim() || '';
        const signedOut = !!document.querySelector('a[href="/login"], form[action="/session"]');
        const hasAvatarMenu = !!document.querySelector('summary[aria-label*="View profile and more"]');
        return {
          loggedIn: Boolean(username) || (!signedOut && hasAvatarMenu),
          username: username || null
        };
      })()
    `);
    return result;
  } catch {
    return { loggedIn: false, username: null };
  }
};

const resolveUsername = async () => {
  const current = await checkLoginStatus();
  if (current.username) return current.username;

  await page.goto("https://github.com/settings/profile");
  await page.sleep(1200);

  const fromSettings = await checkLoginStatus();
  return fromSettings.username;
};

const extractProfile = async (username) => {
  await page.goto(`https://github.com/${username}`);
  await page.sleep(1200);

  try {
    return await page.evaluate(`
      (() => {
        const toInt = (raw) => {
          const text = (raw || '').toLowerCase().replace(/,/g, '').trim();
          if (!text) return 0;

          const compact = text.match(/^(\\d+(?:\\.\\d+)?)([km])$/);
          if (compact) {
            let value = parseFloat(compact[1]);
            if (Number.isNaN(value)) return 0;
            if (compact[2] === 'k') value *= 1_000;
            if (compact[2] === 'm') value *= 1_000_000;
            return Math.round(value);
          }

          const digits = text.replace(/[^0-9]/g, '');
          if (!digits) return 0;

          // GitHub counters can render duplicated screen-reader text (e.g. "104104").
          if (digits.length % 2 === 0) {
            const half = digits.length / 2;
            if (digits.slice(0, half) === digits.slice(half)) {
              return parseInt(digits.slice(0, half), 10);
            }
          }

          return parseInt(digits, 10);
        };

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
  const all = [];
  const seen = new Set();
  const maxPages = 60;

  for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
    await page.goto(`https://github.com/${username}?page=${pageIndex}&tab=repositories`);
    await page.sleep(1000);

    try {
      const pageResult = await page.evaluate(`
        (() => {
          const toInt = (raw) => {
            const text = (raw || '').toLowerCase().replace(/,/g, '').trim();
            if (!text) return 0;
            const match = text.match(/(\\d+(?:\\.\\d+)?)\\s*([km]?)/);
            if (!match) return 0;
            let value = parseFloat(match[1]);
            if (Number.isNaN(value)) return 0;
            if (match[2] === 'k') value *= 1_000;
            if (match[2] === 'm') value *= 1_000_000;
            return Math.round(value);
          };

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
  const all = [];
  const seen = new Set();
  const maxPages = 60;

  for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
    await page.goto(`https://github.com/${username}?page=${pageIndex}&tab=stars`);
    await page.sleep(1000);

    try {
      const pageResult = await page.evaluate(`
        (() => {
          const toInt = (raw) => {
            const text = (raw || '').toLowerCase().replace(/,/g, '').trim();
            if (!text) return 0;
            const match = text.match(/(\\d+(?:\\.\\d+)?)\\s*([km]?)/);
            if (!match) return 0;
            let value = parseFloat(match[1]);
            if (Number.isNaN(value)) return 0;
            if (match[2] === 'k') value *= 1_000;
            if (match[2] === 'm') value *= 1_000_000;
            return Math.round(value);
          };

          const list = [];
          const rows = document.querySelectorAll('#user-starred-repos li');
          for (const row of rows) {
            const link = row.querySelector('h3 a');
            if (!link) continue;

            const fullName = (link.textContent || '').replace(/\\s+/g, ' ').trim();
            const description = (row.querySelector('p')?.textContent || '').trim();
            const language = (row.querySelector('[itemprop="programmingLanguage"]')?.textContent || '').trim();
            const starsRaw = (row.querySelector('a[href$="/stargazers"]')?.textContent || '').trim();
            const updatedAt = row.querySelector('relative-time')?.getAttribute('datetime') || null;

            list.push({
              fullName,
              url: link.href,
              description,
              language,
              stars: toInt(starsRaw),
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

  let login = await checkLoginStatus();

  if (!login.loggedIn) {
    await page.showBrowser("https://github.com/login");
    await page.setData("status", "Please log in to GitHub...");

    await page.promptUser(
      "Please log in to GitHub. Click 'Done' after the homepage loads.",
      async () => {
        const result = await checkLoginStatus();
        return result.loggedIn;
      },
      2000,
    );

    login = await checkLoginStatus();
  }

  await page.setData("status", "Login confirmed. Collecting data in background...");
  await page.goHeadless();

  await page.setProgress({
    phase: { step: 1, total: 3, label: "Profile" },
    message: "Resolving account...",
  });

  const username = login.username || (await resolveUsername());
  if (!username) {
    await page.setData("error", "Could not resolve GitHub username after login.");
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

  const result = {
    profile: state.profile,
    repositories: state.repositories,
    starred: state.starred,
    exportSummary: {
      count: state.repositories.length + state.starred.length,
      label: "items",
      details: `${state.repositories.length} repositories, ${state.starred.length} starred`,
    },
    timestamp: new Date().toISOString(),
    version: "1.1.2-playwright",
    platform: "github",
    company: "GitHub",
    exportedAt: new Date().toISOString(),
  };

  state.isComplete = true;
  await page.setData("result", result);
  await page.setData(
    "status",
    `Complete! ${state.repositories.length} repositories and ${state.starred.length} starred repos collected.`,
  );

  return { success: true, data: result };
})();

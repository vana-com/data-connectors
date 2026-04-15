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

const PLATFORM = "github";
const VERSION = "1.2.0";
const CANONICAL_SCOPES = [
  "github.profile",
  "github.repositories",
  "github.starred",
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

const formatExportSummaryDetails = (repositories, starred) => ({
  repositories,
  starred,
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
      details: formatExportSummaryDetails(0, 0),
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

    const totalItems = state.repositories.length + state.starred.length;
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
        ),
      },
    });

    state.isComplete = true;
    await page.setData("result", result);
    await page.setData(
      "status",
      `Complete! ${state.repositories.length} repositories and ${state.starred.length} starred repos collected.`,
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

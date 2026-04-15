/**
 * Instagram Connector (Playwright)
 *
 * Uses Playwright for real browser control with network interception.
 * Requires the playwright-runner sidecar.
 */

// State management
const state = {
  webInfo: null,
  profileData: null,
  timelineEdges: [],
  pageInfo: null,
  totalFetched: 0,
  adsData: { advertisers: [], ad_topics: [] },
  followingAccounts: [],
  isProfileComplete: false,
  isTimelineComplete: false,
  isAdsComplete: false,
  isFollowingComplete: false,
  isComplete: false
};

const PLATFORM = "instagram";
const VERSION = "2.1.0-playwright";
const CANONICAL_SCOPES = [
  "instagram.profile",
  "instagram.posts",
  "instagram.following",
  "instagram.ads",
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
      details: {
        posts: 0,
        following: 0,
        advertisers: 0,
        adTopics: 0,
      },
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
      "Instagram connector received an empty or invalid requestedScopes array.",
      "init",
    );
  }
  const deduped = Array.from(new Set(raw));
  const invalid = deduped.filter((scope) => !CANONICAL_SCOPES.includes(scope));
  if (invalid.length > 0) {
    throw makeFatalRunError(
      "protocol_violation",
      `Instagram connector received unsupported requestedScopes: ${invalid.join(", ")}.`,
      "init",
    );
  }
  return deduped;
};

// ── Resilience helpers (ported from CG prod instagram-headless.js) ───
//
// Instagram's edges occasionally return transient HTTP errors on login,
// account-center navigation, and graphql queries. Without wrapping
// page.goto / page.evaluate / page.waitForSelector / page.setData in
// timeouts + try/catch, a single blip surfaces to the caller as a raw
// `net::ERR_HTTP_RESPONSE_CODE_FAILURE` and kills the whole run.
//
// These helpers match the ones shipped in CG origin/main's hand-
// maintained Instagram connector. They are intentionally defined inline
// rather than imported because data-connectors scripts are executed as
// raw source by both the CG client-side VM and data-connect's
// playwright-runner — neither resolves `import` statements. Shared
// helpers need their own solution (see the "generalized error handling
// at the proxy level" followup in the connector contract plan).

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

// Wrap page.goto in a timeout + retry loop. Returns true on success and
// false if every attempt failed. Callers can decide whether a failed
// navigation is fatal (login page) or recoverable (individual ads sub-
// page, where we want to skip the scope instead of killing the run).
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
        `[instagram] Navigation attempt ${attempt}/${attempts} failed for ${url}: ${message}`,
      );
      if (attempt < attempts) {
        await page.sleep(betweenMs);
      }
    }
  }
  return false;
};

// Helper: Scrape the list of accounts the logged-in user follows via
// Instagram's internal friendships endpoint. Runs entirely inside
// page.evaluate so it's portable across any runtime that implements the
// canonical Page API.
//
// Ported from Context Gateway's instagram-headless.js (which is being
// decommissioned) so that the canonical connector is a superset and CG
// users don't lose following_accounts when the canonical script is
// activated.
const scrapeFollowingAccounts = async (userId, expectedCount) => {
  try {
    if (!userId) {
      return {
        ok: false,
        data: [],
        error: makeConnectorError(
          "runtime_error",
          "Instagram following collection could not start without a user id.",
          "omitted",
          { scope: "instagram.following", phase: "collect" },
        ),
      };
    }
    const apiAccounts = await page.evaluate(`
      (async ({ userId, expectedCount }) => {
        const collected = [];
        const seen = new Set();
        let nextMaxId = null;
        let iterations = 0;

        while (iterations < 20) {
          iterations += 1;
          const params = new URLSearchParams({ count: '50' });
          if (nextMaxId) params.set('max_id', nextMaxId);

          const response = await fetch(\`/api/v1/friendships/\${userId}/following/?\${params.toString()}\`, {
            headers: {
              'x-ig-app-id': '936619743392459',
              'x-requested-with': 'XMLHttpRequest'
            },
            credentials: 'include'
          });

          if (!response.ok) {
            throw new Error(\`Following API failed with status \${response.status}\`);
          }

          const data = await response.json();
          const users = Array.isArray(data.users) ? data.users : [];

          for (const user of users) {
            if (!user?.username || seen.has(user.username)) continue;
            seen.add(user.username);
            collected.push({
              username: user.username,
              full_name: user.full_name || '',
              pk: user.pk || user.id || '',
              is_private: !!user.is_private,
              is_verified: !!user.is_verified,
              profile_pic_url: user.profile_pic_url || null
            });
          }

          if ((typeof expectedCount === 'number' && expectedCount > 0 && collected.length >= expectedCount) || !data.next_max_id) {
            break;
          }

          nextMaxId = data.next_max_id;
        }

        return {
          accounts: collected,
          incomplete:
            typeof expectedCount === 'number' &&
            expectedCount > 0 &&
            collected.length < expectedCount &&
            Boolean(nextMaxId),
        };
      })(${JSON.stringify({ userId, expectedCount })})
    `);
    const accounts = Array.isArray(apiAccounts?.accounts)
      ? apiAccounts.accounts
      : [];
    const incomplete = Boolean(apiAccounts?.incomplete);
    if (incomplete) {
      return {
        ok: true,
        data: accounts,
        error: makeConnectorError(
          "upstream_error",
          `Instagram following collection stopped before reaching the expected count (${accounts.length}/${expectedCount || "unknown"}).`,
          "degraded",
          { scope: "instagram.following", phase: "collect" },
        ),
      };
    }
    return { ok: true, data: accounts, error: null };
  } catch (error) {
    await page.setData('status', `Failed to scrape following accounts: ${error?.message || String(error)}`);
    return {
      ok: false,
      data: [],
      error: makeConnectorError(
        inferErrorClass(error?.message || String(error), "upstream_error"),
        `Instagram following collection failed: ${error?.message || String(error)}`,
        "omitted",
        { scope: "instagram.following", phase: "collect" },
      ),
    };
  }
};

// Helper: Fetch web_info to get logged-in user data
const fetchWebInfo = async () => {
  try {
    const result = await page.evaluate(`
      (async () => {
        try {
          const response = await fetch("https://www.instagram.com/accounts/web_info/", {
            headers: { "X-Requested-With": "XMLHttpRequest" }
          });
          if (!response.ok) return { error: 'response not ok', status: response.status };

          const html = await response.text();
          const parser = new DOMParser();
          const doc = parser.parseFromString(html, "text/html");
          const scripts = doc.querySelectorAll('script[type="application/json"][data-sjs]');

          const findPolarisData = (obj) => {
            if (!obj || typeof obj !== 'object') return null;
            if (Array.isArray(obj) && obj[0] === 'PolarisViewer' && obj.length >= 3) {
              return obj[2];
            }
            for (const key in obj) {
              if (Object.prototype.hasOwnProperty.call(obj, key)) {
                const found = findPolarisData(obj[key]);
                if (found) return found;
              }
            }
            return null;
          };

          let foundData = null;
          for (const script of scripts) {
            try {
              const jsonContent = JSON.parse(script.textContent);
              foundData = findPolarisData(jsonContent);
              if (foundData) break;
            } catch (e) {}
          }

          if (foundData && foundData.data) {
            return { success: true, data: foundData.data };
          }
          return { error: 'no polaris data found', scriptsCount: scripts.length };
        } catch (err) {
          return { error: err.message };
        }
      })()
    `);
    if (result?.success) {
      return result.data;
    }
    return null;
  } catch (err) {
    return null;
  }
};

// Main export flow
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
    const wantsProfile = wantsScope("instagram.profile");
    const wantsFollowing = wantsScope("instagram.following");
    const wantsPosts = wantsScope("instagram.posts");
    const wantsAds = wantsScope("instagram.ads");

    const errors = [];
    const scopes = {};
    let followingResult = { ok: false, data: [], error: null };
    let postsIssue = null;
    let adsIssue = null;
    let adsAdvertisersCollected = false;
    let adsTopicsCollected = false;

    await page.setData("status", "Checking login status...");
    await page.sleep(2000);

    const webInfo = await fetchWebInfo();
    state.webInfo = webInfo;

    let isLoggedIn = Boolean(webInfo && webInfo.username);

    if (!isLoggedIn) {
      const loginReachable = await safeGoto(
        "https://www.instagram.com/accounts/login/",
      );
      if (!loginReachable) {
        throw makeFatalRunError(
          "navigation_error",
          "Could not reach Instagram login page after multiple attempts.",
          "auth",
        );
      }
      await page.sleep(2000);

      const userSelector =
        'input[name="username"], input[name="email"], input[aria-label*="Username"]';
      const passSelector =
        'input[name="password"], input[name="pass"], input[aria-label*="Password"]';
      const supportsRequestInput = typeof page.requestInput === "function";

      let hasLoginForm = false;
      try {
        await page.waitForSelector(userSelector, {
          timeout: 10000,
          state: "visible",
        });
        hasLoginForm = true;
      } catch {
        hasLoginForm = false;
      }

      if (supportsRequestInput && hasLoginForm) {
        const { username: loginUser, password } = await page.requestInput({
          message: "Log in to Instagram",
          schema: {
            type: "object",
            properties: {
              username: {
                type: "string",
                description: "Instagram username, email, or phone number",
              },
              password: { type: "string", format: "password" },
            },
            required: ["username", "password"],
          },
        });

        await page.fill(userSelector, loginUser);
        await page.sleep(300);
        await page.fill(passSelector, password);
        await page.sleep(300);
        await page.press(passSelector, "Enter");
        await page.sleep(12000);

        const needs2fa = await page.evaluate(`
          !!document.querySelector('input[name="verificationCode"]') ||
          !!document.querySelector('input[name="security_code"]') ||
          !!document.querySelector('input[aria-label="Security Code"]') ||
          !!document.querySelector('input[name="approvals_code"]')
        `);
        if (needs2fa) {
          const { code } = await page.requestInput({
            message: "Enter your Instagram security/verification code",
            schema: {
              type: "object",
              properties: {
                code: {
                  type: "string",
                  description: "6-digit verification code",
                },
              },
              required: ["code"],
            },
          });
          const otpSelector =
            'input[name="verificationCode"], input[name="security_code"], input[aria-label="Security Code"], input[name="approvals_code"]';
          try {
            await page.fill(otpSelector, code);
            await page.sleep(500);
            await page.press(otpSelector, "Enter");
          } catch {
            await page.evaluate(`
              (() => {
                const el = document.querySelector(${JSON.stringify(otpSelector)});
                if (el) {
                  const setter = Object.getOwnPropertyDescriptor(
                    window.HTMLInputElement.prototype, 'value'
                  )?.set;
                  if (setter) setter.call(el, ${JSON.stringify(code)});
                  else el.value = ${JSON.stringify(code)};
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                  const form = el.closest('form');
                  if (form) form.submit();
                }
              })()
            `);
          }
          await page.sleep(5000);
        }
      }

      for (let dismissAttempt = 0; dismissAttempt < 3; dismissAttempt++) {
        await page.evaluate(`
          (() => {
            const cookieBtns = document.querySelectorAll('button');
            for (const btn of cookieBtns) {
              const text = (btn.textContent || '').trim().toLowerCase();
              if (text.includes('allow all cookies') || text.includes('allow essential and optional cookies') ||
                  text.includes('decline optional cookies') || text.includes('accept all')) {
                btn.click();
                return 'dismissed cookie banner';
              }
            }

            for (const btn of cookieBtns) {
              const text = (btn.textContent || '').trim().toLowerCase();
              if (text === 'not now' || text === 'skip') {
                btn.click();
                return 'dismissed interstitial: ' + text;
              }
            }

            for (const btn of cookieBtns) {
              const text = (btn.textContent || '').trim().toLowerCase();
              if (text === 'this was me') {
                btn.click();
                return 'dismissed security prompt';
              }
            }

            return 'no interstitials found';
          })()
        `);
        await page.sleep(2000);
      }

      let newWebInfo = null;
      for (let r = 0; r < 3; r++) {
        newWebInfo = await fetchWebInfo();
        if (newWebInfo?.username) break;
        await page.sleep(2000);
      }
      let loginSucceeded = Boolean(newWebInfo && newWebInfo.username);

      if (!loginSucceeded) {
        const { headed } = await page.showBrowser(
          "https://www.instagram.com/accounts/login/",
        );
        if (headed) {
          await page.setData(
            "status",
            "Please complete login in the browser...",
          );
          await page.promptUser(
            'Complete any remaining verification, then click "Done".',
            async () => {
              const info = await fetchWebInfo();
              return Boolean(info && info.username);
            },
            2000,
          );
          await page.goHeadless();
        } else {
          throw makeFatalRunError(
            "auth_failed",
            "Instagram login requires a headed browser or requestInput support.",
            "auth",
          );
        }

        for (let dismissAttempt = 0; dismissAttempt < 3; dismissAttempt++) {
          await page.evaluate(`
            (() => {
              const btns = document.querySelectorAll('button');
              for (const btn of btns) {
                const text = (btn.textContent || '').trim().toLowerCase();
                if (text.includes('allow all cookies') || text.includes('allow essential and optional cookies') ||
                    text.includes('decline optional cookies') || text.includes('accept all') ||
                    text === 'not now' || text === 'skip' || text === 'this was me') {
                  btn.click();
                  return 'dismissed: ' + text;
                }
              }
              return 'none';
            })()
          `);
          await page.sleep(1500);
        }
        newWebInfo = await fetchWebInfo();
        loginSucceeded = Boolean(newWebInfo && newWebInfo.username);
      }

      state.webInfo = newWebInfo;
      if (!loginSucceeded) {
        throw makeFatalRunError(
          "auth_failed",
          "Instagram login could not be confirmed.",
          "auth",
        );
      }
      await page.setData("status", "Login completed");
    } else {
      await page.setData("status", "Session restored from previous login");
    }

    const username = state.webInfo?.username;
    if (!username) {
      throw makeFatalRunError(
        "runtime_error",
        "Could not determine the Instagram username for this session.",
      );
    }

    await page.setData("status", `Logged in as @${username}`);

    await page.setProgress({
      phase: { step: 1, total: 3, label: "Fetching profile" },
      message: "Setting up network capture...",
    });

    await page.captureNetwork({
      urlPattern: "/graphql",
      bodyPattern:
        "PolarisProfilePageContentQuery|ProfilePageQuery|UserByUsernameQuery",
      key: "profileResponse",
    });

    if (wantsPosts) {
      await page.captureNetwork({
        urlPattern: "/graphql",
        bodyPattern:
          "PolarisProfilePostsQuery|PolarisProfilePostsTabContentQuery_connection|ProfilePostsQuery|UserMediaQuery",
        key: "postsResponse",
      });
    }

    await page.setData("status", "Network capture configured");

    await page.setProgress({
      phase: { step: 1, total: 3, label: "Fetching profile" },
      message: `Navigating to profile: @${username}`,
    });
    const profileReachable = await safeGoto(
      `https://www.instagram.com/${username}/`,
    );
    if (!profileReachable) {
      throw makeFatalRunError(
        "navigation_error",
        `Could not reach Instagram profile page for @${username} after multiple attempts.`,
      );
    }
    await page.sleep(3000);

    await page.setProgress({
      phase: { step: 1, total: 3, label: "Fetching profile" },
      message: "Waiting for profile data...",
    });
    let profileData = null;
    let postsData = wantsPosts ? null : { skipped: true };
    let attempts = 0;
    const maxAttempts = 30;

    while (attempts < maxAttempts && (!profileData || !postsData)) {
      await page.sleep(1000);
      attempts++;

      if (!profileData) {
        profileData = await page.getCapturedResponse("profileResponse");
        if (profileData) {
          await page.setProgress({
            phase: { step: 1, total: 3, label: "Fetching profile" },
            message: "Profile data captured!",
          });

          const userData = profileData?.data?.data?.user;
          if (userData) {
            state.profileData = {
              username: userData.username,
              full_name: userData.full_name,
              pk: userData.pk,
              id: userData.id,
              biography: userData.biography,
              follower_count: userData.follower_count,
              following_count: userData.following_count,
              media_count: userData.media_count,
              total_clips_count: userData.total_clips_count,
              profile_pic_url: userData.profile_pic_url,
              hd_profile_pic_url: userData.hd_profile_pic_url_info?.url,
              has_profile_pic: userData.has_profile_pic,
              is_private: userData.is_private,
              is_verified: userData.is_verified,
              is_business: userData.is_business,
              is_professional_account: userData.is_professional_account,
              account_type: userData.account_type,
              external_url: userData.external_url,
              external_lynx_url: userData.external_lynx_url,
              bio_links: userData.bio_links,
              linked_fb_info: userData.linked_fb_info,
              pronouns: userData.pronouns,
              account_badges: userData.account_badges,
              has_story_archive: userData.has_story_archive,
              viewer_data: profileData.data?.data?.viewer,
              collected_at: new Date().toISOString(),
            };
            state.isProfileComplete = true;
            await page.setData("profile", state.profileData);

            if (wantsFollowing) {
              await page.setProgress({
                phase: { step: 1, total: 3, label: "Fetching following" },
                message: `Fetching following list for @${state.profileData.username}...`,
              });
              followingResult = await scrapeFollowingAccounts(
                state.profileData.id || state.profileData.pk,
                state.profileData.following_count,
              );
              state.followingAccounts = followingResult.data;
              state.isFollowingComplete = followingResult.ok;
              if (followingResult.error) {
                errors.push(followingResult.error);
              }
              await page.setData(
                "following_count_collected",
                state.followingAccounts.length,
              );
            } else {
              state.isFollowingComplete = true;
            }
          }
        }
      }

      if (!postsData) {
        postsData = await page.getCapturedResponse("postsResponse");
        if (postsData) {
          await page.setProgress({
            phase: { step: 1, total: 3, label: "Fetching profile" },
            message: "Posts data captured!",
          });
        }
      }
    }

    if (!state.profileData) {
      throw makeFatalRunError(
        "selector_error",
        `Instagram profile data could not be captured for @${username}.`,
      );
    }

    if (wantsPosts && !postsData) {
      await page.setProgress({
        phase: { step: 2, total: 3, label: "Fetching posts" },
        message: "Scrolling to load posts...",
        count: 0,
      });
      await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
      await page.sleep(2000);
      postsData = await page.getCapturedResponse("postsResponse");
    }

    if (wantsPosts) {
      if (!postsData) {
        postsIssue = makeConnectorError(
          "upstream_error",
          `Instagram posts data was not captured for @${username}.`,
          "omitted",
          { scope: "instagram.posts", phase: "collect" },
        );
      } else {
        const timelineData =
          postsData?.data?.data?.xdt_api__v1__feed__user_timeline_graphql_connection;
        if (!timelineData?.edges || !Array.isArray(timelineData.edges)) {
          postsIssue = makeConnectorError(
            "selector_error",
            `Instagram posts payload was malformed for @${username}.`,
            "omitted",
            { scope: "instagram.posts", phase: "collect" },
          );
        } else {
          const { edges, page_info: pageInfo } = timelineData;
          state.timelineEdges = edges;
          state.pageInfo = pageInfo;
          state.totalFetched = edges.length;
          const mediaCount = state.profileData?.media_count;

          await page.setProgress({
            phase: { step: 2, total: 3, label: "Fetching posts" },
            message: mediaCount
              ? `Captured ${state.totalFetched} of ${mediaCount} posts`
              : `Captured ${state.totalFetched} posts`,
            count: state.totalFetched,
          });

          if (pageInfo?.has_next_page && pageInfo?.end_cursor) {
            let hasMore = true;
            let scrollAttempts = 0;
            const maxScrollAttempts = 20;

            while (hasMore && scrollAttempts < maxScrollAttempts) {
              scrollAttempts++;

              await page.clearNetworkCaptures();
              await page.captureNetwork({
                urlPattern: "/graphql",
                bodyPattern:
                  "PolarisProfilePostsQuery|PolarisProfilePostsTabContentQuery_connection|ProfilePostsQuery|UserMediaQuery",
                key: "postsResponse",
              });

              await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
              await page.sleep(2000);

              const nextPostsData = await page.getCapturedResponse("postsResponse");
              if (!nextPostsData) {
                postsIssue = makeConnectorError(
                  "upstream_error",
                  `Instagram posts pagination stopped before all pages were captured for @${username}.`,
                  "degraded",
                  { scope: "instagram.posts", phase: "collect" },
                );
                break;
              }

              const nextTimelineData =
                nextPostsData?.data?.data?.xdt_api__v1__feed__user_timeline_graphql_connection;
              if (!nextTimelineData?.edges) {
                postsIssue = makeConnectorError(
                  "selector_error",
                  `Instagram posts pagination returned an unreadable page for @${username}.`,
                  "degraded",
                  { scope: "instagram.posts", phase: "collect" },
                );
                break;
              }

              const {
                edges: newEdges,
                page_info: newPageInfo,
              } = nextTimelineData;

              const existingIds = new Set(
                state.timelineEdges
                  .map(
                    (edge) =>
                      edge.node?.id ||
                      edge.node?.pk ||
                      edge.node?.media_id ||
                      edge.node?.code,
                  )
                  .filter(Boolean),
              );

              const uniqueNewEdges = newEdges.filter((edge) => {
                const nodeId =
                  edge.node?.id ||
                  edge.node?.pk ||
                  edge.node?.media_id ||
                  edge.node?.code;
                return nodeId && !existingIds.has(nodeId);
              });

              if (uniqueNewEdges.length > 0) {
                state.timelineEdges = [...state.timelineEdges, ...uniqueNewEdges];
                state.pageInfo = newPageInfo;
                state.totalFetched = state.timelineEdges.length;

                await page.setProgress({
                  phase: { step: 2, total: 3, label: "Fetching posts" },
                  message: mediaCount
                    ? `Captured ${state.totalFetched} of ${mediaCount} posts`
                    : `Captured ${state.totalFetched} posts`,
                  count: state.totalFetched,
                });
              }

              hasMore = Boolean(
                newPageInfo?.has_next_page &&
                  newPageInfo?.end_cursor &&
                  uniqueNewEdges.length > 0,
              );
              if (
                !hasMore &&
                newPageInfo?.has_next_page &&
                uniqueNewEdges.length === 0
              ) {
                postsIssue = makeConnectorError(
                  "upstream_error",
                  `Instagram posts pagination stopped yielding new records before completion for @${username}.`,
                  "degraded",
                  { scope: "instagram.posts", phase: "collect" },
                );
              }
            }

            if (!postsIssue && state.pageInfo?.has_next_page) {
              postsIssue = makeConnectorError(
                "upstream_error",
                `Instagram posts pagination did not finish within the connector attempt limit for @${username}.`,
                "degraded",
                { scope: "instagram.posts", phase: "collect" },
              );
            }
          }

          state.isTimelineComplete = true;
        }
      }

      if (postsIssue) {
        errors.push(postsIssue);
      }
    }

    if (wantsAds) {
      await page.setProgress({
        phase: { step: 3, total: 3, label: "Fetching ad interests" },
        message: "Navigating to ad preferences...",
      });

      const adsReachable = await safeGoto(
        "https://accountscenter.instagram.com/ads/",
      );
      if (!adsReachable) {
        adsIssue = makeConnectorError(
          "navigation_error",
          "Instagram ads landing page could not be reached.",
          "omitted",
          { scope: "instagram.ads", phase: "collect" },
        );
      } else {
        await page.sleep(4000);

        const scrapeDialogList = async () => {
          return await page.evaluate(`
            (() => {
              const dialog = document.querySelector('[role="dialog"]');
              if (!dialog) return [];
              const items = dialog.querySelectorAll('[role="list"] [role="listitem"]');
              return Array.from(items)
                .map(el => el.textContent.trim())
                .filter(t => t.length > 0);
            })()
          `);
        };

        try {
          await page.setProgress({
            phase: { step: 3, total: 3, label: "Fetching ad interests" },
            message: "Collecting advertisers...",
          });

          await page.evaluate(`
            (() => {
              const btn = document.querySelector('[role="button"][aria-label*="advertiser" i]');
              if (btn) btn.click();
            })()
          `);
          await page.sleep(2000);

          const advertiserNames = await scrapeDialogList();
          state.adsData.advertisers = advertiserNames.map((name) => ({ name }));
          adsAdvertisersCollected = true;

          await page.evaluate(`
            (() => {
              const dialog = document.querySelector('[role="dialog"]');
              const close = dialog?.querySelector('[aria-label="Close" i]');
              if (close) close.click();
            })()
          `);
          await page.sleep(1000);
        } catch (error) {
          adsIssue = makeConnectorError(
            inferErrorClass(error?.message || String(error), "selector_error"),
            `Instagram advertisers collection failed: ${error?.message || String(error)}`,
            "omitted",
            { scope: "instagram.ads", phase: "collect" },
          );
        }

        await page.setProgress({
          phase: { step: 3, total: 3, label: "Fetching ad interests" },
          message: `Found ${state.adsData.advertisers.length} advertisers. Collecting ad topics...`,
        });

        const topicsReachable = await safeGoto(
          "https://accountscenter.instagram.com/ads/ad_topics/",
        );
        if (!topicsReachable) {
          const disposition = adsAdvertisersCollected ? "degraded" : "omitted";
          adsIssue = makeConnectorError(
            "navigation_error",
            "Instagram ad topics page could not be reached.",
            disposition,
            { scope: "instagram.ads", phase: "collect" },
          );
        } else {
          try {
            await page.sleep(3000);
            const topicNames = await page.evaluate(`
              (() => {
                const dialog = document.querySelector('[role="dialog"]');
                if (!dialog) return [];
                const items = dialog.querySelectorAll('[role="list"] [role="listitem"]');
                return Array.from(items)
                  .map(el => el.textContent.trim())
                  .filter(t => t.length > 0 && !t.toLowerCase().includes('special topic') && !t.toLowerCase().includes('see less'));
              })()
            `);
            state.adsData.ad_topics = topicNames.map((name) => ({ name }));
            adsTopicsCollected = true;
          } catch (error) {
            adsIssue = makeConnectorError(
              inferErrorClass(error?.message || String(error), "selector_error"),
              `Instagram ad topics collection failed: ${error?.message || String(error)}`,
              adsAdvertisersCollected ? "degraded" : "omitted",
              { scope: "instagram.ads", phase: "collect" },
            );
          }
        }
      }

      state.isAdsComplete =
        adsAdvertisersCollected || adsTopicsCollected;
      await page.setProgress({
        phase: { step: 3, total: 3, label: "Fetching ad interests" },
        message: `Ad interests: ${state.adsData.advertisers.length} advertisers, ${state.adsData.ad_topics.length} topics`,
      });

      if (adsIssue && (adsAdvertisersCollected || adsTopicsCollected)) {
        adsIssue = { ...adsIssue, disposition: "degraded" };
      }
      if (adsIssue) {
        errors.push(adsIssue);
      }
    }

    const posts = (state.timelineEdges || []).map((edge) => {
      const node = edge.node;
      const imgUrl =
        node.image_versions2?.candidates?.[0]?.url ||
        node.carousel_media?.[0]?.image_versions2?.candidates?.[0]?.url ||
        "";
      const caption = node.caption?.text || "";
      const numOfLikes = node.like_count || 0;
      const whoLiked = (node.facepile_top_likers || []).map((liker) => ({
        profile_pic_url: liker.profile_pic_url || "",
        pk: liker.pk || liker.id || "",
        username: liker.username || "",
        id: liker.id || liker.pk || "",
      }));

      return {
        img_url: imgUrl,
        caption,
        num_of_likes: numOfLikes,
        who_liked: whoLiked,
      };
    });

    if (wantsProfile) {
      scopes["instagram.profile"] = {
        username: state.profileData.username,
        full_name: state.profileData.full_name,
        bio: state.profileData.biography,
        profile_pic_url: state.profileData.profile_pic_url,
        external_url: state.profileData.external_url,
        follower_count: state.profileData.follower_count,
        following_count: state.profileData.following_count,
        media_count: state.profileData.media_count,
        is_private: state.profileData.is_private,
        is_verified: state.profileData.is_verified,
        is_business: state.profileData.is_business,
      };
    }

    if (wantsPosts && postsIssue?.disposition !== "omitted") {
      scopes["instagram.posts"] = {
        posts,
      };
    }

    if (wantsFollowing && followingResult.ok) {
      scopes["instagram.following"] = {
        accounts: state.followingAccounts,
        total: state.followingAccounts.length,
      };
    }

    if (wantsAds && (adsAdvertisersCollected || adsTopicsCollected)) {
      scopes["instagram.ads"] = {
        advertisers: state.adsData.advertisers,
        ad_topics: state.adsData.ad_topics,
      };
    }

    state.isComplete = state.isProfileComplete;
    const totalItems =
      posts.length +
      state.followingAccounts.length +
      state.adsData.advertisers.length +
      state.adsData.ad_topics.length;
    const result = buildResult({
      requestedScopes,
      scopes,
      errors,
      exportSummary: {
        count: totalItems,
        label: totalItems === 1 ? "item" : "items",
        details: {
          posts: posts.length,
          following: state.followingAccounts.length,
          advertisers: state.adsData.advertisers.length,
          adTopics: state.adsData.ad_topics.length,
        },
      },
    });

    await page.setData("result", result);
    const postCount = result["instagram.posts"]?.posts?.length || 0;
    const adCount = result["instagram.ads"]?.advertisers?.length || 0;
    const topicCount = result["instagram.ads"]?.ad_topics?.length || 0;
    await page.setData(
      "status",
      `Complete! ${postCount} posts, ${adCount} advertisers, ${topicCount} ad topics collected for @${state.profileData.username}`,
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

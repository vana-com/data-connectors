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
    if (!userId) return [];
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

        return collected;
      })(${JSON.stringify({ userId, expectedCount })})
    `);
    return Array.isArray(apiAccounts) ? apiAccounts : [];
  } catch (error) {
    // Non-fatal: following data is optional at the connector level.
    await page.setData('status', `Failed to scrape following accounts: ${error?.message || String(error)}`);
    return [];
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
  // Honest scope gating: if the runtime exposes requestedScopes(), respect
  // it so we can skip collection for scopes the caller didn't ask for.
  // A null return (or a missing method) means "collect everything" — the
  // legacy default — so older runtimes continue to work unchanged. This
  // is not an enforcement layer against a malicious caller; the script
  // runs in a client-controlled JS VM and the gate can be stripped. It
  // exists so well-behaved flows don't waste worker cycles or overcollect.
  const requestedScopesList =
    typeof page.requestedScopes === 'function' ? page.requestedScopes() : null;
  const wantsScope = (scope) =>
    requestedScopesList === null || requestedScopesList.includes(scope);

  // Profile data is load-bearing for login detection and for the username
  // we pass to the Following endpoint, so we always collect it. We just
  // omit it from the result if it wasn't requested.
  const wantsProfile = wantsScope('instagram.profile');
  const wantsFollowing = wantsScope('instagram.following');
  const wantsPosts = wantsScope('instagram.posts');
  const wantsAds = wantsScope('instagram.ads');

  // Navigate to Instagram
  // We start on login page - check if already logged in
  await page.setData('status', 'Checking login status...');
  await page.sleep(2000);

  const webInfo = await fetchWebInfo();
  state.webInfo = webInfo;

  const isLoggedIn = webInfo && webInfo.username;

  if (!isLoggedIn) {
    // Navigation to the login page is load-bearing; retry a few times
    // before giving up so a transient HTTP blip doesn't kill the whole run.
    const loginReachable = await safeGoto(
      'https://www.instagram.com/accounts/login/',
    );
    if (!loginReachable) {
      return {
        success: false,
        error: 'Could not reach Instagram login page after multiple attempts.',
      };
    }
    await page.sleep(2000);

    // Selectors are deliberately broad — Instagram ships different DOMs by
    // region/version. These cover the shapes observed in production:
    //   - input[name="username"] + input[name="password"]    (older)
    //   - input[name="email"]    + input[name="pass"]        (current 2025+)
    //   - input[aria-label*="Username"] + input[aria-label*="Password"]  (regional)
    const userSelector = 'input[name="username"], input[name="email"], input[aria-label*="Username"]';
    const passSelector = 'input[name="password"], input[name="pass"], input[aria-label*="Password"]';

    const supportsRequestInput = typeof page.requestInput === 'function';

    // Wait for the login form to render before we try to interact with it.
    // Instagram hydrates its forms asynchronously, so a one-shot DOM check
    // can race hydration. waitForSelector polls until the element is visible
    // or the timeout elapses.
    let hasLoginForm = false;
    try {
      await page.waitForSelector(userSelector, { timeout: 10000, state: 'visible' });
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
            username: { type: "string", description: "Instagram username, email, or phone number" },
            password: { type: "string", format: "password" },
          },
          required: ["username", "password"],
        },
      });

      // Use the canonical Page API's page.fill / page.press so the runtime
      // (Playwright, under both DataConnect and Context Gateway) handles
      // React-synthetic-event dispatch correctly. Setting input.value by
      // hand and firing a bubbling 'input' event does NOT trigger React's
      // onChange for controlled inputs, which is why previous versions of
      // this script failed silently on Instagram's current DOM.
      await page.fill(userSelector, loginUser);
      await page.sleep(300);
      await page.fill(passSelector, password);
      await page.sleep(300);
      // Press Enter on the password field rather than clicking a submit
      // button — Instagram renders its submit as either
      // `<button type="submit">`, `<input type="submit">`, or
      // `<div role="button">`, and the Enter-key path bypasses all of
      // those variations.
      await page.press(passSelector, 'Enter');
      // Instagram's SPA redirect can take 10+ seconds after a successful
      // submit. Wait long enough that an immediate check for the login
      // form or a 2FA prompt will see a settled DOM.
      await page.sleep(12000);

      // Handle 2FA / suspicious login challenge
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
            properties: { code: { type: "string", description: "6-digit verification code" } },
            required: ["code"],
          },
        });
        const otpSelector = 'input[name="verificationCode"], input[name="security_code"], input[aria-label="Security Code"], input[name="approvals_code"]';
        try {
          await page.fill(otpSelector, code);
          await page.sleep(500);
          await page.press(otpSelector, 'Enter');
        } catch {
          // If the selector disambiguation failed, fall back to a DOM-level
          // form fill that at least gets the character into the field.
          //
          // Use window.HTMLInputElement.prototype directly rather than
          // Object.getPrototypeOf(el): it's the standard bypass for React's
          // controlled inputs (React 16+) and is bulletproof against any
          // polyfill that may have mutated the element's instance prototype
          // chain.
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

    // Dismiss Instagram interstitials that appear after login
    // These block the page and prevent fetchWebInfo() from working
    for (let dismissAttempt = 0; dismissAttempt < 3; dismissAttempt++) {
      await page.evaluate(`
        (() => {
          // Cookie consent banner — "Allow All Cookies" or "Decline Optional Cookies"
          const cookieBtns = document.querySelectorAll('button');
          for (const btn of cookieBtns) {
            const text = (btn.textContent || '').trim().toLowerCase();
            if (text.includes('allow all cookies') || text.includes('allow essential and optional cookies') ||
                text.includes('decline optional cookies') || text.includes('accept all')) {
              btn.click();
              return 'dismissed cookie banner';
            }
          }

          // "Save Your Login Info?" dialog — click "Not Now"
          // "Turn on Notifications?" dialog — click "Not Now"
          for (const btn of cookieBtns) {
            const text = (btn.textContent || '').trim().toLowerCase();
            if (text === 'not now' || text === 'skip') {
              btn.click();
              return 'dismissed interstitial: ' + text;
            }
          }

          // "We Noticed an Unusual Login Attempt" — click "This Was Me"
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

    // Check if login succeeded. Give fetchWebInfo a few tries — the page
    // may still be settling after the Instagram SPA navigation.
    let newWebInfo = null;
    for (let r = 0; r < 3; r++) {
      newWebInfo = await fetchWebInfo();
      if (newWebInfo?.username) break;
      await page.sleep(2000);
    }
    let loginSucceeded = !!(newWebInfo && newWebInfo.username);

    // Fallback to headed browser if programmatic login failed
    if (!loginSucceeded) {
      const { headed } = await page.showBrowser('https://www.instagram.com/accounts/login/');
      if (headed) {
        await page.setData('status', 'Please complete login in the browser...');
        await page.promptUser(
          'Complete any remaining verification, then click "Done".',
          async () => {
            const info = await fetchWebInfo();
            return !!(info && info.username);
          },
          2000
        );
        await page.goHeadless();
      } else {
        await page.setData('error', 'Instagram login failed.');
        return { error: 'Instagram login failed' };
      }

      // Dismiss any remaining interstitials after headed browser login
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
    }

    state.webInfo = newWebInfo;
    await page.setData('status', 'Login completed');
  } else {
    await page.setData('status', 'Session restored from previous login');
  }

  // Get the username
  const username = state.webInfo?.username;
  if (!username) {
    await page.setData('error', 'Could not determine username');
    return { error: 'Could not determine username' };
  }

  await page.setData('status', `Logged in as @${username}`);

  // ═══ PHASE 1: Profile Data ═══
  await page.setProgress({
    phase: { step: 1, total: 3, label: 'Fetching profile' },
    message: 'Setting up network capture...',
  });

  // Set up network captures BEFORE navigating to profile. The profile
  // capture is load-bearing (we need profile.id for the following scrape
  // and username/counts for the export summary), so always run it. The
  // posts capture is gated on the instagram.posts scope — skipping it
  // means we don't scroll or paginate for posts below.
  await page.captureNetwork({
    urlPattern: '/graphql',
    bodyPattern: 'PolarisProfilePageContentQuery|ProfilePageQuery|UserByUsernameQuery',
    key: 'profileResponse'
  });

  if (wantsPosts) {
    await page.captureNetwork({
      urlPattern: '/graphql',
      bodyPattern: 'PolarisProfilePostsQuery|PolarisProfilePostsTabContentQuery_connection|ProfilePostsQuery|UserMediaQuery',
      key: 'postsResponse'
    });
  }

  await page.setData('status', 'Network capture configured');

  // Navigate to user's profile — profile is load-bearing for the Following
  // scrape (we need the user id) and for the final exported username, so
  // retry a few times before bailing.
  await page.setProgress({
    phase: { step: 1, total: 3, label: 'Fetching profile' },
    message: `Navigating to profile: @${username}`,
  });
  const profileReachable = await safeGoto(
    `https://www.instagram.com/${username}/`,
  );
  if (!profileReachable) {
    return {
      success: false,
      error: `Could not reach Instagram profile page for @${username} after multiple attempts.`,
    };
  }
  await page.sleep(3000);

  // Wait for profile data
  await page.setProgress({
    phase: { step: 1, total: 3, label: 'Fetching profile' },
    message: 'Waiting for profile data...',
  });
  let profileData = null;
  // When posts are not requested, treat postsData as "already done" so the
  // wait loop exits as soon as the profile capture arrives.
  let postsData = wantsPosts ? null : { skipped: true };
  let attempts = 0;
  const maxAttempts = 30;

  while (attempts < maxAttempts && (!profileData || !postsData)) {
    await page.sleep(1000);
    attempts++;

    if (!profileData) {
      profileData = await page.getCapturedResponse('profileResponse');
      if (profileData) {
        await page.setProgress({
          phase: { step: 1, total: 3, label: 'Fetching profile' },
          message: 'Profile data captured!',
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
            collected_at: new Date().toISOString()
          };
          state.isProfileComplete = true;
          await page.setData('profile', state.profileData);

          // Scrape the following list once we have the authoritative user id
          // and expected following count. This runs against Instagram's
          // internal friendships endpoint via page.evaluate and is portable.
          if (wantsFollowing) {
            await page.setProgress({
              phase: { step: 1, total: 3, label: 'Fetching following' },
              message: `Fetching following list for @${state.profileData.username}...`,
            });
            state.followingAccounts = await scrapeFollowingAccounts(
              state.profileData.id || state.profileData.pk,
              state.profileData.following_count,
            );
            state.isFollowingComplete = true;
            await page.setData('following_count_collected', state.followingAccounts.length);
          } else {
            // Mark complete so the done check doesn't wait on it.
            state.isFollowingComplete = true;
          }
        }
      }
    }

    if (!postsData) {
      postsData = await page.getCapturedResponse('postsResponse');
      if (postsData) {
        await page.setProgress({
          phase: { step: 1, total: 3, label: 'Fetching profile' },
          message: 'Posts data captured!',
        });
      }
    }
  }

  // If we didn't get posts data (and posts were actually requested), try
  // scrolling to trigger loading.
  if (wantsPosts && !postsData) {
    await page.setProgress({
      phase: { step: 2, total: 3, label: 'Fetching posts' },
      message: 'Scrolling to load posts...',
      count: 0,
    });
    await page.evaluate(`window.scrollTo(0, document.body.scrollHeight)`);
    await page.sleep(2000);
    postsData = await page.getCapturedResponse('postsResponse');
  }

  // Process initial posts data (only when posts were requested — when
  // posts are skipped, postsData is a {skipped: true} sentinel that would
  // otherwise trip the truthiness check below).
  if (wantsPosts && postsData) {
    const timelineData = postsData?.data?.data?.xdt_api__v1__feed__user_timeline_graphql_connection;
    if (timelineData) {
      const { edges, page_info } = timelineData;
      if (edges && Array.isArray(edges)) {
        state.timelineEdges = edges;
        state.pageInfo = page_info;
        state.totalFetched = edges.length;
        const mediaCount = state.profileData?.media_count;

        await page.setProgress({
          phase: { step: 2, total: 3, label: 'Fetching posts' },
          message: mediaCount
            ? `Captured ${state.totalFetched} of ${mediaCount} posts`
            : `Captured ${state.totalFetched} posts`,
          count: state.totalFetched,
        });

        // Fetch more pages if available
        if (page_info?.has_next_page && page_info?.end_cursor) {

          let hasMore = true;
          let scrollAttempts = 0;
          const maxScrollAttempts = 20;

          while (hasMore && scrollAttempts < maxScrollAttempts) {
            scrollAttempts++;

            await page.clearNetworkCaptures();
            await page.captureNetwork({
              urlPattern: '/graphql',
              bodyPattern: 'PolarisProfilePostsQuery|PolarisProfilePostsTabContentQuery_connection|ProfilePostsQuery|UserMediaQuery',
              key: 'postsResponse'
            });

            await page.evaluate(`window.scrollTo(0, document.body.scrollHeight)`);
            await page.sleep(2000);

            const nextPostsData = await page.getCapturedResponse('postsResponse');
            if (nextPostsData) {
              const nextTimelineData = nextPostsData?.data?.data?.xdt_api__v1__feed__user_timeline_graphql_connection;
              if (nextTimelineData?.edges) {
                const { edges: newEdges, page_info: newPageInfo } = nextTimelineData;

                const existingIds = new Set(
                  state.timelineEdges.map(edge =>
                    edge.node?.id || edge.node?.pk || edge.node?.media_id || edge.node?.code
                  ).filter(Boolean)
                );

                const uniqueNewEdges = newEdges.filter(edge => {
                  const nodeId = edge.node?.id || edge.node?.pk || edge.node?.media_id || edge.node?.code;
                  return nodeId && !existingIds.has(nodeId);
                });

                if (uniqueNewEdges.length > 0) {
                  state.timelineEdges = [...state.timelineEdges, ...uniqueNewEdges];
                  state.pageInfo = newPageInfo;
                  state.totalFetched = state.timelineEdges.length;

                  await page.setProgress({
                    phase: { step: 2, total: 3, label: 'Fetching posts' },
                    message: mediaCount
                      ? `Captured ${state.totalFetched} of ${mediaCount} posts`
                      : `Captured ${state.totalFetched} posts`,
                    count: state.totalFetched,
                  });
                }

                hasMore = newPageInfo?.has_next_page && newPageInfo?.end_cursor && uniqueNewEdges.length > 0;
              } else {
                hasMore = false;
              }
            } else {
              hasMore = false;
            }
          }
        }

        state.isTimelineComplete = true;
      }
    }
  }

  // ═══ PHASE 3: Ad Interests ═══
  // Scrapes from Accounts Center. DOM uses stable ARIA roles:
  //   dialog > list > listitem (textContent = name)
  // "See all advertisers" opens a dialog; "See all ad topics" navigates to /ads/ad_topics/ dialog.
  //
  // Gated on instagram.ads: when the caller didn't request ads, we skip
  // the entire accountscenter navigation and dialog scraping.
  if (wantsAds) {
  await page.setProgress({
    phase: { step: 3, total: 3, label: 'Fetching ad interests' },
    message: 'Navigating to ad preferences...',
  });

  // Ads sub-page navigation failures are recoverable — we skip the ads
  // scope rather than killing the run. The scoped result will come back
  // with advertisers/ad_topics as empty arrays.
  const adsReachable = await safeGoto(
    'https://accountscenter.instagram.com/ads/',
  );
  if (!adsReachable) {
    console.error(
      '[instagram] Could not reach ads landing; skipping instagram.ads scope',
    );
  }
  await page.sleep(4000);

  // Helper: extract names from listitem elements inside a dialog
  const scrapeDialogList = async () => {
    return await page.evaluate(`
      (() => {
        const dialog = document.querySelector('[role="dialog"]');
        if (!dialog) return [];
        const items = dialog.querySelectorAll('[role="list"] [role="listitem"]');
        return Array.from(items).map(el => el.textContent.trim()).filter(t => t.length > 0);
      })()
    `);
  };

  // 1. Advertisers — click "See all" button to open dialog.
  // Wrapped in try/catch so a transient DOM or network issue in this
  // sub-phase doesn't kill the whole ads collection.
  if (adsReachable) {
    try {
      await page.setProgress({
        phase: { step: 3, total: 3, label: 'Fetching ad interests' },
        message: 'Collecting advertisers...',
      });

      await page.evaluate(`
        (() => {
          const btn = document.querySelector('[role="button"][aria-label*="advertiser" i]');
          if (btn) btn.click();
        })()
      `);
      await page.sleep(2000);

      const advertiserNames = await scrapeDialogList();
      state.adsData.advertisers = advertiserNames.map(name => ({ name }));

      // Close dialog
      await page.evaluate(`
        (() => {
          const dialog = document.querySelector('[role="dialog"]');
          const close = dialog?.querySelector('[aria-label="Close" i]');
          if (close) close.click();
        })()
      `);
      await page.sleep(1000);
    } catch (error) {
      console.error(
        '[instagram] advertisers scrape failed:',
        error?.message || String(error),
      );
    }
  }

  await page.setProgress({
    phase: { step: 3, total: 3, label: 'Fetching ad interests' },
    message: `Found ${state.adsData.advertisers.length} advertisers. Collecting ad topics...`,
  });

  // 2. Ad topics — navigate to sub-page which opens its own dialog.
  // Retry the navigation via safeGoto, and wrap the scrape in try/catch
  // so partial ads data (e.g., advertisers collected but topics failed)
  // still surfaces to the caller.
  const topicsReachable = await safeGoto(
    'https://accountscenter.instagram.com/ads/ad_topics/',
  );
  if (topicsReachable) {
    try {
      await page.sleep(3000);
      const topicNames = await page.evaluate(`
        (() => {
          const dialog = document.querySelector('[role="dialog"]');
          if (!dialog) return [];
          // "Your activity-based topics" section has a heading followed by a generic with topic text,
          // or list items. Collect all listitem texts from the dialog, filtering out non-topic entries.
          const items = dialog.querySelectorAll('[role="list"] [role="listitem"]');
          return Array.from(items)
            .map(el => el.textContent.trim())
            .filter(t => t.length > 0 && !t.toLowerCase().includes('special topic') && !t.toLowerCase().includes('see less'));
        })()
      `);
      state.adsData.ad_topics = topicNames.map(name => ({ name }));
    } catch (error) {
      console.error(
        '[instagram] ad topics scrape failed:',
        error?.message || String(error),
      );
    }
  } else {
    console.error(
      '[instagram] Could not reach ads/ad_topics; skipping topics sub-scrape',
    );
  }

  state.isAdsComplete = state.adsData.advertisers.length > 0 || state.adsData.ad_topics.length > 0;

  await page.setProgress({
    phase: { step: 3, total: 3, label: 'Fetching ad interests' },
    message: `Ad interests: ${state.adsData.advertisers.length} advertisers, ${state.adsData.ad_topics.length} topics`,
  });
  } // end if (wantsAds)

  // Transform data to schema format
  const transformDataForSchema = () => {
    const profile = state.profileData;
    const edges = state.timelineEdges;

    if (!profile) {
      return null;
    }

    const posts = (edges || []).map((edge) => {
      const node = edge.node;
      const imgUrl = node.image_versions2?.candidates?.[0]?.url ||
        node.carousel_media?.[0]?.image_versions2?.candidates?.[0]?.url || "";
      const caption = node.caption?.text || "";
      const numOfLikes = node.like_count || 0;
      const whoLiked = (node.facepile_top_likers || []).map((liker) => ({
        profile_pic_url: liker.profile_pic_url || "",
        pk: liker.pk || liker.id || "",
        username: liker.username || "",
        id: liker.id || liker.pk || ""
      }));

      return {
        img_url: imgUrl,
        caption: caption,
        num_of_likes: numOfLikes,
        who_liked: whoLiked
      };
    });

    // Build the scoped result, only including keys for scopes the caller
    // actually requested. When requestedScopesList is null (legacy),
    // wantsScope always returns true and all four scopes are emitted.
    const scopedResult = {};
    if (wantsProfile) {
      scopedResult['instagram.profile'] = {
        username: profile.username,
        full_name: profile.full_name,
        bio: profile.biography,
        profile_pic_url: profile.profile_pic_url,
        external_url: profile.external_url,
        follower_count: profile.follower_count,
        following_count: profile.following_count,
        media_count: profile.media_count,
        is_private: profile.is_private,
        is_verified: profile.is_verified,
        is_business: profile.is_business,
      };
    }
    if (wantsPosts) {
      scopedResult['instagram.posts'] = {
        posts: posts,
      };
    }
    if (wantsFollowing) {
      scopedResult['instagram.following'] = {
        accounts: state.followingAccounts,
        total: state.followingAccounts.length,
      };
    }
    if (wantsAds) {
      scopedResult['instagram.ads'] = {
        advertisers: state.adsData.advertisers,
        ad_topics: state.adsData.ad_topics,
      };
    }
    return {
      ...scopedResult,
      exportSummary: {
        count: posts.length,
        label: posts.length === 1 ? 'post' : 'posts'
      },
      timestamp: new Date().toISOString(),
      version: "2.0.0-playwright",
      platform: "instagram",
      requestedScopes: requestedScopesList,
    };
  };

  // Build final result
  state.isComplete = state.isProfileComplete;
  const result = transformDataForSchema();

  if (result) {
    await page.setData('result', result);
    const postCount = result['instagram.posts']?.posts?.length || 0;
    const adCount = result['instagram.ads']?.advertisers?.length || 0;
    const topicCount = result['instagram.ads']?.ad_topics?.length || 0;
    await page.setData('status', `Complete! ${postCount} posts, ${adCount} advertisers, ${topicCount} ad topics collected for @${result['instagram.profile']?.username}`);
    return { success: true, data: result };
  } else {
    await page.setData('error', 'Failed to transform data');
    return { success: false, error: 'Failed to transform data' };
  }
})();

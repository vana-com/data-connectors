/**
 * Instagram Connector (Playwright)
 *
 * Exports:
 * - instagram.profile — Profile information (bio, follower counts)
 * - instagram.posts — Published posts (images, captions, likes)
 * - instagram.ads — Ad interests (advertisers, ad topics)
 *
 * Extraction method: Network capture (GraphQL) + DOM scraping (ads)
 */

// ─── Credentials ─────────────────────────────────────────────

const INSTAGRAM_LOGIN = process.env.USER_LOGIN_INSTAGRAM || '';
const INSTAGRAM_PASSWORD = process.env.USER_PASSWORD_INSTAGRAM || '';

// ─── State ───────────────────────────────────────────────────

const state = {
  webInfo: null,
  profileData: null,
  timelineEdges: [],
  pageInfo: null,
  totalFetched: 0,
  adsData: { advertisers: [], ad_topics: [] },
  isProfileComplete: false,
  isTimelineComplete: false,
  isAdsComplete: false,
};

// ─── Login Detection ─────────────────────────────────────────

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

const checkLoginStatus = async () => {
  const webInfo = await fetchWebInfo();
  if (webInfo && webInfo.username) {
    state.webInfo = webInfo;
    return true;
  }
  return false;
};

// ─── Automated Login ─────────────────────────────────────────

const performLogin = async () => {
  const loginStr = JSON.stringify(INSTAGRAM_LOGIN);
  const passwordStr = JSON.stringify(INSTAGRAM_PASSWORD);

  await page.goto('https://www.instagram.com/accounts/login/');
  await page.sleep(3000);

  // Instagram is a React app — use nativeInputValueSetter for reliable input
  await page.evaluate(`
    (() => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      ).set;

      const usernameInput = document.querySelector('input[name="username"]');
      const passwordInput = document.querySelector('input[name="password"]');

      if (usernameInput) {
        usernameInput.focus();
        nativeInputValueSetter.call(usernameInput, ${loginStr});
        usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
        usernameInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (passwordInput) {
        passwordInput.focus();
        nativeInputValueSetter.call(passwordInput, ${passwordStr});
        passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
        passwordInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()
  `);
  await page.sleep(1000);

  // Click the Log In button
  await page.evaluate(`
    (() => {
      const btn = document.querySelector('button[type="submit"]');
      if (btn) btn.click();
    })()
  `);
  await page.sleep(5000);
};

// ─── Main Export Flow ────────────────────────────────────────

(async () => {
  const TOTAL_STEPS = 3;

  // ═══ PHASE 1: Automated Login ═══
  await page.setData('status', 'Checking login status...');
  await page.goto('https://www.instagram.com/');
  await page.sleep(3000);

  let isLoggedIn = await checkLoginStatus();

  if (!isLoggedIn) {
    if (!INSTAGRAM_LOGIN || !INSTAGRAM_PASSWORD) {
      await page.setData('error', 'No credentials found. Set USER_LOGIN_INSTAGRAM and USER_PASSWORD_INSTAGRAM in .env');
      return;
    }
    await page.setData('status', 'Logging in...');
    await performLogin();

    isLoggedIn = await checkLoginStatus();
    if (!isLoggedIn) {
      await page.sleep(5000);
      isLoggedIn = await checkLoginStatus();
    }
    if (!isLoggedIn) {
      await page.setData('error', 'Automated login failed. Check credentials or login flow (possible 2FA/CAPTCHA).');
      return;
    }
    await page.setData('status', 'Login successful');
  } else {
    await page.setData('status', 'Session restored from previous login');
  }

  // ═══ PHASE 2: Data Collection (headless) ═══
  await page.goHeadless();

  const username = state.webInfo?.username;
  if (!username) {
    await page.setData('error', 'Could not determine username from web_info');
    return;
  }

  await page.setData('status', 'Logged in as @' + username);

  // ═══ STEP 1: Profile + Posts via Network Capture ═══
  await page.setProgress({
    phase: { step: 1, total: TOTAL_STEPS, label: 'Fetching profile' },
    message: 'Setting up network capture...',
  });

  await page.captureNetwork({
    urlPattern: '/graphql',
    bodyPattern: 'PolarisProfilePageContentQuery|ProfilePageQuery|UserByUsernameQuery',
    key: 'profileResponse'
  });

  await page.captureNetwork({
    urlPattern: '/graphql',
    bodyPattern: 'PolarisProfilePostsQuery|PolarisProfilePostsTabContentQuery_connection|ProfilePostsQuery|UserMediaQuery',
    key: 'postsResponse'
  });

  await page.setProgress({
    phase: { step: 1, total: TOTAL_STEPS, label: 'Fetching profile' },
    message: 'Navigating to profile: @' + username,
  });
  await page.goto('https://www.instagram.com/' + username + '/');
  await page.sleep(3000);

  // Wait for profile and posts data from network captures
  await page.setProgress({
    phase: { step: 1, total: TOTAL_STEPS, label: 'Fetching profile' },
    message: 'Waiting for profile data...',
  });

  let profileData = null;
  let postsData = null;
  let attempts = 0;
  const maxAttempts = 30;

  while (attempts < maxAttempts && (!profileData || !postsData)) {
    await page.sleep(1000);
    attempts++;

    if (!profileData) {
      profileData = await page.getCapturedResponse('profileResponse');
      if (profileData) {
        const userData = profileData?.data?.data?.user;
        if (userData) {
          state.profileData = {
            username: userData.username,
            full_name: userData.full_name,
            biography: userData.biography,
            follower_count: userData.follower_count,
            following_count: userData.following_count,
            media_count: userData.media_count,
            profile_pic_url: userData.profile_pic_url,
            hd_profile_pic_url: userData.hd_profile_pic_url_info?.url,
            is_private: userData.is_private,
            is_verified: userData.is_verified,
            is_business: userData.is_business,
            external_url: userData.external_url,
          };
          state.isProfileComplete = true;
          await page.setProgress({
            phase: { step: 1, total: TOTAL_STEPS, label: 'Fetching profile' },
            message: 'Profile data captured!',
          });
        }
      }
    }

    if (!postsData) {
      postsData = await page.getCapturedResponse('postsResponse');
    }
  }

  // ═══ STEP 2: Posts Pagination ═══
  await page.setProgress({
    phase: { step: 2, total: TOTAL_STEPS, label: 'Fetching posts' },
    message: 'Processing posts...',
  });

  // If posts weren't captured, try scrolling
  if (!postsData) {
    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    await page.sleep(2000);
    postsData = await page.getCapturedResponse('postsResponse');
  }

  if (postsData) {
    const timelineData = postsData?.data?.data?.xdt_api__v1__feed__user_timeline_graphql_connection;
    if (timelineData) {
      const { edges, page_info } = timelineData;
      if (edges && Array.isArray(edges)) {
        state.timelineEdges = edges;
        state.pageInfo = page_info;
        state.totalFetched = edges.length;
        const mediaCount = state.profileData?.media_count;

        await page.setProgress({
          phase: { step: 2, total: TOTAL_STEPS, label: 'Fetching posts' },
          message: mediaCount
            ? 'Captured ' + state.totalFetched + ' of ' + mediaCount + ' posts'
            : 'Captured ' + state.totalFetched + ' posts',
          count: state.totalFetched,
        });

        // Paginate for more posts
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

            await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
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
                    phase: { step: 2, total: TOTAL_STEPS, label: 'Fetching posts' },
                    message: mediaCount
                      ? 'Captured ' + state.totalFetched + ' of ' + mediaCount + ' posts'
                      : 'Captured ' + state.totalFetched + ' posts',
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

  // ═══ STEP 3: Ad Interests (DOM scraping from Accounts Center) ═══
  await page.setProgress({
    phase: { step: 3, total: TOTAL_STEPS, label: 'Fetching ad interests' },
    message: 'Navigating to ad preferences...',
  });

  await page.goto('https://accountscenter.instagram.com/ads/');
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

  // Advertisers — click "See all" button to open dialog
  await page.setProgress({
    phase: { step: 3, total: TOTAL_STEPS, label: 'Fetching ad interests' },
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

  await page.setProgress({
    phase: { step: 3, total: TOTAL_STEPS, label: 'Fetching ad interests' },
    message: 'Found ' + state.adsData.advertisers.length + ' advertisers. Collecting ad topics...',
  });

  // Ad topics — navigate to sub-page
  await page.goto('https://accountscenter.instagram.com/ads/ad_topics/');
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
  state.adsData.ad_topics = topicNames.map(name => ({ name }));

  state.isAdsComplete = state.adsData.advertisers.length > 0 || state.adsData.ad_topics.length > 0;

  await page.setProgress({
    phase: { step: 3, total: TOTAL_STEPS, label: 'Fetching ad interests' },
    message: 'Ad interests: ' + state.adsData.advertisers.length + ' advertisers, ' + state.adsData.ad_topics.length + ' topics',
  });

  // ═══ Build Result ═══
  const posts = (state.timelineEdges || []).map((edge) => {
    const node = edge.node;
    const imgUrl = node.image_versions2?.candidates?.[0]?.url ||
      node.carousel_media?.[0]?.image_versions2?.candidates?.[0]?.url || '';
    const caption = node.caption?.text || '';
    const numOfLikes = node.like_count || 0;
    const whoLiked = (node.facepile_top_likers || []).map((liker) => ({
      profile_pic_url: liker.profile_pic_url || '',
      pk: String(liker.pk || liker.id || ''),
      username: liker.username || '',
      id: String(liker.id || liker.pk || '')
    }));

    return { img_url: imgUrl, caption: caption, num_of_likes: numOfLikes, who_liked: whoLiked };
  });

  const profile = state.profileData || {};

  const result = {
    'instagram.profile': {
      username: profile.username || '',
      full_name: profile.full_name || '',
      bio: profile.biography || '',
      profile_pic_url: profile.profile_pic_url || '',
      external_url: profile.external_url || null,
      follower_count: profile.follower_count || 0,
      following_count: profile.following_count || 0,
      media_count: profile.media_count || 0,
      is_private: profile.is_private || false,
      is_verified: profile.is_verified || false,
      is_business: profile.is_business || false,
    },
    'instagram.posts': {
      posts: posts,
    },
    'instagram.ads': {
      advertisers: state.adsData.advertisers,
      ad_topics: state.adsData.ad_topics,
    },
    exportSummary: {
      count: posts.length + state.adsData.advertisers.length + state.adsData.ad_topics.length,
      label: 'items',
      details: posts.length + ' posts, ' + state.adsData.advertisers.length + ' advertisers, ' + state.adsData.ad_topics.length + ' ad topics',
    },
    timestamp: new Date().toISOString(),
    version: '1.0.0-playwright',
    platform: 'instagram',
  };

  await page.setData('result', result);
  await page.setData('status', 'Complete! Exported ' + result.exportSummary.details);
})();

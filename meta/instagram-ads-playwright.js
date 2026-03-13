/**
 * Instagram Ads Connector (Playwright)
 *
 * Exports:
 * - instagram.ads — advertisers, ad topics, and targeting categories from Meta Accounts Center
 *
 * Extraction: DOM scraping of Accounts Center dialogs (ARIA roles)
 * Optimized: no profile/posts fetch, DOM-readiness polling instead of fixed waits.
 */

// ─── Helpers ─────────────────────────────────────────────

// Poll for a CSS selector to appear, returning true when found or false on timeout.
const waitForSelector = async (selector, timeoutMs) => {
  const selectorStr = JSON.stringify(selector);
  try {
    return await page.evaluate(`
      new Promise((resolve) => {
        const el = document.querySelector(${selectorStr});
        if (el) return resolve(true);
        const interval = setInterval(() => {
          if (document.querySelector(${selectorStr})) {
            clearInterval(interval);
            resolve(true);
          }
        }, 150);
        setTimeout(() => { clearInterval(interval); resolve(false); }, ${timeoutMs});
      })
    `);
  } catch (e) {
    return false;
  }
};

// Scrape all listitem texts from the first dialog's list on the page.
const scrapeDialogList = async () => {
  try {
    return await page.evaluate(`
      (() => {
        const dialog = document.querySelector('[role="dialog"]');
        if (!dialog) return [];
        const items = dialog.querySelectorAll('[role="list"] [role="listitem"]');
        return Array.from(items).map(el => el.textContent.trim()).filter(t => t.length > 0);
      })()
    `);
  } catch (e) {
    return [];
  }
};

// ─── Login Detection ─────────────────────────────────────

const checkLoginStatus = async () => {
  try {
    return await page.evaluate(`
      (() => {
        const url = window.location.href;

        // Redirected to login — not authenticated
        if (url.includes('/accounts/login') || url.includes('/sign_in') ||
            !!document.querySelector('input[type="password"]')) {
          return false;
        }

        // On Accounts Center — navigation elements mean we're logged in
        if (url.includes('accountscenter.instagram.com') || url.includes('accountscenter.facebook.com')) {
          return !!(
            document.querySelector('[role="banner"]') ||
            document.querySelector('[role="navigation"]') ||
            document.querySelector('[role="dialog"]') ||
            document.querySelector('[role="list"]') ||
            document.querySelector('[role="button"]')
          );
        }

        // On instagram.com main site
        if (url.includes('instagram.com')) {
          return !!(
            document.querySelector('svg[aria-label="Home"]') ||
            document.querySelector('a[href="/direct/inbox/"]')
          );
        }

        return false;
      })()
    `);
  } catch (e) {
    return false;
  }
};

// ─── Main Export Flow ────────────────────────────────────

(async () => {
  // ═══ Login check ═══
  await page.setData('status', 'Checking login...');

  // Wait for initial page (connectURL) to settle
  await page.sleep(1500);

  let isLoggedIn = await checkLoginStatus();

  if (!isLoggedIn) {
    // Show headed browser for manual login
    await page.showBrowser('https://www.instagram.com/accounts/login/');
    await page.promptUser(
      'Please log in to Instagram. Login will be detected automatically.',
      async () => await checkLoginStatus(),
      2000
    );
    await page.goHeadless();
    isLoggedIn = true;
  } else {
    await page.setData('status', 'Session active');
  }

  // ═══ Navigate to Ads page ═══
  // connectURL may have already taken us here, but after login flow we may be elsewhere
  await page.setProgress({
    phase: { step: 1, total: 3, label: 'Advertisers' },
    message: 'Loading ad preferences...',
  });

  const currentUrl = await page.evaluate(`window.location.href`);
  if (!currentUrl.includes('accountscenter.instagram.com/ads')) {
    await page.goto('https://accountscenter.instagram.com/ads/');
  }

  // Wait for page to have interactive content
  const adsPageReady = await waitForSelector('[role="button"]', 8000);
  if (!adsPageReady) {
    // Page may be slow — give it one more second
    await page.sleep(1000);
  }

  // ═══ Step 1: Advertisers ═══
  await page.setProgress({
    phase: { step: 1, total: 3, label: 'Advertisers' },
    message: 'Opening advertisers list...',
  });

  // Click "See all advertisers" button to open dialog
  const clickedAdvertisers = await page.evaluate(`
    (() => {
      const btn = document.querySelector('[role="button"][aria-label*="advertiser" i]');
      if (btn) { btn.click(); return true; }
      return false;
    })()
  `);

  let advertiserNames = [];
  if (clickedAdvertisers) {
    // Wait for dialog with list to appear
    const dialogReady = await waitForSelector('[role="dialog"] [role="list"]', 5000);
    if (!dialogReady) {
      await waitForSelector('[role="dialog"]', 2000);
    }
    advertiserNames = await scrapeDialogList();

    // Close dialog before proceeding
    await page.evaluate(`
      (() => {
        const dialog = document.querySelector('[role="dialog"]');
        const close = dialog?.querySelector('[aria-label="Close" i]');
        if (close) close.click();
      })()
    `);
    // Brief pause for dialog close animation
    await page.sleep(300);
  }

  await page.setProgress({
    phase: { step: 1, total: 3, label: 'Advertisers' },
    message: `Found ${advertiserNames.length} advertisers`,
    count: advertiserNames.length,
  });

  // ═══ Step 2: Ad Topics ═══
  await page.setProgress({
    phase: { step: 2, total: 3, label: 'Ad topics' },
    message: 'Loading ad topics...',
  });

  await page.goto('https://accountscenter.instagram.com/ads/ad_topics/');

  // Wait for dialog/list to appear
  const topicsReady = await waitForSelector('[role="dialog"] [role="list"]', 5000);
  if (!topicsReady) {
    await waitForSelector('[role="dialog"]', 2000);
  }

  const topicNames = await page.evaluate(`
    (() => {
      try {
        const dialog = document.querySelector('[role="dialog"]');
        if (!dialog) return [];
        const items = dialog.querySelectorAll('[role="list"] [role="listitem"]');
        return Array.from(items)
          .map(el => el.textContent.trim())
          .filter(t => t.length > 0 &&
            !t.toLowerCase().includes('special topic') &&
            !t.toLowerCase().includes('see less'));
      } catch (e) { return []; }
    })()
  `);

  // ═══ Step 3: Categories used to reach you ═══
  await page.setProgress({
    phase: { step: 3, total: 3, label: 'Targeting categories' },
    message: 'Loading targeting categories...',
  });

  // Navigate back to the ads page to access Manage info tab
  await page.goto('https://accountscenter.instagram.com/ads/');
  await waitForSelector('[role="tab"]', 5000);

  // Click "Manage info" tab (second tab in the tab pair)
  await page.evaluate(`
    (() => {
      const tabs = document.querySelectorAll('[role="tab"]');
      for (const tab of tabs) {
        if (tab.textContent.trim().includes('Manage info')) {
          tab.click();
          return true;
        }
      }
      return false;
    })()
  `);

  // Wait for Manage info content to load, then click "Categories used to reach you"
  await waitForSelector('[role="tabpanel"]', 3000);
  await page.sleep(500);

  const clickedCategories = await page.evaluate(`
    (() => {
      const links = document.querySelectorAll('[role="tabpanel"] a, [role="tabpanel"] [role="link"]');
      for (const link of links) {
        if (link.textContent.includes('Categories used to reach you')) {
          link.click();
          return true;
        }
      }
      return false;
    })()
  `);

  let categories = [];
  if (clickedCategories) {
    // Wait for the categories dialog to appear (it overlays the page)
    // The dialog contains a heading "Categories used to reach you" and listitems with "Remove" buttons
    await waitForSelector('button[aria-label="Close"], [role="button"][aria-label="Close"]', 5000);
    await page.sleep(500);

    // Click "View all" if present to expand the full list
    await page.evaluate(`
      (() => {
        const btns = document.querySelectorAll('button, [role="button"]');
        for (const btn of btns) {
          if (btn.textContent.trim() === 'View all') {
            btn.click();
            return true;
          }
        }
        return false;
      })()
    `);

    // Wait for expanded list to load
    await page.sleep(500);

    // Scrape categories — only items that have a "Remove" button (actual targeting categories)
    categories = await page.evaluate(`
      (() => {
        try {
          const items = document.querySelectorAll('[role="listitem"]');
          const seen = new Set();
          return Array.from(items).map(item => {
            // Only include listitems that have a Remove button — these are actual categories
            const removeBtn = item.querySelector('button, [role="button"]');
            if (!removeBtn || !removeBtn.textContent.includes('Remove')) return null;
            const texts = [];
            const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT, null);
            let node;
            while (node = walker.nextNode()) {
              const t = node.textContent.trim();
              if (t && t !== 'Remove' && t !== 'Removed categories') texts.push(t);
            }
            if (texts.length === 0) return null;
            // Deduplicate by name
            if (seen.has(texts[0])) return null;
            seen.add(texts[0]);
            return {
              name: texts[0],
              description: texts.length > 1 ? texts[1] : null
            };
          }).filter(Boolean);
        } catch (e) { return []; }
      })()
    `);

    // Close dialog
    await page.evaluate(`
      (() => {
        const btns = document.querySelectorAll('button, [role="button"]');
        for (const btn of btns) {
          const label = btn.getAttribute('aria-label') || '';
          if (label === 'Close') { btn.click(); return; }
        }
      })()
    `);
  }

  await page.setProgress({
    phase: { step: 3, total: 3, label: 'Targeting categories' },
    message: `Found ${categories.length} targeting categories`,
    count: categories.length,
  });

  // ═══ Build result ═══
  const advertisers = advertiserNames.map(name => ({ name }));
  const ad_topics = topicNames.map(name => ({ name }));

  if (advertisers.length === 0 && ad_topics.length === 0 && categories.length === 0) {
    await page.setData('error', 'No ad data found. The account may have no ad history, or the Accounts Center layout may have changed.');
  }

  const result = {
    'instagram.ads': {
      advertisers,
      ad_topics,
      categories,
    },
    exportSummary: {
      count: advertisers.length + ad_topics.length + categories.length,
      label: 'ad interests',
      details: `${advertisers.length} advertisers, ${ad_topics.length} ad topics, ${categories.length} targeting categories`,
    },
    timestamp: new Date().toISOString(),
    version: '1.0.0-playwright',
    platform: 'instagram',
  };

  await page.setData('result', result);
  await page.setData('status', `Complete! ${advertisers.length} advertisers, ${ad_topics.length} ad topics, ${categories.length} targeting categories`);

  return result;
})();

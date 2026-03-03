/**
 * Amazon Connector (Playwright)
 *
 * Exports:
 * - amazon.profile  — Account name, email, Prime status
 * - amazon.orders   — Order history with items, prices, dates, and status
 *
 * Extraction method: DOM scraping (Amazon uses server-rendered HTML, no clean JSON APIs)
 *
 * Architecture:
 *   Phase 1 (visible browser): User logs in manually (handles CAPTCHA / 2FA)
 *   Phase 2 (headless): Scrape profile page + paginated order history year-by-year
 */

const state = {
  profile: null,
  orders: [],
  isComplete: false,
};

// ─── Login Detection ──────────────────────────────────────

// Quick check: does the nav bar look logged in? (can be fooled by stale cookies)
const checkNavBarLogin = async () => {
  try {
    return await page.evaluate(`
      (() => {
        // Sign-in form means NOT logged in
        const hasLoginForm = !!document.querySelector("form[name='signIn']");
        if (hasLoginForm) return false;

        // CAPTCHA / 2FA challenge pages
        const hasCaptcha = !!document.querySelector('form.cvf-widget-form-captcha');
        const hasMfa = !!document.querySelector('form#auth-mfa-form');
        const hasChallenge = window.location.href.includes('/ap/challenge') ||
                             window.location.href.includes('/ap/mfa') ||
                             window.location.href.includes('/ap/signin');
        if (hasCaptcha || hasMfa || hasChallenge) return false;

        // Logged-in indicator: nav greeting shows "Hello, <Name>" (not "Hello, Sign in")
        const navLink = document.querySelector('#nav-link-accountList');
        const greeting = (navLink?.textContent || '').trim();
        const isLoggedIn = greeting.includes('Hello') && !greeting.includes('Sign in');

        return isLoggedIn;
      })()
    `);
  } catch (e) {
    return false;
  }
};

// Deep check: navigate to an authenticated page and verify the session is truly valid.
// Amazon shows "Hello, Name" in the nav bar from stale cookies even when the session
// has expired, so we must verify by actually hitting an authenticated endpoint.
const verifySession = async () => {
  try {
    await page.goto('https://www.amazon.com/your-orders/orders');
    await page.sleep(2500);

    return await page.evaluate(`
      (() => {
        const url = window.location.href;
        // If we got redirected to sign-in, session is invalid
        if (url.includes('/ap/signin') || url.includes('/ap/challenge') || url.includes('/ap/mfa')) {
          return false;
        }
        // If a sign-in form appeared, session is invalid
        const hasLoginForm = !!document.querySelector("form[name='signIn']");
        if (hasLoginForm) return false;
        // If we're still on the orders page, session is valid
        return url.includes('/your-orders') || url.includes('/order-history');
      })()
    `);
  } catch (e) {
    return false;
  }
};

// ─── Profile Extraction ───────────────────────────────────

const extractProfile = async () => {
  try {
    // Navigate to account settings page — has both name and email
    await page.goto('https://www.amazon.com/gp/css/homepage.html');
    await page.sleep(2000);

    const profile = await page.evaluate(`
      (() => {
        let name = '';
        let email = '';
        let isPrime = false;

        // ── Name extraction ──
        // Strategy 1: nav bar greeting "Hello, <Name>"
        const greetingSpan = document.querySelector('#nav-link-accountList .nav-line-1');
        const greeting = (greetingSpan?.textContent || '').trim();
        const nameMatch = greeting.match(/Hello,\\s*(.+)/);
        if (nameMatch) name = nameMatch[1].trim();

        // Strategy 2: account settings page shows name in a section
        if (!name) {
          const pageText = document.body.innerText || '';
          // Look for "Name:\\n<actual name>" or "Name<newline>SomeName" pattern
          const namePatterns = [
            /(?:^|\\n)\\s*Name[:\\s]*\\n\\s*([A-Z][a-zA-Z]+(?:\\s+[A-Z][a-zA-Z]+)*)/m,
            /(?:^|\\n)\\s*([A-Z][a-zA-Z]+(?:\\s+[A-Z][a-zA-Z]+)+)\\s*(?:\\n|Edit)/m,
          ];
          for (const pattern of namePatterns) {
            const m = pageText.match(pattern);
            if (m && m[1] && m[1].length > 1 && m[1].length < 60) {
              name = m[1].trim();
              break;
            }
          }
        }

        // ── Email extraction ──
        // Strategy 1: search all text nodes for an isolated email address
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const text = walker.currentNode.textContent.trim();
          const match = text.match(/^[a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}$/);
          if (match) { email = match[0]; break; }
        }

        // Strategy 2: scan innerText lines for an email
        if (!email) {
          const bodyText = document.body.innerText || '';
          const emailMatch = bodyText.match(/[a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}/);
          if (emailMatch) email = emailMatch[0];
        }

        // ── Prime status ──
        isPrime = !!document.querySelector('#nav-prime-menu') ||
                  !!document.querySelector('a[href*="/prime"] img') ||
                  !!document.querySelector('#navbar-prime, [data-nav-ref="nav_prime_try"]');

        return { name, email, isPrime };
      })()
    `);

    return {
      name: profile?.name || '',
      email: profile?.email || '',
      isPrime: profile?.isPrime || false,
    };
  } catch (e) {
    return null;
  }
};

// ─── Order History Extraction ─────────────────────────────

// Get available years from the order filter dropdown
const getOrderYears = async () => {
  try {
    await page.goto('https://www.amazon.com/your-orders/orders');
    await page.sleep(2000);

    return await page.evaluate(`
      (() => {
        // Find the year filter dropdown options
        const options = document.querySelectorAll(
          'select#time-filter option, ' +
          'select[name="timeFilter"] option, ' +
          'form#timePeriodForm select option'
        );
        const years = [];
        for (const opt of options) {
          const value = opt.value || opt.getAttribute('value') || '';
          const yearMatch = value.match(/year-(\\d{4})/);
          if (yearMatch) {
            years.push(parseInt(yearMatch[1], 10));
          }
        }

        // If dropdown not found, try parsing from page links or fallback
        if (years.length === 0) {
          const links = document.querySelectorAll('a[href*="timeFilter=year-"]');
          for (const link of links) {
            const href = link.getAttribute('href') || '';
            const yearMatch = href.match(/year-(\\d{4})/);
            if (yearMatch) years.push(parseInt(yearMatch[1], 10));
          }
        }

        // Deduplicate and sort descending
        return [...new Set(years)].sort((a, b) => b - a);
      })()
    `);
  } catch (e) {
    return [];
  }
};

// Extract orders from a single page of results
const extractOrdersFromPage = async () => {
  try {
    return await page.evaluate(`
      (() => {
        const orders = [];

        // Use div.order-card (confirmed via debug dump) — do NOT use div.a-box-group
        // which is too broad and matches sub-boxes within each order card
        const orderCards = document.querySelectorAll(
          'div.order-card, ' +
          'div.js-order-card'
        );

        for (const card of orderCards) {
          try {
            // ── Order metadata: search the full card text for patterns ──

            const cardText = card.textContent || '';

            // Order date — search for date pattern in the card's full text
            let orderDate = '';
            const dateMatch = cardText.match(
              /(?:January|February|March|April|May|June|July|August|September|October|November|December)\\s+\\d{1,2},\\s+\\d{4}/
            );
            if (dateMatch) orderDate = dateMatch[0];

            // Order total — search for price pattern prefixed by "Total" or "Grand Total"
            let orderTotal = '';
            const totalMatch = cardText.match(/(?:Total|ORDER TOTAL)[\\s\\S]{0,20}?(\\$[\\d,.]+)/i);
            if (totalMatch) {
              orderTotal = totalMatch[1];
            } else {
              // Fallback: find any dollar amount in the order header area
              const headerArea = card.querySelector('.order-header, .a-box:first-child');
              if (headerArea) {
                const headerPriceMatch = (headerArea.textContent || '').match(/\\$[\\d,.]+/);
                if (headerPriceMatch) orderTotal = headerPriceMatch[0];
              }
            }

            // Order number — search for order ID pattern (###-#######-#######)
            let orderId = '';
            const idMatch = cardText.match(/\\d{3}-\\d{7}-\\d{7}/);
            if (idMatch) orderId = idMatch[0];

            // ── Items within this order ──

            const itemEls = card.querySelectorAll(
              'a[href*="/dp/"], ' +
              'a[href*="/gp/product/"]'
            );
            const items = [];
            const seenItems = new Set();
            for (const itemEl of itemEls) {
              const itemName = (itemEl.textContent || '').replace(/\\s+/g, ' ').trim();
              const itemUrl = itemEl.getAttribute('href') || '';
              if (!itemName || itemName.length < 3 || seenItems.has(itemName)) continue;
              seenItems.add(itemName);

              items.push({
                name: itemName,
                url: itemUrl.startsWith('http') ? itemUrl : ('https://www.amazon.com' + itemUrl),
                price: '',
              });
            }

            // Delivery status — use innerText to exclude <script> tag content
            // (textContent includes JS keywords like "return;" that false-match)
            let deliveryStatus = '';
            const visibleText = card.innerText || '';
            const statusMatch = visibleText.match(
              /(?:Delivered|Arriving|Shipped|Out for delivery|Return (?:started|complete|processed)|Refund|Cancelled)[^\\n]*/i
            );
            if (statusMatch) {
              deliveryStatus = statusMatch[0].replace(/\\s+/g, ' ').trim().substring(0, 100);
            }

            if (orderId || items.length > 0) {
              orders.push({
                orderId,
                orderDate,
                orderTotal,
                deliveryStatus,
                items,
              });
            }
          } catch (e) {
            // Skip malformed order card
          }
        }

        // Check for next page
        const nextPageLink = document.querySelector(
          'ul.a-pagination li.a-last a, ' +
          'a[href*="startIndex"]:not([href*="startIndex=0"])'
        );
        const hasNextPage = !!nextPageLink;

        return { orders, hasNextPage };
      })()
    `);
  } catch (e) {
    return { orders: [], hasNextPage: false };
  }
};

// Fetch an order's detail page and extract per-item prices.
// The detail page shows each item with its individual price.
const fetchOrderPrices = async (orderId) => {
  try {
    const detailUrl = `https://www.amazon.com/gp/your-account/order-details?orderID=${encodeURIComponent(orderId)}`;
    await page.goto(detailUrl);
    await page.sleep(1500);

    return await page.evaluate(`
      (() => {
        const prices = {};
        // On the detail page, each item row has a product link and a price nearby.
        // Look for item links and find the associated price in their container.
        const itemLinks = document.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]');
        const seen = new Set();
        for (const link of itemLinks) {
          const name = (link.textContent || '').replace(/\\s+/g, ' ').trim();
          if (!name || name.length < 3 || seen.has(name)) continue;
          seen.add(name);

          // Walk up to find a row-level container that has a price
          let el = link.parentElement;
          for (let d = 0; d < 8 && el; d++) {
            const text = el.textContent || '';
            const priceMatch = text.match(/\\$\\d+\\.\\d{2}/);
            if (priceMatch) {
              prices[name] = priceMatch[0];
              break;
            }
            el = el.parentElement;
          }
        }
        return prices;
      })()
    `);
  } catch (e) {
    return {};
  }
};

// Enrich a batch of orders with per-item prices from their detail pages
const enrichOrdersWithPrices = async (orders, progressPrefix) => {
  for (let i = 0; i < orders.length; i++) {
    const order = orders[i];
    if (!order.orderId) continue;
    // Skip if all items already have prices
    if (order.items.every(item => item.price)) continue;

    const prices = await fetchOrderPrices(order.orderId);

    // Match prices to items by name
    for (const item of order.items) {
      if (item.price) continue;
      if (prices[item.name]) {
        item.price = prices[item.name];
      }
    }
  }
};

// Extract all orders for a given year
const extractOrdersForYear = async (year, stepLabel) => {
  const yearOrders = [];
  let startIndex = 0;
  const maxPages = 50;

  for (let pageNum = 0; pageNum < maxPages; pageNum++) {
    const url = `https://www.amazon.com/your-orders/orders?timeFilter=year-${year}&startIndex=${startIndex}`;
    await page.goto(url);
    await page.sleep(2000);

    const result = await extractOrdersFromPage();
    const pageOrders = result?.orders || [];
    yearOrders.push(...pageOrders);

    await page.setProgress({
      phase: { step: 2, total: 2, label: stepLabel },
      message: `${year}: ${yearOrders.length} orders so far (page ${pageNum + 1})...`,
      count: yearOrders.length,
    });

    if (!result?.hasNextPage || pageOrders.length === 0) break;
    startIndex += 10;
    await page.sleep(1500);
  }

  // Enrich orders with per-item prices from detail pages
  if (yearOrders.length > 0) {
    await page.setProgress({
      phase: { step: 2, total: 2, label: stepLabel },
      message: `${year}: Fetching item prices for ${yearOrders.length} orders...`,
      count: yearOrders.length,
    });
    await enrichOrdersWithPrices(yearOrders);
  }

  return yearOrders;
};

// ─── Main Export Flow ─────────────────────────────────────

(async () => {
  const TOTAL_STEPS = 2;

  // ═══ PHASE 1: Login Detection ═══
  await page.setData('status', 'Checking login status...');
  await page.sleep(2000);

  // First quick check: does the nav bar look logged in?
  let navBarOk = await checkNavBarLogin();

  // Even if nav bar looks good, verify session is actually valid
  // (stale cookies can make the nav bar show "Hello, Name" with an expired session)
  let sessionValid = false;
  if (navBarOk) {
    await page.setData('status', 'Verifying session...');
    sessionValid = await verifySession();
  }

  if (!sessionValid) {
    // Session is invalid or expired — show browser for manual login.
    // Navigate to a clean Amazon page (not force_login which causes redirect loops).
    await page.showBrowser('https://www.amazon.com');
    await page.setData('status', 'Please log in to Amazon...');
    await page.sleep(3000);

    await page.promptUser(
      'Please log in to Amazon. Complete any CAPTCHA or two-factor authentication, then click "Done" when you see the homepage with your name.',
      async () => await checkNavBarLogin(),
      3000
    );

    // After user says they're logged in, verify the session is real
    await page.setData('status', 'Verifying login...');
    sessionValid = await verifySession();
    if (!sessionValid) {
      await page.setData('error', 'Login could not be verified. Please try again.');
      return;
    }

    await page.setData('status', 'Login verified');
    await page.sleep(1000);
  } else {
    await page.setData('status', 'Session restored from previous login');
  }

  // ═══ Switch to headless ═══
  await page.goHeadless();

  // ═══ PHASE 2: Data Collection ═══

  // Step 1: Extract profile
  await page.setProgress({
    phase: { step: 1, total: TOTAL_STEPS, label: 'Profile' },
    message: 'Extracting profile information...',
  });

  state.profile = await extractProfile();

  if (state.profile) {
    await page.setProgress({
      phase: { step: 1, total: TOTAL_STEPS, label: 'Profile' },
      message: `Profile: ${state.profile.name || 'Unknown'}${state.profile.isPrime ? ' (Prime)' : ''}`,
    });
  }

  // Step 2: Extract order history
  await page.setProgress({
    phase: { step: 2, total: TOTAL_STEPS, label: 'Orders' },
    message: 'Loading order history...',
  });

  const years = await getOrderYears();
  const allOrders = [];

  if (years.length > 0) {
    for (const year of years) {
      const yearOrders = await extractOrdersForYear(year, 'Orders');
      allOrders.push(...yearOrders);

      await page.setProgress({
        phase: { step: 2, total: TOTAL_STEPS, label: 'Orders' },
        message: `${year}: ${yearOrders.length} orders. Total so far: ${allOrders.length}`,
        count: allOrders.length,
      });
    }
  } else {
    // Fallback: no year dropdown found, scrape the default orders page
    await page.goto('https://www.amazon.com/your-orders/orders');
    await page.sleep(2000);
    const result = await extractOrdersFromPage();
    allOrders.push(...(result?.orders || []));
  }

  state.orders = allOrders;

  // ═══ Build Result ═══
  const totalItems = allOrders.reduce((sum, o) => sum + o.items.length, 0);
  const yearSpan = years.length || 1;

  const result = {
    'amazon.profile': state.profile || {
      name: '',
      email: '',
      isPrime: false,
    },
    'amazon.orders': {
      orders: allOrders,
      total: allOrders.length,
    },
    exportSummary: {
      count: allOrders.length,
      label: allOrders.length === 1 ? 'order' : 'orders',
      details: `${allOrders.length} orders (${totalItems} items) across ${yearSpan} years`,
    },
    timestamp: new Date().toISOString(),
    version: '1.0.0-playwright',
    platform: 'amazon',
  };

  state.isComplete = true;
  await page.setData('result', result);
  await page.setData('status',
    `Complete! ${allOrders.length} orders (${totalItems} items) collected${state.profile?.name ? ' for ' + state.profile.name : ''}.`
  );

  return { success: true, data: result };
})();

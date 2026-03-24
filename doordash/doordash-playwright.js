/**
 * DoorDash Connector (Playwright) — Order History Extraction
 *
 * Exports:
 * - doordash.orders — Order history with restaurant names, items, dates, totals, status
 *
 * Extraction method: Browser login (manual via showBrowser/promptUser, or automated
 * via requestInput), then network capture of GraphQL responses on the orders page,
 * falling back to DOM scraping.
 *
 * DoorDash login is multi-step: email -> Continue -> password -> Submit.
 * DoorDash uses Cloudflare bot protection; automated login may fail.
 * Supports: email/password, Google Sign-In, Apple Sign-In.
 */

// ─── Credentials ─────────────────────────────────────────────

let DOORDASH_LOGIN = process.env.USER_LOGIN_DOORDASH || process.env.DOORDASH_USER || '';
let DOORDASH_PASSWORD = process.env.USER_PASSWORD_DOORDASH || process.env.DOORDASH_PASSWORD || '';

// ─── Login Detection ─────────────────────────────────────────

const checkLoginStatus = async () => {
  try {
    return await page.evaluate(`
      (() => {
        const url = window.location.href;

        // Still on login/identity/Apple OAuth page
        if (url.includes('/consumer/login') || url.includes('/identity/') || url.includes('appleid.apple.com')) return false;

        // Check for logged-in indicators
        // DoorDash shows user avatar or account button when logged in
        const hasAccountBtn = !!document.querySelector('[data-testid="AccountButton"]') ||
                              !!document.querySelector('[data-testid="account-button"]') ||
                              !!document.querySelector('button[aria-label*="account" i]') ||
                              !!document.querySelector('a[href*="/account"]');

        // Check for "Sign In" button (means NOT logged in)
        const signInBtn = document.querySelector('a[href*="/consumer/login"]') ||
                          document.querySelector('button[data-testid="SignInButton"]');
        if (signInBtn) {
          const text = (signInBtn.textContent || '').trim().toLowerCase();
          if (text.includes('sign in') || text.includes('log in')) return false;
        }

        // Check for orders link (only visible when logged in)
        const hasOrdersLink = !!document.querySelector('a[href*="/orders"]');

        return hasAccountBtn || hasOrdersLink;
      })()
    `);
  } catch (e) {
    return false;
  }
};

// ─── Automated Login ─────────────────────────────────────────

const performLogin = async () => {
  const loginStr = JSON.stringify(DOORDASH_LOGIN);
  const passwordStr = JSON.stringify(DOORDASH_PASSWORD);

  await page.goto('https://www.doordash.com/consumer/login/');
  await page.sleep(3000);

  // Step 1: Fill email field
  await page.evaluate(`
    (() => {
      const emailInput = document.querySelector('input[name="email"]') ||
                         document.querySelector('input[type="email"]') ||
                         document.querySelector('input[id*="email"]') ||
                         document.querySelector('input[autocomplete="email"]') ||
                         document.querySelector('input[type="text"]');
      if (emailInput) {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        ).set;
        nativeInputValueSetter.call(emailInput, ${loginStr});
        emailInput.dispatchEvent(new Event('input', { bubbles: true }));
        emailInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()
  `);
  await page.sleep(1000);

  // Step 2: Click "Continue" or "Next" button (multi-step login)
  await page.evaluate(`
    (() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const text = (btn.textContent || '').trim().toLowerCase();
        if (text === 'continue' || text === 'continue to log in' || text === 'next' || text === 'sign in') {
          btn.click();
          return true;
        }
      }
      // Fallback: submit button
      const submitBtn = document.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.click();
    })()
  `);
  await page.sleep(3000);

  // Step 3: Fill password field (appears after email step)
  await page.evaluate(`
    (() => {
      const passwordInput = document.querySelector('input[name="password"]') ||
                            document.querySelector('input[type="password"]');
      if (passwordInput) {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        ).set;
        nativeInputValueSetter.call(passwordInput, ${passwordStr});
        passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
        passwordInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()
  `);
  await page.sleep(1000);

  // Step 4: Click login/submit button
  await page.evaluate(`
    (() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const text = (btn.textContent || '').trim().toLowerCase();
        if (text === 'log in' || text === 'sign in' || text === 'submit') {
          btn.click();
          return true;
        }
      }
      const submitBtn = document.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.click();
    })()
  `);
  await page.sleep(5000);
};

// ─── Order Extraction from DOM ───────────────────────────────

const extractOrdersFromDOM = async () => {
  try {
    return await page.evaluate(`
      (() => {
        const orders = [];
        const seen = new Set();

        // Strategy 1: Look for order card elements with known selectors
        const orderSelectors = [
          'a[href*="/orders/"]',
          '[data-testid*="order"]',
          '[data-testid*="Order"]',
        ];

        for (const sel of orderSelectors) {
          const elements = document.querySelectorAll(sel);
          if (elements.length === 0) continue;

          for (const el of elements) {
            const text = (el.textContent || '').trim();
            if (text.length < 10) continue;

            const lines = text.split('\\n').map(l => l.trim()).filter(l => l.length > 0);

            let restaurant = '';
            let date = '';
            let total = '';
            let itemCount = '';
            let status = '';
            let orderId = '';

            // Try to get order ID from href
            const link = el.tagName === 'A' ? el : el.querySelector('a[href*="/orders/"]');
            if (link) {
              const hrefMatch = (link.href || '').match(/\\/orders\\/([a-f0-9-]+|\\d+)/i);
              if (hrefMatch) orderId = hrefMatch[1];
            }

            // Parse text content for order details
            for (const line of lines) {
              if (!date && /(\\d{1,2}\\/\\d{1,2}\\/\\d{2,4})/.test(line)) {
                date = line.match(/(\\d{1,2}\\/\\d{1,2}\\/\\d{2,4})/)[1];
              } else if (!date && /((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?\\s+\\d{1,2},?\\s+\\d{4})/i.test(line)) {
                date = line.match(/((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?\\s+\\d{1,2},?\\s+\\d{4})/i)[1];
              }
              if (!total && /\\$[\\d,]+\\.\\d{2}/.test(line)) {
                total = line.match(/(\\$[\\d,]+\\.\\d{2})/)[1];
              }
              if (!itemCount && /\\d+\\s*items?/i.test(line)) {
                itemCount = line.match(/(\\d+)\\s*items?/i)[1] + ' items';
              }
              if (!status) {
                const lc = line.toLowerCase();
                const statuses = ['delivered', 'cancelled', 'canceled', 'refunded', 'in progress', 'picked up', 'on the way'];
                for (const s of statuses) {
                  if (lc.includes(s)) {
                    status = s.charAt(0).toUpperCase() + s.slice(1);
                    break;
                  }
                }
              }
            }

            // Restaurant name: first meaningful line
            for (const line of lines) {
              if (line.length > 2 && line.length < 100 &&
                  !line.startsWith('$') &&
                  !/^\\d+\\s*items?/i.test(line) &&
                  !/^(delivered|cancelled|canceled|refunded|order|reorder|help|rate)/i.test(line) &&
                  !/^(\\d{1,2}\\/|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec))/i.test(line)) {
                restaurant = line;
                break;
              }
            }

            const key = orderId || (restaurant + date + total);
            if (key && seen.has(key)) continue;
            if (key) seen.add(key);

            if (restaurant || orderId) {
              orders.push({ orderId, restaurant, date, total, itemCount, status });
            }
          }
          if (orders.length > 0) return orders;
        }

        // Strategy 2: Generic scan for order-like content
        const allElements = document.querySelectorAll('div, section, article, li');
        for (const el of allElements) {
          const text = (el.textContent || '').trim();
          if (text.length < 15 || text.length > 1500) continue;
          if (el.querySelectorAll('div, section, article').length > 5) continue;

          const hasPrice = /\\$[\\d,]+\\.\\d{2}/.test(text);
          const hasDate = /(\\d{1,2}\\/\\d{1,2}\\/\\d{2,4})|((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec))/i.test(text);
          const hasItems = /\\d+\\s*items?/i.test(text);

          if (hasPrice && (hasDate || hasItems)) {
            const lines = text.split('\\n').map(l => l.trim()).filter(l => l.length > 0);
            let restaurant = '', date = '', total = '', itemCount = '';

            for (const line of lines) {
              if (!total && /\\$[\\d,]+\\.\\d{2}/.test(line)) total = line.match(/(\\$[\\d,]+\\.\\d{2})/)[1];
              if (!date && /(\\d{1,2}\\/\\d{1,2}\\/\\d{2,4})/.test(line)) date = line.match(/(\\d{1,2}\\/\\d{1,2}\\/\\d{2,4})/)[1];
              if (!date && /((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?\\s+\\d{1,2},?\\s+\\d{4})/i.test(line)) {
                date = line.match(/((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?\\s+\\d{1,2},?\\s+\\d{4})/i)[1];
              }
              if (!itemCount && /\\d+\\s*items?/i.test(line)) itemCount = line.match(/(\\d+)\\s*items?/i)[1] + ' items';
            }

            for (const line of lines) {
              if (line.length > 2 && line.length < 100 &&
                  !line.startsWith('$') && !/^\\d+\\s*items?/i.test(line) &&
                  !/^(\\d{1,2}\\/|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec))/i.test(line)) {
                restaurant = line;
                break;
              }
            }

            const key = restaurant + date + total;
            if (key && seen.has(key)) continue;
            if (key) seen.add(key);

            if (restaurant || total) {
              orders.push({ orderId: '', restaurant, date, total, itemCount, status: '' });
            }
          }
        }

        return orders;
      })()
    `);
  } catch (e) {
    return [];
  }
};

// ─── Main Export Flow ────────────────────────────────────────

(async () => {
  const TOTAL_STEPS = 4;

  // ═══ PHASE 1: Login ═══
  await page.setData('status', 'Checking login status...');
  await page.goto('https://www.doordash.com');
  await page.sleep(3000);

  let isLoggedIn = await checkLoginStatus();

  // Tier 1: Session restored from browser profile
  if (isLoggedIn) {
    await page.setData('status', 'Session restored from browser profile');
  }

  // Tier 2: Automated login with credentials (via env or requestInput)
  if (!isLoggedIn && DOORDASH_LOGIN && DOORDASH_PASSWORD) {
    await page.setData('status', 'Attempting automated login...');
    await performLogin();
    await page.sleep(2000);
    isLoggedIn = await checkLoginStatus();
    if (!isLoggedIn) {
      await page.sleep(3000);
      isLoggedIn = await checkLoginStatus();
    }
    if (isLoggedIn) {
      await page.setData('status', 'Automated login successful');
    }
  }

  // Tier 3: Manual browser login — supports Google, Apple, email/password, 2FA
  if (!isLoggedIn) {
    await page.setData('status', 'Opening browser for manual login...');
    await page.showBrowser('https://www.doordash.com/consumer/login/');
    await page.promptUser(
      'Please log in to DoorDash (email/password, Google, or Apple Sign-In). Login will be detected automatically when complete.',
      async () => await checkLoginStatus(),
      3000
    );
    isLoggedIn = true;
    await page.setData('status', 'Manual login successful');
  }

  // ═══ PHASE 2: Data Collection (headless) ═══
  await page.goHeadless();

  // ─── Helper: extract orders from a GraphQL response ───
  const findOrdersInResponse = (obj, depth) => {
    if (!obj || depth > 4) return null;
    if (Array.isArray(obj) && obj.length > 0 && typeof obj[0] === 'object') return obj;
    if (typeof obj === 'object') {
      for (const key of Object.keys(obj)) {
        const val = obj[key];
        if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object') {
          const first = val[0];
          const looksLikeOrders = first.store || first.storeName || first.restaurant ||
                                   first.createdAt || first.orderUuid || first.deliveryAddress;
          if (looksLikeOrders) return val;
        }
        const found = findOrdersInResponse(val, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };

  const parseOrdersFromResponse = (resp) => {
    if (!resp) return [];
    const data = resp.data || resp;
    const orderList = findOrdersInResponse(data, 0) || [];
    const orders = [];

    for (const o of orderList) {
      const storeName = o.store?.name || o.storeName || o.merchantName || o.restaurant?.name || '';
      const orderId = o.orderUuid || o.id || o.orderId || '';
      const date = o.createdAt || o.submittedAt || o.orderDate || o.deliveryTime || '';
      const total = o.totalCharged?.displayString || o.totalCharged?.unitAmount ||
                    o.grandTotal?.displayString || o.grandTotal?.unitAmount ||
                    (typeof o.totalCharged === 'string' ? o.totalCharged : '') ||
                    (typeof o.total === 'string' ? o.total : '') || '';
      const items = o.orderItems || o.items || [];
      const itemNames = Array.isArray(items) ? items.map(i => i.name || i.itemName || '').filter(n => n) : [];
      const status = o.deliveryStatus || o.status || o.orderStatus || '';

      orders.push({
        orderId,
        restaurant: storeName,
        date,
        total: typeof total === 'number' ? '$' + (total / 100).toFixed(2) : String(total),
        itemCount: items.length ? items.length + ' items' : '',
        items: itemNames.length > 0 ? itemNames : undefined,
        status,
      });
    }
    return orders;
  };

  // ═══ STEP 1: Navigate to orders page and capture initial batch ═══
  await page.setProgress({
    phase: { step: 1, total: TOTAL_STEPS, label: 'Loading orders' },
    message: 'Navigating to order history...',
  });

  // DoorDash fires getConsumerOrdersWithDetails GraphQL query on /orders
  await page.captureNetwork({
    urlPattern: 'getConsumerOrdersWithDetails',
    key: 'orders_graphql'
  });

  await page.goto('https://www.doordash.com/orders');
  await page.sleep(5000);

  // Check if we got redirected to login
  const currentUrl = await page.evaluate(`window.location.href`);
  if (currentUrl && (currentUrl.includes('/login') || currentUrl.includes('/identity'))) {
    await page.setData('error', 'Session expired or login failed. Please try again.');
    return;
  }

  // ═══ STEP 2: Extract all orders (with pagination via scroll) ═══
  await page.setProgress({
    phase: { step: 2, total: TOTAL_STEPS, label: 'Extracting orders' },
    message: 'Reading order data...',
  });

  let allOrders = [];
  const seenOrderIds = new Set();

  const addOrders = (orders) => {
    for (const o of orders) {
      if (o.orderId && seenOrderIds.has(o.orderId)) continue;
      if (o.orderId) seenOrderIds.add(o.orderId);
      allOrders.push(o);
    }
  };

  // Parse initial GraphQL capture
  const graphqlResp = await page.getCapturedResponse('orders_graphql');
  if (graphqlResp) {
    addOrders(parseOrdersFromResponse(graphqlResp));
    await page.setData('status', 'Found ' + allOrders.length + ' orders from first page');
  }

  // Paginate by scrolling to trigger more loads
  const MAX_SCROLL_PAGES = 10;
  for (let scrollPage = 0; scrollPage < MAX_SCROLL_PAGES; scrollPage++) {
    await page.clearNetworkCaptures();
    await page.captureNetwork({
      urlPattern: 'getConsumerOrdersWithDetails',
      key: 'orders_page_' + scrollPage
    });

    await page.evaluate(`window.scrollTo(0, document.body.scrollHeight)`);
    await page.sleep(3000);

    const moreResp = await page.getCapturedResponse('orders_page_' + scrollPage);
    if (!moreResp) break;

    const moreOrders = parseOrdersFromResponse(moreResp);
    if (moreOrders.length === 0) break;

    const prevCount = allOrders.length;
    addOrders(moreOrders);

    if (allOrders.length === prevCount) break; // all duplicates

    await page.setProgress({
      phase: { step: 2, total: TOTAL_STEPS, label: 'Extracting orders' },
      message: 'Found ' + allOrders.length + ' orders so far...',
      count: allOrders.length,
    });
  }

  // Fall back to DOM scraping if network capture found nothing
  if (allOrders.length === 0) {
    await page.setData('status', 'API capture empty, trying DOM extraction...');
    allOrders = await extractOrdersFromDOM();
  }

  // ═══ STEP 3: Fetch order details for orders that have IDs ═══
  if (allOrders.length > 0) {
    await page.setProgress({
      phase: { step: 3, total: TOTAL_STEPS, label: 'Fetching details' },
      message: 'Loading order details...',
    });

    const MAX_DETAIL_FETCHES = Math.min(allOrders.length, 50);

    for (let i = 0; i < MAX_DETAIL_FETCHES; i++) {
      const order = allOrders[i];
      if (!order.orderId) continue;

      await page.clearNetworkCaptures();
      await page.captureNetwork({
        urlPattern: 'getConsumerOrder',
        key: 'detail_' + i
      });
      await page.captureNetwork({
        urlPattern: 'graphql',
        bodyPattern: order.orderId,
        key: 'detail_body_' + i
      });

      await page.goto('https://www.doordash.com/orders/' + order.orderId);
      await page.sleep(4000);

      // Try GraphQL capture first
      const detailResp = await page.getCapturedResponse('detail_' + i) ||
                          await page.getCapturedResponse('detail_body_' + i);

      let gotDetail = false;
      if (detailResp) {
        const detailData = detailResp.data || detailResp;
        // Walk the response to find item-level data
        const findItems = (obj, depth) => {
          if (!obj || depth > 5) return null;
          if (typeof obj === 'object' && !Array.isArray(obj)) {
            for (const key of ['orderItems', 'items', 'lineItems', 'cartItems']) {
              if (Array.isArray(obj[key]) && obj[key].length > 0) return obj[key];
            }
            for (const key of Object.keys(obj)) {
              const found = findItems(obj[key], depth + 1);
              if (found) return found;
            }
          }
          return null;
        };

        const items = findItems(detailData, 0);
        if (items && items.length > 0) {
          order.items = items.map(item => {
            const name = item.name || item.itemName || item.title || '';
            const qty = item.quantity || item.qty || 1;
            const price = item.price?.displayString || item.price?.unitAmount ||
                          item.unitPrice?.displayString || item.unitPrice ||
                          (typeof item.price === 'string' ? item.price : '');
            return {
              name,
              quantity: qty,
              price: typeof price === 'number' ? '$' + (price / 100).toFixed(2) : String(price || ''),
            };
          }).filter(item => item.name);
          order.itemCount = order.items.length + ' items';
          gotDetail = true;
        }

        // Extract status and delivery address if missing
        const findField = (obj, fields, depth) => {
          if (!obj || depth > 4) return '';
          if (typeof obj === 'object' && !Array.isArray(obj)) {
            for (const f of fields) {
              if (obj[f] !== undefined && obj[f] !== null) {
                if (typeof obj[f] === 'object' && obj[f].displayString) return obj[f].displayString;
                if (typeof obj[f] === 'string' || typeof obj[f] === 'number') return String(obj[f]);
              }
            }
            for (const key of Object.keys(obj)) {
              const found = findField(obj[key], fields, depth + 1);
              if (found) return found;
            }
          }
          return '';
        };

        if (!order.status) {
          order.status = findField(detailData, ['deliveryStatus', 'orderStatus', 'status'], 0);
        }
        const deliveryAddr = findField(detailData, ['formattedAddress', 'printableAddress', 'shortName'], 0);
        if (deliveryAddr) order.deliveryAddress = deliveryAddr;
      }

      // DOM fallback for detail page
      if (!gotDetail) {
        const domDetail = await page.evaluate(`
          (() => {
            const text = document.body?.innerText || '';
            const lines = text.split('\\n').map(l => l.trim()).filter(l => l.length > 0);
            const items = [];
            let status = '';
            let deliveryAddress = '';

            let inItemsSection = false;
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];
              const lc = line.toLowerCase();

              if (lc === 'order details' || lc === 'items' || lc === 'your items' ||
                  lc === 'order summary' || lc === 'your order') {
                inItemsSection = true;
                continue;
              }
              if (inItemsSection && (lc.startsWith('subtotal') || lc.startsWith('total') ||
                  lc.startsWith('delivery fee') || lc.startsWith('service fee') ||
                  lc.startsWith('tip') || lc === 'payment')) {
                inItemsSection = false;
                continue;
              }

              if (inItemsSection && line.length > 2 && line.length < 200 && !line.startsWith('$')) {
                const nextLine = i + 1 < lines.length ? lines[i + 1] : '';
                const priceMatch = nextLine.match(/^[A-Z]*\\$([\\d,]+\\.\\d{2})/);
                if (/^x\\d+$/i.test(line) || /^\\d+x$/i.test(line)) continue;
                if (['help', 'reorder', 'rate', 'receipt', 'details', 'back'].includes(lc)) continue;
                items.push({
                  name: line,
                  price: priceMatch ? '$' + priceMatch[1] : '',
                  quantity: 1,
                });
                if (priceMatch) i++;
              }

              if (!status) {
                const statuses = ['delivered', 'cancelled', 'canceled', 'refunded', 'picked up', 'on the way'];
                for (const s of statuses) {
                  if (lc.includes(s)) { status = s.charAt(0).toUpperCase() + s.slice(1); break; }
                }
              }

              if ((lc.includes('deliver') && lc.includes('address')) || lc.includes('delivered to')) {
                if (i + 1 < lines.length && lines[i + 1].length > 5) {
                  deliveryAddress = lines[i + 1];
                }
              }
            }

            return { items, status, deliveryAddress };
          })()
        `);

        if (domDetail.items && domDetail.items.length > 0) {
          order.items = domDetail.items;
          order.itemCount = domDetail.items.length + ' items';
        }
        if (domDetail.status && !order.status) order.status = domDetail.status;
        if (domDetail.deliveryAddress) order.deliveryAddress = domDetail.deliveryAddress;
      }

      if ((i + 1) % 5 === 0 || i === MAX_DETAIL_FETCHES - 1) {
        await page.setProgress({
          phase: { step: 3, total: TOTAL_STEPS, label: 'Fetching details' },
          message: 'Fetched details for ' + (i + 1) + ' of ' + MAX_DETAIL_FETCHES + ' orders...',
          count: i + 1,
        });
      }

      await page.sleep(500); // rate limit
    }
  }

  // ═══ STEP 4: Build result ═══
  await page.setProgress({
    phase: { step: 4, total: TOTAL_STEPS, label: 'Finalizing' },
    message: 'Building export...',
  });

  if (!allOrders || allOrders.length === 0) {
    await page.setData('error', 'No orders found. The page structure may have changed, or your account may have no order history.');
    return;
  }

  const result = {
    'doordash.orders': {
      orders: allOrders,
    },
    exportSummary: {
      count: allOrders.length,
      label: allOrders.length === 1 ? 'order' : 'orders',
      details: allOrders.length + ' orders from DoorDash order history',
    },
    timestamp: new Date().toISOString(),
    version: '1.0.0-playwright',
    platform: 'doordash',
  };

  await page.setData('result', result);
  await page.setData('status', 'Complete! Exported ' + allOrders.length + ' orders from DoorDash.');
})();

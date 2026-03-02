// Shop app Connector (Playwright)
// Exports order history from https://shop.app/account/order-history
// Uses the live Apollo Client cache (via React fiber) — not the static SSR snapshot.

const state = {
  orders: [],
  isComplete: false
};

// ─── Login check ───────────────────────────────────────────────

const checkLoginStatus = async () => {
  try {
    const loggedIn = await page.evaluate(`
      (() => {
        // Detect obvious login form elements
        const emailInput = document.querySelector('input[type="email"], input[name="email"]');
        const passwordInput = document.querySelector('input[type="password"], input[name="password"]');
        const hasLoginForm = !!emailInput && !!passwordInput;
        if (hasLoginForm) return false;

        // Detect order-history context
        const headings = Array.from(document.querySelectorAll('h1, h2, h3'));
        const hasOrdersHeading = headings.some(h => /orders?|order history/i.test(h.textContent || ''));

        const hasOrderCard =
          !!document.querySelector('[data-test*="order"], [data-testid*="order"]') ||
          !!document.querySelector('a[href*="/orders/"], a[href*="/order/"]');

        return hasOrdersHeading || hasOrderCard;
      })()
    `);
    return !!loggedIn;
  } catch (err) {
    return false;
  }
};

// ─── Scroll to load more (infinite list / "Load more") ───────────

const scrollToLoadOrders = async () => {
  await page.evaluate(`
    (async () => {
      const delay = ms => new Promise(r => setTimeout(r, ms));
      let lastHeight = 0;
      let sameCount = 0;

      for (let i = 0; i < 25; i++) {
        window.scrollTo(0, document.body.scrollHeight);
        await delay(800);
        const newHeight = document.body.scrollHeight;
        if (newHeight === lastHeight) {
          sameCount++;
          if (sameCount >= 3) break;
        } else {
          sameCount = 0;
          lastHeight = newHeight;
        }
      }

      window.scrollTo(0, 0);
    })()
  `);
  await page.sleep(1000);
};

// ─── Order extraction: Apollo cache (primary) ───────────────────
// Shop app uses Apollo Client. The live client cache (accessed via React fiber)
// accumulates all orders as the page scrolls — unlike window.__APOLLO_STATE__,
// which is a static SSR snapshot containing only the initial page of orders.
//
// After scrolling, the app writes loaded pages into a colon-format key:
//   deliveriesOrdersList:{"filter":...,"sortBy":...}
// rather than the cursor-paginated parenthesis-format keys in the SSR snapshot.

const extractOrdersFromApollo = async () => {
  try {
    const orders = await page.evaluate(`
      (() => {
        // Traverse the React fiber tree to find the live Apollo Client cache.
        function getLiveApolloState() {
          try {
            const root = document.querySelector('#root') || document.body;
            const fiberKey = Object.keys(root).find(
              k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
            );
            if (!fiberKey) return null;
            let fiber = root[fiberKey];
            let count = 0;
            while (fiber && count < 300) {
              count++;
              const props = fiber.memoizedProps || fiber.pendingProps;
              if (props && props.client && props.client.cache) {
                return props.client.cache.extract();
              }
              fiber = fiber.return;
            }
          } catch (e) {}
          return null;
        }

        const state = getLiveApolloState() || window.__APOLLO_STATE__;
        if (!state || typeof state !== 'object') return null;

        const orders = [];
        const seenOrderIds = new Set();
        const seenRefs = new Set();
        const allRefs = [];

        function collectRefs(nodes) {
          if (!Array.isArray(nodes)) return;
          nodes.forEach(n => {
            if (n && n.__ref && n.__ref.startsWith('Order:') && !seenRefs.has(n.__ref)) {
              seenRefs.add(n.__ref);
              allRefs.push(n.__ref);
            }
          });
        }

        const root = state.ROOT_QUERY;
        if (!root) return orders;

        // Prefer the paginated accumulation key (colon format). This key is populated
        // after scrolling and grows as each new page is fetched — it holds all orders.
        const paginatedKey = Object.keys(root).find(
          k => k.startsWith('deliveriesOrdersList:') && k[21] !== '('
        );
        if (paginatedKey && root[paginatedKey]) {
          collectRefs(root[paginatedKey].nodes);
        }

        // Also collect from cursor-paginated keys (parenthesis format) as a fallback
        // for orders not yet in the paginated accumulation key (e.g. on first load).
        Object.keys(root)
          .filter(k => k.startsWith('deliveriesOrdersList('))
          .forEach(k => collectRefs(root[k].nodes));

        for (const ref of allRefs) {
          const orderObj = state[ref];
          if (!orderObj || seenOrderIds.has(orderObj.id)) continue;
          seenOrderIds.add(orderObj.id);

          const shopRef = orderObj.shop;
          let merchantName = '';
          if (shopRef && shopRef.__ref) {
            const shopObj = state[shopRef.__ref];
            if (shopObj && shopObj.name) merchantName = shopObj.name;
          }

          const price = orderObj.effectiveTotalPrice || orderObj.totalPriceAfterOfferApplied;
          let total = null;
          let currency = (price && price.currencyCode) || '';
          if (price && price.amount != null) {
            const n = parseFloat(price.amount);
            if (!Number.isNaN(n)) total = n;
          }

          const lineItems = orderObj.lineItems && orderObj.lineItems.nodes;
          const itemTitles = [];
          if (Array.isArray(lineItems)) {
            lineItems.forEach(li => {
              const liRef = li && li.__ref;
              if (liRef && state[liRef] && state[liRef].productTitle) {
                itemTitles.push(state[liRef].productTitle);
              }
            });
          }

          orders.push({
            id: String(orderObj.id),
            orderNumber: String(orderObj.id),
            placedAt: orderObj.createdAt || '',
            merchantName,
            total,
            currency,
            status: orderObj.displayStatus || '',
            itemCount: orderObj.totalItemCount != null ? orderObj.totalItemCount : (itemTitles.length || null),
            lineItemTitles: itemTitles.length ? itemTitles : undefined,
            detailUrl: 'https://shop.app/account/order-history'
          });
        }

        return orders;
      })()
    `);

    return Array.isArray(orders) ? orders : null;
  } catch (err) {
    return null;
  }
};

// ─── Check if more orders remain ─────────────────────────────────
// Reads hasNextPage from the live Apollo cache so the scroll loop knows when to stop.

const checkHasNextPage = async () => {
  try {
    return await page.evaluate(`
      (() => {
        function getLiveApolloState() {
          try {
            const root = document.querySelector('#root') || document.body;
            const fiberKey = Object.keys(root).find(
              k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
            );
            if (!fiberKey) return null;
            let fiber = root[fiberKey];
            let count = 0;
            while (fiber && count < 300) {
              count++;
              const props = fiber.memoizedProps || fiber.pendingProps;
              if (props && props.client && props.client.cache) {
                return props.client.cache.extract();
              }
              fiber = fiber.return;
            }
          } catch (e) {}
          return null;
        }

        const state = getLiveApolloState() || window.__APOLLO_STATE__;
        if (!state) return false;
        const root = state.ROOT_QUERY;
        if (!root) return false;

        const paginatedKey = Object.keys(root).find(
          k => k.startsWith('deliveriesOrdersList:') && k[21] !== '('
        );
        if (paginatedKey && root[paginatedKey] && root[paginatedKey].pageInfo) {
          return !!root[paginatedKey].pageInfo.hasNextPage;
        }
        return Object.keys(root)
          .filter(k => k.startsWith('deliveriesOrdersList('))
          .some(k => root[k] && root[k].pageInfo && root[k].pageInfo.hasNextPage);
      })()
    `);
  } catch (err) {
    return false;
  }
};

// ─── Order extraction: DOM fallback ────────────────────────────
// When Apollo state is not present, scrape cards by structure and text.

const extractOrdersFromDOM = async () => {
  try {
    const orders = await page.evaluate(`
      (() => {
        const orders = [];
        const currencyRe = /\\$\\s*\\d[\\d,]*(\\.\\d{2})?|\\d[\\d,]*(\\.\\d{2})?\\s*(USD|EUR|GBP|CAD)/;
        const itemCountRe = /^(\\d+)\\s*item(s)?\\s*[·•]\\s*\\$/;
        const seen = new Set();

        // Cards often contain "N item(s) · $X.XX" and shop name
        const links = document.querySelectorAll('a[href*="shop.app"]');
        for (const a of links) {
          const card = a.closest('div[class]') || a;
          const text = (card.textContent || '').trim();
          if (!text || text.length < 10) continue;
          const key = text.slice(0, 120);
          if (seen.has(key)) continue;
          if (!currencyRe.test(text) && !/\\d+\\s*item(s)?\\s*[·•]/.test(text)) continue;
          seen.add(key);

          let total = null;
          let currency = 'USD';
          const moneyMatch = text.match(/\\$\\s*([\\d,]+(?:\\.\\d{2})?)/);
          if (moneyMatch) {
            total = parseFloat(moneyMatch[1].replace(/,/g, ''));
            currency = 'USD';
          }

          const itemMatch = text.match(/^(\\d+)\\s*item(s)?/);
          const itemCount = itemMatch ? parseInt(itemMatch[1], 10) : null;

          let merchantName = '';
          const lines = text.split(/\\s*[\\n·]\\s*/).filter(Boolean);
          for (const line of lines) {
            if (/orders?|order history/i.test(line)) continue;
            if (itemCountRe.test(line) || /^\\$/.test(line)) continue;
            if (line.length > 2 && line.length < 80) {
              merchantName = line;
              break;
            }
          }

          orders.push({
            id: a.href || key.slice(0, 80),
            orderNumber: '',
            placedAt: '',
            merchantName,
            total,
            currency,
            status: '',
            itemCount,
            detailUrl: a.href || ''
          });
        }

        return orders;
      })()
    `);

    return Array.isArray(orders) ? orders : [];
  } catch (err) {
    return [];
  }
};

// ─── Main flow ────────────────────────────────────────────────

(async () => {
  const TOTAL_STEPS = 3;

  // Phase 1: Login / session detection
  await page.setData('status', 'Checking Shop app login status...');
  await page.goto('https://shop.app/account/order-history');
  await page.sleep(3000);

  let isLoggedIn = await checkLoginStatus();

  if (!isLoggedIn) {
    await page.showBrowser('https://shop.app/account/order-history');
    await page.setData('status', 'Please log in to Shop app...');

    await page.promptUser(
      'Please log in to Shop app. Click "Done" when you see your order history.',
      async () => {
        return await checkLoginStatus();
      },
      2000
    );

    await page.setData('status', 'Login completed');
    await page.sleep(1500);
  } else {
    await page.setData('status', 'Shop app session restored from previous login');
  }

  // Phase 2: Headless data collection
  await page.goHeadless();

  await page.setProgress({
    phase: { step: 1, total: TOTAL_STEPS, label: 'Loading orders' },
    message: 'Scrolling to load all orders...'
  });
  await scrollToLoadOrders();

  await page.setProgress({
    phase: { step: 2, total: TOTAL_STEPS, label: 'Extracting orders' },
    message: 'Reading order data from page...'
  });

  // Prefer live Apollo cache (accumulates all orders as the page scrolls)
  let orders = await extractOrdersFromApollo();
  if (orders && orders.length > 0) {
    // Pagination: scroll until hasNextPage is false or no new orders appear
    const maxRounds = 20;
    for (let round = 0; round < maxRounds; round++) {
      const hasMore = await checkHasNextPage();
      if (!hasMore) break;
      await page.evaluate(`window.scrollTo(0, document.body.scrollHeight)`);
      await page.sleep(1500);
      const more = await extractOrdersFromApollo();
      if (!more || more.length <= orders.length) break;
      orders = more;
      await page.setProgress({
        phase: { step: 2, total: TOTAL_STEPS, label: 'Extracting orders' },
        message: 'Loaded ' + orders.length + ' orders...',
        count: orders.length
      });
    }
  }
  if (!orders || orders.length === 0) {
    orders = await extractOrdersFromDOM();
  }

  state.orders = orders;

  await page.setProgress({
    phase: { step: 3, total: TOTAL_STEPS, label: 'Finalizing export' },
    message: `Preparing ${orders.length} orders for export...`,
    count: orders.length
  });

  const result = {
    'shop.orders': {
      orders,
      total: orders.length
    },
    exportSummary: {
      count: orders.length,
      label: orders.length === 1 ? 'order' : 'orders'
    },
    timestamp: new Date().toISOString(),
    version: '1.0.0-playwright',
    platform: 'shop'
  };

  state.isComplete = true;

  if (orders.length > 0) {
    await page.setData('result', result);
    await page.setData(
      'status',
      `Complete! Exported ${orders.length} ${orders.length === 1 ? 'order' : 'orders'} from Shop app.`
    );
    return { success: true, data: result };
  } else {
    await page.setData('error', 'No orders found on your Shop app order history page.');
    return { success: false, error: 'No orders found' };
  }
})();


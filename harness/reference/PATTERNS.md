# Data Extraction Patterns

Three primary patterns for extracting data, in order of preference.

## Pattern A: REST API Fetch (Preferred)

**Use when:** The platform has REST/JSON APIs accessible from a logged-in browser session.
**Example:** LinkedIn, ChatGPT

### How to discover APIs:
1. Open the platform in Chrome
2. Open DevTools > Network tab
3. Filter by XHR/Fetch
4. Browse the platform — watch for JSON responses
5. Note the endpoint URLs, required headers, auth mechanisms

### Implementation — API fetch helper:

```javascript
const fetchApi = async (endpoint) => {
  const endpointStr = JSON.stringify(endpoint);
  try {
    return await page.evaluate(`
      (async () => {
        try {
          // Get CSRF token from cookies (platform-specific)
          const csrfToken = (document.cookie.match(/JSESSIONID="?([^";]+)/) || [])[1] || '';
          const resp = await fetch(${endpointStr}, {
            headers: { 'csrf-token': csrfToken },
            credentials: 'include'
          });
          if (!resp.ok) return { _error: resp.status };
          return await resp.json();
        } catch(e) { return { _error: e.message }; }
      })()
    `);
  } catch (e) {
    return { _error: e.message || String(e) };
  }
};

// Usage
const data = await fetchApi('/api/v1/me');
if (data._error) {
  await page.setData('error', 'API failed: ' + data._error);
  return;
}
```

### Auth token extraction (ChatGPT pattern):

Some platforms embed auth tokens in the page source:

```javascript
const token = await page.evaluate(`
  (() => {
    try {
      // Look for auth tokens in script tags
      const bootstrapEl = document.getElementById('client-bootstrap');
      if (bootstrapEl) {
        const data = JSON.parse(bootstrapEl.textContent);
        return data.accessToken || null;
      }
      return null;
    } catch { return null; }
  })()
`);

// Use token in API calls
const tokenStr = JSON.stringify(token);
const data = await page.evaluate(`
  (async () => {
    const resp = await fetch('/backend-api/conversations', {
      headers: { 'Authorization': 'Bearer ' + ${tokenStr} }
    });
    return await resp.json();
  })()
`);
```

### Parallel API calls:

```javascript
const [profileData, positionsData] = await Promise.all([
  fetchApi('/api/profile'),
  fetchApi('/api/positions'),
]);
```

### Paginated API calls:

```javascript
const allItems = [];
let offset = 0;
const limit = 50;

while (true) {
  await page.setProgress({
    phase: { step: 2, total: 3, label: 'Fetching items' },
    message: `Fetched ${allItems.length} items so far...`,
    count: allItems.length,
  });

  const data = await fetchApi(`/api/items?offset=${offset}&limit=${limit}`);
  if (data._error) break;

  const items = data.elements || [];
  allItems.push(...items);

  if (items.length < limit) break; // last page
  offset += limit;
  await page.sleep(500); // rate limiting
}
```

---

## Pattern B: Network Capture

**Use when:** Platform uses GraphQL/XHR that fires during page navigation. You want to capture the raw response.
**Example:** Instagram, Spotify

### Implementation:

```javascript
// 1. Register capture BEFORE navigating
await page.captureNetwork({
  urlPattern: 'instagram.com/graphql/query',   // URL substring to match
  bodyPattern: 'PolarisProfilePage',            // Response body substring
  key: 'profile_data'                           // Key for retrieval
});

// 2. Navigate to trigger the request
await page.goto('https://www.instagram.com/username/');
await page.sleep(3000); // wait for requests to fire

// 3. Retrieve captured response
const response = await page.getCapturedResponse('profile_data');
if (response) {
  const user = response.data?.user;
  // Process user data...
}
```

### Multiple captures:

```javascript
// Register multiple captures
await page.captureNetwork({
  urlPattern: '/graphql',
  bodyPattern: 'UserProfile',
  key: 'user'
});
await page.captureNetwork({
  urlPattern: '/graphql',
  bodyPattern: 'UserMedia',
  key: 'media'
});

await page.goto('https://platform.com/profile');
await page.sleep(3000);

const userResp = await page.getCapturedResponse('user');
const mediaResp = await page.getCapturedResponse('media');
```

---

## Pattern C: DOM Scraping (Fallback)

**Use when:** No API available, data only exists in rendered HTML.
**Example:** GitHub

### Selector strategy (critical):

**DO use:**
- Tag structure: `main > section`, `h2`, `p`
- ARIA roles: `[role="main"]`, `[aria-label*="repositories"]`
- Data attributes: `[data-testid="profile-name"]`, `[itemprop="name"]`
- Semantic HTML: `nav`, `article`, `header`, `aside`
- Text content matching via JS

**DO NOT use:**
- Obfuscated class names: `.x1lliihq`, `.css-1dbjc4n`
- Frequently-changing class names: `.feed-shared-update-v2__description`
- Framework-generated IDs: `#react-root-0-3-1`

### Implementation:

```javascript
const profileData = await page.evaluate(`
  (() => {
    // Use stable selectors
    const name = (document.querySelector('span[itemprop="name"]')?.textContent || '').trim();
    const bio = (document.querySelector('div[data-bio-text]')?.textContent || '').trim();

    // Use structural selectors as fallback
    const stats = document.querySelectorAll('nav a span');
    const followers = stats.length > 0 ? stats[0]?.textContent?.trim() : '';

    return { name, bio, followers };
  })()
`);
```

### Pagination via DOM:

```javascript
const allItems = [];
let pageNum = 1;
const maxPages = 20;

while (pageNum <= maxPages) {
  await page.goto(`https://platform.com/items?page=${pageNum}`);
  await page.sleep(1500);

  const items = await page.evaluate(`
    (() => {
      const rows = document.querySelectorAll('[data-testid="item-row"]');
      return Array.from(rows).map(row => ({
        title: (row.querySelector('h3')?.textContent || '').trim(),
        url: row.querySelector('a')?.href || '',
      }));
    })()
  `);

  if (!items || items.length === 0) break;
  allItems.push(...items);

  // Check for next page
  const hasNext = await page.evaluate(`!!document.querySelector('a[rel="next"]')`);
  if (!hasNext) break;

  pageNum++;
  await page.sleep(500);
}
```

---

## Common Patterns

### Login detection:

```javascript
const checkLoginStatus = async () => {
  try {
    return await page.evaluate(`
      (() => {
        // Check for login form (NOT logged in)
        const hasLoginForm = !!document.querySelector('input[type="password"]') ||
                            !!document.querySelector('form[action*="login"]');
        if (hasLoginForm) return false;

        // Check for challenge/2FA pages
        const url = window.location.href;
        if (url.includes('/challenge') || url.includes('/checkpoint')) return false;

        // Check for logged-in indicators
        const isLoggedIn = !!document.querySelector('LOGGED_IN_SELECTOR');
        return isLoggedIn;
      })()
    `);
  } catch (e) {
    return false;
  }
};
```

### Dismissing popups/modals:

```javascript
// Dismiss cookie banners, upgrade prompts, etc.
await page.evaluate(`
  (() => {
    const dismissSelectors = [
      'button[aria-label="Close"]',
      'button[aria-label="Dismiss"]',
      '[data-testid="close-button"]',
    ];
    for (const sel of dismissSelectors) {
      const btn = document.querySelector(sel);
      if (btn) { btn.click(); break; }
    }
  })()
`);
await page.sleep(500);
```

### Safe text extraction:

```javascript
// Always guard against null/undefined
const getText = (selector) => `(document.querySelector('${selector}')?.textContent || '').trim()`;

const name = await page.evaluate(getText('h1.profile-name'));
```

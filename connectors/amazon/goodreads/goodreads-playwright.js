/**
 * Goodreads Connector (Playwright)
 *
 * Exports:
 * - goodreads.profile — User profile data (name, URL, reading stats)
 * - goodreads.books — Complete library from CSV export (titles, authors, ratings, reviews, shelves, dates)
 *
 * Extraction method: DOM scraping (profile) + CSV export download (books)
 * Auth: Amazon login (all Goodreads auth routes through Amazon)
 */

// ─── Credentials ─────────────────────────────────────────────

let PLATFORM_LOGIN = process.env.USER_LOGIN_GOODREADS || '';
let PLATFORM_PASSWORD = process.env.USER_PASSWORD_GOODREADS || '';

// ─── Login Detection ─────────────────────────────────────────

const checkLoginStatus = async () => {
  try {
    return await page.evaluate(`
      (() => {
        const path = window.location.pathname;
        const host = window.location.hostname;

        // Still on Amazon auth pages
        if (host.includes('amazon.com')) return false;

        // On Goodreads login/sign-in pages
        if (/\\/(user\\/sign_in|ap-handler)/.test(path)) return false;

        // Password field visible means login form
        if (!!document.querySelector('input[type="password"]')) return false;

        // Logged-in indicator: user menu link to profile
        return !!document.querySelector('a[href*="/user/show/"]');
      })()
    `);
  } catch (e) {
    return false;
  }
};

// ─── Automated Login ─────────────────────────────────────────

const performLogin = async () => {
  const loginStr = JSON.stringify(PLATFORM_LOGIN);
  const passwordStr = JSON.stringify(PLATFORM_PASSWORD);

  // Goodreads sign-in page
  await page.goto('https://www.goodreads.com/user/sign_in');
  await page.sleep(3000);

  // Click "Sign in with email" button to go to Amazon auth
  await page.evaluate(`
    (() => {
      // Look for the email sign-in button
      const buttons = document.querySelectorAll('button, a');
      for (const btn of buttons) {
        const text = (btn.textContent || '').toLowerCase();
        if (text.includes('sign in with email') || text.includes('email')) {
          btn.click();
          return true;
        }
      }
      // Try direct link to Amazon sign-in
      const amazonLink = document.querySelector('a[href*="amazon.com/ap/signin"]');
      if (amazonLink) { amazonLink.click(); return true; }
      return false;
    })()
  `);
  await page.sleep(3000);

  // Now on Amazon login page - fill email
  await page.evaluate(`
    (() => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      ).set;

      const emailInput = document.querySelector('input[name="email"], input[type="email"], #ap_email');
      if (emailInput) {
        nativeInputValueSetter.call(emailInput, ${loginStr});
        emailInput.dispatchEvent(new Event('input', { bubbles: true }));
        emailInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()
  `);
  await page.sleep(500);

  // Check if password field is on same page or separate
  const hasPasswordOnPage = await page.evaluate(`!!document.querySelector('input[type="password"], #ap_password')`);

  if (hasPasswordOnPage) {
    // Single-page login: fill password and submit
    await page.evaluate(`
      (() => {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        ).set;
        const passInput = document.querySelector('input[type="password"], #ap_password');
        if (passInput) {
          nativeInputValueSetter.call(passInput, ${passwordStr});
          passInput.dispatchEvent(new Event('input', { bubbles: true }));
          passInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })()
    `);
    await page.sleep(500);
    await page.evaluate(`
      (() => {
        const btn = document.querySelector('#signInSubmit, button[type="submit"], input[type="submit"]');
        if (btn) btn.click();
      })()
    `);
  } else {
    // Multi-step: submit email first
    await page.evaluate(`
      (() => {
        const btn = document.querySelector('#continue, button[type="submit"], input[type="submit"]');
        if (btn) btn.click();
      })()
    `);
    await page.sleep(3000);

    // Now fill password on second page
    await page.evaluate(`
      (() => {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        ).set;
        const passInput = document.querySelector('input[type="password"], #ap_password');
        if (passInput) {
          nativeInputValueSetter.call(passInput, ${passwordStr});
          passInput.dispatchEvent(new Event('input', { bubbles: true }));
          passInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })()
    `);
    await page.sleep(500);
    await page.evaluate(`
      (() => {
        const btn = document.querySelector('#signInSubmit, button[type="submit"], input[type="submit"]');
        if (btn) btn.click();
      })()
    `);
  }

  await page.sleep(5000);

  // Check for 2FA/OTP challenge
  const needs2FA = await page.evaluate(`
    (() => {
      const url = window.location.href;
      if (url.includes('/ap/mfa') || url.includes('/ap/cvf')) return true;
      return !!document.querySelector('#auth-mfa-otpcode, input[name="otpCode"], input[name="code"]');
    })()
  `);

  if (needs2FA) {
    const twoFA = await page.requestInput({
      message: 'Amazon requires a verification code. Check your email or authenticator app.',
      schema: {
        type: 'object',
        properties: {
          code: { type: 'string', title: 'Verification code' }
        },
        required: ['code']
      }
    });

    const codeStr = JSON.stringify(twoFA.code);
    await page.evaluate(`
      (() => {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        ).set;
        const codeInput = document.querySelector('#auth-mfa-otpcode, input[name="otpCode"], input[name="code"]');
        if (codeInput) {
          nativeInputValueSetter.call(codeInput, ${codeStr});
          codeInput.dispatchEvent(new Event('input', { bubbles: true }));
          codeInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })()
    `);
    await page.sleep(500);
    await page.evaluate(`
      (() => {
        const btn = document.querySelector('#auth-signin-button, button[type="submit"], input[type="submit"]');
        if (btn) btn.click();
      })()
    `);
    await page.sleep(5000);
  }
};

// ─── CSV Parser ──────────────────────────────────────────────

const parseCSV = (csvText) => {
  const lines = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i];
    if (ch === '"') {
      if (inQuotes && csvText[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === '\n' && !inQuotes) {
      lines.push(current);
      current = '';
    } else if (ch === '\r' && !inQuotes) {
      // skip
    } else {
      current += ch;
    }
  }
  if (current) lines.push(current);

  if (lines.length < 2) return [];

  // Parse header
  const headerLine = lines[0];
  const headers = [];
  let field = '';
  let hInQuotes = false;
  for (let i = 0; i < headerLine.length; i++) {
    const ch = headerLine[i];
    if (ch === '"') {
      hInQuotes = !hInQuotes;
    } else if (ch === ',' && !hInQuotes) {
      headers.push(field.trim());
      field = '';
    } else {
      field += ch;
    }
  }
  headers.push(field.trim());

  // Parse rows
  const rows = [];
  for (let r = 1; r < lines.length; r++) {
    const line = lines[r];
    if (!line.trim()) continue;
    const values = [];
    let val = '';
    let rInQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (rInQuotes && line[i + 1] === '"') {
          val += '"';
          i++;
        } else {
          rInQuotes = !rInQuotes;
        }
      } else if (ch === ',' && !rInQuotes) {
        values.push(val);
        val = '';
      } else {
        val += ch;
      }
    }
    values.push(val);

    const obj = {};
    for (let i = 0; i < headers.length; i++) {
      let v = (values[i] || '').trim();
      // Clean Goodreads ISBN format: ="0060590297" -> 0060590297
      if (v.startsWith('="') && v.endsWith('"')) {
        v = v.slice(2, -1);
      }
      obj[headers[i]] = v;
    }
    rows.push(obj);
  }
  return rows;
};

// ─── Main Export Flow ────────────────────────────────────────

(async () => {
  const TOTAL_STEPS = 3;

  // ═══ PHASE 1: Login ═══
  // Runner already navigated to the connectURL (sign_in page).
  // If already logged in, Goodreads redirects away from sign_in.
  await page.setData('status', 'Checking login status...');
  await page.sleep(3000);

  let isLoggedIn = await checkLoginStatus();

  if (!isLoggedIn) {
    if (!PLATFORM_LOGIN || !PLATFORM_PASSWORD) {
      const creds = await page.requestInput({
        message: 'Enter your Goodreads credentials (uses Amazon login).',
        schema: {
          type: 'object',
          properties: {
            method: {
              type: 'string',
              title: 'Login method',
              description: 'email, Amazon, Google, or Apple'
            },
            username: { type: 'string', title: 'Email address' },
            password: { type: 'string', title: 'Password' }
          },
          required: ['username', 'password']
        }
      });
      PLATFORM_LOGIN = creds.username;
      PLATFORM_PASSWORD = creds.password;
    }

    await page.setData('status', 'Logging in via Amazon...');
    await performLogin();
    await page.sleep(3000);

    isLoggedIn = await checkLoginStatus();
    if (!isLoggedIn) {
      await page.sleep(5000);
      isLoggedIn = await checkLoginStatus();
    }
    if (!isLoggedIn) {
      await page.setData('error', 'Login failed. You may need to complete a CAPTCHA or verify your account on Amazon.');
      return;
    }
    await page.setData('status', 'Login successful');
  } else {
    await page.setData('status', 'Session restored from previous login');
  }

  // ═══ PHASE 2: Extract Profile ═══
  await page.setProgress({
    phase: { step: 1, total: TOTAL_STEPS, label: 'Profile' },
    message: 'Extracting profile data...',
  });

  // Get user ID from profile link
  const userInfo = await page.evaluate(`
    (() => {
      const profileLink = document.querySelector('a[href*="/user/show/"]');
      if (!profileLink) return null;
      const href = profileLink.getAttribute('href');
      const match = href.match(/\\/user\\/show\\/(\\d+)/);
      return {
        userId: match ? match[1] : null,
        profileUrl: 'https://www.goodreads.com' + href
      };
    })()
  `);

  if (!userInfo || !userInfo.userId) {
    await page.setData('error', 'Could not find your Goodreads user ID. Are you logged in?');
    return;
  }

  // Navigate to profile page for more details
  let profileData = { name: '', stats: {}, shelves: {}, avatarUrl: '', bio: '', location: '', joined: '' };
  try {
    await page.goto(userInfo.profileUrl);
    await page.sleep(2000);

    profileData = await page.evaluate(`
      (() => {
        const rawName = (document.querySelector('h1, [data-testid="userName"]')?.firstChild?.textContent || document.querySelector('h1, [data-testid="userName"]')?.textContent || '').trim();
      // Strip UI artifacts like "(edit profile)" links
      const name = rawName.replace(/\\s*\\(edit.*\\)/i, '').replace(/\\s+/g, ' ').trim();

        // Reading stats from profile sidebar
        const statElements = document.querySelectorAll('.profilePageUserStatsRow, .userInfoBoxContent, [data-testid*="stat"]');
        const stats = {};
        statElements.forEach(el => {
          const label = (el.querySelector('.profilePageUserStatsLabel, .userInfoBoxRowTitle')?.textContent || '').trim().toLowerCase();
          const value = (el.querySelector('.profilePageUserStatsValue, .userInfoBoxRowItem')?.textContent || '').trim();
          if (label && value) stats[label] = value;
        });

        // Try to get stats from shelves section
        const shelfLinks = document.querySelectorAll('a[href*="/review/list/"]');
        const shelves = {};
        shelfLinks.forEach(link => {
          const text = (link.textContent || '').trim();
          const countMatch = text.match(/\\((\\d+)\\)/);
          const shelfMatch = link.href.match(/shelf=([^&]+)/);
          if (countMatch && shelfMatch) {
            shelves[shelfMatch[1]] = parseInt(countMatch[1], 10);
          }
        });

        // Profile image
        const avatar = document.querySelector('.profilePictureIcon img, .userImage img, img[alt*="profile"]');
        const avatarUrl = avatar ? avatar.src : null;

        // About / bio
        const bio = (document.querySelector('.profilePageBio, .aboutAuthorInfo, [data-testid="bio"]')?.textContent || '').trim();

        // Location
        const location = (document.querySelector('.profileInfoLine .profilePageUserLocation, [data-testid="location"]')?.textContent || '').trim();

        // Joined date
        const joined = (document.querySelector('.profileInfoLine .profilePageUserJoinDate, [data-testid="joinDate"]')?.textContent || '').trim();

        return { name, stats, shelves, avatarUrl, bio, location, joined };
      })()
    `) || profileData;
  } catch (e) {
    await page.setData('status', 'Profile page slow, continuing with book data...');
  }

  // ═══ PHASE 3: Fetch books via RSS feeds ═══
  await page.setProgress({
    phase: { step: 2, total: TOTAL_STEPS, label: 'Fetching shelves' },
    message: 'Fetching your bookshelves via RSS...',
  });

  // Close browser to use httpFetch (bypasses CORS, auto-injects cookies)
  await page.closeBrowser();

  let books = [];
  const shelfNames = ['read', 'currently-reading', 'to-read'];

  for (const shelf of shelfNames) {
    let shelfPage = 1;
    let shelfTotal = 0;

    while (true) {
      const rssUrl = 'https://www.goodreads.com/review/list_rss/' + userInfo.userId
        + '?shelf=' + shelf + '&page=' + shelfPage + '&per_page=100';
      const rssResp = await page.httpFetch(rssUrl);

      if (!rssResp.ok || !rssResp.text) break;

      const items = rssResp.text.split('<item>').slice(1);
      if (items.length === 0) break;

      for (const item of items) {
        const extract = (tag) => {
          const cdataMatch = item.match(new RegExp('<' + tag + '><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></' + tag + '>'));
          if (cdataMatch) return cdataMatch[1].trim();
          const simpleMatch = item.match(new RegExp('<' + tag + '>([^<]*)</' + tag + '>'));
          return simpleMatch ? simpleMatch[1].trim() : '';
        };

        books.push({
          'Title': extract('title'),
          'Author': extract('author_name'),
          'ISBN': extract('isbn'),
          'My Rating': extract('user_rating'),
          'Average Rating': extract('average_rating'),
          'Date Read': extract('user_read_at'),
          'Date Added': extract('user_date_added'),
          'Bookshelves': shelf,
          'Exclusive Shelf': shelf,
          'My Review': extract('user_review'),
          'Book Id': extract('book_id'),
          'Image URL': extract('book_large_image_url') || extract('book_medium_image_url'),
        });
      }

      shelfTotal += items.length;

      await page.setProgress({
        phase: { step: 2, total: TOTAL_STEPS, label: 'Fetching shelves' },
        message: 'Shelf "' + shelf + '": fetched ' + shelfTotal + ' books...',
        count: books.length,
      });

      // RSS feeds return up to 100 per page; if fewer, we're done with this shelf
      if (items.length < 100) break;
      shelfPage++;
      await page.sleep(500);
    }

    await page.sleep(300);
  }

  // ═══ PHASE 4: Build Result ═══
  await page.setProgress({
    phase: { step: 3, total: TOTAL_STEPS, label: 'Finalizing' },
    message: 'Building export...',
  });

  // Normalize book data
  const normalizedBooks = books.map(b => ({
    title: b['Title'] || '',
    author: b['Author'] || b['Author l-f'] || '',
    isbn: b['ISBN'] || '',
    isbn13: b['ISBN13'] || '',
    myRating: parseInt(b['My Rating'] || '0', 10),
    averageRating: parseFloat(b['Average Rating'] || '0'),
    publisher: b['Publisher'] || '',
    numberOfPages: parseInt(b['Number of Pages'] || '0', 10) || null,
    yearPublished: b['Year Published'] || b['Original Publication Year'] || '',
    dateRead: b['Date Read'] || '',
    dateAdded: b['Date Added'] || '',
    exclusiveShelf: b['Exclusive Shelf'] || '',
    bookshelves: b['Bookshelves'] || '',
    myReview: b['My Review'] || '',
    bookId: b['Book Id'] || '',
  }));

  // Build shelf counts
  const shelfCounts = {};
  normalizedBooks.forEach(b => {
    const shelf = b.exclusiveShelf || 'unknown';
    shelfCounts[shelf] = (shelfCounts[shelf] || 0) + 1;
  });

  const ratedBooks = normalizedBooks.filter(b => b.myRating > 0);
  const avgUserRating = ratedBooks.length > 0
    ? (ratedBooks.reduce((sum, b) => sum + b.myRating, 0) / ratedBooks.length).toFixed(1)
    : null;

  const shelfBreakdown = Object.entries(shelfCounts)
    .map(([shelf, count]) => count + ' ' + shelf)
    .join(', ');

  const result = {
    'goodreads.profile': {
      userId: userInfo.userId,
      profileUrl: userInfo.profileUrl,
      name: profileData.name || '',
      bio: profileData.bio || '',
      location: profileData.location || '',
      joined: profileData.joined || '',
      avatarUrl: profileData.avatarUrl || '',
      shelves: profileData.shelves || shelfCounts,
      stats: profileData.stats || {},
      averageUserRating: avgUserRating,
      totalBooks: normalizedBooks.length,
      totalRated: ratedBooks.length,
    },
    'goodreads.books': normalizedBooks,
    exportSummary: {
      count: normalizedBooks.length,
      label: 'books',
      details: normalizedBooks.length + ' books (' + shelfBreakdown + ')',
    },
    timestamp: new Date().toISOString(),
    version: '1.0.0-playwright',
    platform: 'goodreads',
  };

  await page.setData('result', result);
  await page.setData('status', 'Complete! Exported ' + result.exportSummary.details);
})();

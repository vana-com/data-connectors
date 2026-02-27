/**
 * LinkedIn Connector (Playwright) — API Data Extraction
 *
 * Uses Playwright for real browser control to extract profile data.
 * Requires the playwright-runner sidecar.
 *
 * Extracts data from LinkedIn's Voyager API responses instead of the rendered DOM.
 * Two extraction methods:
 *   1. <code> element extraction — LinkedIn embeds Voyager API responses in
 *      <code id="bpr-guid-XXX"> elements as JSON. Parse these directly.
 *   2. captureNetwork interception — Register URL patterns before navigating
 *      to detail pages, capture the API responses LinkedIn's frontend makes.
 *
 * Both methods are immune to DOM layout changes because they read structured
 * JSON data, not rendered HTML.
 */

// State management
const state = {
  profileUrl: null,
  miniProfile: null,
  heroData: null,
  aboutData: null,
  experiences: [],
  education: [],
  skills: [],
  languages: [],
  isComplete: false
};

// ─── Login Helpers ───────────────────────────────────────────

const checkLoginStatus = async () => {
  try {
    const result = await page.evaluate(`
      (() => {
        // Check for login form (means NOT logged in)
        const hasLoginForm = !!document.querySelector('input[name="session_key"]') ||
                            !!document.querySelector('#username');
        if (hasLoginForm) return false;

        // Check for challenge/verification pages (code entry, captcha, etc.)
        const url = window.location.href;
        const isChallenge = url.includes('/checkpoint/') ||
                           url.includes('/challenge/') ||
                           url.includes('/uas/') ||
                           url.includes('/authwall');
        if (isChallenge) return false;

        // Also check for verification input fields in the DOM
        const hasVerificationInput = !!document.querySelector('input[name="pin"]') ||
                                     !!document.querySelector('#input__email_verification_pin') ||
                                     !!document.querySelector('input[name="verification_code"]') ||
                                     !!document.querySelector('.pin-verification') ||
                                     !!document.querySelector('[data-litms-control-urn*="checkpoint"]');
        if (hasVerificationInput) return false;

        // Require definitive proof of being logged in — profile or feed links
        // (nav/header alone is too loose, challenge pages have those too)
        const hasProfileLink = !!document.querySelector('a[href*="/in/"]');
        const hasFeedLink = !!document.querySelector('a[href*="/feed"]');
        const hasFeedModule = !!document.querySelector('.feed-identity-module');
        const hasGlobalNav = !!document.querySelector('.global-nav__me');

        return hasProfileLink || hasFeedLink || hasFeedModule || hasGlobalNav;
      })()
    `);
    return result;
  } catch (err) {
    return false;
  }
};

// ─── API Data Extraction Helpers ─────────────────────────────

// Step 1: Extract data from <code id="bpr-guid-XXX"> elements
const extractFromCodeElements = async (urlFilter) => {
  const filterStr = JSON.stringify(urlFilter);
  return await page.evaluate(`
    (() => {
      const results = [];
      const codeEls = document.querySelectorAll('code[id^="bpr-guid-"]');
      for (const el of codeEls) {
        const dataletEl = document.getElementById('datalet-' + el.id);
        if (!dataletEl) continue;
        try {
          const meta = JSON.parse(dataletEl.textContent);
          if (${filterStr} && !meta.request.includes(${filterStr})) continue;
          const body = JSON.parse(el.textContent);
          results.push({ request: meta.request, data: body });
        } catch(e) { continue; }
      }
      return results;
    })()
  `);
};

// Step 2: Collect unique entities from API responses (runs in Node.js)
const collectIncludedEntities = (apiResponses) => {
  const seen = new Set();
  const entities = [];
  for (const resp of apiResponses) {
    const included = resp?.data?.included || resp?.included || [];
    for (const entity of included) {
      const urn = entity.entityUrn;
      if (urn && seen.has(urn)) continue;
      if (urn) seen.add(urn);
      entities.push(entity);
    }
  }
  return entities;
};

// Step 3: Wait for a network capture to arrive
const waitForCapture = async (key, maxAttempts = 15) => {
  for (let i = 0; i < maxAttempts; i++) {
    const captured = await page.getCapturedResponse(key);
    if (captured) return captured;
    await page.sleep(1000);
  }
  return null;
};

// Step 4: Profile picture URL builder and date formatter
const buildProfilePictureUrl = (pictureData) => {
  // Handle both MiniProfile format and full Profile format
  const vecImage = pictureData?.displayImageReferenceResolutionResult?.vectorImage || pictureData;
  if (!vecImage?.rootUrl || !vecImage?.artifacts?.length) return '';
  const largest = vecImage.artifacts[vecImage.artifacts.length - 1];
  return vecImage.rootUrl + largest.fileIdentifyingUrlPathSegment;
};

const formatDateRange = (startDate, endDate) => {
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const fmt = (d) => d ? (d.month ? MONTHS[d.month - 1] + ' ' : '') + d.year : '';
  const start = fmt(startDate);
  const end = endDate ? fmt(endDate) : 'Present';
  if (!start) return '';
  return start + ' - ' + end;
};

// Helper: get vanity name from profile URL
const getVanityName = () => {
  if (!state.profileUrl) return null;
  const match = state.profileUrl.match(/\/in\/([^/?#]+)/);
  return match ? match[1] : null;
};

// Helper: in-browser Voyager API fetch with CSRF token
const fetchVoyagerApi = async (endpoint) => {
  const endpointStr = JSON.stringify(endpoint);
  try {
    return await page.evaluate(`
      (async () => {
        try {
          const csrfToken = (document.cookie.match(/JSESSIONID="?([^";]+)/) || [])[1] || '';
          const resp = await fetch(${endpointStr}, {
            headers: { 'csrf-token': csrfToken },
            credentials: 'include'
          });
          if (!resp.ok) return null;
          return await resp.json();
        } catch(e) { return null; }
      })()
    `);
  } catch (e) {
    return null;
  }
};

// Recursive text extraction from topComponents structures
const extractTextsFromComponents = (obj) => {
  const texts = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (o.text && typeof o.text === 'object' && o.text.text) {
      texts.push(o.text.text);
    } else if (o.text && typeof o.text === 'string') {
      texts.push(o.text);
    }
    if (o.title && typeof o.title === 'object' && o.title.text) {
      texts.push(o.title.text);
    }
    if (Array.isArray(o)) {
      for (const item of o) walk(item);
    } else {
      for (const key of Object.keys(o)) {
        if (typeof o[key] === 'object') walk(o[key]);
      }
    }
  };
  walk(obj);
  return texts;
};

// ─── Profile Navigation ─────────────────────────────────────

// Step 5: Get profile URL from API data
const getProfileUrl = async () => {
  try {
    // Primary: extract from <code> elements
    const meResponses = await extractFromCodeElements('/voyager/api/me');
    if (meResponses.length > 0) {
      const meData = meResponses[0].data;
      const included = meData.included || [];
      const miniProfile = included.find(e =>
        e.publicIdentifier && e.firstName
      );
      if (miniProfile) {
        state.miniProfile = miniProfile; // Cache for later use
        return 'https://www.linkedin.com/in/' + miniProfile.publicIdentifier + '/';
      }
    }

    // Fallback: in-browser fetch
    const fetchResult = await fetchVoyagerApi('/voyager/api/me');
    if (fetchResult) {
      const mini = (fetchResult.included || []).find(e => e.publicIdentifier);
      if (mini) {
        state.miniProfile = mini;
        return 'https://www.linkedin.com/in/' + mini.publicIdentifier + '/';
      }
    }

    // Fallback: extract profile URL from page DOM (feed page has profile links)
    const domResult = await page.evaluate(`
      (() => {
        // Look for profile link in the feed sidebar or nav
        const links = document.querySelectorAll('a[href*="/in/"]');
        for (const link of links) {
          const href = link.getAttribute('href') || '';
          if (href.includes('/in/me')) continue;
          const match = href.match(/\\/in\\/([a-z0-9][a-z0-9-]+[a-z0-9])/i);
          if (match) return 'https://www.linkedin.com/in/' + match[1] + '/';
        }
        return null;
      })()
    `);
    return domResult;
  } catch (err) {
    return null;
  }
};

// ─── Detail Page Navigation ──────────────────────────────────

// Step 8: Navigate to detail page with network capture
const navigateToDetailPage = async (baseUrl, section, progressStep, totalSteps, label) => {
  const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  const detailUrl = base + 'details/' + section + '/';

  // Clear previous captures and register for this section
  await page.clearNetworkCaptures();
  await page.captureNetwork({
    urlPattern: '/voyager/api',
    key: section + '_capture'
  });

  await page.setProgress({
    phase: { step: progressStep, total: totalSteps, label },
    message: 'Loading ' + section + ' details page...',
  });

  await page.goto(detailUrl);
  await page.sleep(3000);

  // Handle "Load more" — don't clear captures, keep accumulating
  let loadMoreAttempts = 0;
  const MAX_LOAD_MORE = 20;
  while (loadMoreAttempts < MAX_LOAD_MORE) {
    const clicked = await page.evaluate(`
      (() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          if (btn.textContent.trim() === 'Load more') {
            btn.scrollIntoView(); btn.click(); return true;
          }
        }
        return false;
      })()
    `);
    if (!clicked) break;
    loadMoreAttempts++;
    await page.sleep(1500);

    await page.setProgress({
      phase: { step: progressStep, total: totalSteps, label },
      message: 'Loading more ' + section + '... (page ' + loadMoreAttempts + ')',
    });
  }

  // Scroll to bottom to trigger any remaining lazy loads
  await page.evaluate(`window.scrollTo(0, document.body.scrollHeight)`);
  await page.sleep(500);
};

// ─── Data Extraction: Hero + About (from main profile) ──────

// Step 9: Generic detail page entity extractor (multi-method)
const extractDetailPageEntities = async (section) => {
  // Method 1: <code> elements (LinkedIn embeds API data in DOM)
  const codeResponses = await extractFromCodeElements('/voyager/api');
  let entities = collectIncludedEntities(codeResponses);
  if (entities.length > 0) return entities;

  // Method 2: captured network response from page navigation
  const captured = await page.getCapturedResponse(section + '_capture');
  if (captured) {
    entities = collectIncludedEntities([captured]);
    if (entities.length > 0) return entities;
  }

  // Method 3: in-browser fetch to Voyager API profileView endpoint
  const vanityName = getVanityName();
  if (vanityName) {
    const data = await fetchVoyagerApi(
      '/voyager/api/identity/profiles/' + encodeURIComponent(vanityName) + '/profileView'
    );
    if (data) {
      entities = collectIncludedEntities([data]);
      if (entities.length > 0) return entities;
    }
  }

  return entities;
};

// Step 6: Extract hero section from API data
const extractHeroSection = async () => {
  try {
    const data = { fullName: '', headline: '', location: '', connections: '', profilePictureUrl: '' };

    // Primary: extract from <code> elements
    const profileResponses = await extractFromCodeElements('voyagerIdentityDashProfiles');
    let entities = [];
    if (profileResponses.length > 0) {
      entities = collectIncludedEntities(profileResponses);
    }

    // Fallback: try captured network response
    if (entities.length === 0) {
      const captured = await page.getCapturedResponse('profileGraphQL');
      if (captured) {
        entities = collectIncludedEntities([captured]);
      }
    }

    // Fallback: use miniProfile from /api/me (cached in getProfileUrl)
    if (entities.length === 0 && state.miniProfile) {
      data.fullName = ((state.miniProfile.firstName || '') + ' ' + (state.miniProfile.lastName || '')).trim();
      data.headline = state.miniProfile.occupation || '';
      if (state.miniProfile.picture) {
        data.profilePictureUrl = buildProfilePictureUrl(state.miniProfile.picture);
      }
      return data;
    }

    // Parse Profile entity
    const profile = entities.find(e =>
      (e['$type'] || '').includes('identity.profile.Profile') && e.firstName
    );
    if (profile) {
      data.fullName = ((profile.firstName || '') + ' ' + (profile.lastName || '')).trim();
      data.headline = profile.headline || '';
      if (profile.profilePicture) {
        data.profilePictureUrl = buildProfilePictureUrl(profile.profilePicture);
      }
    }

    // Resolve location from Geo entity
    if (profile?.geoLocation?.['*geo']) {
      const geoUrn = profile.geoLocation['*geo'];
      const geoEntity = entities.find(e => e.entityUrn === geoUrn);
      if (geoEntity) {
        data.location = geoEntity.defaultLocalizedName || '';
      }
    }

    return data;
  } catch (err) {
    return null;
  }
};

// Step 7: Extract about section with multi-level fallback
const extractAboutSection = async () => {
  try {
    // Level 1: Check profile API data for summary field
    const allResponses = await extractFromCodeElements('/voyager/api');
    const allEntities = collectIncludedEntities(allResponses);
    for (const entity of allEntities) {
      if (entity.summary && entity.summary.length > 10) {
        return { aboutText: entity.summary };
      }
    }

    // Level 2: Scroll page to trigger lazy loads, then re-check
    await scrollToLoadContent();
    await page.sleep(1000);
    const newResponses = await extractFromCodeElements('/voyager/api');
    const newEntities = collectIncludedEntities(newResponses);
    for (const entity of newEntities) {
      if (entity.summary && entity.summary.length > 10) {
        return { aboutText: entity.summary };
      }
    }

    // Level 3: Check for About in topComponents of profile cards
    for (const entity of newEntities) {
      if (entity.topComponents && Array.isArray(entity.topComponents)) {
        for (const comp of entity.topComponents) {
          const textComp = comp?.components?.textComponent;
          if (textComp?.text?.text?.length > 50) {
            return { aboutText: textComp.text.text };
          }
        }
      }
    }

    // Level 4: In-browser fetch to profileView endpoint
    const vanityName = state.profileUrl ? (state.profileUrl.match(/\/in\/([^/]+)/)?.[1] || '') : '';
    if (vanityName) {
      const vanityNameStr = JSON.stringify(vanityName);
      const result = await page.evaluate(`
        (async () => {
          try {
            const csrfToken = (document.cookie.match(/JSESSIONID="?([^";]+)/) || [])[1] || '';
            const resp = await fetch('/voyager/api/identity/profiles/' + ${vanityNameStr} + '/profileView', {
              headers: { 'csrf-token': csrfToken },
              credentials: 'include'
            });
            if (!resp.ok) return null;
            const data = await resp.json();
            const entities = data.included || [];
            for (const e of entities) {
              if (e.summary && e.summary.length > 10) return { aboutText: e.summary };
            }
            return null;
          } catch(e) { return null; }
        })()
      `);
      if (result) return result;
    }

    // Level 5: Minimal DOM fallback — look for section with "about" id
    const domResult = await page.evaluate(`
      (() => {
        // Try section with about ID
        const aboutSection = document.querySelector('section#about, section[id*="about"], div#about');
        if (aboutSection) {
          const spans = aboutSection.querySelectorAll('span');
          for (const span of spans) {
            const t = span.textContent.trim();
            if (t.length > 20 && !t.includes('About')) return { aboutText: t };
          }
        }
        // Try the old approach as final fallback
        const sections = document.querySelectorAll('main section, section');
        for (const section of sections) {
          const h2 = section.querySelector('h2');
          if (h2 && h2.textContent.trim() === 'About') {
            const spans = section.querySelectorAll('span');
            for (const span of spans) {
              const t = span.textContent.trim();
              if (t.length > 20 && !t.includes('About')) return { aboutText: t };
            }
          }
        }
        return null;
      })()
    `);
    return domResult;
  } catch (err) {
    return null;
  }
};

// ─── Data Extraction: Detail Pages ──────────────────────────

// Step 10: Extract experiences from detail page API data
const extractExperiencesFromDetailPage = async () => {
  try {
    const entities = await extractDetailPageEntities('experience');
    const experiences = [];
    const seen = new Set();

    // Approach 1: Look for Position-like entities (have title + companyName)
    for (const entity of entities) {
      if (entity.title && entity.companyName) {
        const urn = entity.entityUrn || '';
        if (seen.has(urn) && urn) continue;
        if (urn) seen.add(urn);
        const tp = entity.timePeriod || {};
        experiences.push({
          jobTitle: entity.title,
          companyName: entity.companyName,
          dates: formatDateRange(tp.startDate, tp.endDate),
          location: entity.locationName || '',
          description: entity.description || ''
        });
      }
    }

    // Approach 2: Parse from topComponents if Approach 1 found nothing
    if (experiences.length === 0) {
      for (const entity of entities) {
        const topComps = entity.topComponents;
        if (!Array.isArray(topComps) || topComps.length < 2) continue;
        // Skip section header cards
        const entityUrn = entity.entityUrn || '';
        if (entityUrn.includes('EXPERIENCE') && !entityUrn.includes('profilePosition')) continue;

        const texts = extractTextsFromComponents(topComps);

        if (texts.length >= 2) {
          const DATE_RE = /\b(19|20)\d{2}\b/;
          const role = { jobTitle: texts[0], companyName: '', dates: '', location: '', description: '' };
          for (let i = 1; i < texts.length; i++) {
            const t = texts[i];
            if (!role.companyName && !DATE_RE.test(t) && t.length < 80) { role.companyName = t; continue; }
            if (!role.dates && DATE_RE.test(t)) { role.dates = t; continue; }
            if (!role.description && t.length > 20) { role.description = t; continue; }
          }
          if (role.jobTitle) experiences.push(role);
        }
      }
    }

    // Approach 3: DOM scraping fallback
    if (experiences.length === 0) {
      const domExperiences = await page.evaluate(`
        (() => {
          const results = [];
          // LinkedIn detail pages use list items for each entry
          const items = document.querySelectorAll('li.pvs-list__paged-list-item, li.artdeco-list__item, main li');
          for (const item of items) {
            const spans = item.querySelectorAll('span[aria-hidden="true"]');
            const texts = [];
            for (const span of spans) {
              const t = span.textContent.trim();
              if (t && t.length > 0 && t.length < 500) texts.push(t);
            }
            if (texts.length >= 2) {
              const DATE_RE = /\\b(19|20)\\d{2}\\b/;
              const role = { jobTitle: texts[0], companyName: '', dates: '', location: '', description: '' };
              for (let i = 1; i < texts.length; i++) {
                const t = texts[i];
                if (!role.companyName && !DATE_RE.test(t) && t.length < 80) { role.companyName = t; continue; }
                if (!role.dates && DATE_RE.test(t)) { role.dates = t; continue; }
                if (!role.location && t.includes(',') && t.length < 60) { role.location = t; continue; }
                if (!role.description && t.length > 30) { role.description = t; continue; }
              }
              if (role.jobTitle && (role.companyName || role.dates)) results.push(role);
            }
          }
          return results;
        })()
      `);
      if (domExperiences && domExperiences.length > 0) {
        experiences.push(...domExperiences);
      }
    }

    return experiences;
  } catch (err) {
    return [];
  }
};

// Step 11: Extract education from detail page API data
const extractEducationFromDetailPage = async () => {
  try {
    const entities = await extractDetailPageEntities('education');
    const education = [];
    const seen = new Set();

    // Approach 1: Direct entity fields
    for (const entity of entities) {
      if (entity.schoolName) {
        const urn = entity.entityUrn || '';
        if (seen.has(urn) && urn) continue;
        if (urn) seen.add(urn);
        const tp = entity.timePeriod || {};
        education.push({
          schoolName: entity.schoolName,
          degree: [entity.degreeName, entity.fieldOfStudy].filter(Boolean).join(', '),
          years: formatDateRange(tp.startDate, tp.endDate),
          grade: entity.grade || '',
          logoUrl: ''
        });
      }
    }

    // Approach 2: Parse from topComponents
    if (education.length === 0) {
      for (const entity of entities) {
        const topComps = entity.topComponents;
        if (!Array.isArray(topComps) || topComps.length < 2) continue;

        const texts = extractTextsFromComponents(topComps);

        if (texts.length >= 1) {
          const DATE_RE = /\b(19|20)\d{2}\b/;
          const entry = { schoolName: texts[0], degree: '', years: '', grade: '', logoUrl: '' };
          for (let i = 1; i < texts.length; i++) {
            const t = texts[i];
            if (!entry.years && DATE_RE.test(t)) { entry.years = t; continue; }
            if (t.toLowerCase().startsWith('grade')) { entry.grade = t; continue; }
            if (!entry.degree) { entry.degree = t; continue; }
          }
          if (entry.schoolName) education.push(entry);
        }
      }
    }

    // Approach 3: DOM scraping fallback
    if (education.length === 0) {
      const domEducation = await page.evaluate(`
        (() => {
          const results = [];
          const items = document.querySelectorAll('li.pvs-list__paged-list-item, li.artdeco-list__item, main li');
          for (const item of items) {
            const spans = item.querySelectorAll('span[aria-hidden="true"]');
            const texts = [];
            for (const span of spans) {
              const t = span.textContent.trim();
              if (t && t.length > 0 && t.length < 500) texts.push(t);
            }
            if (texts.length >= 1) {
              const DATE_RE = /\\b(19|20)\\d{2}\\b/;
              const entry = { schoolName: texts[0], degree: '', years: '', grade: '', logoUrl: '' };
              for (let i = 1; i < texts.length; i++) {
                const t = texts[i];
                if (!entry.years && DATE_RE.test(t)) { entry.years = t; continue; }
                if (t.toLowerCase().startsWith('grade')) { entry.grade = t; continue; }
                if (!entry.degree) { entry.degree = t; continue; }
              }
              if (entry.schoolName) results.push(entry);
            }
          }
          return results;
        })()
      `);
      if (domEducation && domEducation.length > 0) {
        education.push(...domEducation);
      }
    }

    return education;
  } catch (err) {
    return [];
  }
};

// Step 12: Extract skills from detail page API data
const extractSkillsFromDetailPage = async () => {
  try {
    const entities = await extractDetailPageEntities('skills');
    const skills = [];
    const seen = new Set();

    // Approach 1: Skill entities with name field
    for (const entity of entities) {
      const type = entity['$type'] || '';
      if (entity.name && (type.includes('Skill') || type.includes('skill'))) {
        if (seen.has(entity.name)) continue;
        seen.add(entity.name);
        skills.push({ name: entity.name, endorsements: '' });
      }
    }

    // Approach 2: topComponents extraction
    if (skills.length === 0) {
      for (const entity of entities) {
        const topComps = entity.topComponents;
        if (!Array.isArray(topComps)) continue;

        const texts = extractTextsFromComponents(topComps);

        // Skills are typically single-text entries
        if (texts.length >= 1 && texts[0].length < 100) {
          const name = texts[0];
          if (!seen.has(name)) {
            seen.add(name);
            skills.push({ name, endorsements: texts.length > 1 ? texts.slice(1).join('; ') : '' });
          }
        }
      }
    }

    // Approach 3: DOM scraping fallback
    if (skills.length === 0) {
      const domSkills = await page.evaluate(`
        (() => {
          const results = [];
          const seen = new Set();
          const items = document.querySelectorAll('li.pvs-list__paged-list-item, li.artdeco-list__item, main li');
          for (const item of items) {
            const spans = item.querySelectorAll('span[aria-hidden="true"]');
            const texts = [];
            for (const span of spans) {
              const t = span.textContent.trim();
              if (t && t.length > 0 && t.length < 200) texts.push(t);
            }
            if (texts.length >= 1 && texts[0].length < 100) {
              const name = texts[0];
              if (!seen.has(name)) {
                seen.add(name);
                results.push({ name, endorsements: texts.length > 1 ? texts.slice(1).join('; ') : '' });
              }
            }
          }
          return results;
        })()
      `);
      if (domSkills && domSkills.length > 0) {
        skills.push(...domSkills);
      }
    }

    return skills;
  } catch (err) {
    return [];
  }
};

// Step 13: Extract languages from detail page API data
const extractLanguagesFromDetailPage = async () => {
  try {
    const entities = await extractDetailPageEntities('languages');
    const languages = [];
    const seen = new Set();

    // Approach 1: Language entities
    for (const entity of entities) {
      const type = entity['$type'] || '';
      if (entity.name && (type.includes('Language') || type.includes('language') || entity.proficiency)) {
        if (seen.has(entity.name)) continue;
        seen.add(entity.name);
        languages.push({ name: entity.name, proficiency: entity.proficiency || '' });
      }
    }

    // Approach 2: topComponents
    if (languages.length === 0) {
      for (const entity of entities) {
        const topComps = entity.topComponents;
        if (!Array.isArray(topComps)) continue;

        const texts = extractTextsFromComponents(topComps);

        if (texts.length >= 1 && texts[0].length < 50) {
          const name = texts[0];
          if (!seen.has(name)) {
            seen.add(name);
            languages.push({ name, proficiency: texts.length > 1 ? texts[1] : '' });
          }
        }
      }
    }

    // Approach 3: DOM scraping fallback
    if (languages.length === 0) {
      const domLanguages = await page.evaluate(`
        (() => {
          const results = [];
          const seen = new Set();
          const items = document.querySelectorAll('li.pvs-list__paged-list-item, li.artdeco-list__item, main li');
          for (const item of items) {
            const spans = item.querySelectorAll('span[aria-hidden="true"]');
            const texts = [];
            for (const span of spans) {
              const t = span.textContent.trim();
              if (t && t.length > 0 && t.length < 200) texts.push(t);
            }
            if (texts.length >= 1 && texts[0].length < 50) {
              const name = texts[0];
              if (!seen.has(name)) {
                seen.add(name);
                results.push({ name, proficiency: texts.length > 1 ? texts[1] : '' });
              }
            }
          }
          return results;
        })()
      `);
      if (domLanguages && domLanguages.length > 0) {
        languages.push(...domLanguages);
      }
    }

    return languages;
  } catch (err) {
    return [];
  }
};

// Helper: Scroll to load lazy content on the main profile page
const scrollToLoadContent = async () => {
  await page.evaluate(`
    (async () => {
      const delay = ms => new Promise(r => setTimeout(r, ms));
      const scrollHeight = document.body.scrollHeight;
      const step = window.innerHeight;

      for (let pos = 0; pos < scrollHeight; pos += step) {
        window.scrollTo(0, pos);
        await delay(500);
      }

      await delay(500);
      window.scrollTo(0, document.body.scrollHeight);
      await delay(1000);

      window.scrollTo(0, 0);
    })()
  `);
  await page.sleep(1000);
};

// ─── Main Export Flow ────────────────────────────────────────

(async () => {
  const TOTAL_STEPS = 6;

  // ═══ PHASE 1: Login Detection ═══
  await page.setData('status', 'Checking login status...');
  await page.sleep(2000);

  let isLoggedIn = await checkLoginStatus();

  if (!isLoggedIn) {
    await page.showBrowser('https://www.linkedin.com/login');
    await page.setData('status', 'Please log in to LinkedIn...');
    await page.sleep(2000);

    await page.promptUser(
      'Please log in to LinkedIn. Click "Done" when you see your feed.',
      async () => {
        return await checkLoginStatus();
      },
      2000
    );

    await page.setData('status', 'Login completed');
    await page.sleep(2000);
  } else {
    await page.setData('status', 'Session restored from previous login');
  }

  // ═══ Switch to headless ═══
  await page.goHeadless();

  // ═══ Find profile URL ═══
  await page.setData('status', 'Finding your profile...');
  await page.goto('https://www.linkedin.com/feed/');
  await page.sleep(3000);

  const profileUrl = await getProfileUrl();

  // Step 14: Register network capture before profile navigation
  await page.captureNetwork({
    urlPattern: 'voyagerIdentityDashProfiles',
    key: 'profileGraphQL'
  });

  if (!profileUrl) {
    await page.setData('status', 'Navigating to your profile...');
    await page.goto('https://www.linkedin.com/in/me/');
    await page.sleep(3000);
  } else {
    await page.setData('status', 'Navigating to your profile...');
    await page.goto(profileUrl);
    await page.sleep(3000);
  }

  state.profileUrl = await page.evaluate(`window.location.href`);

  // If URL is still /in/me/, try to resolve the actual vanity URL
  if (state.profileUrl.includes('/in/me')) {
    // Wait for potential client-side redirect
    await page.sleep(2000);
    const resolvedUrl = await page.evaluate(`window.location.href`);
    if (!resolvedUrl.includes('/in/me')) {
      state.profileUrl = resolvedUrl;
    } else {
      // Try to extract canonical URL from the page
      const canonical = await page.evaluate(`
        (() => {
          const link = document.querySelector('link[rel="canonical"]');
          if (link && link.href && link.href.includes('/in/') && !link.href.includes('/in/me'))
            return link.href;
          return null;
        })()
      `);
      if (canonical) state.profileUrl = canonical;
    }
  }

  // Normalize: remove trailing hash/query, ensure trailing slash
  const profileBase = state.profileUrl.split('?')[0].split('#')[0].replace(/\/+$/, '') + '/';

  // ═══ STEP 1: Hero + About (from main profile page) ═══
  await page.setProgress({
    phase: { step: 1, total: TOTAL_STEPS, label: 'Loading profile' },
    message: 'Scrolling to load profile content...',
  });
  await scrollToLoadContent();

  await page.setProgress({
    phase: { step: 1, total: TOTAL_STEPS, label: 'Loading profile' },
    message: 'Extracting profile header...',
  });
  state.heroData = await extractHeroSection();

  if (state.heroData?.fullName) {
    await page.setProgress({
      phase: { step: 1, total: TOTAL_STEPS, label: 'Loading profile' },
      message: `Found profile: ${state.heroData.fullName}`,
    });
  }

  // ═══ STEP 2: About ═══
  await page.setProgress({
    phase: { step: 2, total: TOTAL_STEPS, label: 'Extracting about' },
    message: 'Extracting about section...',
  });
  state.aboutData = await extractAboutSection();

  // ═══ STEP 3: Experience (from detail page) ═══
  await navigateToDetailPage(profileBase, 'experience', 3, TOTAL_STEPS, 'Extracting experience');
  state.experiences = await extractExperiencesFromDetailPage();
  await page.setProgress({
    phase: { step: 3, total: TOTAL_STEPS, label: 'Extracting experience' },
    message: `Found ${state.experiences.length} experiences`,
    count: state.experiences.length,
  });

  // ═══ STEP 4: Education (from detail page) ═══
  await navigateToDetailPage(profileBase, 'education', 4, TOTAL_STEPS, 'Extracting education');
  state.education = await extractEducationFromDetailPage();
  await page.setProgress({
    phase: { step: 4, total: TOTAL_STEPS, label: 'Extracting education' },
    message: `Found ${state.education.length} education entries`,
    count: state.education.length,
  });

  // ═══ STEP 5: Skills (from detail page) ═══
  await navigateToDetailPage(profileBase, 'skills', 5, TOTAL_STEPS, 'Extracting skills');
  state.skills = await extractSkillsFromDetailPage();
  await page.setProgress({
    phase: { step: 5, total: TOTAL_STEPS, label: 'Extracting skills' },
    message: `Found ${state.skills.length} skills`,
    count: state.skills.length,
  });

  // ═══ STEP 6: Languages (from detail page) ═══
  await navigateToDetailPage(profileBase, 'languages', 6, TOTAL_STEPS, 'Extracting languages');
  state.languages = await extractLanguagesFromDetailPage();
  await page.setProgress({
    phase: { step: 6, total: TOTAL_STEPS, label: 'Extracting languages' },
    message: `Found ${state.languages.length} languages`,
    count: state.languages.length,
  });

  // ═══ Build Result ═══
  const hero = state.heroData || {};
  const about = state.aboutData || {};

  const result = {
    'linkedin.profile': {
      profileUrl: state.profileUrl,
      fullName: hero.fullName || '',
      headline: hero.headline || '',
      location: hero.location || '',
      connections: hero.connections || '',
      profilePictureUrl: hero.profilePictureUrl || '',
      about: about.aboutText || '',
    },
    'linkedin.experience': {
      experiences: state.experiences,
    },
    'linkedin.education': {
      education: state.education,
    },
    'linkedin.skills': {
      skills: state.skills,
    },
    'linkedin.languages': {
      languages: state.languages,
    },
    exportSummary: {
      count: state.experiences.length + state.education.length + state.skills.length + state.languages.length,
      label: 'profile items',
      details: [
        state.experiences.length + ' experiences',
        state.education.length + ' education',
        state.skills.length + ' skills',
        state.languages.length + ' languages',
      ].join(', ')
    },
    timestamp: new Date().toISOString(),
    version: "3.0.0-playwright",
    platform: "linkedin"
  };

  state.isComplete = true;

  if (result['linkedin.profile'].fullName) {
    await page.setData('result', result);
    await page.setData('status', `Complete! Exported ${result.exportSummary.details} for ${result['linkedin.profile'].fullName}`);
    return { success: true, data: result };
  } else {
    await page.setData('error', 'Failed to extract profile data');
    return { success: false, error: 'Failed to extract profile data' };
  }
})();

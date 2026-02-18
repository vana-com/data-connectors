/**
 * LinkedIn Connector (Playwright)
 *
 * Uses Playwright for real browser control to extract profile data.
 * Requires the playwright-runner sidecar.
 *
 * LinkedIn uses obfuscated/hashed CSS class names that change frequently.
 * This connector avoids class names entirely, finding data by:
 *   1. Isolating the content section (main > div > div > div:first-child)
 *   2. Drilling through single-child wrappers to reach entry containers
 *   3. Parsing P element text positionally with content-based heuristics
 *
 * Navigates to /details/ subpages to get complete data (experience, skills,
 * education, languages) beyond what's visible on the main profile.
 */

// State management
const state = {
  profileUrl: null,
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

        // Check for elements that appear when logged in
        const hasNav = !!document.querySelector('nav') || !!document.querySelector('header');
        const hasProfileLink = !!document.querySelector('a[href*="/in/"]');
        const hasFeedLink = !!document.querySelector('a[href*="/feed"]');

        return hasProfileLink || hasFeedLink || hasNav;
      })()
    `);
    return result;
  } catch (err) {
    return false;
  }
};

// ─── Profile Navigation ─────────────────────────────────────

const getProfileUrl = async () => {
  try {
    const result = await page.evaluate(`
      (() => {
        const profileLinks = document.querySelectorAll('a[href*="/in/"]');
        for (const link of profileLinks) {
          const href = link.href;
          if (href.includes('/in/') && !href.includes('/in/edit') && !href.includes('/in/me')) {
            return href;
          }
        }
        return null;
      })()
    `);
    return result;
  } catch (err) {
    return null;
  }
};

// ─── Detail Page Helpers ────────────────────────────────────

// Navigate to a detail page and click "Load more" until all entries are visible.
const navigateToDetailPage = async (baseUrl, section, progressStep, totalSteps, label) => {
  // Ensure baseUrl ends with /
  const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  const detailUrl = base + 'details/' + section + '/';

  await page.setProgress({
    phase: { step: progressStep, total: totalSteps, label },
    message: `Loading ${section} details page...`,
  });

  await page.goto(detailUrl);
  await page.sleep(3000);

  // Click "Load more" repeatedly until all content is loaded
  let loadMoreAttempts = 0;
  const MAX_LOAD_MORE = 20; // safety limit
  while (loadMoreAttempts < MAX_LOAD_MORE) {
    const clicked = await page.evaluate(`
      (() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          if (btn.textContent.trim() === 'Load more') {
            btn.scrollIntoView();
            btn.click();
            return true;
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
      message: `Loading more ${section}... (page ${loadMoreAttempts})`,
    });
  }

  // Scroll to bottom to trigger any remaining lazy loads
  await page.evaluate(`
    (async () => {
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise(r => setTimeout(r, 1000));
    })()
  `);
  await page.sleep(500);
};

// ─── Data Extraction: Hero + About (from main profile) ──────

const extractHeroSection = async () => {
  try {
    const result = await page.evaluate(`
      (() => {
        const data = {
          fullName: '',
          headline: '',
          location: '',
          connections: '',
          profilePictureUrl: ''
        };

        const firstSection = document.querySelector('main section');
        if (!firstSection) return data;

        const h2 = firstSection.querySelector('h2');
        if (h2) data.fullName = h2.textContent.trim();

        const img = firstSection.querySelector('img');
        if (img && img.src) data.profilePictureUrl = img.src;

        const ps = [];
        firstSection.querySelectorAll('p').forEach(p => {
          const t = p.textContent.trim();
          if (t.length > 1 && t !== '\\u00b7' && t !== '\\u00B7') {
            ps.push({ text: t, visible: p.offsetHeight > 0 });
          }
        });

        const visiblePs = ps.filter(p => p.visible);
        if (visiblePs.length > 0) data.headline = visiblePs[0].text;

        for (const p of visiblePs) {
          if (p.text.includes('connections') || p.text.includes('followers')) {
            data.connections = p.text;
            break;
          }
        }

        const skipPatterns = ['connections', 'followers', 'Contact info', 'Open to',
          'Show details', 'Get started', 'Add titles', 'Tell non-profits'];
        for (let i = 1; i < visiblePs.length; i++) {
          const t = visiblePs[i].text;
          if (t === data.headline) continue;
          if (t === data.connections) break;
          if (skipPatterns.some(pat => t.includes(pat))) continue;
          if (t.length < 80) {
            data.location = t;
            break;
          }
        }

        return data;
      })()
    `);
    return result;
  } catch (err) {
    return null;
  }
};

const extractAboutSection = async () => {
  try {
    const result = await page.evaluate(`
      (() => {
        const sections = document.querySelectorAll('main section');
        for (const section of sections) {
          const h2 = section.querySelector('h2');
          if (h2 && h2.textContent.trim() === 'About') {
            const spans = section.querySelectorAll('span');
            for (const span of spans) {
              const t = span.textContent.trim();
              if (t.length > 20 && !t.includes('About')) {
                return { aboutText: t };
              }
            }
            const ps = section.querySelectorAll('p');
            for (const p of ps) {
              const t = p.textContent.trim();
              if (t.length > 20 && !t.includes('About')) {
                return { aboutText: t };
              }
            }
          }
        }
        return null;
      })()
    `);
    return result;
  } catch (err) {
    return null;
  }
};

// ─── Data Extraction: Detail Pages ──────────────────────────

// All detail page extractors share the same container-finding strategy:
//  1. Isolate content section: main > div > div > div:first-child
//     (excludes sidebar ads and footer — the root cause of previous mismatches)
//  2. Walk within content section to find the container with the most
//     entry-like child divs (divs containing P elements).
//     This is safe because step 1 already excluded non-content areas.
//
// The shared JS snippet is inlined in each evaluate() call to keep each
// function self-contained (page.evaluate receives a string, not closures).

const extractExperiencesFromDetailPage = async () => {
  try {
    const result = await page.evaluate(`
      (() => {
        const experiences = [];
        const DATE_RE = /\\b(19|20)\\d{2}\\b/;
        const DURATION_ONLY_RE = /^\\d+\\s*(yr|mos|mo)s?/;
        const EMPLOYMENT_RE = /^(Full-time|Part-time|Contract|Permanent|Internship|Self-employed|Freelance|Temporary|Apprenticeship|Seasonal)/i;
        const SKILLS_RE = /(and \\+\\d+ skill|^Skills:)/;
        const HEADINGS = ['Experience', 'Education', 'Skills', 'Languages'];
        const SKIP_TEXT = ['Private to you', 'Visit our', 'Go to your', 'Recommendation transparency'];

        // Find entries container within content section
        const contentSection = document.querySelector('main > div > div > div:first-child');
        if (!contentSection) return experiences;
        let container = null;
        let bestScore = 0;
        const walk = (el, depth) => {
          if (depth > 15) return;
          let score = 0;
          for (const c of el.children) {
            if (c.tagName === 'DIV' && c.querySelectorAll('p').length >= 2) score++;
          }
          if (score > bestScore) { bestScore = score; container = el; }
          for (const c of el.children) {
            if (c.tagName === 'DIV' || c.tagName === 'SECTION') walk(c, depth + 1);
          }
        };
        walk(contentSection, 0);
        if (!container) return experiences;

        for (const child of container.children) {
          if (child.tagName !== 'DIV') continue;
          const ps = Array.from(child.querySelectorAll('p'))
            .map(p => p.textContent.trim()).filter(t => t.length > 0);
          if (ps.length < 2) continue;
          if (ps.length === 1 && HEADINGS.includes(ps[0])) continue;
          if (ps.every(t => SKIP_TEXT.some(s => t.includes(s)))) continue;

          // Detect company group: first P is company name, second is duration-only
          const isCompanyGroup = ps.length >= 3 && DURATION_ONLY_RE.test(ps[1]);

          if (isCompanyGroup) {
            // Date-anchored parsing: find all date lines (contain \\u00b7),
            // then work backwards for title and forwards for description.
            const companyName = ps[0];
            const dateIndices = [];
            for (let i = 2; i < ps.length; i++) {
              if (DATE_RE.test(ps[i]) && !SKILLS_RE.test(ps[i]) && !EMPLOYMENT_RE.test(ps[i]) && ps[i].includes('\\u00b7')) {
                dateIndices.push(i);
              }
            }

            for (let di = 0; di < dateIndices.length; di++) {
              const dateIdx = dateIndices[di];
              const prevBound = di > 0 ? dateIndices[di - 1] : 1;
              let titleIdx = -1;
              for (let j = dateIdx - 1; j > prevBound; j--) {
                if (EMPLOYMENT_RE.test(ps[j]) || SKILLS_RE.test(ps[j])) continue;
                if (DATE_RE.test(ps[j]) && ps[j].includes('\\u00b7')) break;
                titleIdx = j;
                break;
              }

              const nextDateIdx = di + 1 < dateIndices.length ? dateIndices[di + 1] : ps.length;
              let description = '';
              for (let j = dateIdx + 1; j < nextDateIdx; j++) {
                if (SKILLS_RE.test(ps[j]) || EMPLOYMENT_RE.test(ps[j])) continue;
                let isNextTitle = false;
                for (let k = j + 1; k <= j + 2 && k < ps.length; k++) {
                  if (EMPLOYMENT_RE.test(ps[k]) || SKILLS_RE.test(ps[k])) continue;
                  if (DATE_RE.test(ps[k]) && ps[k].includes('\\u00b7')) { isNextTitle = true; break; }
                  break;
                }
                if (isNextTitle) break;
                description = ps[j];
                break;
              }

              const role = {
                jobTitle: titleIdx >= 0 ? ps[titleIdx] : '',
                companyName,
                dates: ps[dateIdx],
                location: '',
                description
              };
              if (role.jobTitle) experiences.push(role);
            }
          } else {
            // Individual entry: title, company, dates, [location], [description], [skills]
            const role = { jobTitle: ps[0], companyName: ps[1] || '', dates: '', location: '', description: '' };

            for (let i = 2; i < ps.length; i++) {
              const t = ps[i];
              if (SKILLS_RE.test(t)) continue;
              if (EMPLOYMENT_RE.test(t)) continue;
              if (!role.dates && DATE_RE.test(t)) { role.dates = t; continue; }
              if (role.dates && !role.location && t.length < 60 && t.includes(',')) { role.location = t; continue; }
              if (!role.description && t.length > 15 && !DATE_RE.test(t)) role.description = t;
            }

            if (role.jobTitle) experiences.push(role);
          }
        }

        return experiences;
      })()
    `);
    return result || [];
  } catch (err) {
    return [];
  }
};

const extractEducationFromDetailPage = async () => {
  try {
    const result = await page.evaluate(`
      (() => {
        const education = [];
        const DATE_RE = /\\b(19|20)\\d{2}\\b/;
        const HEADINGS = ['Experience', 'Education', 'Skills', 'Languages'];
        const SKIP_TEXT = ['Private to you', 'Visit our', 'Go to your', 'Recommendation transparency'];

        const contentSection = document.querySelector('main > div > div > div:first-child');
        if (!contentSection) return education;
        let container = null;
        let bestScore = 0;
        const walk = (el, depth) => {
          if (depth > 15) return;
          let score = 0;
          for (const c of el.children) {
            if (c.tagName === 'DIV' && c.querySelectorAll('p').length >= 1) score++;
          }
          if (score > bestScore) { bestScore = score; container = el; }
          for (const c of el.children) {
            if (c.tagName === 'DIV' || c.tagName === 'SECTION') walk(c, depth + 1);
          }
        };
        walk(contentSection, 0);
        if (!container) return education;

        for (const child of container.children) {
          if (child.tagName !== 'DIV') continue;
          const ps = Array.from(child.querySelectorAll('p'))
            .map(p => p.textContent.trim()).filter(t => t.length > 0);
          if (ps.length === 0) continue;
          if (ps.length === 1 && (HEADINGS.includes(ps[0]) || ps[0].length < 20)) continue;
          if (ps.every(t => SKIP_TEXT.some(s => t.includes(s)))) continue;

          const img = child.querySelector('img');
          const entry = {
            schoolName: ps[0] || '',
            degree: '',
            years: '',
            grade: '',
            logoUrl: img ? img.src : ''
          };

          for (let i = 1; i < ps.length; i++) {
            const t = ps[i];
            if (!entry.years && DATE_RE.test(t)) entry.years = t;
            else if (t.toLowerCase().startsWith('grade:') || t.toLowerCase().startsWith('grade :')) entry.grade = t;
            else if (!entry.degree && t.length > 0) entry.degree = t;
          }

          if (entry.schoolName) education.push(entry);
        }

        return education;
      })()
    `);
    return result || [];
  } catch (err) {
    return [];
  }
};

const extractSkillsFromDetailPage = async () => {
  try {
    const result = await page.evaluate(`
      (() => {
        const skills = [];
        const HEADINGS = ['Experience', 'Education', 'Skills', 'Languages'];
        const SKIP_TEXT = ['Private to you', 'Visit our', 'Go to your', 'Recommendation transparency'];

        const contentSection = document.querySelector('main > div > div > div:first-child');
        if (!contentSection) return skills;
        let container = null;
        let bestScore = 0;
        const walk = (el, depth) => {
          if (depth > 15) return;
          let score = 0;
          for (const c of el.children) {
            if (c.tagName === 'DIV' && c.querySelectorAll('p').length >= 1) score++;
          }
          if (score > bestScore) { bestScore = score; container = el; }
          for (const c of el.children) {
            if (c.tagName === 'DIV' || c.tagName === 'SECTION') walk(c, depth + 1);
          }
        };
        walk(contentSection, 0);
        if (!container) return skills;

        for (const child of container.children) {
          if (child.tagName !== 'DIV') continue;
          const ps = Array.from(child.querySelectorAll('p'))
            .map(p => p.textContent.trim()).filter(t => t.length > 0);
          if (ps.length === 0) continue;
          if (ps.length === 1 && (HEADINGS.includes(ps[0]) || ps[0].length < 3)) continue;
          if (ps.every(t => SKIP_TEXT.some(s => t.includes(s)))) continue;

          skills.push({
            name: ps[0],
            endorsements: ps.length > 1 ? ps.slice(1).join('; ') : ''
          });
        }

        return skills;
      })()
    `);
    return result || [];
  } catch (err) {
    return [];
  }
};

const extractLanguagesFromDetailPage = async () => {
  try {
    const result = await page.evaluate(`
      (() => {
        const languages = [];
        const HEADINGS = ['Experience', 'Education', 'Skills', 'Languages'];
        const SKIP_TEXT = ['Private to you', 'Visit our', 'Go to your', 'Recommendation transparency'];

        const contentSection = document.querySelector('main > div > div > div:first-child');
        if (!contentSection) return languages;
        let container = null;
        let bestScore = 0;
        const walk = (el, depth) => {
          if (depth > 15) return;
          let score = 0;
          for (const c of el.children) {
            if (c.tagName === 'DIV' && c.querySelectorAll('p').length >= 1) score++;
          }
          if (score > bestScore) { bestScore = score; container = el; }
          for (const c of el.children) {
            if (c.tagName === 'DIV' || c.tagName === 'SECTION') walk(c, depth + 1);
          }
        };
        walk(contentSection, 0);
        if (!container) return languages;

        for (const child of container.children) {
          if (child.tagName !== 'DIV') continue;
          const ps = Array.from(child.querySelectorAll('p'))
            .map(p => p.textContent.trim()).filter(t => t.length > 0);
          if (ps.length === 0) continue;
          if (ps.length === 1 && (HEADINGS.includes(ps[0]) || ps[0].length < 3)) continue;
          if (ps.every(t => SKIP_TEXT.some(s => t.includes(s)))) continue;

          languages.push({
            name: ps[0],
            proficiency: ps.length > 1 ? ps[1] : ''
          });
        }

        return languages;
      })()
    `);
    return result || [];
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
    profileUrl: state.profileUrl,
    fullName: hero.fullName || '',
    headline: hero.headline || '',
    location: hero.location || '',
    connections: hero.connections || '',
    profilePictureUrl: hero.profilePictureUrl || '',
    about: about.aboutText || '',
    experience: state.experiences,
    education: state.education,
    skills: state.skills,
    languages: state.languages,
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
    version: "1.3.0-playwright",
    platform: "linkedin"
  };

  state.isComplete = true;

  if (result.fullName) {
    await page.setData('result', result);
    await page.setData('status', `Complete! Exported ${result.exportSummary.details} for ${result.fullName}`);
    return { success: true, data: result };
  } else {
    await page.setData('error', 'Failed to extract profile data');
    return { success: false, error: 'Failed to extract profile data' };
  }
})();

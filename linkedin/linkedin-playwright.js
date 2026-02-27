/**
 * LinkedIn Connector (Playwright)
 *
 * Uses Playwright for real browser control to extract profile data.
 * Requires the playwright-runner sidecar.
 *
 * LinkedIn uses obfuscated/hashed CSS class names that change frequently.
 * This connector avoids class names entirely, finding data by:
 *   1. Isolating the content section (main > div > div > div:first-child,
 *      with fallback to main section or main)
 *   2. Walking the DOM tree scoring containers by entry-like children
 *   3. Extracting text from P elements, falling back to leaf SPAN elements
 *   4. Parsing text positionally with content-based heuristics
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

  await page.goto(detailUrl, { timeout: 60000 });
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

        // LinkedIn uses h1 for the name (changed from h2 circa Feb 2026)
        const heading = firstSection.querySelector('h1') || firstSection.querySelector('h2');
        if (heading) data.fullName = heading.textContent.trim();

        const img = firstSection.querySelector('img');
        if (img && img.src) data.profilePictureUrl = img.src;

        // LinkedIn moved headline/location/connections out of <p> into <span>/<div>.
        // Collect visible text snippets, normalizing whitespace and deduplicating.
        const CTA_PATTERNS = ['connections', 'followers', 'Contact info', 'Open to',
          'Show details', 'Get started', 'Add titles', 'Tell non-profits', 'Show all',
          'See all', 'Learn more', 'View profile', 'Message', 'Connect', 'Follow',
          'Pending', 'More actions', 'Edit', 'Add profile', 'Open', 'premium',
          'Reactivate', 'Verified', 'Enhance profile', 'Add profile section',
          'Send profile', 'Save to PDF', 'Saved items', 'Activity', 'Resources',
          'About this profile'];

        const isCta = (t) => CTA_PATTERNS.some(pat => t.includes(pat));
        const norm = (s) => s.replace(/\\s+/g, ' ').trim();

        const textNodes = [];
        const seenTexts = new Set();
        firstSection.querySelectorAll('p, span, div').forEach(el => {
          let depth = 0;
          let par = el.parentElement;
          while (par && par !== firstSection) { depth++; par = par.parentElement; }
          if (depth > 8) return;

          const t = norm(el.textContent);

          // Skip wrapper elements: text = concatenation of all children's text
          if (el.children.length > 0) {
            const childConcat = norm(Array.from(el.children).map(c => c.textContent).join(''));
            if (childConcat === t) return;
          }

          if (!t || t.length < 2) return;
          if (t === '\\u00b7' || t === '\\u00B7') return;
          if (seenTexts.has(t)) return;

          const visible = el.offsetHeight > 0 && el.offsetWidth > 0;
          if (!visible) return;

          seenTexts.add(t);
          textNodes.push({ text: t, tag: el.tagName });
        });

        // Find connections (contains "connections" or "followers")
        for (const node of textNodes) {
          if (node.text.includes('connections') || node.text.includes('followers')) {
            data.connections = node.text;
            break;
          }
        }

        // Find headline: first non-CTA text that isn't the name
        for (const node of textNodes) {
          const t = node.text;
          if (t === data.fullName) continue;
          if (t === data.connections) continue;
          if (isCta(t)) continue;
          if (t.length > 200) continue;
          if (t.length < 3) continue;
          data.headline = t;
          break;
        }

        // Find location: next short text after headline
        let foundHeadline = false;
        for (const node of textNodes) {
          const t = node.text;
          if (t === data.headline) { foundHeadline = true; continue; }
          if (!foundHeadline) continue;
          if (t === data.fullName || t === data.connections) continue;
          if (isCta(t)) continue;
          if (t.length > 80) continue;
          if (t.length < 3) continue;
          data.location = t;
          break;
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
//  1. Isolate content section: try main > div > div > div:first-child first,
//     fall back to main section, then main (resilient to LinkedIn DOM changes).
//  2. Walk within content section to find the container with the most
//     entry-like child divs/LIs (elements containing P or leaf SPAN text).
//  3. Extract text preferring <p> elements, falling back to leaf <span>
//     elements when <p> gives insufficient results. Normalizes whitespace
//     and skips invisible spans to handle LinkedIn's dual-text pattern
//     (visible + accessible spans side by side).
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

        // Text extraction: prefer <p>, fall back to leaf <span>.
        // Normalizes whitespace and deduplicates to handle LinkedIn's
        // dual-text pattern (visible + accessible spans side by side).
        const norm = (s) => s.replace(/\\s+/g, ' ').trim();
        const getTexts = (el) => {
          const seen = new Set();
          const texts = [];
          const add = (raw) => {
            const t = norm(raw);
            if (!t || t.length < 1 || seen.has(t)) return;
            seen.add(t);
            texts.push(t);
          };
          el.querySelectorAll('p').forEach(p => add(p.textContent));
          if (texts.length < 2) {
            el.querySelectorAll('span').forEach(span => {
              const raw = span.textContent.trim();
              if (!raw || raw.length < 2) return;
              if (span.children.length > 0) {
                const childConcat = norm(Array.from(span.children).map(c => c.textContent).join(''));
                if (childConcat === norm(raw)) return;
              }
              if (span.offsetHeight === 0 && span.offsetWidth === 0) return;
              add(raw);
            });
          }
          return texts;
        };

        // Find content container — try specific selector, fall back to broader
        const contentSection = document.querySelector('main > div > div > div:first-child')
          || document.querySelector('main section')
          || document.querySelector('main');
        if (!contentSection) return experiences;

        const hasEnoughText = (el) => {
          if (el.querySelectorAll('p').length >= 2) return true;
          let count = 0;
          const seen = new Set();
          el.querySelectorAll('span').forEach(s => {
            const t = s.textContent.trim();
            if (t.length < 3 || seen.has(t)) return;
            if (s.children.length > 0) {
              const cc = norm(Array.from(s.children).map(c => c.textContent).join(''));
              if (cc === norm(t)) return;
            }
            seen.add(t);
            count++;
          });
          return count >= 2;
        };

        let container = null;
        let bestScore = 0;
        const walk = (el, depth) => {
          if (depth > 15) return;
          let score = 0;
          for (const c of el.children) {
            if ((c.tagName === 'DIV' || c.tagName === 'LI') && hasEnoughText(c)) score++;
          }
          if (score > bestScore) { bestScore = score; container = el; }
          for (const c of el.children) {
            if (['DIV', 'SECTION', 'UL', 'LI'].includes(c.tagName)) walk(c, depth + 1);
          }
        };
        walk(contentSection, 0);
        if (!container) return experiences;

        for (const child of container.children) {
          if (child.tagName !== 'DIV' && child.tagName !== 'LI') continue;
          const ps = getTexts(child);
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

        const norm = (s) => s.replace(/\\s+/g, ' ').trim();
        const getTexts = (el) => {
          const seen = new Set();
          const texts = [];
          const add = (raw) => {
            const t = norm(raw);
            if (!t || t.length < 1 || seen.has(t)) return;
            seen.add(t);
            texts.push(t);
          };
          el.querySelectorAll('p').forEach(p => add(p.textContent));
          if (texts.length < 2) {
            el.querySelectorAll('span').forEach(span => {
              const raw = span.textContent.trim();
              if (!raw || raw.length < 2) return;
              if (span.children.length > 0) {
                const childConcat = norm(Array.from(span.children).map(c => c.textContent).join(''));
                if (childConcat === norm(raw)) return;
              }
              if (span.offsetHeight === 0 && span.offsetWidth === 0) return;
              add(raw);
            });
          }
          return texts;
        };

        const contentSection = document.querySelector('main > div > div > div:first-child')
          || document.querySelector('main section')
          || document.querySelector('main');
        if (!contentSection) return education;

        const hasEnoughText = (el) => {
          if (el.querySelectorAll('p').length >= 1) return true;
          let count = 0;
          const seen = new Set();
          el.querySelectorAll('span').forEach(s => {
            const t = s.textContent.trim();
            if (t.length < 3 || seen.has(t)) return;
            if (s.children.length > 0) {
              const cc = norm(Array.from(s.children).map(c => c.textContent).join(''));
              if (cc === norm(t)) return;
            }
            seen.add(t);
            count++;
          });
          return count >= 1;
        };

        let container = null;
        let bestScore = 0;
        const walk = (el, depth) => {
          if (depth > 15) return;
          let score = 0;
          for (const c of el.children) {
            if ((c.tagName === 'DIV' || c.tagName === 'LI') && hasEnoughText(c)) score++;
          }
          if (score > bestScore) { bestScore = score; container = el; }
          for (const c of el.children) {
            if (['DIV', 'SECTION', 'UL', 'LI'].includes(c.tagName)) walk(c, depth + 1);
          }
        };
        walk(contentSection, 0);
        if (!container) return education;

        for (const child of container.children) {
          if (child.tagName !== 'DIV' && child.tagName !== 'LI') continue;
          const ps = getTexts(child);
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

        const norm = (s) => s.replace(/\\s+/g, ' ').trim();
        const getTexts = (el) => {
          const seen = new Set();
          const texts = [];
          const add = (raw) => {
            const t = norm(raw);
            if (!t || t.length < 1 || seen.has(t)) return;
            seen.add(t);
            texts.push(t);
          };
          el.querySelectorAll('p').forEach(p => add(p.textContent));
          if (texts.length < 2) {
            el.querySelectorAll('span').forEach(span => {
              const raw = span.textContent.trim();
              if (!raw || raw.length < 2) return;
              if (span.children.length > 0) {
                const childConcat = norm(Array.from(span.children).map(c => c.textContent).join(''));
                if (childConcat === norm(raw)) return;
              }
              if (span.offsetHeight === 0 && span.offsetWidth === 0) return;
              add(raw);
            });
          }
          return texts;
        };

        const contentSection = document.querySelector('main > div > div > div:first-child')
          || document.querySelector('main section')
          || document.querySelector('main');
        if (!contentSection) return skills;

        const hasEnoughText = (el) => {
          if (el.querySelectorAll('p').length >= 1) return true;
          let count = 0;
          const seen = new Set();
          el.querySelectorAll('span').forEach(s => {
            const t = s.textContent.trim();
            if (t.length < 3 || seen.has(t)) return;
            if (s.children.length > 0) {
              const cc = norm(Array.from(s.children).map(c => c.textContent).join(''));
              if (cc === norm(t)) return;
            }
            seen.add(t);
            count++;
          });
          return count >= 1;
        };

        let container = null;
        let bestScore = 0;
        const walk = (el, depth) => {
          if (depth > 15) return;
          let score = 0;
          for (const c of el.children) {
            if ((c.tagName === 'DIV' || c.tagName === 'LI') && hasEnoughText(c)) score++;
          }
          if (score > bestScore) { bestScore = score; container = el; }
          for (const c of el.children) {
            if (['DIV', 'SECTION', 'UL', 'LI'].includes(c.tagName)) walk(c, depth + 1);
          }
        };
        walk(contentSection, 0);
        if (!container) return skills;

        for (const child of container.children) {
          if (child.tagName !== 'DIV' && child.tagName !== 'LI') continue;
          const ps = getTexts(child);
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

        const norm = (s) => s.replace(/\\s+/g, ' ').trim();
        const getTexts = (el) => {
          const seen = new Set();
          const texts = [];
          const add = (raw) => {
            const t = norm(raw);
            if (!t || t.length < 1 || seen.has(t)) return;
            seen.add(t);
            texts.push(t);
          };
          el.querySelectorAll('p').forEach(p => add(p.textContent));
          if (texts.length < 2) {
            el.querySelectorAll('span').forEach(span => {
              const raw = span.textContent.trim();
              if (!raw || raw.length < 2) return;
              if (span.children.length > 0) {
                const childConcat = norm(Array.from(span.children).map(c => c.textContent).join(''));
                if (childConcat === norm(raw)) return;
              }
              if (span.offsetHeight === 0 && span.offsetWidth === 0) return;
              add(raw);
            });
          }
          return texts;
        };

        const contentSection = document.querySelector('main > div > div > div:first-child')
          || document.querySelector('main section')
          || document.querySelector('main');
        if (!contentSection) return languages;

        const hasEnoughText = (el) => {
          if (el.querySelectorAll('p').length >= 1) return true;
          let count = 0;
          const seen = new Set();
          el.querySelectorAll('span').forEach(s => {
            const t = s.textContent.trim();
            if (t.length < 3 || seen.has(t)) return;
            if (s.children.length > 0) {
              const cc = norm(Array.from(s.children).map(c => c.textContent).join(''));
              if (cc === norm(t)) return;
            }
            seen.add(t);
            count++;
          });
          return count >= 1;
        };

        let container = null;
        let bestScore = 0;
        const walk = (el, depth) => {
          if (depth > 15) return;
          let score = 0;
          for (const c of el.children) {
            if ((c.tagName === 'DIV' || c.tagName === 'LI') && hasEnoughText(c)) score++;
          }
          if (score > bestScore) { bestScore = score; container = el; }
          for (const c of el.children) {
            if (['DIV', 'SECTION', 'UL', 'LI'].includes(c.tagName)) walk(c, depth + 1);
          }
        };
        walk(contentSection, 0);
        if (!container) return languages;

        for (const child of container.children) {
          if (child.tagName !== 'DIV' && child.tagName !== 'LI') continue;
          const ps = getTexts(child);
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
  await page.goto('https://www.linkedin.com/feed/', { timeout: 60000 });
  await page.sleep(3000);

  const profileUrl = await getProfileUrl();

  if (!profileUrl) {
    await page.setData('status', 'Navigating to your profile...');
    await page.goto('https://www.linkedin.com/in/me/', { timeout: 60000 });
    await page.sleep(3000);
  } else {
    await page.setData('status', 'Navigating to your profile...');
    await page.goto(profileUrl, { timeout: 60000 });
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
    version: "2.0.0-playwright",
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

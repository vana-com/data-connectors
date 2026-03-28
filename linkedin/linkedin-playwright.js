/**
 * LinkedIn Connector (Playwright) — Voyager API Extraction
 *
 * Exports:
 * - linkedin.profile — Profile info (name, headline, location, about, picture)
 * - linkedin.experience — Work experience (titles, companies, dates)
 * - linkedin.education — Education history (schools, degrees, years)
 * - linkedin.skills — Skills with endorsement counts
 * - linkedin.languages — Languages with proficiency
 * - linkedin.connections — Connections with headlines and date connected
 *
 * Extraction method: REST API fetch (LinkedIn Voyager API)
 */

// ─── Credentials ─────────────────────────────────────────────

const LINKEDIN_LOGIN = process.env.USER_LOGIN_LINKEDIN || '';
const LINKEDIN_PASSWORD = process.env.USER_PASSWORD_LINKEDIN || '';

// ─── Login Detection ─────────────────────────────────────────

const checkLoginStatus = async () => {
  try {
    return await page.evaluate(`
      (() => {
        const hasLoginForm = !!document.querySelector('input[name="session_key"]') ||
                            !!document.querySelector('#username');
        if (hasLoginForm) return false;

        const url = window.location.href;
        const isChallenge = url.includes('/checkpoint/') ||
                           url.includes('/challenge/') ||
                           url.includes('/uas/') ||
                           url.includes('security-verification');
        if (isChallenge) return false;

        const hasFeedIndicators = !!document.querySelector('.scaffold-layout') ||
                                 !!document.querySelector('.global-nav__me-photo') ||
                                 url.includes('/feed') ||
                                 !!document.querySelector('.global-nav');
        return hasFeedIndicators;
      })()
    `);
  } catch (e) {
    return false;
  }
};

// ─── Automated Login ─────────────────────────────────────────

const performLogin = async () => {
  const loginStr = JSON.stringify(LINKEDIN_LOGIN);
  const passwordStr = JSON.stringify(LINKEDIN_PASSWORD);

  await page.goto('https://www.linkedin.com/login');
  await page.sleep(3000);

  const hasForm = await page.evaluate(`!!document.querySelector('input[name="session_key"]')`);
  if (!hasForm) return;

  await page.evaluate(`
    (() => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      ).set;

      const emailInput = document.querySelector('input[name="session_key"]');
      const passwordInput = document.querySelector('input[name="session_password"]');

      if (emailInput) {
        emailInput.focus();
        nativeInputValueSetter.call(emailInput, ${loginStr});
        emailInput.dispatchEvent(new Event('input', { bubbles: true }));
        emailInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (passwordInput) {
        passwordInput.focus();
        nativeInputValueSetter.call(passwordInput, ${passwordStr});
        passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
        passwordInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()
  `);
  await page.sleep(500);

  await page.evaluate(`
    (() => {
      const btn = document.querySelector('button[type="submit"]');
      if (btn) btn.click();
    })()
  `);
  await page.sleep(5000);
};

// ─── API Helpers ─────────────────────────────────────────────

const fetchApi = async (endpoint) => {
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
          if (!resp.ok) return { _error: resp.status };
          return await resp.json();
        } catch(e) { return { _error: e.message }; }
      })()
    `);
  } catch (e) {
    return { _error: e.message || String(e) };
  }
};

const checkApiAuth = async () => {
  const result = await fetchApi('/voyager/api/me');
  return !result._error;
};

// ─── Data Extraction Helpers ─────────────────────────────────

// Handles both legacy (timePeriod.startDate/endDate) and dash (dateRange.start/end) formats
const extractTimePeriod = (obj) => {
  if (!obj) return '';
  // Dash API uses dateRange with start/end objects
  const dr = obj.dateRange || obj;
  const start = dr.start || dr.startDate || obj.startDate;
  const end = dr.end || dr.endDate || obj.endDate;
  let result = '';
  if (start) {
    result += (start.month ? start.month + '/' : '') + (start.year || '');
  }
  result += ' - ';
  if (end) {
    result += (end.month ? end.month + '/' : '') + (end.year || '');
  } else {
    result += 'Present';
  }
  return result.trim();
};

const extractYears = (obj) => {
  if (!obj) return '';
  const dr = obj.dateRange || obj;
  const start = dr.start || dr.startDate || obj.startDate;
  const end = dr.end || dr.endDate || obj.endDate;
  const startYear = start?.year || '';
  const endYear = end?.year || '';
  if (startYear && endYear) return startYear + ' - ' + endYear;
  if (startYear) return startYear + ' - Present';
  return '';
};

// ─── Main Export Flow ────────────────────────────────────────

(async () => {
  const TOTAL_STEPS = 6;

  // ═══ PHASE 1: Login ═══
  await page.setData('status', 'Checking login status...');
  await page.sleep(2000);

  let isAuthenticated = await checkApiAuth();

  if (!isAuthenticated) {
    await page.setData('status', 'Attempting session restore...');
    try {
      await page.goto('https://www.linkedin.com/feed/');
      await page.sleep(4000);
    } catch (e) {
      await page.sleep(2000);
    }
    isAuthenticated = await checkApiAuth();
  }

  if (!isAuthenticated && LINKEDIN_LOGIN && LINKEDIN_PASSWORD) {
    await page.setData('status', 'Logging in with credentials...');
    await performLogin();

    const postLoginUrl = await page.evaluate(`window.location.href`);
    const hitChallenge = postLoginUrl &&
      (postLoginUrl.includes('/checkpoint') || postLoginUrl.includes('/challenge'));

    if (!hitChallenge) {
      isAuthenticated = await checkApiAuth();
    }
  }

  if (!isAuthenticated) {
    // Try requestInput-based login
    await page.goto('https://www.linkedin.com/login');
    await page.sleep(2000);

    const hasLoginForm = await page.evaluate(`!!document.querySelector('input[name="session_key"]')`);

    if (hasLoginForm) {
      const credentialsResult = await page.requestData({
        message: "Log in to LinkedIn",
        schema: {
          type: "object",
          properties: {
            email: { type: "string", description: "LinkedIn email or phone number" },
            password: { type: "string", format: "password" },
          },
          required: ["email", "password"],
        },
      });
      if (credentialsResult.status === 'skipped') {
        await page.setData('error', 'Login credentials required but not available in automated mode.');
        return;
      }
      const { email, password } = credentialsResult.data;

      await page.evaluate(`
        (() => {
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          ).set;

          const emailInput = document.querySelector('input[name="session_key"]');
          const passwordInput = document.querySelector('input[name="session_password"]');

          if (emailInput) {
            emailInput.focus();
            nativeInputValueSetter.call(emailInput, ${JSON.stringify(email)});
            emailInput.dispatchEvent(new Event('input', { bubbles: true }));
            emailInput.dispatchEvent(new Event('change', { bubbles: true }));
          }
          if (passwordInput) {
            passwordInput.focus();
            nativeInputValueSetter.call(passwordInput, ${JSON.stringify(password)});
            passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
            passwordInput.dispatchEvent(new Event('change', { bubbles: true }));
          }
        })()
      `);
      await page.sleep(500);
      await page.evaluate(`
        (() => {
          const btn = document.querySelector('button[type="submit"]');
          if (btn) btn.click();
        })()
      `);
      await page.sleep(5000);

      // Handle 2FA / security verification
      const needs2fa = await page.evaluate(`
        !!document.querySelector('input[name="pin"]') ||
        !!document.querySelector('#input__email_verification_pin') ||
        window.location.href.includes('/checkpoint/')
      `);
      if (needs2fa) {
        const tfaResult = await page.requestData({
          message: "Enter your LinkedIn verification code",
          schema: {
            type: "object",
            properties: { code: { type: "string", description: "Verification code from email or authenticator" } },
            required: ["code"],
          },
        });
        if (tfaResult.status === 'skipped') {
          await page.setData('error', 'Verification code required but not available in automated mode.');
          return;
        }
        const { code } = tfaResult.data;
        await page.evaluate(`
          (() => {
            const input = document.querySelector('input[name="pin"]') ||
                          document.querySelector('#input__email_verification_pin') ||
                          document.querySelector('input[type="text"]');
            if (input) {
              const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value'
              ).set;
              nativeInputValueSetter.call(input, ${JSON.stringify(code)});
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
            }
          })()
        `);
        await page.evaluate(`document.querySelector('button[type="submit"]')?.click()`);
        await page.sleep(5000);
      }

      // Dismiss LinkedIn interstitials (cookie consent, messaging prompts)
      for (let dismissAttempt = 0; dismissAttempt < 3; dismissAttempt++) {
        await page.evaluate(`
          (() => {
            const buttons = document.querySelectorAll('button');
            for (const btn of buttons) {
              const text = (btn.textContent || '').trim().toLowerCase();
              // Cookie consent banner
              if (text.includes('accept & join') || text.includes('accept cookies') ||
                  text.includes('accept all') || text.includes('agree')) {
                btn.click();
                return 'dismissed cookie consent';
              }
              // "Skip for now" or "Not now" prompts
              if (text === 'not now' || text === 'skip' || text === 'skip for now' || text === 'dismiss') {
                btn.click();
                return 'dismissed interstitial';
              }
            }
            // Also try the cookie consent action buttons by their class
            const consentBtn = document.querySelector('.artdeco-global-alert__action');
            if (consentBtn) { consentBtn.click(); return 'dismissed via alert action'; }
            return null;
          })()
        `);
        await page.sleep(1500);
      }

      isAuthenticated = await checkApiAuth();
      if (!isAuthenticated) {
        try {
          await page.goto('https://www.linkedin.com/feed/');
          await page.sleep(3000);
        } catch (e) {
          await page.sleep(2000);
        }
        isAuthenticated = await checkApiAuth();
      }
    }

    // Fallback to manual browser login if programmatic login failed
    if (!isAuthenticated) {
      await page.setData('status', 'Please complete login in the browser...');
      const manualResult = await page.requestManualAction(
        'Complete any remaining verification, then click "Done".',
        async () => await checkLoginStatus(),
        { url: 'https://www.linkedin.com/login', interval: 2000 }
      );
      if (manualResult.status === 'skipped') {
        await page.setData('error', 'Login required but not available in automated mode.');
        return;
      }

      isAuthenticated = await checkApiAuth();
      if (!isAuthenticated) {
        try {
          await page.goto('https://www.linkedin.com/feed/');
          await page.sleep(3000);
        } catch (e) {
          await page.sleep(2000);
        }
        isAuthenticated = await checkApiAuth();
      }

      if (!isAuthenticated) {
        await page.setData('error', 'Login failed. Could not authenticate with LinkedIn API.');
        return;
      }
    }
  }

  await page.setData('status', 'Authenticated — starting data collection');

  // ═══ PHASE 2: Data Collection (headless) ═══
  await page.goHeadless();

  try {
    await page.goto('https://www.linkedin.com/feed/');
    await page.sleep(3000);
  } catch (e) {
    await page.sleep(2000);
  }

  // ═══ STEP 1: Fetch basic profile via /me ═══
  await page.setProgress({
    phase: { step: 1, total: TOTAL_STEPS, label: 'Fetching profile' },
    message: 'Loading your profile...',
  });

  const meData = await fetchApi('/voyager/api/me');
  if (meData._error) {
    await page.setData('error', 'Failed to fetch profile: ' + meData._error);
    return;
  }

  const publicIdentifier = meData.miniProfile?.publicIdentifier ||
                           meData.publicIdentifier || '';

  if (!publicIdentifier) {
    await page.setData('error', 'Could not determine your LinkedIn public identifier.');
    return;
  }

  await page.sleep(500);

  // ═══ STEP 2: Fetch full profile via dash endpoint ═══
  await page.setProgress({
    phase: { step: 2, total: TOTAL_STEPS, label: 'Fetching full profile' },
    message: 'Loading experience, education, skills, languages...',
  });

  const publicIdStr = encodeURIComponent(publicIdentifier);

  // Use the dash profiles endpoint with FullProfileWithEntities decoration
  const dashProfile = await fetchApi(
    '/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity='
    + publicIdStr
    + '&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-93'
  );

  let profileEl = {};
  if (!dashProfile._error && dashProfile.elements && dashProfile.elements.length > 0) {
    profileEl = dashProfile.elements[0];
  } else {
    // Fallback: try without decoration version number or with different version
    const dashProfile2 = await fetchApi(
      '/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity='
      + publicIdStr
      + '&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-109'
    );
    if (!dashProfile2._error && dashProfile2.elements && dashProfile2.elements.length > 0) {
      profileEl = dashProfile2.elements[0];
    } else {
      // Minimal fallback: basic profile without entities
      const basicProfile = await fetchApi(
        '/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=' + publicIdStr
      );
      if (!basicProfile._error && basicProfile.elements && basicProfile.elements.length > 0) {
        profileEl = basicProfile.elements[0];
      }
    }
  }

  await page.sleep(500);

  // ═══ STEP 3: Extract profile data ═══
  await page.setProgress({
    phase: { step: 3, total: TOTAL_STEPS, label: 'Extracting profile data' },
    message: 'Processing profile, experience, education...',
  });

  // --- Profile ---
  const fullName = ((profileEl.firstName || meData.miniProfile?.firstName || '') + ' ' +
                    (profileEl.lastName || meData.miniProfile?.lastName || '')).trim();
  const headline = profileEl.headline || meData.miniProfile?.occupation || '';
  const locationName = profileEl.location?.basicLocation?.countryCode
    ? [profileEl.location?.preferredGeoPlace, profileEl.location?.basicLocation?.countryCode].filter(Boolean).join(', ')
    : profileEl.geoLocation?.geo?.defaultLocalizedName || '';
  const about = profileEl.summary || '';
  const profileUrl = 'https://www.linkedin.com/in/' + publicIdentifier + '/';

  // Extract profile picture from dash profile or /me
  const profilePictureUrl = (() => {
    // Try dash profile picture
    const dashPic = profileEl.profilePicture?.displayImageReference?.vectorImage;
    if (dashPic) {
      const artifacts = dashPic.artifacts || [];
      if (artifacts.length > 0) {
        return (dashPic.rootUrl || '') + (artifacts[artifacts.length - 1].fileIdentifyingUrlPathSegment || '');
      }
    }
    // Fallback to /me miniProfile picture
    const pics = meData.miniProfile?.picture?.['com.linkedin.common.VectorImage']?.artifacts ||
                 meData.miniProfile?.picture?.artifacts || [];
    if (pics.length > 0) {
      const rootUrl = meData.miniProfile?.picture?.['com.linkedin.common.VectorImage']?.rootUrl ||
                      meData.miniProfile?.picture?.rootUrl || '';
      const largest = pics[pics.length - 1];
      return rootUrl + (largest.fileIdentifyingUrlPathSegment || '');
    }
    return '';
  })();

  // Connection count — will be updated after fetching connections
  let connectionCountStr = '0';

  const profileResult = {
    profileUrl: profileUrl,
    fullName: fullName,
    headline: headline,
    location: locationName,
    connections: connectionCountStr, // updated later
    profilePictureUrl: profilePictureUrl,
    about: about,
  };

  // --- Experience (from profilePositionGroups) ---
  let experiences = [];
  const positionGroups = profileEl.profilePositionGroups?.elements || [];

  for (const group of positionGroups) {
    const groupCompanyName = group.company?.name || group.name || '';
    const positions = group.profilePositionInPositionGroup?.elements || [];

    if (positions.length > 0) {
      for (const pos of positions) {
        experiences.push({
          jobTitle: pos.title || '',
          companyName: pos.companyName || groupCompanyName,
          dates: extractTimePeriod(pos.dateRange || pos.timePeriod || pos),
          location: pos.locationName || pos.geoLocationName || '',
          description: pos.description || '',
        });
      }
    } else {
      // Group with no sub-positions (single role at company)
      experiences.push({
        jobTitle: group.title || '',
        companyName: groupCompanyName,
        dates: extractTimePeriod(group.dateRange || group.timePeriod || group),
        location: group.locationName || group.geoLocationName || '',
        description: group.description || '',
      });
    }
  }

  // --- Education (from profileEducations) ---
  const rawEducation = profileEl.profileEducations?.elements || [];

  const education = rawEducation.map((edu) => {
    const schoolName = edu.schoolName || edu.school?.name || '';
    const degree = [
      edu.degreeName || '',
      edu.fieldOfStudy || '',
    ].filter(Boolean).join(', ');
    const years = extractYears(edu.dateRange || edu.timePeriod || edu);
    const grade = edu.grade || '';
    const logoUrl = (() => {
      const img = edu.school?.logo?.vectorImage ||
                  edu.school?.logo?.['com.linkedin.common.VectorImage'] ||
                  edu.schoolLogo?.vectorImage || {};
      const artifacts = img.artifacts || [];
      if (artifacts.length > 0) {
        return (img.rootUrl || '') + (artifacts[artifacts.length - 1].fileIdentifyingUrlPathSegment || '');
      }
      return '';
    })();

    return {
      schoolName: schoolName,
      degree: degree,
      years: years,
      grade: grade,
      logoUrl: logoUrl,
    };
  });

  // --- Skills (from profileSkills) ---
  const rawSkills = profileEl.profileSkills?.elements || [];

  let skills = [];
  for (const skillCategory of rawSkills) {
    // profileSkills may be grouped by category (e.g. "Industry Knowledge", "Tools & Technologies")
    const categorySkills = skillCategory.skills || skillCategory.elements || [];
    if (Array.isArray(categorySkills)) {
      for (const sk of categorySkills) {
        skills.push({
          name: sk.name || '',
          endorsements: String(sk.endorsementCount || sk.endorsements || 0),
        });
      }
    }
    // If the element itself is a skill (not a category)
    if (skillCategory.name && !categorySkills.length) {
      skills.push({
        name: skillCategory.name || '',
        endorsements: String(skillCategory.endorsementCount || skillCategory.endorsements || 0),
      });
    }
  }

  // --- Languages (from profileLanguages) ---
  const rawLanguages = profileEl.profileLanguages?.elements || [];

  let languages = rawLanguages.map((lang) => ({
    name: lang.name || '',
    proficiency: lang.proficiency || '',
  }));

  // ═══ STEP 4: Fetch connections ═══
  await page.setProgress({
    phase: { step: 4, total: TOTAL_STEPS, label: 'Fetching connections' },
    message: 'Fetching connection records...',
  });

  const connectionRecords = [];
  let start = 0;
  const count = 40;
  const maxConnections = 2000;
  let totalAvailable = 0;

  while (start < maxConnections) {
    const endpoint = '/voyager/api/relationships/dash/connections'
      + '?count=' + count
      + '&q=search'
      + '&sortType=RECENTLY_ADDED'
      + '&start=' + start;

    const data = await fetchApi(endpoint);
    if (data._error) {
      if (start === 0) {
        await page.setData('status', '[WARN] Could not fetch connections: ' + data._error);
      }
      break;
    }

    totalAvailable = data.paging?.total || totalAvailable;
    const elements = data.elements || [];
    if (elements.length === 0) break;

    for (const el of elements) {
      connectionRecords.push({
        memberUrn: typeof el.connectedMember === 'string' ? el.connectedMember : '',
        createdAt: el.createdAt || 0,
      });
    }

    await page.setProgress({
      phase: { step: 4, total: TOTAL_STEPS, label: 'Fetching connections' },
      message: 'Fetched ' + connectionRecords.length + (totalAvailable ? ' of ' + totalAvailable : '') + ' connections...',
      count: connectionRecords.length,
    });

    if (elements.length < count) break;
    start += count;
    await page.sleep(300);
  }

  // Update connection count in profile result
  profileResult.connections = String(totalAvailable || connectionRecords.length);

  // ═══ STEP 5: Resolve connection profiles ═══
  await page.setProgress({
    phase: { step: 5, total: TOTAL_STEPS, label: 'Resolving profiles' },
    message: 'Resolving member profiles...',
  });

  const profileMap = {};
  const memberUrns = connectionRecords.map(r => r.memberUrn).filter(Boolean);
  const batchSize = 20;
  let resolved = 0;
  let consecutiveFailures = 0;

  for (let i = 0; i < memberUrns.length; i += batchSize) {
    const batch = memberUrns.slice(i, i + batchSize);
    const urnList = batch.map(u => encodeURIComponent(u)).join(',');
    const profileData = await fetchApi(
      '/voyager/api/identity/dash/profiles?ids=List(' + urnList + ')'
    );

    if (!profileData._error) {
      consecutiveFailures = 0;

      if (profileData.results && typeof profileData.results === 'object') {
        for (const [key, profile] of Object.entries(profileData.results)) {
          if (profile && (profile.firstName || profile.publicIdentifier)) {
            profileMap[key] = profile;
            resolved++;
          }
        }
      }
      if (profileData.elements && Array.isArray(profileData.elements)) {
        for (const profile of profileData.elements) {
          const urn = profile.entityUrn || profile.dashEntityUrn || '';
          if (urn && (profile.firstName || profile.publicIdentifier)) {
            profileMap[urn] = profile;
            resolved++;
          }
        }
      }
    } else {
      consecutiveFailures++;
      if (consecutiveFailures <= 2) {
        for (const urn of batch) {
          const singleData = await fetchApi(
            '/voyager/api/identity/dash/profiles?ids=List(' + encodeURIComponent(urn) + ')'
          );
          if (!singleData._error && singleData.results) {
            const singleResult = singleData.results[urn] || Object.values(singleData.results)[0];
            if (singleResult && (singleResult.firstName || singleResult.publicIdentifier)) {
              profileMap[urn] = singleResult;
              resolved++;
            }
          }
        }
      }
      if (consecutiveFailures >= 5) break;
    }

    await page.setProgress({
      phase: { step: 5, total: TOTAL_STEPS, label: 'Resolving profiles' },
      message: 'Resolved ' + resolved + ' of ' + memberUrns.length + ' profiles...',
      count: resolved,
    });

    await page.sleep(500);
  }

  // ═══ STEP 6: Build result ═══
  await page.setProgress({
    phase: { step: 6, total: TOTAL_STEPS, label: 'Finalizing' },
    message: 'Building export...',
  });

  const connections = connectionRecords.map((record) => {
    const profile = profileMap[record.memberUrn] || {};
    const firstName = profile.firstName || '';
    const lastName = profile.lastName || '';
    const connFullName = (firstName + ' ' + lastName).trim();
    const connHeadline = profile.headline || profile.occupation || '';
    const publicId = profile.publicIdentifier || '';
    const connProfileUrl = publicId ? 'https://www.linkedin.com/in/' + publicId + '/' : '';
    const dateConnected = record.createdAt > 0
      ? new Date(record.createdAt).toISOString().split('T')[0]
      : '';

    return {
      fullName: connFullName,
      headline: connHeadline,
      profileUrl: connProfileUrl,
      dateConnected: dateConnected,
    };
  });

  const resolvedCount = connections.filter(c => c.fullName).length;

  const result = {
    'linkedin.profile': profileResult,
    'linkedin.experience': {
      experiences: experiences,
    },
    'linkedin.education': {
      education: education,
    },
    'linkedin.skills': {
      skills: skills,
    },
    'linkedin.languages': {
      languages: languages,
    },
    'linkedin.connections': {
      connections: connections,
    },
    exportSummary: {
      count: experiences.length + education.length + skills.length + languages.length + connections.length + 1,
      label: 'items',
      details: '1 profile, ' + experiences.length + ' experiences, ' + education.length + ' education, '
        + skills.length + ' skills, ' + languages.length + ' languages, '
        + connections.length + ' connections (' + resolvedCount + ' with profiles)',
    },
    timestamp: new Date().toISOString(),
    version: '1.0.0-playwright',
    platform: 'linkedin',
  };

  await page.setData('result', result);
  await page.setData('status', 'Complete! Exported ' + result.exportSummary.details);

  return { success: true, data: result };
})();

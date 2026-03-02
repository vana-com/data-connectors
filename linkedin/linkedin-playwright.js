/**
 * LinkedIn Connector (Playwright) — Voyager Dash API Extraction
 *
 * Uses Playwright for browser control (login) then extracts all profile data
 * via LinkedIn's Voyager Dash REST API. No DOM scraping needed.
 *
 * API endpoints used:
 *   - /voyager/api/me — get profileUrn, miniProfile (name, picture)
 *   - /voyager/api/identity/dash/profiles?decorationId=FullProfileWithEntities-109
 *     — headline, summary (about), geoLocation, education, skills, languages
 *   - /voyager/api/identity/dash/profilePositions?q=viewee
 *     — all work experience positions
 */

// ─── Login Helpers ───────────────────────────────────────────

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

        const hasFeedIndicators = !!document.querySelector('.feed-shared-update-v2') ||
                                 !!document.querySelector('.scaffold-layout') ||
                                 !!document.querySelector('div[data-test-id="feed"]') ||
                                 !!document.querySelector('.global-nav__me-photo') ||
                                 url.includes('/feed') ||
                                 !!document.querySelector('img.global-nav__me-photo');
        return hasFeedIndicators;
      })()
    `);
  } catch (e) {
    return false;
  }
};

// ─── API Helpers ─────────────────────────────────────────────

const debug = async (msg) => {
  await page.setData('status', '[DEBUG] ' + msg);
};

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

const buildProfilePictureUrl = (pictureData) => {
  const vecImage = pictureData?.['com.linkedin.common.VectorImage'] ||
    pictureData?.displayImageReferenceResolutionResult?.vectorImage || pictureData;
  if (!vecImage?.rootUrl || !vecImage?.artifacts?.length) return '';
  const largest = vecImage.artifacts[vecImage.artifacts.length - 1];
  return vecImage.rootUrl + (largest.fileIdentifyingUrlPathSegment || '');
};

const formatDateRange = (dateRange) => {
  if (!dateRange) return '';
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const fmt = (d) => d ? (d.month ? MONTHS[d.month - 1] + ' ' : '') + d.year : '';
  const start = fmt(dateRange.start);
  const end = dateRange.end ? fmt(dateRange.end) : 'Present';
  if (!start) return '';
  return start + ' - ' + end;
};

const PROFICIENCY_MAP = {
  NATIVE_OR_BILINGUAL: 'Native or bilingual proficiency',
  FULL_PROFESSIONAL: 'Full professional proficiency',
  PROFESSIONAL_WORKING: 'Professional working proficiency',
  LIMITED_WORKING: 'Limited working proficiency',
  ELEMENTARY: 'Elementary proficiency',
};

// ─── Main Export Flow ────────────────────────────────────────

(async () => {
  const TOTAL_STEPS = 4;

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

  // ═══ Navigate to feed (needed for CSRF cookie) ═══
  await page.setData('status', 'Loading LinkedIn...');
  await page.goto('https://www.linkedin.com/feed/');
  await page.sleep(3000);

  // ═══ STEP 1: Get profile identity ═══
  await page.setProgress({
    phase: { step: 1, total: TOTAL_STEPS, label: 'Getting profile' },
    message: 'Fetching profile identity...',
  });

  const meData = await fetchApi('/voyager/api/me');
  if (meData._error) {
    await page.setData('error', 'Failed to fetch profile identity: ' + meData._error);
    return { success: false, error: 'Failed to fetch /api/me' };
  }

  const miniProfile = meData.miniProfile;
  if (!miniProfile?.publicIdentifier) {
    await page.setData('error', 'Could not find profile identifier');
    return { success: false, error: 'No publicIdentifier in /api/me' };
  }

  const publicId = miniProfile.publicIdentifier;
  const profileUrn = miniProfile.dashEntityUrn;
  const fullName = ((miniProfile.firstName || '') + ' ' + (miniProfile.lastName || '')).trim();

  await debug('Found profile: ' + fullName + ' (' + publicId + ')');
  await page.setProgress({
    phase: { step: 1, total: TOTAL_STEPS, label: 'Getting profile' },
    message: 'Found profile: ' + fullName,
  });

  // ═══ STEP 2: Fetch all data in parallel ═══
  await page.setProgress({
    phase: { step: 2, total: TOTAL_STEPS, label: 'Fetching data' },
    message: 'Fetching profile data...',
  });

  // Two API calls in parallel — one for full profile (about, edu, skills, languages),
  // one for positions (not included in the FullProfile decorator).
  const encodedUrn = encodeURIComponent(profileUrn);
  const [fullProfileData, positionsData] = await Promise.all([
    fetchApi(
      '/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=' +
      encodeURIComponent(publicId) +
      '&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-109'
    ),
    fetchApi(
      '/voyager/api/identity/dash/profilePositions?q=viewee&profileUrn=' + encodedUrn
    ),
  ]);

  // ═══ STEP 3: Parse profile data ═══
  await page.setProgress({
    phase: { step: 3, total: TOTAL_STEPS, label: 'Processing' },
    message: 'Processing profile data...',
  });

  const profile = fullProfileData?.elements?.[0] || {};

  // Profile picture
  let profilePictureUrl = '';
  if (miniProfile.picture) {
    profilePictureUrl = buildProfilePictureUrl(miniProfile.picture);
  }

  // Location
  const location = profile.geoLocation?.geo?.defaultLocalizedName || '';

  // About / summary
  const about = profile.summary || '';

  // Headline
  const headline = profile.headline || miniProfile.occupation || '';

  // ── Experiences ──
  const positions = positionsData?.elements || [];
  const experiences = positions.map(pos => ({
    jobTitle: pos.title || '',
    companyName: pos.companyName || '',
    dates: formatDateRange(pos.dateRange),
    location: pos.locationName || '',
    description: pos.description || '',
  }));
  await debug('Positions: ' + experiences.length);

  // ── Education ──
  const eduElements = profile.profileEducations?.elements || [];
  const education = eduElements.map(edu => ({
    schoolName: edu.schoolName || '',
    degree: [edu.degreeName, edu.fieldOfStudy].filter(Boolean).join(', '),
    years: formatDateRange(edu.dateRange),
    grade: edu.grade || '',
    logoUrl: '',
  }));
  await debug('Education: ' + education.length);

  // ── Skills ──
  const skillElements = profile.profileSkills?.elements || [];
  const skills = skillElements.map(s => ({
    name: s.name || '',
    endorsements: '',
  }));
  await debug('Skills: ' + skills.length + ' (of ' + (profile.profileSkills?.paging?.total || '?') + ')');

  // ── Languages ──
  const langElements = profile.profileLanguages?.elements || [];
  const languages = langElements.map(l => ({
    name: l.name || '',
    proficiency: PROFICIENCY_MAP[l.proficiency] || l.proficiency || '',
  }));
  await debug('Languages: ' + languages.length);

  // ═══ STEP 4: Build result ═══
  await page.setProgress({
    phase: { step: 4, total: TOTAL_STEPS, label: 'Finalizing' },
    message: 'Building export...',
  });

  const profileUrl = 'https://www.linkedin.com/in/' + publicId + '/';

  const result = {
    'linkedin.profile': {
      profileUrl,
      fullName,
      headline,
      location,
      connections: '',
      profilePictureUrl,
      about,
    },
    'linkedin.experience': {
      experiences,
    },
    'linkedin.education': {
      education,
    },
    'linkedin.skills': {
      skills,
    },
    'linkedin.languages': {
      languages,
    },
    exportSummary: {
      count: experiences.length + education.length + skills.length + languages.length,
      label: 'profile items',
      details: [
        experiences.length + ' experiences',
        education.length + ' education',
        skills.length + ' skills',
        languages.length + ' languages',
      ].join(', ')
    },
    timestamp: new Date().toISOString(),
    version: "4.0.0-playwright",
    platform: "linkedin"
  };

  if (fullName) {
    await page.setData('result', result);
    await page.setData('status', 'Complete! Exported ' + result.exportSummary.details + ' for ' + fullName);
    return { success: true, data: result };
  } else {
    await page.setData('error', 'Failed to extract profile data');
    return { success: false, error: 'Failed to extract profile data' };
  }
})();

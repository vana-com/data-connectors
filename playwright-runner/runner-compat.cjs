function isPlainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function inferPlatformFromScopes(requestedScopes) {
  if (!Array.isArray(requestedScopes)) {
    return null;
  }

  for (const scope of requestedScopes) {
    if (typeof scope !== 'string') {
      continue;
    }

    const [platform] = scope.split('.', 1);
    if (platform) {
      return platform;
    }
  }

  return null;
}

function isMeaningfulResumeUrl(url) {
  if (typeof url !== 'string' || url.trim().length === 0) {
    return false;
  }

  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function resolveHeadlessResumeUrl(options = {}) {
  const { resumeUrl, currentUrl } = options;

  if (isMeaningfulResumeUrl(resumeUrl)) {
    return resumeUrl;
  }

  if (isMeaningfulResumeUrl(currentUrl)) {
    return currentUrl;
  }

  return 'about:blank';
}

function inferLegacyErrorClass(reason) {
  const normalizedReason = String(reason || '').toLowerCase();

  if (/(login|sign in|sign-in|authenticate|authentication|auth|2fa|password|captcha|verification)/.test(normalizedReason)) {
    return 'auth_failed';
  }
  if (/(rate limit|too many requests|429)/.test(normalizedReason)) {
    return 'rate_limited';
  }
  if (/(timeout|timed out)/.test(normalizedReason)) {
    return 'timeout';
  }
  if (/(network|fetch failed|econn|socket|dns)/.test(normalizedReason)) {
    return 'network_error';
  }
  if (/(selector|locator)/.test(normalizedReason)) {
    return 'selector_error';
  }
  if (/(navigation|redirect|page crashed|about:blank)/.test(normalizedReason)) {
    return 'navigation_error';
  }

  return 'runtime_error';
}

function normalizeProtocolDefaults(result, options) {
  if (!isPlainRecord(result)) {
    return result;
  }

  const { requestedScopes = [], inferredPlatform } = options;
  let changed = false;
  const normalized = { ...result };

  if (!Array.isArray(normalized.requestedScopes) || normalized.requestedScopes.length === 0) {
    normalized.requestedScopes = [...requestedScopes];
    changed = true;
  }

  if (!Array.isArray(normalized.errors)) {
    normalized.errors = [];
    changed = true;
  }

  if (
    (typeof normalized.platform !== 'string' || normalized.platform.length === 0) &&
    inferredPlatform
  ) {
    normalized.platform = inferredPlatform;
    changed = true;
  }

  if (isPlainRecord(normalized.exportSummary) && normalized.exportSummary.details !== undefined) {
    const details = normalized.exportSummary.details;
    if (!isPlainRecord(details)) {
      normalized.exportSummary = { ...normalized.exportSummary };
      if (typeof details === 'string') {
        normalized.exportSummary.details = { text: details };
      } else if (Array.isArray(details)) {
        normalized.exportSummary.details = { items: details };
      } else {
        normalized.exportSummary.details = { value: details };
      }
      changed = true;
    }
  }

  return changed ? normalized : result;
}

function normalizeFailureReason(errorValue) {
  if (typeof errorValue === 'string' && errorValue.trim().length > 0) {
    return errorValue.trim();
  }

  if (
    isPlainRecord(errorValue) &&
    typeof errorValue.message === 'string' &&
    errorValue.message.trim().length > 0
  ) {
    return errorValue.message.trim();
  }

  return 'Connector reported failure';
}

function synthesizeLegacyFailureResult(result, options) {
  const { requestedScopes = [], inferredPlatform } = options;
  const reason = normalizeFailureReason(result.error);

  return {
    requestedScopes: [...requestedScopes],
    timestamp: new Date().toISOString(),
    version:
      typeof result.version === 'string' && result.version.length > 0
        ? result.version
        : 'legacy-compat',
    platform:
      typeof result.platform === 'string' && result.platform.length > 0
        ? result.platform
        : inferredPlatform || 'unknown',
    exportSummary: {
      count: 0,
      label: 'items',
    },
    errors: [
      {
        errorClass: inferLegacyErrorClass(reason),
        reason,
        disposition: 'fatal',
      },
    ],
  };
}

function normalizeConnectorResult(result, options = {}) {
  const requestedScopes = Array.isArray(options.requestedScopes)
    ? options.requestedScopes.filter((scope) => typeof scope === 'string' && scope.length > 0)
    : [];
  const inferredPlatform = inferPlatformFromScopes(requestedScopes);

  if (!isPlainRecord(result)) {
    return result;
  }

  const hasLegacyWrapper =
    typeof result.success === 'boolean' &&
    (Object.prototype.hasOwnProperty.call(result, 'data') ||
      Object.prototype.hasOwnProperty.call(result, 'error'));

  if (!hasLegacyWrapper) {
    return normalizeProtocolDefaults(result, {
      requestedScopes,
      inferredPlatform,
    });
  }

  if (result.success) {
    if (!isPlainRecord(result.data)) {
      return synthesizeLegacyFailureResult(
        {
          ...result,
          error: 'Legacy success wrapper must contain an object data payload',
        },
        {
          requestedScopes,
          inferredPlatform,
        },
      );
    }

    return normalizeProtocolDefaults(result.data, {
      requestedScopes,
      inferredPlatform,
    });
  }

  return synthesizeLegacyFailureResult(result, {
    requestedScopes,
    inferredPlatform,
  });
}

module.exports = {
  normalizeConnectorResult,
  resolveHeadlessResumeUrl,
};

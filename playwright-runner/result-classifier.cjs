const CONNECTOR_RESULT_RESERVED_KEYS = new Set([
  'requestedScopes',
  'timestamp',
  'version',
  'platform',
  'exportSummary',
  'errors',
]);

const TELEMETRY_ERROR_CLASS_PRIORITY = [
  'protocol_violation',
  'auth_failed',
  'rate_limited',
  'upstream_error',
  'navigation_error',
  'network_error',
  'timeout',
  'selector_error',
  'runtime_error',
  'personal_server_unavailable',
  'unknown',
];

function isPlainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function protocolFailure(message, scopeSummary) {
  return {
    outcome: 'failure',
    errorClass: 'protocol_violation',
    scopeSummary: scopeSummary || {
      requested: 0,
      produced: 0,
      degraded: 0,
      omitted: 0,
    },
    debug: `Protocol violation: ${message}`,
  };
}

function dominantErrorClass(errors) {
  for (const errorClass of TELEMETRY_ERROR_CLASS_PRIORITY) {
    if (errors.some((error) => error.errorClass === errorClass)) {
      return errorClass;
    }
  }
  return 'unknown';
}

function hasSameMembers(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return false;
  }

  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== a.length || right.size !== b.length) {
    return false;
  }

  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

function validateConnectorErrors(rawErrors, requestedScopes) {
  if (!Array.isArray(rawErrors)) {
    return { protocolMessage: 'errors must be an array' };
  }

  const errors = [];
  for (const rawError of rawErrors) {
    if (!isPlainRecord(rawError)) {
      return { protocolMessage: 'errors entries must be objects' };
    }

    const { errorClass, reason, disposition, scope, phase } = rawError;
    if (
      typeof errorClass !== 'string' ||
      !TELEMETRY_ERROR_CLASS_PRIORITY.includes(errorClass)
    ) {
      return { protocolMessage: 'errors entries must use a known errorClass' };
    }
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      return { protocolMessage: 'errors entries must include a non-empty reason' };
    }
    if (disposition !== 'omitted' && disposition !== 'degraded' && disposition !== 'fatal') {
      return { protocolMessage: 'errors entries must use omitted, degraded, or fatal disposition' };
    }
    if ((disposition === 'omitted' || disposition === 'degraded') && typeof scope !== 'string') {
      return { protocolMessage: `${disposition} errors must include a scope` };
    }
    if (typeof scope === 'string' && scope.length > 0 && !requestedScopes.has(scope)) {
      return { protocolMessage: `errors scope '${scope}' is outside requestedScopes` };
    }
    if (phase !== undefined && typeof phase !== 'string') {
      return { protocolMessage: 'errors phase must be a string when present' };
    }

    errors.push({
      errorClass,
      reason,
      disposition,
      ...(typeof scope === 'string' ? { scope } : {}),
      ...(typeof phase === 'string' ? { phase } : {}),
    });
  }

  return { errors };
}

function isCanonicalScopeId(scope) {
  return (
    typeof scope === 'string' &&
    scope.length > 0 &&
    scope.includes('.') &&
    !scope.startsWith('.') &&
    !scope.endsWith('.')
  );
}

function classifyConnectorResult(result, options) {
  if (!isPlainRecord(result)) {
    return protocolFailure('connector result must be an object');
  }

  if (
    typeof result.success === 'boolean' &&
    (Object.prototype.hasOwnProperty.call(result, 'data') ||
      Object.prototype.hasOwnProperty.call(result, 'error'))
  ) {
    return protocolFailure('legacy { success, data } wrapper is not supported');
  }

  const requestedScopesValue = result.requestedScopes;
  if (!Array.isArray(requestedScopesValue) || requestedScopesValue.length === 0) {
    return protocolFailure('requestedScopes must be a non-empty array');
  }

  if (requestedScopesValue.some((scope) => !isCanonicalScopeId(scope))) {
    return protocolFailure('requestedScopes must contain canonical scope ids');
  }

  const requestedScopes = requestedScopesValue.slice();
  const requestedScopeSet = new Set(requestedScopes);
  if (requestedScopeSet.size !== requestedScopes.length) {
    return protocolFailure('requestedScopes must be deduplicated');
  }

  if (
    options &&
    Array.isArray(options.expectedRequestedScopes) &&
    !hasSameMembers(requestedScopes, options.expectedRequestedScopes)
  ) {
    return protocolFailure('requestedScopes does not match the resolved execution scope set');
  }

  if (typeof result.timestamp !== 'string' || result.timestamp.length === 0) {
    return protocolFailure('timestamp is required');
  }
  if (typeof result.version !== 'string' || result.version.length === 0) {
    return protocolFailure('version is required');
  }
  if (typeof result.platform !== 'string' || result.platform.length === 0) {
    return protocolFailure('platform is required');
  }

  if (!isPlainRecord(result.exportSummary)) {
    return protocolFailure('exportSummary is required');
  }

  const exportSummary = result.exportSummary;
  if (
    typeof exportSummary.count !== 'number' ||
    !Number.isFinite(exportSummary.count) ||
    exportSummary.count < 0
  ) {
    return protocolFailure('exportSummary.count must be a non-negative number');
  }
  if (typeof exportSummary.label !== 'string' || exportSummary.label.length === 0) {
    return protocolFailure('exportSummary.label must be a string');
  }
  if (
    exportSummary.details !== undefined &&
    !isPlainRecord(exportSummary.details)
  ) {
    return protocolFailure('exportSummary.details must be an object when present');
  }

  const { errors, protocolMessage } = validateConnectorErrors(result.errors, requestedScopeSet);
  if (!errors) {
    return protocolFailure(protocolMessage || 'errors is malformed');
  }

  const producedScopes = Object.keys(result).filter(
    (key) => !CONNECTOR_RESULT_RESERVED_KEYS.has(key),
  );
  for (const producedScope of producedScopes) {
    if (!isCanonicalScopeId(producedScope)) {
      return protocolFailure(`produced scope key '${producedScope}' is not canonical`);
    }
    if (!requestedScopeSet.has(producedScope)) {
      return protocolFailure(`produced scope key '${producedScope}' is outside requestedScopes`);
    }
  }

  const producedScopeSet = new Set(producedScopes);
  const degradedScopes = new Set(
    errors
      .filter((error) => error.disposition === 'degraded' && error.scope)
      .map((error) => error.scope),
  );
  const omittedScopes = new Set(
    errors
      .filter((error) => error.disposition === 'omitted' && error.scope)
      .map((error) => error.scope),
  );
  const fatalErrors = errors.filter((error) => error.disposition === 'fatal');

  for (const scope of degradedScopes) {
    if (!producedScopeSet.has(scope)) {
      return protocolFailure(`degraded scope '${scope}' must also be present in the result`);
    }
    if (omittedScopes.has(scope)) {
      return protocolFailure(`scope '${scope}' cannot be both degraded and omitted`);
    }
  }

  for (const scope of omittedScopes) {
    if (producedScopeSet.has(scope)) {
      return protocolFailure(`omitted scope '${scope}' must not be present in the result`);
    }
  }

  const scopeSummary = {
    requested: requestedScopeSet.size,
    produced: producedScopeSet.size,
    degraded: degradedScopes.size,
    omitted: omittedScopes.size,
  };

  if (fatalErrors.length > 0) {
    return {
      outcome: 'failure',
      errorClass: dominantErrorClass(fatalErrors),
      recordCount: exportSummary.count,
      scopeSummary,
      debug: fatalErrors[0] ? fatalErrors[0].reason : undefined,
    };
  }

  for (const scope of requestedScopeSet) {
    if (!producedScopeSet.has(scope) && !omittedScopes.has(scope)) {
      return protocolFailure(
        `requested scope '${scope}' must be produced or marked omitted`,
        scopeSummary,
      );
    }
  }

  if (producedScopeSet.size === 0) {
    return {
      outcome: 'failure',
      errorClass: dominantErrorClass(errors),
      recordCount: exportSummary.count,
      scopeSummary,
      debug: errors[0] ? errors[0].reason : undefined,
    };
  }

  if (errors.length === 0) {
    return {
      outcome: 'success',
      recordCount: exportSummary.count,
      scopeSummary,
    };
  }

  return {
    outcome: 'partial',
    errorClass: dominantErrorClass(errors),
    recordCount: exportSummary.count,
    scopeSummary,
    debug: errors[0] ? errors[0].reason : undefined,
  };
}

module.exports = {
  classifyConnectorResult,
};

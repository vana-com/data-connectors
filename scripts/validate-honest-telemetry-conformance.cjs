#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const CORPUS_PATH = path.resolve(
  __dirname,
  '..',
  'connectors',
  '_conformance',
  'honest-telemetry',
  'corpus.json',
);

const RESERVED_KEYS = new Set([
  'requestedScopes',
  'timestamp',
  'version',
  'platform',
  'exportSummary',
  'errors',
]);

const ERROR_PRIORITY = [
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

function isCanonicalScopeId(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.includes('.') &&
    !value.startsWith('.') &&
    !value.endsWith('.')
  );
}

function dominantErrorClass(errors) {
  for (const errorClass of ERROR_PRIORITY) {
    if (errors.some((entry) => entry.errorClass === errorClass)) {
      return errorClass;
    }
  }
  return 'unknown';
}

function protocolViolation(message) {
  return {
    validity: 'protocol_violation',
    classification: {
      outcome: 'failure',
      errorClass: 'protocol_violation',
    },
    debug: message,
  };
}

function validateErrors(rawErrors, requestedScopeSet) {
  if (!Array.isArray(rawErrors)) {
    return { protocolMessage: 'errors must be an array' };
  }

  const errors = [];
  for (const entry of rawErrors) {
    if (!isPlainRecord(entry)) {
      return { protocolMessage: 'errors entries must be objects' };
    }

    const { errorClass, reason, disposition, scope, phase } = entry;
    if (typeof errorClass !== 'string' || !ERROR_PRIORITY.includes(errorClass)) {
      return { protocolMessage: 'errors entries must use a known errorClass' };
    }
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      return { protocolMessage: 'errors entries must include a non-empty reason' };
    }
    if (!['omitted', 'degraded', 'fatal'].includes(disposition)) {
      return { protocolMessage: 'errors entries must use omitted, degraded, or fatal disposition' };
    }
    if ((disposition === 'omitted' || disposition === 'degraded') && typeof scope !== 'string') {
      return { protocolMessage: `${disposition} errors must include a scope` };
    }
    if (typeof scope === 'string' && !requestedScopeSet.has(scope)) {
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

function classifyConnectorResult(result) {
  if (!isPlainRecord(result)) {
    return protocolViolation('result must be an object');
  }

  if (!Array.isArray(result.requestedScopes) || result.requestedScopes.length === 0) {
    return protocolViolation('requestedScopes must be a non-empty array');
  }
  if (result.requestedScopes.some((scope) => !isCanonicalScopeId(scope))) {
    return protocolViolation('requestedScopes must contain canonical scope ids');
  }

  const requestedScopeSet = new Set(result.requestedScopes);
  if (requestedScopeSet.size !== result.requestedScopes.length) {
    return protocolViolation('requestedScopes must be deduplicated');
  }

  if (typeof result.timestamp !== 'string' || result.timestamp.length === 0) {
    return protocolViolation('timestamp is required');
  }
  if (typeof result.version !== 'string' || result.version.length === 0) {
    return protocolViolation('version is required');
  }
  if (typeof result.platform !== 'string' || result.platform.length === 0) {
    return protocolViolation('platform is required');
  }
  if (!isPlainRecord(result.exportSummary)) {
    return protocolViolation('exportSummary is required');
  }
  if (
    typeof result.exportSummary.count !== 'number' ||
    !Number.isFinite(result.exportSummary.count) ||
    result.exportSummary.count < 0
  ) {
    return protocolViolation('exportSummary.count must be a non-negative number');
  }
  if (
    typeof result.exportSummary.label !== 'string' ||
    result.exportSummary.label.length === 0
  ) {
    return protocolViolation('exportSummary.label must be a non-empty string');
  }
  if (
    result.exportSummary.details !== undefined &&
    !isPlainRecord(result.exportSummary.details)
  ) {
    return protocolViolation('exportSummary.details must be an object when present');
  }

  const { errors, protocolMessage } = validateErrors(result.errors, requestedScopeSet);
  if (!errors) {
    return protocolViolation(protocolMessage || 'errors is malformed');
  }

  const producedScopes = Object.keys(result).filter((key) => !RESERVED_KEYS.has(key));
  for (const producedScope of producedScopes) {
    if (!isCanonicalScopeId(producedScope)) {
      return protocolViolation(`produced key '${producedScope}' is not a canonical scope id`);
    }
    if (!requestedScopeSet.has(producedScope)) {
      return protocolViolation(`produced scope '${producedScope}' is outside requestedScopes`);
    }
  }

  const producedScopeSet = new Set(producedScopes);
  const degradedScopes = new Set(
    errors
      .filter((entry) => entry.disposition === 'degraded' && entry.scope)
      .map((entry) => entry.scope),
  );
  const omittedScopes = new Set(
    errors
      .filter((entry) => entry.disposition === 'omitted' && entry.scope)
      .map((entry) => entry.scope),
  );
  const fatalErrors = errors.filter((entry) => entry.disposition === 'fatal');

  for (const scope of degradedScopes) {
    if (!producedScopeSet.has(scope)) {
      return protocolViolation(`degraded scope '${scope}' must also be present in the result`);
    }
    if (omittedScopes.has(scope)) {
      return protocolViolation(`scope '${scope}' cannot be both degraded and omitted`);
    }
  }

  for (const scope of omittedScopes) {
    if (producedScopeSet.has(scope)) {
      return protocolViolation(`omitted scope '${scope}' must not be present in the result`);
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
      validity: 'valid',
      classification: {
        outcome: 'failure',
        errorClass: dominantErrorClass(fatalErrors),
        scopeSummary,
      },
    };
  }

  for (const scope of requestedScopeSet) {
    if (!producedScopeSet.has(scope) && !omittedScopes.has(scope)) {
      return protocolViolation(
        `requested scope '${scope}' must be produced or marked omitted`,
      );
    }
  }

  if (producedScopeSet.size === 0) {
    return {
      validity: 'valid',
      classification: {
        outcome: 'failure',
        errorClass: dominantErrorClass(errors),
        scopeSummary,
      },
    };
  }

  if (errors.length === 0) {
    return {
      validity: 'valid',
      classification: {
        outcome: 'success',
        scopeSummary,
      },
    };
  }

  return {
    validity: 'valid',
    classification: {
      outcome: 'partial',
      errorClass: dominantErrorClass(errors),
      scopeSummary,
    },
  };
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function compareSubset(actual, expected, currentPath = 'expected') {
  const mismatches = [];

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      mismatches.push(`${currentPath}: expected array, got ${typeof actual}`);
      return mismatches;
    }
    if (actual.length !== expected.length) {
      mismatches.push(`${currentPath}: expected length ${expected.length}, got ${actual.length}`);
      return mismatches;
    }
    for (let i = 0; i < expected.length; i++) {
      mismatches.push(...compareSubset(actual[i], expected[i], `${currentPath}[${i}]`));
    }
    return mismatches;
  }

  if (isPlainRecord(expected)) {
    if (!isPlainRecord(actual)) {
      mismatches.push(`${currentPath}: expected object, got ${typeof actual}`);
      return mismatches;
    }
    for (const [key, value] of Object.entries(expected)) {
      mismatches.push(...compareSubset(actual[key], value, `${currentPath}.${key}`));
    }
    return mismatches;
  }

  if (actual !== expected) {
    mismatches.push(
      `${currentPath}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
  return mismatches;
}

function validateCorpus(corpusPath = CORPUS_PATH) {
  const corpus = loadJson(corpusPath);
  const corpusDir = path.dirname(corpusPath);
  const results = [];
  let failures = 0;

  for (const testCase of corpus.cases || []) {
    const fixturePath = path.resolve(corpusDir, testCase.fixture);
    const fixture = loadJson(fixturePath);
    const actual = classifyConnectorResult(fixture);
    const mismatches = compareSubset(actual, testCase.expected);
    const ok = mismatches.length === 0;

    if (!ok) failures++;
    results.push({
      id: testCase.id,
      ok,
      mismatches,
      fixture: path.relative(process.cwd(), fixturePath),
    });
  }

  return {
    ok: failures === 0,
    total: results.length,
    failures,
    results,
  };
}

function main() {
  const summary = validateCorpus();

  for (const result of summary.results) {
    if (result.ok) {
      console.log(`ok   ${result.id}  ${result.fixture}`);
      continue;
    }

    console.error(`fail ${result.id}  ${result.fixture}`);
    for (const mismatch of result.mismatches) {
      console.error(`  - ${mismatch}`);
    }
  }

  console.log(
    `\nValidated ${summary.total} honest telemetry conformance fixtures: ${summary.total - summary.failures} passed, ${summary.failures} failed.`,
  );

  process.exit(summary.ok ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  classifyConnectorResult,
  validateCorpus,
};

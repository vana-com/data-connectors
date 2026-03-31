#!/usr/bin/env node
/**
 * test-connectors.cjs — Batch smoke test for data connectors.
 *
 * Wraps run-connector.cjs to run each connector headlessly, validates output
 * against declared scopes, and reports per-connector health.
 *
 * Usage:
 *   node scripts/test-connectors.cjs [options]
 *
 * Options:
 *   --connectors <id>,<id>  Override default connector set (comma-separated IDs)
 *   --include-beta          Include beta connectors (default: stable only)
 *   --validate-schemas      Validate result data against schemas/*.json
 *
 * Exit codes: 0 all pass/warn, 1 any fail/auth/timeout
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REGISTRY_PATH = path.join(ROOT, 'registry.json');
const CONNECTORS_DIR = path.join(ROOT, 'connectors');
const RESULTS_DIR = path.join(ROOT, 'test-results');
const RUN_CONNECTOR = path.join(ROOT, 'run-connector.cjs');

// ─── ANSI Colors ────────────────────────────────────────────

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m',
};

// ─── Arg Parsing ────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { connectors: null, includeBeta: false, validateSchemas: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--connectors' && argv[i + 1]) {
      opts.connectors = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    } else if (argv[i] === '--include-beta') {
      opts.includeBeta = true;
    } else if (argv[i] === '--validate-schemas') {
      opts.validateSchemas = true;
    }
  }
  return opts;
}

// ─── Connector Resolution ───────────────────────────────────

function resolveConnectors(registry, opts) {
  if (opts.connectors) {
    return opts.connectors.map(id => {
      const entry = registry.connectors.find(c => c.id === id);
      if (!entry) throw new Error(`Connector not found in registry: ${id}`);
      return entry;
    });
  }
  const allowed = opts.includeBeta ? ['stable', 'beta'] : ['stable'];
  return registry.connectors.filter(c => allowed.includes(c.status));
}

// ─── Outcome Classification ─────────────────────────────────

function classifyOutcome(exitCode, stdoutLines) {
  if (exitCode === 2) return { status: 'auth', error: 'need-input: connector requires credentials' };
  if (exitCode === 3) return { status: 'auth', error: 'legacy-auth: connector uses headed login not supported in batch mode' };
  if (exitCode === 1) {
    const isTimeout = stdoutLines.some(line => {
      try {
        const msg = JSON.parse(line);
        return msg.type === 'error' && msg.message && msg.message.includes('Timeout after 5 minutes');
      } catch { return false; }
    });
    return isTimeout
      ? { status: 'timeout', error: 'Timed out after 5 minutes' }
      : { status: 'fail', error: 'Connector exited with error' };
  }
  if (exitCode === 0) return { status: 'needs-validation' };
  return { status: 'fail', error: `Unknown exit code: ${exitCode}` };
}

// ─── Result Validation ──────────────────────────────────────

function validateResult(data, metadata) {
  const expectedScopes = (metadata.scopes || []).map(s => s.scope);
  const scopesFound = [];
  const scopesMissing = [];
  const warnings = [];

  for (const scope of expectedScopes) {
    const bareSuffix = scope.includes('.') ? scope.split('.').slice(1).join('.') : null;
    const value = scope in data ? data[scope] : (bareSuffix && bareSuffix in data ? data[bareSuffix] : undefined);

    if (value === undefined || value === null) {
      scopesMissing.push(scope);
      continue;
    }

    scopesFound.push(scope);

    if (Array.isArray(value) && value.length === 0) {
      warnings.push(`${scope}: empty array`);
    } else if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) {
      warnings.push(`${scope}: empty object`);
    }
  }

  if (scopesMissing.length > 0) {
    return { status: 'fail', scopesFound, scopesMissing, warnings };
  }
  if (warnings.length > 0) {
    return { status: 'warn', scopesFound, scopesMissing, warnings };
  }
  return { status: 'pass', scopesFound, scopesMissing, warnings };
}

// ─── Exports for testing ────────────────────────────────────

if (require.main !== module) {
  module.exports = { parseArgs, resolveConnectors, classifyOutcome, validateResult };
}

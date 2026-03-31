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

// ─── Exports for testing ────────────────────────────────────

if (require.main !== module) {
  module.exports = { parseArgs, resolveConnectors };
}

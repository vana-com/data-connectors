#!/usr/bin/env node
/**
 * register.cjs — Add a connector to registry.json with checksums.
 *
 * Usage: node register.cjs <connector-js-path> [registry-path]
 *
 * Reads the connector script and metadata JSON (same name, .json),
 * computes SHA-256 checksums, and adds/updates the entry in registry.json.
 *
 * Defaults: registry-path = ./registry.json (repo root)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const connectorPath = process.argv[2];
const registryPath = process.argv[3] || './registry.json';

if (!connectorPath) {
  console.error('Usage: node register.cjs <connector-js-path> [registry-path]');
  process.exit(1);
}

const scriptPath = path.resolve(connectorPath);
const metadataPath = scriptPath.replace(/\.js$/, '.json');

if (!fs.existsSync(scriptPath)) {
  console.error(`Script not found: ${scriptPath}`);
  process.exit(1);
}
if (!fs.existsSync(metadataPath)) {
  console.error(`Metadata not found: ${metadataPath}`);
  process.exit(1);
}

const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
const scriptHash = crypto.createHash('sha256').update(fs.readFileSync(scriptPath)).digest('hex');
const metadataHash = crypto.createHash('sha256').update(fs.readFileSync(metadataPath)).digest('hex');

// Compute paths relative to registry location
const registryDir = path.dirname(path.resolve(registryPath));
const relScript = path.relative(registryDir, scriptPath);
const relMetadata = path.relative(registryDir, metadataPath);

const entry = {
  id: metadata.id || path.basename(scriptPath, '.js'),
  company: metadata.company || path.basename(path.dirname(scriptPath)),
  version: metadata.version || '1.0.0',
  name: metadata.name || '',
  description: metadata.description || '',
  files: {
    script: relScript,
    metadata: relMetadata,
  },
  checksums: {
    script: `sha256:${scriptHash}`,
    metadata: `sha256:${metadataHash}`,
  },
};

// Load or create registry
let registry;
if (fs.existsSync(registryPath)) {
  registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
} else {
  registry = { version: '2.0.0', lastUpdated: '', baseUrl: '', connectors: [] };
}

// Update or add entry
const idx = registry.connectors.findIndex(c => c.id === entry.id);
if (idx >= 0) {
  registry.connectors[idx] = entry;
  console.log(`Updated: ${entry.id}`);
} else {
  registry.connectors.push(entry);
  console.log(`Added: ${entry.id}`);
}

registry.lastUpdated = new Date().toISOString().split('T')[0] + 'T00:00:00Z';

fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
console.log(`Registry: ${registryPath}`);
console.log(`  script:   sha256:${scriptHash}`);
console.log(`  metadata: sha256:${metadataHash}`);

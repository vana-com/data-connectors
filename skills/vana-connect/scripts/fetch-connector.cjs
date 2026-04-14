#!/usr/bin/env node
/**
 * fetch-connector.cjs — Download a connector from the registry.
 *
 * Usage: node scripts/fetch-connector.cjs <platform>
 *
 * Searches the registry for the platform, downloads the connector script,
 * metadata, and connector-local schemas to ~/.dataconnect/connectors/.
 * Prints the local path on success.
 *
 * Exit codes: 0 = found and downloaded, 1 = not found or error.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const platform = process.argv[2];
if (!platform) {
  console.error('Usage: node scripts/fetch-connector.cjs <platform>');
  process.exit(1);
}

const REGISTRY_URL = 'https://raw.githubusercontent.com/vana-com/data-connectors/main/registry.json';
const BASE_URL = 'https://raw.githubusercontent.com/vana-com/data-connectors/main';
const CONNECTORS_DIR = path.join(os.homedir(), '.dataconnect', 'connectors');

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'dataconnect' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        res.resume();
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString()));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function main() {
  // Fetch registry
  let registry;
  try {
    registry = JSON.parse(await fetch(REGISTRY_URL));
  } catch (e) {
    console.error('Failed to fetch registry:', e.message);
    process.exit(1);
  }

  // Search for platform (case-insensitive, partial match)
  const search = platform.toLowerCase();
  const match = (registry.connectors || []).find((c) => {
    const name = (c.name || '').toLowerCase();
    const id = (c.id || '').toLowerCase();
    return name === search || id === search || name.includes(search) || id.includes(search);
  });

  if (!match) {
    console.log(JSON.stringify({ found: false, platform }));
    process.exit(1);
  }

  // Download connector files
  const scriptPath = match.files?.script
    ? `connectors/${match.files.script}`
    : match.scriptPath || match.script_path;
  const metadataPath = match.files?.metadata
    ? `connectors/${match.files.metadata}`
    : scriptPath.replace(/\.js$/, '.json');
  const metadataDir = path.dirname(metadataPath);
  const company = metadataDir.replace(/^connectors\//, '');

  const localDir = path.join(CONNECTORS_DIR, company);
  fs.mkdirSync(localDir, { recursive: true });

  const files = [scriptPath, metadataPath];
  const downloaded = [];

  for (const filePath of files) {
    try {
      const content = await fetch(`${BASE_URL}/${filePath}`);
      const localPath = path.join(CONNECTORS_DIR, filePath);
      fs.writeFileSync(localPath, content);
      downloaded.push(localPath);
    } catch (e) {
      // Metadata might not exist, that's OK
      if (filePath === metadataPath) continue;
      console.error(`Failed to download ${filePath}:`, e.message);
      process.exit(1);
    }
  }

  // Download schemas if referenced in metadata
  try {
    const metaLocal = path.join(CONNECTORS_DIR, metadataPath);
    if (fs.existsSync(metaLocal)) {
      const meta = JSON.parse(fs.readFileSync(metaLocal, 'utf-8'));
      if (meta.scopes && Array.isArray(meta.scopes)) {
        const schemasDir = path.join(localDir, 'schemas');
        fs.mkdirSync(schemasDir, { recursive: true });
        for (const scope of meta.scopes) {
          const scopeName = scope.scope || scope.name;
          if (!scopeName) continue;
          try {
            const schemaContent = await fetch(`${BASE_URL}/${metadataDir}/schemas/${scopeName}.json`);
            fs.writeFileSync(path.join(schemasDir, `${scopeName}.json`), schemaContent);
            downloaded.push(path.join(schemasDir, `${scopeName}.json`));
          } catch {} // Schema might not exist yet
        }
      }
    }
  } catch {} // Non-critical

  const connectorPath = path.join(CONNECTORS_DIR, scriptPath);
  console.log(JSON.stringify({
    found: true,
    platform: match.name || platform,
    connectorPath,
    files: downloaded,
  }));
}

main();

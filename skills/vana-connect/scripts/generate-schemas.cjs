#!/usr/bin/env node
/**
 * generate-schemas.cjs — Draft JSON schemas from connector output.
 *
 * Usage: node generate-schemas.cjs <result-json> <platform> [output-dir]
 *
 * Reads a connector result file, infers schemas from each scoped key,
 * writes draft schema files. The agent should review and adjust.
 *
 * Defaults: output-dir = ./schemas
 */

const fs = require('fs');
const path = require('path');

const resultPath = process.argv[2];
const platform = process.argv[3];
const outputDir = process.argv[4] || './schemas';

if (!resultPath || !platform) {
  console.error('Usage: node generate-schemas.cjs <result-json> <platform> [output-dir]');
  process.exit(1);
}

const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
const metadataKeys = new Set(['exportSummary', 'timestamp', 'version', 'platform']);

function inferType(value) {
  if (value === null || value === undefined) return { type: 'string' };
  if (Array.isArray(value)) {
    if (value.length === 0) return { type: 'array', items: {} };
    return { type: 'array', items: inferType(value[0]) };
  }
  if (typeof value === 'object') {
    const props = {};
    const required = [];
    for (const [k, v] of Object.entries(value)) {
      props[k] = inferType(v);
      required.push(k);
    }
    return { type: 'object', properties: props, required };
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { type: 'integer' } : { type: 'number' };
  }
  if (typeof value === 'boolean') return { type: 'boolean' };
  return { type: 'string' };
}

fs.mkdirSync(outputDir, { recursive: true });

let count = 0;
for (const [key, value] of Object.entries(result)) {
  if (metadataKeys.has(key)) continue;
  if (!key.includes('.')) continue;

  const scope = key;
  const schema = {
    name: `${platform} ${scope.split('.')[1]}`,
    version: '1.0.0',
    scope,
    dialect: 'json',
    description: `Draft schema for ${scope} — review and adjust.`,
    schema: inferType(value),
  };

  const outPath = path.join(outputDir, `${scope}.json`);
  fs.writeFileSync(outPath, JSON.stringify(schema, null, 2) + '\n');
  console.log(`  ${outPath}`);
  count++;
}

if (count === 0) {
  console.error('No scoped keys found in result. Expected keys like "platform.scope".');
  process.exit(1);
}

console.log(`\n${count} draft schema(s) generated. Review before publishing.`);

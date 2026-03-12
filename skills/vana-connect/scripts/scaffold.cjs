#!/usr/bin/env node
/**
 * scaffold.cjs — Hydrate templates to create connector boilerplate.
 *
 * Usage: node scaffold.cjs <platform> [company] [output-dir]
 *
 * Defaults: company = platform, output-dir = ~/.dataconnect/connectors
 */

const fs = require('fs');
const path = require('path');

const platform = process.argv[2];
const company = process.argv[3] || platform;
const outputDir = process.argv[4] || path.join(require('os').homedir(), '.dataconnect', 'connectors');

if (!platform) {
  console.error('Usage: node scaffold.cjs <platform> [company] [output-dir]');
  process.exit(1);
}

const templateDir = path.join(__dirname, '..', 'templates');
const dir = path.join(outputDir, company);

if (fs.existsSync(path.join(dir, `${platform}-playwright.js`))) {
  console.error(`${dir}/${platform}-playwright.js already exists.`);
  process.exit(1);
}

fs.mkdirSync(dir, { recursive: true });

const replacements = {
  '{{platform}}': platform,
  '{{PLATFORM_UPPER}}': platform.toUpperCase(),
  '{{PLATFORM_NAME}}': platform.charAt(0).toUpperCase() + platform.slice(1),
  '{{PLATFORM_URL}}': `https://${platform}.com`,
  '{{LOGIN_URL}}': `https://${platform}.com/login`,
  '{{LOGIN_FORM_SELECTOR}}': 'input[type="password"]',
  '{{LOGGED_IN_SELECTOR}}': 'TODO_LOGGED_IN_SELECTOR',
  '{{Company}}': company.charAt(0).toUpperCase() + company.slice(1),
  '{{scope1}}': 'profile',
  '{{scope1 description}}': 'User profile data',
  '{{scope2}}': 'data',
  '{{scope2 description}}': 'Platform data',
  '{{API fetch / Network capture / DOM scraping}}': 'TODO',
  '{{data description}}': `${platform} data`,
  '{{CSS selector only visible when logged in}}': '',
  '{{field name to vectorize for semantic search}}': '',
  '{{What this scope contains}}': '',
  '{{scope1 label}}': 'Profile',
};

function hydrate(content) {
  for (const [key, val] of Object.entries(replacements)) {
    content = content.split(key).join(val);
  }
  return content;
}

const files = [
  { template: 'connector-script.js', output: `${platform}-playwright.js` },
  { template: 'connector-metadata.json', output: `${platform}-playwright.json` },
];

for (const { template, output } of files) {
  const src = fs.readFileSync(path.join(templateDir, template), 'utf8');
  const dest = path.join(dir, output);
  fs.writeFileSync(dest, hydrate(src));
  console.log(`  ${dest}`);
}

console.log(`\nFill in: connectSelector, scopes, login selectors, data fetching logic.`);

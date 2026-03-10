#!/usr/bin/env node

/**
 * Standalone Connector Test Runner
 *
 * Runs a connector JS file directly using the playwright-runner without the Tauri app.
 * Spawns the playwright-runner's `index.cjs` as a child process.
 *
 * Requires PLAYWRIGHT_RUNNER_DIR env var pointing to the playwright-runner directory,
 * or auto-detects from common locations (../data-dt-app/playwright-runner).
 *
 * Usage:
 *   node test-connector.cjs ./linkedin/linkedin-playwright.js [options]
 *
 * Options:
 *   --headless   Run without visible browser (default: headed)
 *   --url URL    Override the initial URL (default: from metadata JSON)
 *   --output FILE  Where to save result JSON (default: ./connector-result.json)
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');

// ─── ANSI Colors ────────────────────────────────────────────
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function print(color, prefix, msg) {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.log(`${c.gray}${ts}${c.reset} ${color}${prefix}${c.reset} ${msg}`);
}

// ─── Resolve Playwright Runner ──────────────────────────────
function resolveRunnerDir() {
  // 1. Explicit env var
  if (process.env.PLAYWRIGHT_RUNNER_DIR) {
    const dir = process.env.PLAYWRIGHT_RUNNER_DIR;
    if (fs.existsSync(path.join(dir, 'index.cjs'))) return dir;
    console.error(`${c.red}PLAYWRIGHT_RUNNER_DIR set but index.cjs not found in: ${dir}${c.reset}`);
    process.exit(1);
  }

  // 2. Common locations relative to this script
  const candidates = [
    // Sibling repo (same parent directory)
    path.resolve(__dirname, '..', 'data-dt-app', 'playwright-runner'),
    // Home directory common paths
    path.join(os.homedir(), 'Documents', 'GitHub', 'data-dt-app', 'playwright-runner'),
    path.join(os.homedir(), 'Documents', 'Github', 'data-dt-app', 'playwright-runner'),
    path.join(os.homedir(), 'code', 'data-dt-app', 'playwright-runner'),
    path.join(os.homedir(), 'src', 'data-dt-app', 'playwright-runner'),
  ];

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.cjs'))) return dir;
  }

  console.error(`${c.red}Could not find playwright-runner. Set PLAYWRIGHT_RUNNER_DIR env var.${c.reset}`);
  console.error(`${c.dim}Looked in:${c.reset}`);
  for (const dir of candidates) {
    console.error(`  ${c.dim}${dir}${c.reset}`);
  }
  process.exit(1);
}

// ─── CLI Argument Parsing ───────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    connectorPath: null,
    headless: false,
    url: null,
    output: './connector-result.json',
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--headless') {
      parsed.headless = true;
    } else if (args[i] === '--url' && args[i + 1]) {
      parsed.url = args[++i];
    } else if (args[i] === '--output' && args[i + 1]) {
      parsed.output = args[++i];
    } else if (args[i] === '--help' || args[i] === '-h') {
      printUsage();
      process.exit(0);
    } else if (!args[i].startsWith('--')) {
      parsed.connectorPath = args[i];
    }
  }

  if (!parsed.connectorPath) {
    printUsage();
    process.exit(1);
  }

  return parsed;
}

function printUsage() {
  console.log(`
${c.bold}Connector Test Runner${c.reset}

${c.cyan}Usage:${c.reset}
  node test-connector.cjs <connector.js> [options]

${c.cyan}Options:${c.reset}
  --headless     Run without visible browser (default: headed)
  --url URL      Override the initial URL
  --output FILE  Result JSON path (default: ./connector-result.json)
  --help, -h     Show this help

${c.cyan}Environment:${c.reset}
  PLAYWRIGHT_RUNNER_DIR  Path to the playwright-runner directory (auto-detected if not set)

${c.cyan}Examples:${c.reset}
  node test-connector.cjs ./linkedin/linkedin-playwright.js --headed
  node test-connector.cjs ./linkedin/linkedin-playwright.js --url https://linkedin.com/feed
`);
}

// ─── Metadata Resolution ────────────────────────────────────
function loadMetadata(connectorPath) {
  const metadataPath = connectorPath.replace(/\.js$/, '.json');
  if (!fs.existsSync(metadataPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
  } catch (e) {
    return null;
  }
}

// ─── Message Formatting ─────────────────────────────────────
function formatStatus(status) {
  if (typeof status === 'string') {
    switch (status) {
      case 'COMPLETE': return `${c.bold}${c.green}COMPLETE${c.reset}`;
      case 'ERROR': return `${c.bold}${c.red}ERROR${c.reset}`;
      case 'STOPPED': return `${c.yellow}STOPPED${c.reset}`;
      default: return `${c.blue}${status}${c.reset}`;
    }
  }

  if (typeof status === 'object') {
    const type = status.type || '';
    const msg = status.message || '';
    const phase = status.phase;
    const count = status.count;

    let prefix = '';
    switch (type) {
      case 'STARTED': prefix = `${c.blue}STARTED${c.reset}`; break;
      case 'COLLECTING': prefix = `${c.yellow}COLLECTING${c.reset}`; break;
      case 'WAITING_FOR_USER': prefix = `${c.magenta}WAITING${c.reset}`; break;
      default: prefix = `${c.blue}${type}${c.reset}`;
    }

    let detail = msg;
    if (phase) {
      detail += ` ${c.dim}(${phase.step}/${phase.total} ${phase.label || ''})${c.reset}`;
    }
    if (count !== undefined) {
      detail += ` ${c.cyan}[${count} items]${c.reset}`;
    }

    return `${prefix} ${detail}`;
  }

  return JSON.stringify(status);
}

function handleMessage(msg, resultRef) {
  switch (msg.type) {
    case 'ready':
      // Handled by the caller to send run command
      break;

    case 'status':
      print(c.blue, '[status]', formatStatus(msg.status));
      break;

    case 'log':
      print(c.gray, '[log]   ', msg.message || '');
      break;

    case 'data': {
      const val = typeof msg.value === 'string' ? msg.value : JSON.stringify(msg.value);
      // Highlight [DEBUG] messages differently
      if (val.startsWith('[DEBUG]')) {
        print(c.yellow, '[debug] ', val.substring(8));
      } else if (msg.key === 'error') {
        print(c.red, '[error] ', val);
      } else {
        print(c.cyan, '[data]  ', `${msg.key} = ${val}`);
      }
      break;
    }

    case 'result':
      resultRef.data = msg.data;
      break;

    case 'error':
      print(c.red, '[ERROR] ', msg.message || JSON.stringify(msg));
      break;

    case 'network-captured':
      print(c.dim, '[net]   ', `Captured: ${msg.key} (${msg.url || ''})`);
      break;

    default:
      print(c.gray, '[???]   ', JSON.stringify(msg));
  }
}

// ─── Main ───────────────────────────────────────────────────
async function main() {
  const args = parseArgs();
  const connectorPath = path.resolve(args.connectorPath);

  if (!fs.existsSync(connectorPath)) {
    console.error(`${c.red}Error: Connector file not found: ${connectorPath}${c.reset}`);
    process.exit(1);
  }

  const runnerDir = resolveRunnerDir();
  const metadata = loadMetadata(connectorPath);
  const connectUrl = args.url || (metadata && metadata.connectURL) || 'about:blank';
  const connectorName = metadata?.name || path.basename(connectorPath, '.js');
  const connectorVersion = metadata?.version || 'unknown';

  console.log('');
  console.log(`${c.bold}Connector Test Runner${c.reset}`);
  console.log(`${'─'.repeat(50)}`);
  console.log(`  ${c.cyan}Connector:${c.reset} ${connectorPath}`);
  console.log(`  ${c.cyan}Name:${c.reset}      ${connectorName} v${connectorVersion}`);
  console.log(`  ${c.cyan}URL:${c.reset}       ${connectUrl}`);
  console.log(`  ${c.cyan}Mode:${c.reset}      ${args.headless ? 'headless' : 'headed (visible browser)'}`);
  console.log(`  ${c.cyan}Output:${c.reset}    ${args.output}`);
  console.log(`  ${c.cyan}Runner:${c.reset}    ${runnerDir}`);
  console.log(`${'─'.repeat(50)}`);
  console.log('');

  const startTime = Date.now();
  const resultRef = { data: null };

  // Spawn the playwright runner
  const child = spawn('node', ['index.cjs'], {
    cwd: runnerDir,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Handle stdout (JSON protocol)
  const stdoutRL = readline.createInterface({ input: child.stdout });
  stdoutRL.on('line', (line) => {
    try {
      const msg = JSON.parse(line);

      if (msg.type === 'ready') {
        // Send run command
        const runCmd = JSON.stringify({
          type: 'run',
          runId: `test-${Date.now()}`,
          connectorPath,
          url: connectUrl,
          headless: args.headless,
          forceHeaded: !args.headless,
        });
        child.stdin.write(runCmd + '\n');
        print(c.green, '[runner]', 'Connected, starting connector...');
        return;
      }

      handleMessage(msg, resultRef);
    } catch (e) {
      // Non-JSON output, print as-is
      if (line.trim()) {
        console.log(`${c.dim}${line}${c.reset}`);
      }
    }
  });

  // Handle stderr (PlaywrightRunner debug output)
  const stderrRL = readline.createInterface({ input: child.stderr });
  stderrRL.on('line', (line) => {
    if (line.trim()) {
      print(c.dim, '[runner]', line.replace('[PlaywrightRunner] ', ''));
    }
  });

  // Wait for process to exit
  const exitCode = await new Promise((resolve) => {
    child.on('exit', (code) => resolve(code || 0));
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('');
  console.log(`${'─'.repeat(50)}`);

  // Save result
  if (resultRef.data) {
    const outputPath = path.resolve(args.output);
    fs.writeFileSync(outputPath, JSON.stringify(resultRef.data, null, 2));
    const size = (fs.statSync(outputPath).size / 1024).toFixed(1);
    print(c.green, '[result]', `Saved to ${outputPath} (${size} KB)`);
  } else {
    print(c.red, '[result]', 'No result data returned');
  }

  if (exitCode === 0) {
    console.log(`${c.bold}${c.green}Done${c.reset} in ${elapsed}s`);
  } else {
    console.log(`${c.bold}${c.red}Failed${c.reset} (exit code ${exitCode}) in ${elapsed}s`);
  }
  console.log('');

  process.exit(exitCode);
}

main().catch((err) => {
  console.error(`${c.red}Fatal error: ${err.message}${c.reset}`);
  process.exit(1);
});

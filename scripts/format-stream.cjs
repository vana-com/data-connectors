#!/usr/bin/env node

/**
 * Formats stream-json output from `claude -p --output-format stream-json` into
 * human-readable logs. Shows the agent's thinking, tool calls, and results in real-time.
 *
 * Usage: claude -p "..." --output-format stream-json | node scripts/format-stream.cjs
 */

const readline = require('readline');

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

function ts() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

const rl = readline.createInterface({ input: process.stdin });

let currentToolName = '';
let textBuffer = '';

rl.on('line', (line) => {
  if (!line.trim()) return;

  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    // Non-JSON, print as-is
    process.stdout.write(line + '\n');
    return;
  }

  const type = msg.type;

  if (type === 'assistant') {
    // Agent text message
    const content = msg.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          // Flush text
          console.log(`${c.gray}${ts()}${c.reset} ${c.green}[agent]${c.reset} ${block.text}`);
        } else if (block.type === 'tool_use') {
          currentToolName = block.name || 'tool';
          const inputStr = block.input
            ? JSON.stringify(block.input).substring(0, 200)
            : '';
          console.log(`${c.gray}${ts()}${c.reset} ${c.cyan}[${currentToolName}]${c.reset} ${c.dim}${inputStr}${c.reset}`);
        }
      }
    }
  } else if (type === 'result') {
    // Final result
    const text = msg.result;
    if (text) {
      console.log('');
      console.log(`${c.bold}${c.green}═══ RESULT ═══${c.reset}`);
      console.log(text);
    }
    const cost = msg.cost_usd;
    const duration = msg.duration_ms;
    const apiCalls = msg.num_turns;
    if (cost !== undefined || duration !== undefined) {
      console.log('');
      console.log(`${c.dim}Cost: $${cost?.toFixed(4) || '?'} | Duration: ${duration ? (duration / 1000).toFixed(1) + 's' : '?'} | API turns: ${apiCalls || '?'}${c.reset}`);
    }
  } else if (type === 'tool_result') {
    // Tool result (usually long, show truncated)
    const content = msg.content;
    if (typeof content === 'string' && content.length > 0) {
      const preview = content.substring(0, 300).replace(/\n/g, ' ');
      console.log(`${c.gray}${ts()}${c.reset} ${c.dim}[result] ${preview}${content.length > 300 ? '...' : ''}${c.reset}`);
    }
  } else if (type === 'system') {
    // System messages
    const text = msg.message || msg.subtype || '';
    console.log(`${c.gray}${ts()}${c.reset} ${c.yellow}[system]${c.reset} ${text}`);
  }
});

rl.on('close', () => {
  process.exit(0);
});

#!/usr/bin/env node
/**
 * Claude official-export ingester.
 *
 * Anthropic's Privacy → "Export data" flow (POST
 * /api/organizations/:org/export_data → emailed download) produces a complete
 * ZIP that is a strict superset of what the live-API connector collects:
 * users.json, conversations.json (all threads), projects/*.json, design_chats/*.json.
 *
 * This module turns that export into the SAME honest-telemetry, scoped result
 * the `claude-playwright` connector emits, so the two are interchangeable
 * downstream (claude.conversations / claude.projects).
 *
 * WHY THIS IS A SEPARATE NODE TOOL, NOT A CONNECTOR MODE
 * The page-API connector runtime cannot retrieve the archive:
 *   - in-browser fetch of the download URL returns the SPA shell — the zip is
 *     gated on `Sec-Fetch-Dest: document`, which only a top-level navigation
 *     sets and `fetch()` cannot spoof;
 *   - the runner's `page.httpFetch` reads the body via `response.text()`, which
 *     corrupts binary, and there is no download-capture API.
 * Retrieval therefore belongs in the desktop runner layer (which can drive a
 * navigation, capture the download, and handle binary). This module is the
 * runtime-independent core that layer calls; `normalizeExport()` is a pure
 * function so it is unit-testable without any zip or browser.
 *
 * CLI:
 *   node claude-export-ingest.cjs <export.zip | dir> [more batches...] \
 *     [--scopes claude.conversations,claude.projects] [--org <uuid>] [--out result.json]
 *
 * Multiple batch zips (data-<org>-...-batch-0000.zip, -batch-0001.zip, …) may be
 * passed together; conversations and projects are merged and deduped by uuid.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ALL_SCOPES = ['claude.conversations', 'claude.projects'];

// ─── Normalization (mirrors the connector so payloads are interchangeable) ──
function flattenMessageText(message) {
  if (typeof message?.text === 'string' && message.text.length > 0) return message.text;
  const content = message?.content;
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part) return '';
        if (typeof part === 'string') return part;
        if (typeof part.text === 'string') return part.text;
        if (typeof part.content === 'string') return part.content;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content.text === 'string') return content.text;
  return '';
}

function normalizeMessage(m) {
  return {
    id: m?.uuid || null,
    sender: m?.sender || null,
    parentId: m?.parent_message_uuid || null,
    createdAt: m?.created_at || null,
    updatedAt: m?.updated_at || null,
    content: flattenMessageText(m),
    rawContent: m?.content ?? null,
    attachments: Array.isArray(m?.attachments) ? m.attachments : [],
  };
}

function normalizeConversation(conv) {
  const id = conv?.uuid || conv?.id || null;
  // Export messages carry no `index`; order by created_at, stable on ties.
  const raw = Array.isArray(conv?.chat_messages) ? conv.chat_messages.slice() : [];
  raw.sort((a, b) => {
    const ta = Date.parse(a?.created_at || '') || 0;
    const tb = Date.parse(b?.created_at || '') || 0;
    return ta - tb;
  });
  const messages = raw.map(normalizeMessage);
  return {
    id,
    title: conv?.name || conv?.summary || 'Untitled',
    href: id ? `/chat/${id}` : null,
    createdAt: conv?.created_at || null,
    updatedAt: conv?.updated_at || null,
    starred: typeof conv?.is_starred === 'boolean' ? conv.is_starred : null,
    projectId: conv?.project_uuid || null,
    messageCount: messages.length,
    messages,
    fetchError: null,
  };
}

function normalizeProject(proj) {
  const id = proj?.uuid || proj?.id || null;
  return {
    id,
    title: proj?.name || 'Untitled project',
    href: id ? `/project/${id}` : null,
    label: proj?.name ? `Project, ${proj.name}` : null,
    createdAt: proj?.created_at || null,
    updatedAt: proj?.updated_at || null,
    archived: Boolean(proj?.archived_at),
    detail: proj || null,
  };
}

/**
 * Pure: parsed export inputs → protocol-conformant scoped result.
 * @param {{conversations?:object[], projects?:object[], users?:object[],
 *          designChatCount?:number, organizationId?:string|null,
 *          requestedScopes?:string[]}} input
 */
function normalizeExport(input) {
  const requestedScopes =
    Array.isArray(input.requestedScopes) && input.requestedScopes.length > 0
      ? input.requestedScopes
      : ALL_SCOPES.slice();
  const wantsConversations = requestedScopes.includes('claude.conversations');
  const wantsProjects = requestedScopes.includes('claude.projects');

  const user = Array.isArray(input.users) ? input.users[0] : input.users;
  const profile = {
    name: (user && (user.full_name || user.name)) || null,
    plan: null, // the export does not carry a plan label
  };
  const organizationId = input.organizationId || null;

  const conversations = wantsConversations
    ? (input.conversations || []).map(normalizeConversation).filter((c) => c.id)
    : [];
  const projects = wantsProjects
    ? (input.projects || []).map(normalizeProject).filter((p) => p.id)
    : [];
  const totalMessages = conversations.reduce((sum, c) => sum + (c.messageCount || 0), 0);

  const result = {
    requestedScopes,
    timestamp: new Date().toISOString(),
    version: '2.0.0-export',
    platform: 'claude',
    exportSummary: {
      count: conversations.length + projects.length,
      label: 'items',
      details: {
        conversations: conversations.length,
        messages: totalMessages,
        projects: projects.length,
        designChats: input.designChatCount || 0,
        source: 'official-export',
      },
    },
    errors: [], // the official export is complete by construction
  };

  const scopePayloads = {
    'claude.conversations': {
      profile,
      organizationId,
      conversations,
      total: conversations.length,
      messageTotal: totalMessages,
      source: 'official-export',
    },
    'claude.projects': {
      profile,
      organizationId,
      projects,
      total: projects.length,
      source: 'official-export',
    },
  };
  for (const scope of Object.keys(scopePayloads)) {
    if (requestedScopes.includes(scope)) result[scope] = scopePayloads[scope];
  }
  return result;
}

// ─── ZIP reading (Node side — real binary, via the system `unzip`) ──────────
function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return null;
  }
}

function extractBatch(zipOrDir) {
  const stat = fs.statSync(zipOrDir);
  if (stat.isDirectory()) return zipOrDir;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-export-'));
  execFileSync('unzip', ['-o', '-q', zipOrDir, '-d', tmp]);
  return tmp;
}

function readBatch(dir) {
  const out = { conversations: [], projects: [], users: [], designChatCount: 0 };
  const convFile = path.join(dir, 'conversations.json');
  if (fs.existsSync(convFile)) {
    const c = readJsonSafe(convFile);
    if (Array.isArray(c)) out.conversations = c;
  }
  const usersFile = path.join(dir, 'users.json');
  if (fs.existsSync(usersFile)) {
    const u = readJsonSafe(usersFile);
    if (Array.isArray(u)) out.users = u;
  }
  const projDir = path.join(dir, 'projects');
  if (fs.existsSync(projDir)) {
    for (const f of fs.readdirSync(projDir)) {
      if (!f.endsWith('.json')) continue;
      const p = readJsonSafe(path.join(projDir, f));
      if (p) out.projects.push(p);
    }
  }
  const designDir = path.join(dir, 'design_chats');
  if (fs.existsSync(designDir)) {
    out.designChatCount = fs.readdirSync(designDir).filter((f) => f.endsWith('.json')).length;
  }
  return out;
}

function orgFromZipName(zipPath) {
  // data-<org-uuid>-<ts>-<hash>-batch-0000.zip
  const m = path.basename(zipPath).match(
    /data-([0-9a-f-]{36})-/i,
  );
  return m ? m[1] : null;
}

function ingestBatches(inputs, requestedScopes, orgOverride) {
  const convById = new Map();
  const projById = new Map();
  let users = [];
  let designChatCount = 0;
  let organizationId = orgOverride || null;

  for (const input of inputs) {
    if (!organizationId) organizationId = orgFromZipName(input);
    const dir = extractBatch(input);
    const batch = readBatch(dir);
    for (const c of batch.conversations) {
      const id = c?.uuid || c?.id;
      if (id && !convById.has(id)) convById.set(id, c);
    }
    for (const p of batch.projects) {
      const id = p?.uuid || p?.id;
      if (id && !projById.has(id)) projById.set(id, p);
    }
    if (batch.users.length && !users.length) users = batch.users;
    designChatCount += batch.designChatCount;
  }

  return normalizeExport({
    conversations: Array.from(convById.values()),
    projects: Array.from(projById.values()),
    users,
    designChatCount,
    organizationId,
    requestedScopes,
  });
}

// ─── CLI ────────────────────────────────────────────────────────────────────
function main(argv) {
  const args = argv.slice(2);
  const inputs = [];
  let scopes = null;
  let org = null;
  let out = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--scopes') scopes = args[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--org') org = args[++i];
    else if (a === '--out') out = args[++i];
    else inputs.push(a);
  }
  if (inputs.length === 0) {
    console.error('usage: claude-export-ingest.cjs <export.zip|dir> [more...] [--scopes a,b] [--org uuid] [--out file]');
    process.exit(2);
  }
  const result = ingestBatches(inputs, scopes, org);
  const json = JSON.stringify(result);
  if (out) {
    fs.writeFileSync(out, json);
    const d = result.exportSummary.details;
    console.log(
      `Wrote ${out}: ${d.conversations} conversations, ${d.messages} messages, ${d.projects} projects` +
        (d.designChats ? `, ${d.designChats} design chats` : ''),
    );
  } else {
    process.stdout.write(json);
  }
}

if (require.main === module) {
  main(process.argv);
}

module.exports = {
  normalizeExport,
  normalizeConversation,
  normalizeProject,
  flattenMessageText,
  ingestBatches,
};

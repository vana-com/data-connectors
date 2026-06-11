#!/usr/bin/env node
/**
 * Unit tests for the Claude official-export normalizer.
 *
 * Asserts the export → scoped-result mapping matches the connector's shape and
 * classifies as a conformant `success`, and that genuinely-empty message text
 * is preserved as empty (not fabricated, not dropped silently).
 */

const assert = require('assert');
const {
  normalizeExport,
  normalizeConversation,
  flattenMessageText,
} = require('../claude-export-ingest.cjs');
const {
  classifyConnectorResult,
} = require('../../../scripts/validate-honest-telemetry-conformance.cjs');

const cases = [];
function test(name, fn) {
  try {
    fn();
    cases.push({ name, ok: true });
  } catch (err) {
    cases.push({ name, ok: false, err: err.message });
  }
}

const exportConversation = {
  uuid: 'c1',
  name: 'Trip planning',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  chat_messages: [
    // intentionally out of order; normalizer sorts by created_at
    {
      uuid: 'm2',
      sender: 'assistant',
      parent_message_uuid: 'm1',
      created_at: '2026-01-01T00:01:00Z',
      content: [{ type: 'text', text: 'Lisbon is lovely in spring.' }],
    },
    {
      uuid: 'm1',
      sender: 'human',
      parent_message_uuid: null,
      created_at: '2026-01-01T00:00:00Z',
      content: [{ type: 'text', text: 'Where should I go?' }],
    },
    {
      uuid: 'm3',
      sender: 'human',
      parent_message_uuid: 'm2',
      created_at: '2026-01-01T00:02:00Z',
      content: [{ type: 'text', text: '' }], // genuinely empty turn
    },
  ],
};

const exportProject = {
  uuid: 'p1',
  name: 'Recipes',
  created_at: '2025-05-30T00:00:00Z',
  updated_at: '2025-06-01T00:00:00Z',
  archived_at: null,
  docs: [{ uuid: 'd1' }],
};

const users = [{ uuid: 'u1', full_name: 'Volod I', email_address: 'v@example.com' }];

test('flattenMessageText prefers text, falls back to content blocks', () => {
  assert.strictEqual(flattenMessageText({ text: 'hi', content: [{ text: 'x' }] }), 'hi');
  assert.strictEqual(flattenMessageText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.strictEqual(flattenMessageText({ content: [{ type: 'text', text: '' }] }), '');
});

test('conversation messages are ordered by created_at', () => {
  const c = normalizeConversation(exportConversation);
  assert.deepStrictEqual(c.messages.map((m) => m.id), ['m1', 'm2', 'm3']);
  assert.strictEqual(c.messageCount, 3);
  assert.strictEqual(c.messages[0].content, 'Where should I go?');
});

test('empty message text is preserved as empty, with rawContent retained', () => {
  const c = normalizeConversation(exportConversation);
  const empty = c.messages.find((m) => m.id === 'm3');
  assert.strictEqual(empty.content, '');
  assert.ok(Array.isArray(empty.rawContent), 'rawContent kept for fidelity');
});

test('normalizeExport produces a conformant success with both scopes', () => {
  const r = normalizeExport({
    conversations: [exportConversation],
    projects: [exportProject],
    users,
    designChatCount: 1,
    organizationId: 'org-uuid',
    requestedScopes: ['claude.conversations', 'claude.projects'],
  });
  const c = classifyConnectorResult(r);
  assert.strictEqual(c.validity, 'valid');
  assert.strictEqual(c.classification.outcome, 'success');
  assert.strictEqual(r['claude.conversations'].profile.name, 'Volod I');
  assert.strictEqual(r['claude.conversations'].messageTotal, 3);
  assert.strictEqual(r['claude.conversations'].source, 'official-export');
  assert.strictEqual(r['claude.projects'].total, 1);
  assert.strictEqual(r.exportSummary.details.designChats, 1);
});

test('requestedScopes filters produced scopes', () => {
  const r = normalizeExport({
    conversations: [exportConversation],
    projects: [exportProject],
    users,
    requestedScopes: ['claude.conversations'],
  });
  assert.ok(r['claude.conversations']);
  assert.ok(!r['claude.projects'], 'projects scope not produced when not requested');
  assert.strictEqual(classifyConnectorResult(r).classification.outcome, 'success');
});

const failed = cases.filter((c) => !c.ok);
for (const c of cases) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok ? '' : ' — ' + c.err}`);
console.log(`\n${cases.length - failed.length}/${cases.length} passed.`);
process.exit(failed.length === 0 ? 0 : 1);

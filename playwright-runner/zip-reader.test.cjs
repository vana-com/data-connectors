#!/usr/bin/env node
/**
 * Unit test for the runner's dependency-free ZIP reader (readZipJsonEntries),
 * which backs page.extractZipEntries(). Builds real ZIP archives in-memory
 * (stored + deflate entries) and asserts JSON entries are parsed and filtered.
 */

const assert = require('assert');
const zlib = require('zlib');
const { readZipJsonEntries } = require('./zip-reader.cjs');

// Build a minimal but spec-valid ZIP from { name: Buffer } entries.
// Uses deflate (method 8) when it helps, stored (method 0) otherwise.
function buildZip(entries) {
  const crcTable = (() => {
    const t = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(content);
    const useDeflate = deflated.length < content.length;
    const method = useDeflate ? 8 : 0;
    const data = useDeflate ? deflated : content;
    const crc = crc32(content);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push({ header: central, nameBuf });

    offset += local.length + nameBuf.length + data.length;
  }

  const cdStart = offset;
  const cdParts = [];
  for (const { header, nameBuf } of centrals) {
    cdParts.push(header, nameBuf);
  }
  const cd = Buffer.concat(cdParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(centrals.length, 8);
  eocd.writeUInt16LE(centrals.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdStart, 16);

  return Buffer.concat([...locals, cd, eocd]);
}

const cases = [];
function test(name, fn) {
  try { fn(); cases.push({ name, ok: true }); }
  catch (err) { cases.push({ name, ok: false, err: err.message }); }
}

test('parses stored + deflate JSON entries', () => {
  // A large, compressible payload forces the deflate path; a tiny one stays stored.
  const big = JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ id: i, text: 'hello world' })));
  const zip = buildZip({
    'conversations.json': Buffer.from(big),
    'users.json': Buffer.from('[{"full_name":"Volod I"}]'),
    'notes.txt': Buffer.from('ignore me'),
  });
  const { names, json } = readZipJsonEntries(zip, null);
  assert.ok(names.includes('conversations.json') && names.includes('notes.txt'));
  assert.strictEqual(json['conversations.json'].length, 500);
  assert.strictEqual(json['users.json'][0].full_name, 'Volod I');
  assert.ok(!('notes.txt' in json), 'non-json entries are not parsed');
});

test('include filter selects only matching entries', () => {
  const zip = buildZip({
    'conversations.json': Buffer.from('[1,2,3]'),
    'projects/p1.json': Buffer.from('{"uuid":"p1"}'),
    'users.json': Buffer.from('[{}]'),
  });
  const { json } = readZipJsonEntries(zip, ['projects/']);
  assert.deepStrictEqual(Object.keys(json), ['projects/p1.json']);
});

test('throws on a non-zip buffer', () => {
  assert.throws(() => readZipJsonEntries(Buffer.from('not a zip'), null));
});

const failed = cases.filter((c) => !c.ok);
for (const c of cases) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok ? '' : ' — ' + c.err}`);
console.log(`\n${cases.length - failed.length}/${cases.length} passed.`);
process.exit(failed.length === 0 ? 0 : 1);

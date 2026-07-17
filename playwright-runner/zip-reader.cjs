'use strict';

const zlib = require('zlib');

// Minimal, dependency-free ZIP reader (stored + deflate entries).
// Parses the central directory so it works on real archives without shelling
// out to an `unzip` binary (cross-platform). Returns { names, json } where
// `json` holds parsed JSON entries matching `include` (substring list, or all
// .json when null).
function readZipJsonEntries(buffer, include) {
  const EOCD_SIG = 0x06054b50;
  const CEN_SIG = 0x02014b50;
  // Locate End Of Central Directory (scan backwards; comment is usually empty).
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i >= buffer.length - 22 - 0x10000; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip (no EOCD)');
  const cdCount = buffer.readUInt16LE(eocd + 10);
  let off = buffer.readUInt32LE(eocd + 16);
  const names = [];
  const json = {};
  for (let n = 0; n < cdCount; n++) {
    if (buffer.readUInt32LE(off) !== CEN_SIG) break;
    const method = buffer.readUInt16LE(off + 10);
    const compSize = buffer.readUInt32LE(off + 20);
    const nameLen = buffer.readUInt16LE(off + 28);
    const extraLen = buffer.readUInt16LE(off + 30);
    const commentLen = buffer.readUInt16LE(off + 32);
    const localOff = buffer.readUInt32LE(off + 42);
    const name = buffer.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) { names.push(name); continue; } // directory entry
    names.push(name);
    const wanted = name.endsWith('.json') && (!include || include.some((s) => name.includes(s)));
    if (!wanted) continue;

    // Resolve the data offset from the local file header (its name/extra lengths
    // can differ from the central record).
    const lNameLen = buffer.readUInt16LE(localOff + 26);
    const lExtraLen = buffer.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buffer.subarray(dataStart, dataStart + compSize);
    let raw;
    if (method === 0) raw = comp; // stored
    else if (method === 8) raw = zlib.inflateRawSync(comp); // deflate
    else continue; // unsupported method — skip rather than crash the run
    try { json[name] = JSON.parse(raw.toString('utf8')); } catch (e) { /* skip unparseable */ }
  }
  return { names, json };
}

module.exports = { readZipJsonEntries };

import { test } from "node:test";
import assert from "node:assert/strict";
import "../../shared/audio-export.js";

const A = globalThis.SV_AUDIO_EXPORT;

// Independent CRC reference: bitwise (the lib uses a lookup table) — two
// implementations agreeing is the check.
function crcRef(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 24;
    for (let i = 0; i < 8; i++) crc = ((crc & 0x80000000) ? (crc << 1) ^ 0x04c11db7 : crc << 1) >>> 0;
  }
  return crc >>> 0;
}

test("WAV: header fields and sample round-trip", () => {
  const pcm = new Float32Array([0, 0.5, -0.5, 1]);
  const buf = A.wavFromPcm(pcm, 24000);
  const dv = new DataView(buf);
  const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  assert.equal(tag(0), "RIFF");
  assert.equal(tag(8), "WAVE");
  assert.equal(dv.getUint32(4, true), buf.byteLength - 8);
  assert.equal(dv.getUint16(22, true), 1);          // mono
  assert.equal(dv.getUint32(24, true), 24000);      // sample rate
  assert.equal(dv.getUint16(34, true), 16);         // bits/sample
  assert.equal(dv.getUint32(40, true), pcm.length * 2);
  assert.equal(dv.getInt16(44 + 2, true), 16383);   // 0.5 → 16383
  assert.equal(dv.getInt16(44 + 6, true), 32767);   // 1.0 clamps to max
});

test("Ogg: OpusHead BOS page, OpusTags, granulepos, EOS, valid CRCs", () => {
  const packets = [
    { data: new Uint8Array([0xfc, 1, 2, 3]), samples: 960 },
    { data: new Uint8Array(300).fill(7), samples: 960 },
  ];
  const parts = A.oggFromOpusPackets(packets, { preSkip: 312 });
  const bytes = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { bytes.set(p, o); o += p.length; }

  // Walk every page: capture pattern, CRC, flags, granulepos.
  const pages = [];
  for (let i = 0; i + 27 <= bytes.length;) {
    assert.equal(String.fromCharCode(...bytes.subarray(i, i + 4)), "OggS");
    const nseg = bytes[i + 26];
    let plen = 0;
    for (let s = 0; s < nseg; s++) plen += bytes[i + 27 + s];
    const end = i + 27 + nseg + plen;
    const page = bytes.slice(i, end);
    const embedded = new DataView(page.buffer, page.byteOffset).getUint32(22, true);
    page[22] = page[23] = page[24] = page[25] = 0;
    assert.equal(crcRef(page), embedded, "page CRC");
    pages.push({ type: bytes[i + 5], gp: Number(new DataView(bytes.buffer, i + 6).getBigUint64(0, true)), body: bytes.subarray(i + 27 + nseg, end) });
    i = end;
  }
  assert.equal(pages[0].type & 0x02, 0x02);                                  // BOS
  assert.equal(String.fromCharCode(...pages[0].body.subarray(0, 8)), "OpusHead");
  assert.equal(String.fromCharCode(...pages[1].body.subarray(0, 8)), "OpusTags");
  assert.equal(pages[pages.length - 1].type & 0x04, 0x04);                   // EOS
  assert.equal(pages[pages.length - 1].gp, 312 + 960 * 2);                   // preSkip + total samples
});

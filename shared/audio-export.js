// SubVibe — audio export writers (pure byte-level logic, node-testable):
//   • wavFromPcm: Float32 mono → 16-bit PCM RIFF/WAVE
//   • oggFromOpusPackets: WebCodecs opus packets → a valid Ogg Opus stream
// Hand-written on purpose: the release audit forbids third-party libraries.
(function (g) {
  function wavFromPcm(f32, sampleRate) {
    const n = f32.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const dv = new DataView(buf);
    const w4 = (o, s) => { for (let i = 0; i < 4; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    w4(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); w4(8, "WAVE");
    w4(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true);
    dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    w4(36, "data"); dv.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      dv.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buf;
  }

  // CRC-32, poly 0x04c11db7, init 0, no reflection, no final xor (the Ogg spec).
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let r = i << 24;
      for (let j = 0; j < 8; j++) r = ((r & 0x80000000) ? (r << 1) ^ 0x04c11db7 : r << 1) >>> 0;
      t[i] = r;
    }
    return t;
  })();
  function crc32ogg(bytes) {
    let crc = 0;
    for (let i = 0; i < bytes.length; i++) crc = ((crc << 8) >>> 0) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff];
    return crc >>> 0;
  }

  let pageSeq = 0, serial = 0;
  function page(payload, { bos = false, eos = false, granule = 0n } = {}) {
    const nseg = Math.floor(payload.length / 255) + 1;
    const head = new Uint8Array(27 + nseg);
    const dv = new DataView(head.buffer);
    head.set([0x4f, 0x67, 0x67, 0x53], 0);                 // "OggS"
    head[4] = 0;
    head[5] = (bos ? 0x02 : 0) | (eos ? 0x04 : 0);
    dv.setBigUint64(6, granule, true);
    dv.setUint32(14, serial, true);
    dv.setUint32(18, pageSeq++, true);
    head[26] = nseg;
    let rest = payload.length;
    for (let s = 0; s < nseg; s++) { head[27 + s] = Math.min(255, rest); rest -= Math.min(255, rest); }
    const whole = new Uint8Array(head.length + payload.length);
    whole.set(head, 0); whole.set(payload, head.length);
    const crc = crc32ogg(whole);
    new DataView(whole.buffer).setUint32(22, crc, true);
    return whole;
  }

  // packets: [{data: Uint8Array, samples}] at 48 kHz mono (WebCodecs opus).
  function oggFromOpusPackets(packets, { preSkip = 312 } = {}) {
    pageSeq = 0; serial = ((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0) || 1;
    const head = new Uint8Array(19);
    head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // "OpusHead"
    head[8] = 1;                                                   // version
    head[9] = 1;                                                   // channels
    new DataView(head.buffer).setUint16(10, preSkip, true);
    new DataView(head.buffer).setUint32(12, 48000, true);          // input rate
    // output gain 0 (bytes 16-17), mapping family 0 (byte 18) — already zeroed
    const vendor = "SubVibe";
    const tags = new Uint8Array(8 + 4 + vendor.length + 4);
    tags.set([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73], 0); // "OpusTags"
    new DataView(tags.buffer).setUint32(8, vendor.length, true);
    for (let i = 0; i < vendor.length; i++) tags[12 + i] = vendor.charCodeAt(i);
    // comment count 0 — already zeroed

    const parts = [page(head, { bos: true }), page(tags, { eos: packets.length === 0 })];
    let granule = BigInt(preSkip);
    packets.forEach((p, i) => {
      granule += BigInt(p.samples);
      parts.push(page(p.data, { granule, eos: i === packets.length - 1 }));
    });
    return parts;
  }

  g.SV_AUDIO_EXPORT = { wavFromPcm, oggFromOpusPackets, crc32ogg };
})(globalThis);

// SubVibe — Library/popup export helpers: read the worker's IndexedDB directly
// (same extension origin; bulk audio through base64 messaging would be silly),
// build .srt text and stitch cached dub clips into one audio file. Writes stay
// in the worker. Extension-page-only — NOT a content script.
(function (g) {
  // ── dub audio: read the worker's IndexedDB directly (same extension origin;
  // bulk audio through base64 messaging would be silly). Writes stay in the worker.
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("copilot-subs");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function audioRows(prefix) {
    const d = await openDb();
    if (!d.objectStoreNames.contains("audio")) { d.close(); return []; }
    return new Promise((resolve) => {
      const out = [];
      d.transaction("audio").objectStore("audio").openCursor().onsuccess = (e) => {
        const c = e.target.result;
        if (!c) { d.close(); return resolve(out); }
        if (typeof c.key === "string" && c.key.startsWith(prefix)) out.push({ key: c.key, ...c.value });
        c.continue();
      };
    });
  }
  async function trackCues(key) {
    const d = await openDb();
    return new Promise((resolve) => {
      const r = d.transaction("tracks").objectStore("tracks").get(key);
      r.onsuccess = () => { d.close(); resolve((r.result && r.result.cues) || []); };
      r.onerror = () => { d.close(); resolve([]); };
    });
  }
  function download(name, blobParts, mime) {
    const url = URL.createObjectURL(new Blob(blobParts, { type: mime }));
    const a = document.createElement("a");
    a.href = url; a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  const safeName = (s) => (s || "subvibe").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80);

  async function exportSrt(g, target) {
    const cues = await trackCues(`${g.base}:auto:${target}`);
    if (!cues.length) return alert("Nothing cached for this language yet.");
    download(`${safeName(g.title)} — ${target}.srt`, [window.SV_SRT.cuesToSrt(cues)], "text/plain;charset=utf-8");
  }

  // Stitch every cached clip at its timestamp into ONE audio blob.
  // Ogg/Opus via WebCodecs where available, else WAV (audit forbids an MP3 lib).
  // interactive=false skips the confirm() gap warning (used by the ▶ preview).
  async function stitchDubBlob(gr, target, { interactive = true } = {}) {
    const rows = await audioRows(`${gr.base}:auto:${target}:dub:`);
    if (!rows.length) return null;
    // Several voice configs may exist — export the one with the most clips.
    const byCfg = new Map();
    for (const r of rows) {
      const cfg = r.key.slice(0, r.key.lastIndexOf("#"));
      if (!byCfg.has(cfg)) byCfg.set(cfg, []);
      byCfg.get(cfg).push(r);
    }
    const clips = [...byCfg.values()].sort((a, b) => b.length - a.length)[0];
    const cues = await trackCues(`${gr.base}:auto:${target}`);
    // Spec: warn on gaps — an incomplete dub exports with silent holes.
    const speechMs = clips.reduce((a, r) => a + (r.ms || 0), 0);
    const trackMs = cues.length ? (cues[cues.length - 1].endMs || cues[cues.length - 1].startMs) : 0;
    const pct = trackMs ? Math.min(100, Math.round((speechMs / trackMs) * 100)) : 100;
    if (interactive && pct < 60 && !confirm(`Only ~${pct}% of this video has dub audio cached — the export will have silent gaps. ` +
      `Tip: open the video and click "Generate full dub" in the popup first. Export anyway?`)) return false;
    const lastMs = Math.max(...clips.map((r) => +r.key.slice(r.key.lastIndexOf("#") + 1) + (r.ms || 3000)),
      cues.length ? (cues[cues.length - 1].endMs || 0) : 0);
    const haveEncoder = typeof AudioEncoder !== "undefined";
    const rate = haveEncoder ? 48000 : 24000;
    const decodeCtx = new AudioContext();
    const off = new OfflineAudioContext(1, Math.ceil(((lastMs + 1000) / 1000) * rate), rate);
    for (const r of clips) {
      const startMs = +r.key.slice(r.key.lastIndexOf("#") + 1);
      const bin = atob(r.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      try {
        const buf = await decodeCtx.decodeAudioData(bytes.buffer);
        const src = off.createBufferSource();
        src.buffer = buf;
        src.connect(off.destination);
        src.start(startMs / 1000);
      } catch {} // one undecodable clip must not sink the export
    }
    decodeCtx.close();
    const rendered = await off.startRendering();
    const pcm = rendered.getChannelData(0);
    const name = `${safeName(gr.title)} — ${target} dub`;
    if (!haveEncoder) return { blob: new Blob([g.SV_AUDIO_EXPORT.wavFromPcm(pcm, rate)], { type: "audio/wav" }), name: `${name}.wav`, mime: "audio/wav" };
    const packets = [];
    const enc = new AudioEncoder({
      output: (chunk) => { const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d); packets.push({ data: d, samples: chunk.duration ? Math.round((chunk.duration / 1e6) * 48000) : 960 }); },
      error: (e) => console.warn("[SubVibe] opus encode:", e),
    });
    enc.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 1, bitrate: 48000 });
    const FRAME = 48000; // 1s of samples per AudioData; the encoder splits into 20ms packets
    for (let i = 0; i < pcm.length; i += FRAME) {
      const slice = pcm.subarray(i, Math.min(i + FRAME, pcm.length));
      enc.encode(new AudioData({ format: "f32-planar", sampleRate: 48000, numberOfFrames: slice.length, numberOfChannels: 1, timestamp: Math.round((i / 48000) * 1e6), data: slice }));
    }
    await enc.flush();
    enc.close();
    return { blob: new Blob(g.SV_AUDIO_EXPORT.oggFromOpusPackets(packets, { preSkip: 312 }), { type: "audio/ogg" }), name: `${name}.ogg`, mime: "audio/ogg" };
  }

  async function exportAudio(gr, target) {
    const out = await stitchDubBlob(gr, target, { interactive: true });
    if (out === null) return alert("No dub audio cached for this language yet.");
    if (out) download(out.name, [out.blob], out.mime);
  }

  g.SV_EXPORT = { audioRows, trackCues, download, safeName, exportSrt, stitchDubBlob, exportAudio };
})(globalThis);

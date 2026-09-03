// offscreen-live-worklet.js — the input side of Live Translate as an AudioWorklet.
// Runs on the audio thread: gathers the 16 kHz mono input into 4096-sample
// blocks and posts each block to offscreen-live.js, which turns it into PCM16
// for Gemini Live. Replaces the deprecated ScriptProcessorNode (Chrome warns
// about it in the extension's Errors page); the old node stays as a fallback
// when a worklet can't be loaded.
class SvLivePcm extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let i = 0;
    while (i < ch.length) {
      const take = Math.min(ch.length - i, this.buf.length - this.n);
      this.buf.set(ch.subarray(i, i + take), this.n); this.n += take; i += take;
      if (this.n === this.buf.length) { this.port.postMessage(this.buf, [this.buf.buffer]); this.buf = new Float32Array(4096); this.n = 0; }
    }
    return true;
  }
}
registerProcessor("sv-live-pcm", SvLivePcm);

// Fake environment for offscreen-live.js: chrome stub, scripted WebSocket,
// oscillator getUserMedia. Loaded BEFORE the module under test.
(function () {
  const sent = [];        // chrome.runtime.sendMessage payloads from the module
  const listeners = [];   // the module's onMessage registrations

  window.chrome = {
    runtime: {
      id: "harness",
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: (m) => { sent.push(m); },
    },
    storage: { local: { get: async () => ({ geminiKey: "FAKE-KEY" }) } },
  };

  // 200ms of 440Hz sine as 24kHz PCM16 base64 — the "translated speech" payload.
  function sinePcmBase64(ms, rate) {
    const n = Math.round((ms / 1000) * rate);
    const i16 = new Int16Array(n);
    for (let i = 0; i < n; i++) i16[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000);
    const bytes = new Uint8Array(i16.buffer);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  class FakeWS {
    constructor(url) {
      FakeWS.instances.push(this);
      this.url = url;
      this.readyState = 0;
      this.frames = [];       // everything the module sends
      this.closed = false;
      setTimeout(() => { this.readyState = FakeWS.OPEN; this.onopen && this.onopen(); }, 10);
    }
    send(data) {
      const msg = JSON.parse(data);
      this.frames.push(msg);
      if (msg.setup) {
        setTimeout(() => this._recv({ setupComplete: {} }), 10);
      } else if (msg.realtimeInput && !this._replied) {
        this._replied = true; // one scripted turn per session
        setTimeout(() => {
          this._recv({ serverContent: { inputTranscription: { text: "Guten Morgen, " } } });
          this._recv({ serverContent: { inputTranscription: { text: "wie geht es dir?" }, outputTranscription: { text: "صبح بخیر، " } } });
          this._recv({ serverContent: { outputTranscription: { text: "حالت چطوره؟" }, modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: sinePcmBase64(200, 24000) } }] } } });
          this._recv({ serverContent: { turnComplete: true } });
        }, 30);
      }
    }
    _recv(obj) { this.onmessage && this.onmessage({ data: JSON.stringify(obj) }); }
    close() { this.closed = true; this.readyState = FakeWS.CLOSED; this.onclose && this.onclose(); }
  }
  FakeWS.OPEN = 1; FakeWS.CLOSED = 3;
  FakeWS.instances = [];
  window.WebSocket = FakeWS;

  // getUserMedia → a real MediaStream from an oscillator (no mic permission needed).
  navigator.mediaDevices.getUserMedia = async () => {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const dest = ctx.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    window.__oscCtx = ctx;
    return dest.stream;
  };

  window.__fake = {
    sent, listeners,
    dispatch: (msg) => listeners.forEach((fn) => fn(msg)),
    ws: () => FakeWS.instances[FakeWS.instances.length - 1],
    wsCount: () => FakeWS.instances.length,
  };
})();

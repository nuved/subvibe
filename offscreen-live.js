// Offscreen document: LIVE TRANSLATE (experimental).
//
// One WebSocket session to Gemini's Live translate model: the chosen input
// device (e.g. BlackHole = system audio) streams up as 16kHz PCM16; translated
// SPEECH streams back as 24kHz PCM16 and plays here; the model's input/output
// transcriptions stream back as text and are forwarded so the content script
// can show them as overlay lines. Session-based by design — the free tier
// caps tokens/minute (realtime audio ≈ 4-5K/min vs a 20K budget), never
// request counts, which is exactly why this runs where the TTS dub stalls.
//
// Only ever runs after an explicit user click (background forwards LIVE_START).

const LIVE_WS_BASE = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

let lvStream = null, lvWs = null, lvCtxIn = null, lvSrc = null, lvProc = null, lvCtxPass = null;
let lvCtxOut = null, lvCursor = 0, lvScheduled = [];
let lvRunning = false, lvStarting = false, lvClosing = false, lvRetries = 0;
let lvTurn = { orig: "", out: "" }, lvFlushT = 0, lvPartialT = 0;
let lvChanMode = { orig: null, out: null }; // per-channel stream shape: null=unknown, "cum"=cumulative snapshots
let lvDbgN = 0; // raw-chunk forensics counter (see the onmessage debug log)
let lvStats = null, lvStatsT = 0; // popup-visible flow counters — no console spelunking
let lvCfg = null; // {deviceId, target, model, key, sysAsContent}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "LIVE_PING") { sendResponse({ pong: true }); return; } // readiness handshake — see background LIVE_START
  if (msg.type === "LIVE_START") liveStart(msg);
  else if (msg.type === "LIVE_STOP") liveStop("stopped");
});

const lvState = (running, error, stage) => chrome.runtime.sendMessage({ type: "LIVE_STATE", running, error: error || null, stage: stage || null, stats: lvStats && running ? { secs: Math.round((Date.now() - lvStats.t0) / 1000), upSecs: Math.round(lvStats.upSamples / 16000), heard: lvStats.textIn, spoke: lvStats.textOut, voiceSecs: Math.round(lvStats.voiceMs / 1000) } : null });

async function liveStart(msg) {
  // lvRunning only latches AFTER capture succeeds — without lvStarting, two
  // deliveries in flight both passed this gate and raced for the same stream.
  if (lvRunning || lvStarting) return;
  lvStarting = true;
  lvState(true, null, "Capture page ready…"); // proves LIVE_START arrived
  const geminiKey = msg.key || (await chrome.storage.local.get("geminiKey")).geminiKey;
  if (!geminiKey) { lvStarting = false; lvState(false, "No Gemini API key saved — add it in the popup's API keys."); return; }
  // The API id carries a -preview suffix (ai.google.dev/gemini-api/docs/models/
  // gemini-3.5-live-translate-preview) — the suffixless form we shipped first is
  // REJECTED at setup (the server closes the socket, which looked like an
  // endless "reconnecting…"). Heal any stale stored value here.
  const model = (!msg.model || msg.model === "gemini-3.5-live-translate") ? "gemini-3.5-live-translate-preview" : msg.model;
  lvCfg = { deviceId: msg.deviceId, target: msg.target || "English", model, key: geminiKey, sysAsContent: false,
    // Passthrough only applies to tab capture (Chrome mutes a captured tab
    // until someone routes it back out); a mic passthrough would just echo.
    passVol: msg.streamId && typeof msg.origVol === "number" ? msg.origVol : 0 };

  // The finest-grain breadcrumb: if the popup freezes on THIS line, the raced
  // getUserMedia below is the stall — and its 8s timeout names it.
  lvState(true, null, msg.streamId ? "Opening tab audio…" : "Opening microphone…");
  try {
    if (msg.streamId) {
      // Default path: the tab's own audio, handed over by the popup's
      // tabCapture.getMediaStreamId — no microphone, no permission prompt.
      // Same 8s race as the device path: a hung consume must NAME itself.
      lvStream = await Promise.race([
        navigator.mediaDevices.getUserMedia({
          audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: msg.streamId } },
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("tab stream didn't open in 8s — the browser may block tab capture")), 8000)),
      ]);
    } else {
      // Explicit input device (mic / BlackHole). This document is invisible, so
      // an ungranted mic request has nowhere to prompt and can sit PENDING
      // forever (the operator's eternal "Connecting…"). The popup pre-authorizes
      // before LIVE_START, but never trust that: an 8s race turns a silent hang
      // into a named, popup-visible failure.
      lvStream = await Promise.race([
        navigator.mediaDevices.getUserMedia({
          audio: lvCfg.deviceId ? { deviceId: { exact: lvCfg.deviceId } } : true,
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("microphone permission pending — allow the mic for the extension, then Start again")), 8000)),
      ]);
    }
  } catch (e) { lvStarting = false; lvState(false, "capture: " + (e.message || e)); return; }
  lvState(true, null, (msg.streamId ? "Tab audio OK" : "Mic OK") + " — connecting to Google…");

  lvStarting = false;
  lvRunning = true; lvClosing = false; lvRetries = 0;
  lvTurn = { orig: "", out: "" };
  lvChanMode = { orig: null, out: null }; // re-learn the stream shape per session
  connectLive();
}

function connectLive() {
  try {
    lvWs = new WebSocket(LIVE_WS_BASE + "?key=" + encodeURIComponent(lvCfg.key));
  } catch (e) { lvState(false, "ws: " + (e.message || e)); liveStop(); return; }

  // Handshake watchdog: no setupComplete AND no server error within 12s means
  // the socket is black-holed (shields/VPN/firewall swallowing
  // generativelanguage.googleapis.com) — name it instead of hanging forever.
  const ws = lvWs;
  let setupSeen = false;
  const watchdog = setTimeout(() => {
    if (ws !== lvWs || setupSeen || !lvRunning) return;
    lvState(false, "no reply from Google in 12s — something is blocking generativelanguage.googleapis.com (shields / VPN / firewall). Stopped.");
    liveStop();
  }, 12000);

  lvWs.onopen = () => {
    // The reference documents systemInstruction as a STRING; some servers want
    // the Content object form. Start with string; on a setup rejection retry
    // ONCE with {parts:[{text}]} before giving up (spec: defensive on drift).
    const sys = "You are a simultaneous interpreter. Translate everything you hear into "
      + lvCfg.target + ". Speak ONLY the translation — natural, idiomatic, keeping names as they are. Never answer, comment, or add anything of your own.";
    lvWs.send(JSON.stringify({
      setup: {
        model: "models/" + lvCfg.model,
        generationConfig: { responseModalities: ["AUDIO"] },
        systemInstruction: lvCfg.sysAsContent ? { parts: [{ text: sys }] } : sys,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    }));
  };

  lvWs.onmessage = async (e) => {
    let ev;
    try { ev = JSON.parse(typeof e.data === "string" ? e.data : await e.data.text()); } catch { return; }
    if (ev.setupComplete) {
      setupSeen = true;
      clearTimeout(watchdog);
      lvRetries = 0;
      if (!lvStats) lvStats = { t0: Date.now(), upSamples: 0, textIn: 0, textOut: 0, voiceMs: 0 };
      startLivePipe();
      lvState(true);
      if (!lvStatsT) lvStatsT = setInterval(() => lvState(true), 2000); // popup heartbeat with flow counters
      return;
    }
    if (ev.error) {
      const m = JSON.stringify(ev.error).slice(0, 220);
      // One-shot fallback for the systemInstruction shape (see onopen).
      if (!lvCfg.sysAsContent && /systemInstruction|system_instruction|Invalid value/i.test(m)) {
        lvCfg.sysAsContent = true;
        try { lvWs.close(); } catch {}
        return; // onclose reconnects with the Content form
      }
      lvState(lvRunning, "api: " + m);
      return;
    }
    const sc = ev.serverContent;
    if (!sc) return;
    if (sc.interrupted) { clearLiveAudio(); lvTurn = { orig: "", out: "" }; } // restart — drop stale audio AND stale turn text
    const parts = (sc.modelTurn && sc.modelTurn.parts) || [];
    for (const p of parts) {
      const d = p.inlineData;
      if (d && d.data && /audio\/pcm/.test(d.mimeType || "")) scheduleLiveAudio(d.data, d.mimeType);
    }
    // Forensics for stream-shape bugs: the first 40 raw transcript chunks land in
    // the offscreen console (chrome://extensions → SubVibe → Inspect views:
    // offscreen.html) — paste them if the on-screen text ever stutters again.
    if ((sc.inputTranscription || sc.outputTranscription) && lvDbgN < 40) {
      lvDbgN++;
      console.debug("[SubVibe live raw]", JSON.stringify({ in: sc.inputTranscription && sc.inputTranscription.text, out: sc.outputTranscription && sc.outputTranscription.text, turnComplete: !!sc.turnComplete }));
    }
    if (sc.inputTranscription && sc.inputTranscription.text) { lvTurn.orig = mergeStreamText("orig", lvTurn.orig, sc.inputTranscription.text); if (lvStats) lvStats.textIn++; }
    if (sc.outputTranscription && sc.outputTranscription.text) { lvTurn.out = mergeStreamText("out", lvTurn.out, sc.outputTranscription.text); if (lvStats) lvStats.textOut++; }
    if (sc.turnComplete) flushLiveText();
    else if (lvTurn.orig || lvTurn.out) {
      // Smooth caption cadence: show the growing line at most twice a second
      // (partial), and finalize on turnComplete or 2.5s of silence.
      if (!lvPartialT) lvPartialT = setTimeout(() => { lvPartialT = 0; sendLiveText(false); }, 500);
      clearTimeout(lvFlushT); lvFlushT = setTimeout(flushLiveText, 2500);
    }
  };

  lvWs.onclose = (e) => {
    clearTimeout(watchdog);
    if (lvClosing) return;
    if (!lvRunning) return;
    // The server's close code + reason IS the diagnosis (Gemini names bad
    // model ids and rejected payloads in the close reason) — show it, never
    // swallow it. 1006 = the connection never opened / was refused (key,
    // network, shields).
    const why = "code " + ((e && e.code) || "?") + (e && e.reason ? " — " + String(e.reason).slice(0, 180) : "");
    // A close BEFORE any setupComplete usually means the setup itself was
    // rejected. Attempt 1 retries with the Content-object systemInstruction
    // shape; after that, STOP EARLY and hand over the server's own words —
    // endless reconnects with a doomed setup only hide the cause.
    if (!lvStats) {
      if (!lvCfg.sysAsContent) lvCfg.sysAsContent = true;
      else if (lvRetries >= 2) { lvState(false, "Google closed the session during setup (" + why + "). Likely the model id or the API key. Stopped."); liveStop(); return; }
    }
    // Unexpected close (network blip, session cap, or the sysAsContent retry):
    // fresh session with backoff — context is lost, acceptable for live speech.
    const delay = [1000, 2000, 5000][Math.min(lvRetries, 2)];
    lvRetries++;
    if (lvRetries > 6) { lvState(false, "connection keeps dropping — stopped. Last close: " + why); liveStop(); return; }
    lvState(true, "reconnecting… (" + why + ")");
    setTimeout(() => { if (lvRunning) connectLive(); }, delay);
  };
  lvWs.onerror = () => {}; // onclose carries the retry; error alone is noise
}

// Input side: 16kHz mono PCM16 (Gemini Live input format).
function startLivePipe() {
  if (lvCtxIn) return; // reconnects reuse the running pipe
  if (lvCfg.passVol > 0 && !lvCtxPass) {
    // Keep the captured tab audible under the translation — at NATIVE sample
    // rate (a separate context), not the 16kHz upload rate, so the original
    // keeps its full quality.
    lvCtxPass = new AudioContext();
    const pSrc = lvCtxPass.createMediaStreamSource(lvStream);
    const pGain = lvCtxPass.createGain();
    pGain.gain.value = lvCfg.passVol;
    pSrc.connect(pGain);
    pGain.connect(lvCtxPass.destination);
  }
  lvCtxIn = new AudioContext({ sampleRate: 16000 });
  lvSrc = lvCtxIn.createMediaStreamSource(lvStream);
  lvProc = lvCtxIn.createScriptProcessor(4096, 1, 1);
  const mute = lvCtxIn.createGain();
  mute.gain.value = 0;
  lvProc.onaudioprocess = (e) => {
    if (!lvWs || lvWs.readyState !== WebSocket.OPEN) return;
    const f32 = e.inputBuffer.getChannelData(0);
    const i16 = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    if (lvStats) lvStats.upSamples += i16.length;
    lvWs.send(JSON.stringify({ realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: pcmToBase64(i16) } } }));
  };
  lvSrc.connect(lvProc);
  lvProc.connect(mute);
  mute.connect(lvCtxIn.destination);
}

// Output side: sequential scheduling of 24kHz PCM16 chunks.
function scheduleLiveAudio(b64, mime) {
  if (!lvCtxOut) { lvCtxOut = new AudioContext({ sampleRate: 24000 }); lvCursor = 0; }
  const rate = +((/rate=(\d+)/.exec(mime || "") || [])[1] || 24000);
  const bytes = atob(b64);
  const n = bytes.length >> 1;
  if (!n) return;
  const buf = lvCtxOut.createBuffer(1, Math.max(1, Math.round(n * lvCtxOut.sampleRate / rate)), lvCtxOut.sampleRate);
  // Fill via an intermediate Float32 at the SOURCE rate, then let the buffer's
  // simple nearest-sample copy handle the (usually 1:1) rate difference.
  const f = buf.getChannelData(0);
  for (let i = 0; i < buf.length; i++) {
    const si = Math.min(n - 1, Math.round(i * rate / lvCtxOut.sampleRate));
    const lo = bytes.charCodeAt(si * 2), hi = bytes.charCodeAt(si * 2 + 1);
    let v = (hi << 8) | lo;
    if (v >= 0x8000) v -= 0x10000;
    f[i] = v / 0x8000;
  }
  const src = lvCtxOut.createBufferSource();
  src.buffer = buf;
  src.connect(lvCtxOut.destination);
  const at = Math.max(lvCtxOut.currentTime, lvCursor);
  src.start(at);
  lvCursor = at + buf.duration;
  if (lvStats) lvStats.voiceMs += buf.duration * 1000;
  lvScheduled.push(src);
  src.onended = () => { const i = lvScheduled.indexOf(src); if (i >= 0) lvScheduled.splice(i, 1); };
}

function clearLiveAudio() {
  for (const s of lvScheduled.splice(0)) { try { s.stop(); } catch {} }
  lvCursor = 0;
}

// Streamed transcription chunks arrive as DELTAS, CUMULATIVE snapshots — which
// may also REVISE earlier words — or overlapping fragments, depending on the
// model's mood. Blind += duplicated words on screen (the operator's "appends
// words to the same word"). Strategy: the first snapshot proves the channel is
// cumulative, and from then on the LATEST snapshot simply wins (revisions
// included); otherwise merge by overlap; otherwise append a true delta.
function mergeStreamText(chan, prev, add) {
  if (!add) return prev;
  if (!prev) return add;
  if (add.startsWith(prev)) { lvChanMode[chan] = "cum"; return add; }
  if (lvChanMode[chan] === "cum") {
    // Cumulative channel that rewrote earlier words — replace, unless the new
    // text is a stray sliver (guard against a lone fragment nuking the line).
    return add.length * 2 >= prev.length ? add : prev;
  }
  const max = Math.min(prev.length, add.length);
  for (let k = max; k > 0; k--) if (prev.endsWith(add.slice(0, k))) return prev + add.slice(k); // overlap join
  return prev + add;                                    // pure delta
}

// Long monologues would wrap the overlay into a wall — display the tail only,
// cut at a word boundary.
function displayTail(s, cap) {
  s = s.trim();
  if (s.length <= cap) return s;
  const cut = s.slice(s.length - cap);
  const sp = cut.indexOf(" ");
  return "…" + (sp > 0 ? cut.slice(sp + 1) : cut);
}

function sendLiveText(final) {
  const orig = displayTail(lvTurn.orig, 180), out = displayTail(lvTurn.out, 180);
  if (orig || out) chrome.runtime.sendMessage({ type: "LIVE_TEXT", original: orig, translated: out, partial: !final });
  if (final) lvTurn = { orig: "", out: "" };
}

function flushLiveText() {
  clearTimeout(lvFlushT); lvFlushT = 0;
  clearTimeout(lvPartialT); lvPartialT = 0;
  sendLiveText(true);
}

function pcmToBase64(i16) {
  const bytes = new Uint8Array(i16.buffer);
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}

function liveStop(reason) {
  lvClosing = true;
  const wasRunning = lvRunning;
  lvRunning = false;
  lvStarting = false;
  clearTimeout(lvFlushT);
  clearTimeout(lvPartialT); lvPartialT = 0;
  clearInterval(lvStatsT); lvStatsT = 0; lvStats = null;
  clearLiveAudio();
  try { lvProc && lvProc.disconnect(); } catch {}
  try { lvSrc && lvSrc.disconnect(); } catch {}
  try { lvCtxIn && lvCtxIn.close(); } catch {}
  try { lvCtxOut && lvCtxOut.close(); } catch {}
  try { lvCtxPass && lvCtxPass.close(); } catch {}
  try { lvWs && lvWs.close(); } catch {}
  lvCtxIn = lvSrc = lvProc = lvCtxOut = lvCtxPass = lvWs = null;
  if (lvStream) { lvStream.getTracks().forEach((t) => t.stop()); lvStream = null; }
  if (wasRunning || reason === "stopped") lvState(false);
}

// Offscreen document: STREAMING audio transcription.
//
// Captures the chosen input device (e.g. BlackHole = system audio), streams PCM
// continuously to OpenAI's Realtime transcription endpoint over a WebSocket, and
// forwards each finalized line as text. No chunking → ~1-2s latency, smooth.
//
// Only ever runs after an explicit user click (background sends AUDIO_START).
//
// Browser WebSockets can't set an Authorization header, so we pass the BYOK key
// via the documented subprotocol (the key stays in this extension context, never
// the page). If your account needs ephemeral tokens instead, we'll switch to
// /v1/realtime/client_secrets — the error will tell us.

const RT_URL = "wss://api.openai.com/v1/realtime?intent=transcription";

let stream = null, ws = null, ctx = null, src = null, proc = null;
let running = false;

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === "AUDIO_START") start(msg.deviceId);
  else if (msg.type === "AUDIO_STOP") stop();
});

const err = (m) => chrome.runtime.sendMessage({ type: "AUDIO_ERROR", error: m });

async function start(deviceId) {
  if (running) return;
  const { apiKey } = await chrome.storage.local.get("apiKey");
  if (!apiKey) { err("No OpenAI API key saved."); return; }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    });
  } catch (e) { err("capture: " + (e.message || e)); return; }

  running = true;
  try {
    ws = new WebSocket(RT_URL, ["realtime", "openai-insecure-api-key." + apiKey, "openai-beta.realtime-v1"]);
  } catch (e) { err("ws: " + (e.message || e)); stop(); return; }

  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: "transcription_session.update",
      session: {
        input_audio_format: "pcm16",
        input_audio_transcription: { model: "gpt-4o-transcribe" },
        turn_detection: { type: "server_vad", silence_duration_ms: 500 },
      },
    }));
    startAudioPipe();
  };

  ws.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    if (ev.type === "conversation.item.input_audio_transcription.completed") {
      const t = (ev.transcript || "").trim();
      if (t) chrome.runtime.sendMessage({ type: "AUDIO_TEXT", text: t });
    } else if (ev.type === "error") {
      err("api: " + JSON.stringify(ev.error || ev).slice(0, 220));
    }
  };
  ws.onerror = () => err("websocket error — check the API key / network.");
}

// 24kHz mono PCM16 (the AudioContext resamples the device rate for us).
function startAudioPipe() {
  ctx = new AudioContext({ sampleRate: 24000 });
  src = ctx.createMediaStreamSource(stream);
  proc = ctx.createScriptProcessor(4096, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0; // ScriptProcessor must be connected to run, but stay silent

  proc.onaudioprocess = (e) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const f32 = e.inputBuffer.getChannelData(0);
    const i16 = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: toBase64(i16) }));
  };

  src.connect(proc);
  proc.connect(mute);
  mute.connect(ctx.destination);
}

function toBase64(i16) {
  const bytes = new Uint8Array(i16.buffer);
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}

function stop() {
  running = false;
  try { proc && proc.disconnect(); } catch {}
  try { src && src.disconnect(); } catch {}
  try { ctx && ctx.close(); } catch {}
  try { ws && ws.close(); } catch {}
  ctx = src = proc = ws = null;
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
}

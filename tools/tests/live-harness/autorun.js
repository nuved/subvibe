// Scripted run: start → setup → audio flows up → scripted turn comes back →
// transcript pair emitted → stop cleans up. PASS/FAIL on page + title.
// Runs from the RUN button so AudioContexts get their trusted user gesture.
window.__run = async function () {
  const out = [];
  const check = (name, ok, detail) => out.push({ name, ok: !!ok, detail });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const F = window.__fake;

  F.dispatch({ type: "LIVE_START", deviceId: "", target: "Persian", targetCode: "fa", model: "gemini-3.5-live-translate-preview" });
  await sleep(700); // open + setup + first audio chunks + scripted turn

  const ws = F.ws();
  const setup = ws && ws.frames.find((f) => f.setup);
  check("websocket opened with key in url", ws && /key=FAKE-KEY/.test(ws.url), ws && ws.url.slice(-40));
  check("setup names the model", setup && setup.setup.model === "models/gemini-3.5-live-translate-preview", setup && setup.setup.model);
  // Wire split per js-genai converters: transcriptions TOP-LEVEL in setup,
  // translationConfig INSIDE generationConfig (server 1007s on any other mix).
  const gc = setup && setup.setup.generationConfig;
  check("setup: AUDIO in generationConfig, transcriptions at setup TOP level", gc && gc.responseModalities[0] === "AUDIO" && "inputAudioTranscription" in setup.setup && "outputAudioTranscription" in setup.setup && !("inputAudioTranscription" in gc));
  check("translationConfig in generationConfig targets fa, echo off, no systemInstruction", gc && gc.translationConfig && gc.translationConfig.targetLanguageCode === "fa" && gc.translationConfig.echoTargetLanguage === false && !("systemInstruction" in setup.setup), gc && gc.translationConfig);

  const audioFrames = ws ? ws.frames.filter((f) => f.realtimeInput) : [];
  const a0 = audioFrames[0] && audioFrames[0].realtimeInput.audio;
  check("mic audio streams up as 16kHz PCM", audioFrames.length > 0 && a0 && /rate=16000/.test(a0.mimeType) && a0.data.length > 100, { frames: audioFrames.length });

  const states = F.sent.filter((m) => m.type === "LIVE_STATE");
  check("LIVE_STATE running:true after setup", states.some((s) => s.running === true));

  const texts = F.sent.filter((m) => m.type === "LIVE_TEXT");
  const fin = texts.find((t) => t.partial === false);
  check("overlaps and snapshots merge without duplication", fin && fin.original === "Guten Morgen, wie geht es dir?" && fin.translated === "صبح بخیر، حالت چطوره؟", fin);

  F.dispatch({ type: "LIVE_STOP" });
  await sleep(100);
  check("stop closes the socket", ws && ws.closed);
  check("stop announces running:false", F.sent.some((m) => m.type === "LIVE_STATE" && m.running === false));
  check("no reconnect after clean stop", F.wsCount() === 1, { sockets: F.wsCount() });

  // Sync (store review 2026-10-01): a TAB capture plays the original under the voice through a delay.
  // Fixed 2 s → the delay is 2 s; LIVE_SYNC "off" → it glides to 0; the popup's stats carry syncMs.
  F.dispatch({ type: "LIVE_START", streamId: "tab-1", origVol: 0.5, sync: "2", deviceId: "", target: "Persian", targetCode: "fa", model: "gemini-3.5-live-translate-preview" });
  await sleep(2600); // setup + passthrough + one 2 s heartbeat
  check("tab capture: the original passes through a delay set to the chosen 2 s", typeof lvDelay !== "undefined" && lvDelay && Math.abs(lvDelay.delayTime.value - 2) < 0.05, lvDelay && lvDelay.delayTime.value);
  const st2 = F.sent.filter((m) => m.type === "LIVE_STATE" && m.stats).pop();
  check("stats tell the popup how long the original waits", st2 && st2.stats.syncMs === 2000, st2 && st2.stats);
  F.dispatch({ type: "LIVE_SYNC", sync: "off" });
  await sleep(1800);
  check("Sync off: the original goes back on time", lvDelay && lvDelay.delayTime.value < 0.05, lvDelay && lvDelay.delayTime.value);
  F.dispatch({ type: "LIVE_STOP" });
  await sleep(100);

  const fails = out.filter((r) => !r.ok);
  document.title = fails.length ? `FAIL ${fails.length}/${out.length}` : `PASS ${out.length}/${out.length}`;
  document.getElementById("out").textContent = out.map((r) => `${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail !== undefined ? "  " + JSON.stringify(r.detail) : ""}`).join("\n");
};
document.getElementById("go").addEventListener("click", () => { document.getElementById("go").disabled = true; window.__run(); });

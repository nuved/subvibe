// SubVibe — Dub Mode: speaks the translated sentence-groups over the ducked
// original soundtrack. Runs entirely in the content script; the OpenAI call and
// the audio cache live in the worker (the user's BYOK secret never enters this
// page-reachable context — audio arrives as base64, MV3 messages being JSON).
(function () {
  "use strict";

  let hooks = null;          // from common.js attach(): { base, target, getVideo, playhead, live, cues, site, persist }
  let dubOn = false;
  let conf = { voice: "marin", geminiVoice: "Kore", provider: "openai", multi: false, duck: 0.12, pace: 1 };
  let ctx = null, master = null;
  let buffers = new Map();   // run startMs → decoded AudioBuffer (playback window only)
  let pending = new Set();   // run startMs with a speech request in flight
  let playing = new Map();   // run startMs → { src, gain, voice }
  let spoken = new Set();    // run starts already played (or given up on) since the last seek/attach — each run plays at most once between seeks
  let resumable = new Set(); // run starts stopped mid-clip by an interruption (seek/pause), not a natural end — the ONLY case that resumes with a nonzero offset
  let elig = [];             // eligible groups, refreshed 1×/s by the pump
  // A run = consecutive eligible groups, same assigned voice, gaps < 1.4s,
  // total span ≤ 12s, joined into ONE TTS call. Longer continuous synthesis
  // holds one voice identity and natural prosody; short independent clips
  // drift (gpt-4o-mini-tts loses the timbre across separate generations).
  // Immutable once created: membership never changes after a run is built —
  // only WHEN it gets fetched is still open (the frontier rule below).
  let runs = new Map();      // run startMs → { start, end, text, voice, groups }
  let raf = 0, pumpIv = 0;
  let ducked = false, baseVol = 1, volEl = null;
  let lastT = -1;
  let lastSetVol = -1;       // last value WE wrote to volEl.volume, for self-write detection
  let genAll = null;         // { phase, total, done, cancelled } while generating everything
  let genErr = null;         // last generateAll() failure message, surfaced by the popup
  let nowText = null;        // translated line of the clip currently playing, for the popup's now-playing line
  let decodeFails = 0;       // count of decodeAudioData rejections (diagnostics — a spike here means "TTS ok, playback silent")

  // ── consent-gated transport (session-local per attach, not persisted) ────
  // A fresh video must not spend a cent until the user clicks the on-player
  // button once; a video with any cached dub audio auto-starts (replay is
  // free). transportPaused gates BOTH the pump (no TTS requests) and the loop
  // (no clip starts); the duck releases while paused.
  let transportPaused = true;
  let lastPct = 0, lastRemainUSD = 0; // last coverage snapshot, painted on the button
  let dubctlEl = null;

  const V = () => globalThis.SV_VOICES;
  const estUSD = (ms) => conf.provider === "gemini" ? V().dubEstimateUSDGemini(ms) : V().dubEstimateUSD(ms);
  const gStart = (g) => g.cues[0].startMs;
  const gEnd = (g) => { const last = g.cues[g.cues.length - 1]; return last.endMs || last.startMs + 2500; };
  const gSpanMs = (g) => Math.max(600, gEnd(g) - gStart(g)); // one group's own span (status/coverage UI only)
  // -v4: a generation-version tag on the cache namespace so pre-run-merge /
  // pre-identity-anchor clips (keyed without it) are never replayed — they die
  // with their track via the existing prefix delete/evict, no migration needed.
  // Bumped from -v3 for the persona-anchor instructions + 20s run geometry
  // (Task 21): the old-regime clips must not mix in with the new ones.
  // Gemini adds its own provider segment (e.g. "sv-gem-Kore-v4") so switching
  // ttsProvider never replays/mixes the other provider's cached clips — Gemini
  // is always single-voice (multi-voice stays OpenAI-only in v1), so its tag
  // is unconditionally "sv".
  const curVoice = () => (conf.provider === "gemini" ? conf.geminiVoice : conf.voice);
  const vcfg = () => (conf.provider === "gemini"
    ? "sv-gem-" + conf.geminiVoice + "-v4"
    : (conf.multi ? "mv" : "sv") + "-" + conf.voice + "-v4");
  const audioKey = (run) => `${hooks.base}:dub:${vcfg()}#${run.start}`;
  const spanMs = (run) => Math.max(600, run.end - run.start);
  // Video-time silence between upcoming runs in [from, from+windowMs] —
  // the room that can absorb dub lag without any speed-up or skip.
  function slackAhead(from, windowMs = 45000) {
    const sorted = [...runs.values()].sort((a, b) => a.start - b.start);
    let slack = 0, cursor = from;
    for (const r of sorted) {
      if (r.end <= from) continue;
      if (r.start > from + windowMs) break;
      if (r.start > cursor) slack += r.start - cursor;
      cursor = Math.max(cursor, r.end);
    }
    return slack;
  }

  // Merge adjacent eligible groups (same voice, small gap, bounded total span)
  // into immutable runs, one TTS call per run. A run, once created, NEVER
  // changes membership — only whether it's ELIGIBLE TO FETCH YET can change
  // (see the frontier rule in pump()). A non-speech gap (already excluded
  // from `elig`) simply ends the current run and starts a new one.
  function rebuildRuns() {
    const covered = new Set();
    for (const r of runs.values()) for (const g of r.groups) covered.add(gStart(g));
    let cur = null;
    for (const g of elig) {
      if (covered.has(gStart(g))) { cur = null; continue; } // never regroup an existing run
      // Gemini v1 is single-voice only: voiceForSpeaker is called with
      // multi=false so it always returns curVoice() regardless of g.spk —
      // OpenAI's per-speaker palette logic is untouched for the "openai" path.
      const v = conf.provider === "gemini"
        ? curVoice()
        : V().voiceForSpeaker(g.spk, conf.voice, conf.multi);
      const canJoin = cur && cur.voice === v && gStart(g) - cur.end < 1400 && (gEnd(g) - cur.start) <= 20000;
      if (canJoin) {
        cur.end = gEnd(g); cur.text += " " + (g.d || g.t[hooks.target]); cur.groups.push(g);
      } else {
        cur = { start: gStart(g), end: gEnd(g), text: (g.d || g.t[hooks.target]), voice: v, groups: [g] };
        runs.set(cur.start, cur);
      }
    }
    // Drop runs that scrolled far behind the playhead to bound memory.
    const t = hooks ? hooks.playhead() : 0;
    for (const [k, r] of runs) if (r.end < t - 60000) { runs.delete(k); buffers.delete(k); spoken.delete(k); resumable.delete(k); }
  }

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) =>
          resolve(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : r));
      } catch (e) { resolve({ error: String((e && e.message) || e) }); }
    });
  }
  function bufFromB64(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  // Every closed, translated sentence-group is one dub unit (one utterance).
  function eligibleGroups() {
    const seen = new Set(), out = [];
    for (const c of hooks.cues) {
      const g = c.grp;
      if (!g || seen.has(g)) continue;
      seen.add(g);
      if (g.closed && g.t[hooks.target] && !V().isNonSpeechCaption(g.orig)) out.push(g);
    }
    return out; // cues are sorted by startMs, so groups come out sorted too
  }

  // ── audio graph ──────────────────────────────────────────────────────────
  function ensureCtx() {
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = 0.9; // headroom: dub + ducked original must never sum past full scale
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -12; comp.knee.value = 20; comp.ratio.value = 6;
      comp.attack.value = 0.003; comp.release.value = 0.25;
      master.connect(comp);
      comp.connect(ctx.destination);
    }
    if (ctx.state === "suspended") {
      // Autoplay policy: resume() needs a real page gesture. The transport
      // button's click IS that gesture — ensureCtx() is called from its onclick
      // handler, so this resolves synchronously with the click most of the time.
      ctx.resume().catch(() => {});
    }
    return ctx;
  }

  // ── ducking (video.volume, site slider stays functional) ────────────────
  function setVol(v, x) {
    const clamped = Math.max(0, Math.min(1, x));
    lastSetVol = clamped;
    try { v.volume = clamped; } catch {}
  }
  function onVolumeChange(e) {
    // volumechange fires as an async task; its ordering vs a 0ms timer is not
    // guaranteed, so a timing-based "was this our write" flag can read stale.
    // Detect by value instead: if this echoes what we just wrote, ignore it.
    if (Math.abs(e.target.volume - lastSetVol) < 0.001) return;
    if (!ducked) return;
    // The user moved the SITE's slider while ducked: what they set IS the new
    // ducked level — re-derive the base so disabling restores what they expect.
    // At duck≈0 a user write can't be meaningfully inverted back to a base
    // (division blows up / loses information), so keep the previous base.
    baseVol = conf.duck > 0.01 ? Math.min(1, e.target.volume / conf.duck) : baseVol;
  }
  function bindVolEl(v) {
    if (v === volEl) return;
    if (volEl) {
      volEl.removeEventListener("volumechange", onVolumeChange);
      if (ducked) setVol(volEl, baseVol); // the old element un-ducks
    }
    volEl = v || null;
    if (volEl) {
      volEl.addEventListener("volumechange", onVolumeChange);
      if (ducked) setVol(volEl, baseVol * conf.duck); // keep the swapped-in one ducked
    }
  }
  function duck(on) {
    const v = hooks && hooks.getVideo();
    bindVolEl(v);
    if (!volEl) return;
    if (on && !ducked) { baseVol = volEl.volume; ducked = true; setVol(volEl, baseVol * conf.duck); }
    else if (!on && ducked) { ducked = false; setVol(volEl, baseVol); }
    else if (on && ducked) setVol(volEl, baseVol * conf.duck); // live duck-level change
  }

  // ── look-ahead pump: speech for the next ~60s, 2 in flight, 1 Hz ────────
  async function fetchOne(run, decode = true) {
    const k = run.start;
    pending.add(k);
    try {
      const txt = run.text;
      const resp = await send({
        type: "TTS", key: audioKey(run), text: txt,
        voice: run.voice,
        instructions: V().ttsInstructions(txt, hooks.target),
        durMs: spanMs(run), site: hooks.site, title: document.title, target: hooks.target,
      });
      if (resp && resp.b64) {
        // decode=false (full pre-generate) only warms the worker's cache — a
        // whole film decoded to Float32 would be hundreds of MB of RAM.
        if (decode && dubOn) {
          // Decode is split into its own try/catch: a rejection here (corrupt
          // cache entry, undecodable audio) must not be lumped in with a fetch
          // failure — it's the "TTS row shows ✓ but never plays" case, and the
          // decodeFails counter + this message is how that gets diagnosed.
          try {
            buffers.set(k, await ensureCtx().decodeAudioData(bufFromB64(resp.b64)));
            paintTransport(); // ahead-window % just changed
          } catch (de) {
            decodeFails++;
            console.warn("[SubVibe dub] decode failed:", de && de.message, "run", k);
          }
        }
      } else if (resp && resp.error) console.warn("[SubVibe dub] speech:", resp.error);
    } catch (e) { console.warn("[SubVibe dub] speech:", e && e.message); }
    finally { pending.delete(k); }
  }
  let pumpTicks = 0;
  function pump() {
    if (!dubOn || !hooks || (hooks.live && hooks.live())) return;
    elig = eligibleGroups();
    rebuildRuns();
    pumpTicks++;
    if (pumpTicks % 5 === 0) refreshCoverage(); // paints internally, even on failure
    // Cheap safety net: painting is a string assignment, so an unconditional
    // 1 Hz repaint can never be the bottleneck — it catches any state change
    // (buffers filling, aheadPct shifting) that a targeted call site missed.
    paintTransport();
    if (transportPaused) return; // hard gate: no TTS requests until the user clicks
    const v = hooks.getVideo();
    if (!v || v.ended) return;
    if (v.paused && !(v.currentTime > 0.5)) return; // never spend on a video never started
    const t = hooks.playhead();
    for (const k of buffers.keys()) if (k < t - 30000 || k > t + 90000) buffers.delete(k); // bound RAM
    if (pending.size >= 2) return;
    const sortedRuns = [...runs.values()].sort((a, b) => a.start - b.start);
    for (const run of sortedRuns) {
      const s = run.start;
      if (s < t - 2000) continue;
      if (s > t + 60000) break;
      if (buffers.has(s) || pending.has(s)) continue;
      // Frontier stability: a run at the growing edge of `elig` may still gain
      // more groups on a later pump tick — fetching it now would ship partial
      // text. Only fetch once a later eligible group proves the run is closed,
      // OR the run is due soon enough that waiting risks missing playback.
      const hasLater = elig.some((g) => gStart(g) > run.end);
      if (!hasLater && run.end >= t + 15000) continue;
      fetchOne(run);
      if (pending.size >= 2) break;
    }
  }

  // ── playback ────────────────────────────────────────────────────────────
  function stopOne(k, p, fadeMs) {
    playing.delete(k);
    // Every call site left here (after Step 2 removes the fade-on-next-start
    // path) is an INTERRUPTION — seek, pause, transport toggle, disable — never
    // a natural end (that's src.onended below). Mark the run as heard-but-cut-
    // short so a seek landing back inside it resumes mid-clip instead of
    // restarting from 0 (which would replay audio already heard).
    resumable.add(k);
    try {
      if (fadeMs && ctx) {
        p.gain.gain.cancelScheduledValues(ctx.currentTime); // clear any pending micro-fade ramp first
        p.gain.gain.setTargetAtTime(0, ctx.currentTime, fadeMs / 3000);
        p.src.stop(ctx.currentTime + fadeMs / 1000);
      } else p.src.stop();
    } catch {}
    if (!playing.size) nowText = null;
  }
  function stopAll(fadeMs) { for (const [k, p] of [...playing]) stopOne(k, p, fadeMs); }

  // Returns true iff a clip was actually started. R2 in loop() needs this: a
  // rejected resume (seek landed past the buffer's own tail — a short, near-
  // exhausted resumable clip) must still free up the candidate — mark it
  // spoken and move on to the next run in the SAME frame — instead of retrying
  // the identical, always-rejecting call every frame until R3's 5s staleness
  // clock happens to catch up (a multi-second stall of the whole dub track).
  function startClip(run, s, buf, t, lag, v) {
    const c = ensureCtx();
    if (c.state === "suspended") return false; // transport paused — don't queue silent sources
    const voice = run.voice;
    // Rate: fit/catch-up logic picks the speed needed to stay in sync with the
    // cue, capped so it never chipmunks. conf.pace (user's speech-pace setting,
    // 0.9-1.3, default 1) multiplies OUTSIDE that cap — a user-chosen pace is
    // an intentional, uncapped choice, not something the catch-up logic should
    // clamp.
    // R4 catch-up: starting > 1.5s late allows a higher cap (1.25, still below
    // chipmunk) so the lag shrinks over the next few lines; otherwise 1.1×.
    // (Was 2.5s — condensed dub scripts (Task 16) hold ratio ~1.0, so catch-up
    // now engages sooner to converge before lag can sawtooth.)
    // Gap-aware pacing (Task 19): if the silence between upcoming runs in the
    // next 45s can swallow the current lag on its own (+1s grace), there is no
    // need to speed up to chipmunk-adjacent 1.25× — natural-ish 1.1× plays out
    // and the gap ahead absorbs the difference, official-interpreter style.
    const slack = slackAhead(run.start);
    const absorbable = lag <= slack + 1000;
    const maxRate = absorbable ? 1.1 : (lag > 1500 ? 1.25 : 1.1);
    const fit = (buf.duration * 1000) / spanMs(run);
    const rate = (fit <= 1.08 ? 1 : Math.min(maxRate, fit)) * conf.pace * (v.playbackRate || 1);
    // Flow mode speaks the WHOLE line on a late start — that is the point of
    // voice-over scheduling, so offset stays 0 for every fresh/overdue start.
    // The only case that resumes mid-clip is a seek landing back inside a run
    // that was already partially heard before the interruption (`resumable`);
    // for a run never heard yet, offset math does not apply at all.
    const offset = resumable.has(s) ? (t - s) / 1000 * rate : 0;
    // Reject FIRST: a rejected start (playhead already past the buffer's tail)
    // must bail before touching any currently-playing clip.
    if (offset >= buf.duration - 0.05) return false;
    // Flow mode only ever starts a clip when idle (playing.size === 0 is
    // enforced by loop()'s caller) — this loop is a guarded safety net, not a
    // live path: normal scheduling never reaches it with playing non-empty.
    for (const [k, p] of [...playing]) stopOne(k, p, 120);
    const src = c.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const gain = c.createGain();
    src.connect(gain);
    gain.connect(master);
    // Micro-fades: mp3 decode can open with a click, and a natural end can step —
    // ramp in fast and taper the tail out just before it ends.
    const now = c.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(1, now + 0.02);
    const wallDur = (buf.duration - Math.max(0, offset)) / rate;
    if (wallDur > 0.2) gain.gain.setTargetAtTime(0, now + wallDur - 0.06, 0.025);
    const p = { src, gain, voice };
    playing.set(s, p);
    spoken.add(s);        // this run is now underway — R2 must not pick it again this pass
    resumable.delete(s);  // consumed: mid-clip resume was for this one start only
    nowText = run.text;
    src.onended = () => { if (playing.get(s) === p) { playing.delete(s); if (!playing.size) nowText = null; } };
    src.start(0, Math.max(0, offset));
    return true;
  }

  // ── consent-gated transport button ──────────────────────────────────────
  // Coverage snapshot (like status() computes for the popup, but kept local so
  // painting the button doesn't need a round trip through the popup).
  async function refreshCoverage() {
    if (!hooks) return;
    // Bulletproof: an {error} reply, a missing/malformed `keys` array, or a
    // throwing reduce must never leave lastPct/lastRemainUSD unset or leave
    // this promise rejected — a swallowed failure here is how the button gets
    // stuck forever (the "▶ Start dub (~$NaN)" report). Always repaint at the end.
    try {
      const totalMs = elig.reduce((a, g) => a + gSpanMs(g), 0);
      let cachedMs = 0;
      const r = await send({ type: "AUDIO_KEYS", prefix: `${hooks.base}:dub:${vcfg()}#` });
      const keys = (r && r.keys) || [];
      cachedMs = keys.reduce((a, k) => a + (k.ms || 0), 0);
      lastPct = totalMs ? Math.min(1, cachedMs / totalMs) : 0;
      lastRemainUSD = estUSD(Math.max(0, totalMs - cachedMs));
    } catch (e) {
      console.warn("[SubVibe dub] refreshCoverage:", e && e.message);
      // Leave last known-good lastPct/lastRemainUSD in place rather than
      // resetting to 0/NaN — a transient failure shouldn't erase a real number.
    } finally {
      paintTransport();
    }
  }

  function paintTransport() {
    const overlay = document.getElementById("copilot-subs");
    if (!dubOn || !hooks) { if (dubctlEl) { dubctlEl.remove(); dubctlEl = null; } return; }
    if (!overlay) return;
    if (!dubctlEl) {
      dubctlEl = document.createElement("button");
      dubctlEl.className = "copilot-subs__dubctl";
      dubctlEl.onclick = onTransportClick;
      overlay.appendChild(dubctlEl);
    }
    // A number that isn't known yet (or came back non-finite) renders as
    // "(~$…)", never "(~$NaN)".
    const usd = Number.isFinite(lastRemainUSD) ? lastRemainUSD.toFixed(2) : "…";
    const pct = Math.round((Number.isFinite(lastPct) ? lastPct : 0) * 100);
    let label;
    if (!transportPaused) label = `⏸ dub · ${Math.round(aheadPct() * 100)}% ready`;
    else if (lastPct > 0) label = `▶ dub · ${pct}% cached (~$${usd} more)`;
    else label = `▶ Start dub (~$${usd})`;
    dubctlEl.textContent = label;
  }

  function onTransportClick() {
    transportPaused = !transportPaused;
    if (!transportPaused) { ensureCtx(); duck(true); }
    else { stopAll(150); duck(false); }
    paintTransport();
  }

  // How many upcoming clips (within the next ~60s window) are already decoded
  // and ready to play right now — the badge's dub-readiness counter.
  function readyAhead() {
    if (!hooks || !dubOn) return 0;
    const t = hooks.playhead();
    let n = 0;
    for (const run of [...runs.values()].sort((a, b) => a.start - b.start)) {
      const s = run.start;
      if (s > t + 60000) break;
      if (s >= t - 500 && buffers.has(s)) n++;
    }
    return n;
  }

  // % of the NEXT 60s of speech that is already decoded — the "can I keep
  // watching without gaps" number. Whole-video percent lives in the popup.
  function aheadPct() {
    if (!hooks || !dubOn) return 0;
    const t = hooks.playhead();
    let total = 0, ready = 0;
    for (const r of [...runs.values()].sort((a, b) => a.start - b.start)) {
      if (r.end < t) continue;
      if (r.start > t + 60000) break;
      const span = Math.min(r.end, t + 60000) - Math.max(r.start, t);
      total += span;
      if (buffers.has(r.start)) ready += span;
    }
    return total ? ready / total : (buffers.size ? 1 : 0);
  }

  function loop() {
    raf = requestAnimationFrame(loop);
    if (!dubOn || !hooks) return;
    // If the AudioContext is found suspended while we supposedly aren't paused,
    // the resume silently failed (or never happened) — flip back to paused so
    // the button honestly asks for the one click it needs, instead of quietly
    // doing nothing forever.
    if (ctx && ctx.state === "suspended" && !transportPaused) { transportPaused = true; paintTransport(); }
    const v = hooks.getVideo();
    if (!v) return;
    if (transportPaused) { duck(false); if (playing.size) stopAll(0); return; } // hard gate: no clip starts while paused
    duck(true); // re-assert each frame: element swaps, late loads
    if (v.paused || v.ended) { if (playing.size) stopAll(50); lastT = hooks.playhead(); return; }
    const t = hooks.playhead();
    if (lastT >= 0 && Math.abs(t - lastT) > 1500) {
      stopAll(60); // seek — kill mid-air clips softly
      // Clear `spoken`/`resumable` for runs INSIDE the neighborhood the user
      // just landed in — a run they seeked back INTO (or land right next to)
      // must lose its "already spoken" flag so R2 can pick it again and it
      // actually replays/resumes. Runs far outside the neighborhood are left
      // alone: they're nowhere near the new playhead, so their old spoken
      // state is moot until rebuildRuns()'s own >60s-behind eviction (or a
      // later seek back near them) makes it relevant again.
      const lo = t - 5000, hi = t + 90000;
      for (const k of [...spoken]) if (k >= lo && k <= hi) spoken.delete(k);
      for (const k of [...resumable]) if (k >= lo && k <= hi) resumable.delete(k);
    }
    lastT = t;
    // Voice-over ("lektor") scheduling: speech flows continuously, slightly
    // behind the subtitles, instead of being chained to timestamps.
    //  R1 never cut a clip because the next is due — a clip ends naturally
    //     (onended) or is stopped only by an interruption (seek/pause/toggle).
    //  R2 when nothing is playing, start the earliest buffered, startable,
    //     non-stale, not-yet-spoken-this-pass run — runs become startable at
    //     run.start - 150ms.
    //  R3 staleness (recovery-aware, Task 19): drop a line only when it is
    //     unrecoverable — either outright >10s late, or the playhead is past
    //     its end AND we are >5s late AND the gaps ahead can't claw the excess
    //     back. Otherwise keep it queued; it still gets spoken late, at
    //     catch-up pace — the official-interpreter rule: skip only as a last
    //     resort, never as the default response to lag.
    //  R4 catch-up: startClip applies the >1.5s-late rate cap.
    if (playing.size === 0) {
      const candidates = [...runs.values()].sort((a, b) => a.start - b.start);
      for (const run of candidates) {
        const s = run.start;
        if (spoken.has(s)) continue;
        const lagNow = t - run.start;
        const unrecoverable = lagNow > 10000 ||
          (t > run.end && lagNow > 5000 && slackAhead(run.start) < (lagNow - 5000));
        if (unrecoverable) { spoken.add(s); continue; } // gone — try the next candidate, don't stop here
        if (!(s - 150 <= t)) break;              // sorted by start: nothing earlier is startable either
        if (!buffers.has(s)) continue;           // not buffered yet — wait for it, don't skip ahead
        const buf = buffers.get(s);
        const lag = Math.max(0, t - run.start);
        if (startClip(run, s, buf, t, lag, v)) break; // one start per idle frame — playing.size is now > 0
        // Rejected (offset already past the buffer's tail, e.g. a near-
        // exhausted resumable clip): free the candidate and keep scanning
        // instead of retrying the same doomed run every frame.
        spoken.add(s);
      }
    }
  }

  // ── enable/disable + lifecycle ──────────────────────────────────────────
  function setDubOn(on) {
    dubOn = !!on;
    if (dubOn) {
      if (hooks && !transportPaused) { ensureCtx(); duck(true); }
      if (!pumpIv) pumpIv = setInterval(pump, 1000);
      if (!raf) raf = requestAnimationFrame(loop);
      paintTransport();
    } else {
      stopAll(0);
      duck(false);
      if (dubctlEl) { dubctlEl.remove(); dubctlEl = null; }
      clearInterval(pumpIv); pumpIv = 0;
      cancelAnimationFrame(raf); raf = 0;
      lastT = -1;
    }
  }

  function attach(h) {
    hooks = h;
    buffers.clear(); pending.clear(); elig = []; runs.clear();
    stopAll(0);
    spoken.clear(); resumable.clear(); // fresh attach: no run has played yet, nothing is mid-clip
    lastT = -1;
    // A fresh video must not spend a cent until the user clicks the transport
    // button; a video with any cached dub audio auto-starts (replay is free).
    transportPaused = true;
    elig = eligibleGroups();
    paintTransport(); // show the paused button immediately; refreshed below once coverage is known
    refreshCoverage().then(() => {
      if (lastPct > 0) {
        transportPaused = false;
        if (dubOn) { ensureCtx(); duck(true); } // auto-start: create/resume the ctx now coverage is known
      }
      paintTransport();
    });
    if (dubOn) {
      if (!pumpIv) pumpIv = setInterval(pump, 1000);
      if (!raf) raf = requestAnimationFrame(loop);
    }
  }
  function detach() {
    stopAll(0);
    if (ducked && volEl) { ducked = false; setVol(volEl, baseVol); }
    bindVolEl(null);
    if (dubctlEl) { dubctlEl.remove(); dubctlEl = null; }
    hooks = null;
    buffers.clear(); pending.clear(); elig = []; runs.clear();
    spoken.clear(); resumable.clear();
  }

  // ── status for the popup ────────────────────────────────────────────────
  async function status() {
    if (!hooks) return { attached: false, enabled: dubOn };
    const live = !!(hooks.live && hooks.live());
    const groups = eligibleGroups();
    const totalMs = groups.reduce((a, g) => a + gSpanMs(g), 0);
    let cachedMs = 0;
    const r = await send({ type: "AUDIO_KEYS", prefix: `${hooks.base}:dub:${vcfg()}#` });
    if (r && r.keys) cachedMs = r.keys.reduce((a, k) => a + (k.ms || 0), 0);
    return {
      attached: true, enabled: dubOn, live,
      groups: groups.length, totalMs, cachedMs,
      cachedPct: totalMs ? Math.min(1, cachedMs / totalMs) : 0,
      estRemainingUSD: estUSD(Math.max(0, totalMs - cachedMs)),
      generating: genAll ? { phase: genAll.phase, total: genAll.total, done: genAll.done } : null,
      lastError: genErr,
      nowText,
      // Playback diagnostics — surfaced so "generation healthy, playback silent"
      // (TTS rows all ✓, ducking works, zero dub audio) is observable without a
      // debugger: ctxState catches an autoplay-suspended context, buffersCount
      // near 0 with decodeFails > 0 catches swallowed decode rejections,
      // playingCount stuck at 0 while buffersCount > 0 catches a scheduling bug.
      ctxState: ctx ? ctx.state : null,
      playingCount: playing.size,
      buffersCount: buffers.size,
      decodeFails,
    };
  }

  // Generate the WHOLE video's dub up front (the popup shows the estimate and
  // the user explicitly clicked): first translate every still-untranslated
  // sentence group, then request speech for every group. Speech requests use
  // decode=false — they warm the worker's cache; playback decodes on demand.
  async function generateAll() {
    if (!hooks || genAll || (hooks.live && hooks.live())) return;
    const all = [];
    const seen = new Set();
    for (const c of hooks.cues) {
      const g = c.grp;
      if (g && g.closed && !seen.has(g)) { seen.add(g); all.push(g); }
    }
    const untranslated = all.filter((g) => !g.t[hooks.target]);
    genAll = { phase: "translating", total: untranslated.length, done: 0, cancelled: false };
    genErr = null;
    try {
      for (let i = 0; i < untranslated.length && !genAll.cancelled; i += 40) {
        const batch = untranslated.slice(i, i + 40);
        const resp = await send({ type: "TRANSLATE", cues: batch.map((g) => g.orig), source: "auto", target: hooks.target, site: hooks.site, title: document.title });
        if (!resp || resp.error || !resp.lines) {
          genErr = (resp && resp.error) || "translation failed";
          console.warn("[SubVibe dub] generate:", genErr);
          return; // status() stops reporting "generating"; the pump keeps working incrementally
        }
        batch.forEach((g, k) => {
          if (!resp.lines[k]) return;
          g.t[hooks.target] = resp.lines[k];
          g.spk = { id: (resp.spk && resp.spk[k]) || 0, g: (resp.gen && resp.gen[k]) || "?" };
          g.d = (resp.dub && resp.dub[k]) || null; // condensed dub rendition (rebuildRuns falls back to g.t when null)
          for (const cc of g.cues) { cc.t[hooks.target] = resp.lines[k]; cc.spk = g.spk; }
        });
        genAll.done += batch.length;
        if (hooks.persist) hooks.persist();
      }
      if (genAll.cancelled) return;
      // All groups are translated now, so rebuilding runs here is final — no
      // group arrives later to reshape one of these runs (unlike the pump's
      // incremental frontier, which must wait for that possibility).
      elig = eligibleGroups();
      rebuildRuns();
      const ready = [...runs.values()].sort((a, b) => a.start - b.start);
      genAll = { phase: "speaking", total: ready.length, done: 0, cancelled: false };
      for (const run of ready) {
        if (genAll.cancelled) break;
        if (!buffers.has(run.start)) await fetchOne(run, false); // cached rows return instantly, free
        genAll.done++;
      }
    } finally { genAll = null; }
  }
  function cancelGenerate() { if (genAll) genAll.cancelled = true; }

  // ── settings + messages ─────────────────────────────────────────────────
  chrome.storage.local.get(["dubEnabled", "dubVoice", "dubGeminiVoice", "ttsProvider", "dubMultiVoice", "dubDuckLevel", "dubPace"]).then((s) => {
    conf.voice = s.dubVoice || conf.voice;
    conf.geminiVoice = s.dubGeminiVoice || conf.geminiVoice;
    conf.provider = s.ttsProvider === "gemini" ? "gemini" : "openai";
    conf.multi = !!s.dubMultiVoice;
    if (typeof s.dubDuckLevel === "number") conf.duck = s.dubDuckLevel;
    if (typeof s.dubPace === "number") conf.pace = s.dubPace;
    if (s.dubEnabled) setDubOn(true);
  }).catch(() => {});

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    if (ch.dubVoice || ch.dubGeminiVoice || ch.ttsProvider || ch.dubMultiVoice) {
      if (ch.dubVoice) conf.voice = ch.dubVoice.newValue || "marin";
      if (ch.dubGeminiVoice) conf.geminiVoice = ch.dubGeminiVoice.newValue || "Kore";
      if (ch.ttsProvider) conf.provider = ch.ttsProvider.newValue === "gemini" ? "gemini" : "openai";
      if (ch.dubMultiVoice) conf.multi = !!ch.dubMultiVoice.newValue;
      buffers.clear(); runs.clear(); // a different voice config is a different cache namespace; old runs' baked-in voice is stale too
      spoken.clear(); resumable.clear(); // runs.clear() means rebuildRuns() will recreate the same start-keys — don't let stale spoken/resumable block their replay
    }
    if (ch.dubDuckLevel) {
      conf.duck = typeof ch.dubDuckLevel.newValue === "number" ? ch.dubDuckLevel.newValue : 0.12;
      if (ducked) duck(true);
    }
    if (ch.dubPace) {
      conf.pace = typeof ch.dubPace.newValue === "number" ? ch.dubPace.newValue : 1;
    }
    if (ch.dubEnabled) setDubOn(!!ch.dubEnabled.newValue);
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === "DUB_STATUS") { status().then(sendResponse); return true; }
    if (msg.type === "DUB_GENERATE_ALL") { generateAll(); sendResponse({ ok: true }); return; }
    if (msg.type === "DUB_CANCEL") { cancelGenerate(); sendResponse({ ok: true }); return; }
  });

  window.__svDub = { attach, detach, status, generateAll: () => generateAll(), cancelGenerate, readyAhead };
})();

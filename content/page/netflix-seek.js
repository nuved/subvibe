// Netflix (MAIN world): the <video> element must not be seeked or re-timed directly —
// Netflix's player takes that as a broken session (error M7375). This tiny helper
// runs in the page world and drives Netflix's own player API instead; the
// extension's content script asks it via window.postMessage.
(() => {
  if (window.__svNetflixSeek) return; window.__svNetflixSeek = true;
  const player = () => {
    try {
      const vp = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
      const ids = vp.getAllPlayerSessionIds() || [];
      const id = ids.find((s) => String(s).startsWith("watch-")) || ids[0];
      return id ? vp.getVideoPlayerBySessionId(id) : null;
    } catch (e) { return null; }
  };
  // Netflix's own words about what is playing: the member API's metadata
  // (show, season/episode, titles, synopses); the player's title block is the fallback.
  const netflixMeta = async (id) => {
    const out = { site: "netflix", url: location.href, title: "", show: "", season: 0, episode: 0, epTitle: "", synopsis: "", year: 0, runtimeMin: 0 };
    let why = ""; // why the member API gave nothing — logged so a failing route can be reported
    try {
      // The page's own service table names the member API base ("/nq/website/memberapi/release" on
      // 2026-09-03); the build-id path answered 502 and /api/metadata 404 — verified in the operator's tab.
      const m = window.netflix.reactContext.models;
      const svc = m.services && m.services.data && m.services.data.memberapi;
      const root = svc && Array.isArray(svc.path) && svc.path[0] ? (svc.protocol && svc.hostname ? svc.protocol + "://" + svc.hostname : "") + svc.path[0] : "/nq/website/memberapi/release";
      const r = await fetch(root + "/metadata?movieid=" + encodeURIComponent(id) + "&_=" + Date.now(), { credentials: "include" });
      if (!r.ok) throw new Error("HTTP " + r.status + " from " + root);
      const j = await r.json(); const v = j.video || {};
      if (!v.title) throw new Error("no video in the answer (keys: " + Object.keys(j).slice(0, 8).join(",") + ")");
      const art = (a) => (Array.isArray(a) && a[0] && a[0].url) || (a && a.url) || "";
      out.poster = art(v.boxart) || art(v.storyart) || "";
      if (v.type === "show") {
        out.show = v.title || ""; out.year = v.year || 0; out.synopsis = v.synopsis || "";
        for (const s of v.seasons || []) for (const e of s.episodes || []) if (String(e.id) === String(v.currentEpisode || id)) { out.season = s.seq || 0; out.episode = e.seq || 0; out.epTitle = e.title || ""; out.synopsis = e.synopsis || out.synopsis; out.runtimeMin = Math.round((e.runtime || 0) / 60); }
      } else { out.title = v.title || ""; out.year = v.year || 0; out.synopsis = v.synopsis || ""; out.runtimeMin = Math.round((v.runtime || 0) / 60); }
    } catch (e) { why = String((e && e.message) || e); }
    if (why) console.info("[SubVibe] Netflix metadata: " + why + (out.show || out.title ? "" : " — using the player's title block"));
    if (!out.show && !out.title) { // the player's title block (visible with the controls) — a partial identity, upgraded later
      out.partial = true;
      try {
        const t = document.querySelector('[data-uia="video-title"]');
        if (t) { const h = t.querySelector("h4"); const sp = [...t.querySelectorAll("span")].map((x) => x.textContent.trim()).filter(Boolean); if (h) { out.show = h.textContent.trim(); const m = (sp[0] || "").match(/E(\d+)/i); if (m) out.episode = +m[1]; out.epTitle = sp[1] || ""; } else out.title = t.textContent.trim(); }
      } catch (e) {}
    }
    return out;
  };
  window.addEventListener("message", (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__sv !== "netflix") return;
    const p = player(); const d = ev.data;
    // The board asks once per video for the site's identity; the answer goes back as META.
    if (d.op === "meta") { netflixMeta(d.id).then((meta) => window.postMessage({ __sv: "netflix", type: "META", id: d.id, meta }, "*")); return; }
    try {
      if (d.op === "seek" && p && typeof p.seek === "function") p.seek(Math.max(0, Math.round(d.ms)));
      else if (d.op === "play" && p && typeof p.play === "function") p.play();
      else if (d.op === "pause" && p && typeof p.pause === "function") p.pause();
      else if (d.op === "rate" && p && typeof p.setPlaybackRate === "function") p.setPlaybackRate(d.rate);
      else if (d.op === "rate") { const v = document.querySelector("video"); if (v) v.playbackRate = d.rate; }
    } catch (e) {}
  });
})();

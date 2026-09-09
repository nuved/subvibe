// X (x.com, formerly twitter.com) site adapter — a STREAMING source.
//
// X's player is plain HLS into a <video> (no DRM). When the poster uploaded
// captions, the player attaches a <track src="data:,WEBVTT"> and fills it with
// cues as the subtitle segments arrive — so the cue list is readable IN the page:
// the engine's upgrade poll (readVideoCueList) adopts the whole track for perfect
// sync + pre-translation, and until it holds more than a few cues we read the
// active cue live, DW-style. The subtitle segments are fetched by a worker, so
// the Resource Timing sniffer never sees a file URL here — the track is the source.
//
// Scope: a POST page (/<user>/status/<id>, its media viewer /…/video/1, or
// /i/status/<id>). The home timeline autoplays every video muted while you
// scroll — running there would translate clips nobody chose to watch.
//
// Requirement: the post must carry captions (X accepts an .srt at upload). A
// video without them has no text to translate — the audio fallback still applies.

(function () {
  const HOST = /(^|\.)(x\.com|twitter\.com)$/;
  const statusId = () => { const m = location.pathname.match(/\/status\/(\d+)/); return m ? m[1] : null; };
  const area = (v) => v.clientWidth * v.clientHeight;
  const onScreen = (v) => { const r = v.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 40 && r.top < innerHeight - 40; };
  // The article's own status id: its first /status/ link is the post's timestamp.
  const articleId = (el) => { const a = el && el.querySelector('a[href*="/status/"]'); const m = a && a.getAttribute("href").match(/\/status\/(\d+)/); return m ? m[1] : null; };

  // The clip the user actually started. Replies below the post autoplay muted as
  // they scroll into view; a "largest playing" rule would jump to them.
  let lastPlayed = null;
  document.addEventListener("play", (e) => { if (e.target && e.target.tagName === "VIDEO") lastPlayed = e.target; }, true);

  function pickVideo() {
    const id = statusId();
    const vids = [...document.querySelectorAll("video")].filter((v) => area(v) > 0);
    if (!vids.length) return document.querySelector("video");
    // The media viewer (a dialog over the page) holds the post's video outside any article.
    const viewer = vids.find((v) => !v.closest("article") && v.closest('[role="dialog"], [aria-modal="true"]'));
    if (viewer && onScreen(viewer)) return viewer;
    // The post's own video, while it is on screen (paused or playing).
    const own = id && vids.find((v) => articleId(v.closest("article")) === id);
    if (own && onScreen(own)) return own;
    if (lastPlayed && lastPlayed.isConnected && area(lastPlayed) > 0 && onScreen(lastPlayed)) return lastPlayed;
    const playing = vids.filter((v) => !v.paused && (v.currentTime || 0) > 0 && onScreen(v));
    if (playing.length) return playing.sort((a, b) => area(b) - area(a))[0];
    return own || viewer || vids.sort((a, b) => area(b) - area(a))[0];
  }

  const adapter = {
    site: "x",
    stream: true, // live active-cue read until the track holds enough cues to adopt whole

    matches() {
      return HOST.test(location.hostname) && !!statusId();
    },

    // The post's id — a reply's video (scrolled into view under the post) keys by
    // its own article so its lines never cache under the post.
    getVideoId() {
      const v = pickVideo();
      const a = v && v.closest("article");
      return (a && articleId(a)) || statusId();
    },

    // The URL keys the clip: the post page, its media viewer and /i/status/<id>
    // are one clip, so the cache and per-clip settings agree across all three.
    clipId() { const id = statusId(); return id ? "/status/" + id : location.pathname; },

    getVideoEl() { return pickVideo(); },

    // The nearest positioned ancestor that is the video's own size — X wraps the
    // <video> in a stack of unlabelled divs; the overlay must sit inside the box
    // that moves and resizes with the picture, not in a page-wide column.
    getPlayerContainer() {
      const v = pickVideo();
      if (!v) return document.body;
      const tagged = v.closest('[data-testid="videoComponent"], [data-testid="videoPlayer"]');
      if (tagged) return tagged;
      const vr = v.getBoundingClientRect();
      let el = v.parentElement, best = null;
      for (let i = 0; i < 8 && el && el !== document.body; i++, el = el.parentElement) {
        const r = el.getBoundingClientRect();
        if (Math.abs(r.width - vr.width) > 6 || Math.abs(r.height - vr.height) > 6) break;
        if (getComputedStyle(el).position !== "static") best = el;
      }
      return best || v.parentElement || document.body;
    },

    // The caption X is showing now — read from the video's own text track (the
    // cues live in the page). "hidden" loads the cues without drawing them.
    readNativeText() {
      const v = pickVideo();
      if (!v || !v.textTracks) return "";
      let out = "";
      for (let i = 0; i < v.textTracks.length; i++) {
        const tt = v.textTracks[i];
        if (tt.kind && tt.kind !== "subtitles" && tt.kind !== "captions") continue;
        if (tt.mode === "disabled") { try { tt.mode = "hidden"; } catch (e) {} continue; }
        const cues = tt.activeCues;
        if (cues) for (let j = 0; j < cues.length; j++) out += (cues[j].text || "") + " ";
      }
      return out.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    },

    // Who posted and what they wrote — the board's identity line and the model's
    // reading of the clip come from this (there is no title on X).
    getMeta() {
      const v = pickVideo();
      const id = statusId();
      const art = (v && v.closest("article")) || [...document.querySelectorAll("article")].find((a) => articleId(a) === id) || document.querySelector("article");
      const q = (sel) => (art && art.querySelector(sel)) || null;
      const txt = (el) => ((el && el.innerText) || "").replace(/\s+/g, " ").trim();
      // Signed in, the text block is tagged; signed out it is the first dir="auto" block with words.
      const tweetText = txt(q('[data-testid="tweetText"]')) || txt([...((art && art.querySelectorAll('div[dir="auto"]')) || [])].find((d) => txt(d).length > 1 && !d.querySelector("video")));
      // The author's links: "/NASA" (or "https://x.com/NASA") with the display name as text, and one whose text is "@NASA".
      const profile = /^(?:https?:\/\/(?:x|twitter)\.com)?\/([A-Za-z0-9_]{1,20})\/?$/;
      const links = [...((art && art.querySelectorAll("a[href]")) || [])];
      const handleLink = links.find((a) => /^@[A-Za-z0-9_]+$/.test(txt(a)));
      const nameLink = links.find((a) => profile.test(a.getAttribute("href") || "") && txt(a) && !/^@/.test(txt(a)));
      const m = (handleLink || nameLink) && profile.exec((handleLink || nameLink).getAttribute("href") || "");
      const handle = handleLink ? txt(handleLink).slice(1) : (m ? m[1] : "");
      const name = txt(nameLink).split(/\s{2,}|·/)[0].trim();
      const who = name && handle ? `${name} (@${handle})` : name || (handle ? "@" + handle : "");
      const avatar = q('img[src*="profile_images"]');
      return Promise.resolve({
        site: "x", url: location.href,
        title: [who, tweetText.slice(0, 140)].filter(Boolean).join(": ") || document.title,
        channel: who, description: tweetText.slice(0, 1500),
        poster: avatar ? avatar.src.replace(/_(normal|bigger|x96)\./, "_400x400.") : "", // the 48 px avatar the post shows, at the size the strip draws it
      });
    },

    // X navigates by pushState: no event reaches us, so the URL is watched.
    onNavigate(cb) {
      let last = location.href;
      window.addEventListener("popstate", cb);
      setInterval(() => { if (location.href !== last) { last = location.href; cb(); } }, 500);
    },
  };

  (window.__copilotAdapters = window.__copilotAdapters || []).push(adapter);
})();

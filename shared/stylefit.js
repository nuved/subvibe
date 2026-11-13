// shared/stylefit.js — reads one frame of the playing video and names the subtitle
// preset and karaoke highlight that suit it, with the reason in plain words.
// Pure: RGBA pixels in, a suggestion out. No chrome.*, no DOM, so
// tools/tests/stylefit.test.mjs runs it in node on synthetic frames.
//
// What it looks at: the bottom band (62–95% of the height), where the subtitles sit,
// for brightness and busyness, and the whole frame's dominant colour for the highlight.
(function (g) {
  "use strict";

  const lum = (r, gg, b) => (0.299 * r + 0.587 * gg + 0.114 * b) / 255;

  function hueSat(r, gg, b) {
    r /= 255; gg /= 255; b /= 255;
    const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), d = mx - mn;
    if (d < 1e-6) return [0, 0];
    let h = mx === r ? ((gg - b) / d) % 6 : mx === gg ? (b - r) / d + 2 : (r - gg) / d + 4;
    h *= 60; if (h < 0) h += 360;
    return [h, mx === 0 ? 0 : d / mx];
  }

  // frame: { data: RGBA bytes, w, h }. Returns the numbers the rules use.
  // Black bars baked into the picture (a wide film inside 16:9) are not the scene:
  // the rows between the first and last lit row are.
  function litRows(data, w, h) {
    const rowL = (y) => { let s = 0; for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; s += lum(data[i], data[i + 1], data[i + 2]); } return s / w; };
    let top = 0, bot = h - 1;
    while (top < h - 1 && rowL(top) < 0.035) top++;
    while (bot > top && rowL(bot) < 0.035) bot--;
    return bot - top < h * 0.3 ? [0, h - 1] : [top, bot]; // a dark scene, not bars: keep it all
  }

  function measure(frame) {
    const { data, w, h } = frame;
    const [top, bot] = litRows(data, w, h), lh = bot - top + 1;
    const y0 = top + Math.floor(lh * 0.62), y1 = Math.max(y0 + 1, top + Math.floor(lh * 0.95));
    let s = 0, s2 = 0, n = 0, edge = 0, en = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4, l = lum(data[i], data[i + 1], data[i + 2]);
        s += l; s2 += l * l; n++;
        if (x > 0) { const j = i - 4; edge += Math.abs(l - lum(data[j], data[j + 1], data[j + 2])); en++; }
      }
    }
    const bandL = s / n, bandStd = Math.sqrt(Math.max(0, s2 / n - bandL * bandL)), busy = en ? edge / en : 0;
    // Whole frame: brightness spread (a protected video captures as flat black) and a
    // saturation-weighted mean hue on the colour circle.
    let fs = 0, fs2 = 0, fn = 0, hx = 0, hy = 0, sw = 0;
    for (let i = 0; i < w * h * 4; i += 4) {
      const l = lum(data[i], data[i + 1], data[i + 2]); fs += l; fs2 += l * l; fn++;
      const [hu, sa] = hueSat(data[i], data[i + 1], data[i + 2]);
      const wgt = sa * Math.min(1, l * 3); // dark pixels carry no real colour
      hx += Math.cos(hu * Math.PI / 180) * wgt; hy += Math.sin(hu * Math.PI / 180) * wgt; sw += wgt;
    }
    const frameL = fs / fn, frameStd = Math.sqrt(Math.max(0, fs2 / fn - frameL * frameL));
    let hue = Math.atan2(hy, hx) * 180 / Math.PI; if (hue < 0) hue += 360;
    const colour = sw / fn; // 0 = grey footage, ~0.5+ = strongly coloured
    return { bandL, bandStd, busy, frameL, frameStd, hue, colour, portrait: h > w * 1.1, burned: burnedCaption(data, w, top, bot) };
  }

  // Captions written into the picture itself: a white (or black) bar with letters,
  // low on the frame. Measured on a real YouTube lesson (2026-11-13) at 320 px:
  // the bar's plain rows are ≥85% one extreme; its letter rows are ~40% that
  // extreme with ≥10% of the other and dense sharp edges. A bar is a run of such
  // rows (gaps of ≤3 rows allowed) ≥4% of the height in the bottom 35%, holding
  // at least two plain rows and two letter rows. Needs ≥240 px of width to see letters.
  // Second kind (operator screenshot 2026-11-13, an English podcast): big white
  // letters with a black outline straight on the picture, no bar. Its rows are
  // 15-57% white, 14-35% black and 24-38% sharp edges; a run of ≥4 such rows
  // (≥5% of the height) counts. Both kinds are looked for from 55% of the height.
  function burnedCaption(data, w, top, bot) {
    if (w < 240) return null;
    const lh = bot - top + 1, from = top + Math.floor(lh * 0.55), x0 = Math.floor(w * 0.25), x1 = Math.ceil(w * 0.75), n = x1 - x0;
    let runStart = -1, lastHit = -99, plain = 0, letters = 0, outl = 0, found = null;
    const close = (end) => {
      if (runStart < 0) return;
      const barred = end - runStart + 1 >= Math.max(3, lh * 0.04) && plain >= 2 && letters >= 2;
      const outlined = outl >= Math.max(4, lh * 0.05);
      if (barred || outlined) found = { y: (runStart - top) / lh, yFrame: runStart / (data.length / 4 / w), kind: barred ? "bar" : "outlined" };
    };
    for (let y = from; y <= bot && !found; y++) {
      let hi = 0, lo = 0, edges = 0, prev = -1;
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4, l = lum(data[i], data[i + 1], data[i + 2]);
        if (l > 0.82) hi++; else if (l < 0.14) lo++;
        if (prev >= 0 && Math.abs(l - prev) > 0.35) edges++;
        prev = l;
      }
      const isPlain = Math.max(hi, lo) / n > 0.85;
      const isLetters = Math.max(hi, lo) / n > 0.35 && Math.min(hi, lo) / n > 0.1 && edges / n > 0.2;
      const isOutlined = hi / n > 0.12 && lo / n > 0.08 && edges / n > 0.2; // white letters in a black edge
      if (isPlain || isLetters || isOutlined) {
        if (y - lastHit > 4) { close(lastHit); runStart = y; plain = 0; letters = 0; outl = 0; }
        lastHit = y; if (isPlain) plain++; if (isLetters) letters++; if (isOutlined) outl++;
      }
    }
    if (!found) close(lastHit);
    return found;
  }

  const PRESET_NAME = { classic: "Classic", youtube: "YouTube", tiktok: "TikTok", cinema: "Cinema" };
  const HL_NAME = { classic: "Classic gold", "neon-cyan": "Neon cyan", "neon-magenta": "Neon magenta", ember: "Ember" };

  // The highlight sits opposite the picture's own colour, so it never melts into it.
  function pickHighlight(m) {
    if (m.colour < 0.08) return { hl: "classic", why: "gold reads on grey footage" };
    const h = m.hue;
    if (h < 60 || h >= 330) return { hl: "neon-cyan", why: "cyan stands off the warm colours" };
    if (h < 170) return { hl: "neon-magenta", why: "magenta stands off the greens" };
    if (h < 260) return { hl: "ember", why: "ember stands off the blues" };
    return { hl: "classic", why: "gold stands off the purples" };
  }

  function suggest(frame) {
    const m = measure(frame);
    // A protected (DRM) video, or a black screen between scenes: nothing to read.
    if (m.frameL < 0.03 && m.frameStd < 0.02) return { protected: true, m };
    let preset, why;
    if (m.burned) { preset = "classic"; why = "this video writes its own captions at the bottom, so yours go higher in a dark box that stays apart from them"; }
    else if (m.portrait) { preset = "tiktok"; why = "an upright video: bold outlined words, like the apps it was made for"; }
    else if (m.bandL > 0.58) { preset = "classic"; why = "the bottom of the picture is bright, so a dark box keeps the words readable"; }
    else if (m.busy > 0.075 || m.bandStd > 0.2) { preset = "youtube"; why = "the picture under the words is busy, so a box per line cuts the clutter"; }
    else if (m.bandL < 0.32) { preset = "cinema"; why = "the bottom is dark and calm, so film-style text needs no box"; }
    else { preset = "classic"; why = "a mid-bright picture: a soft dark box is the safest read"; }
    const hl = pickHighlight(m);
    return { preset, hl: hl.hl, position: m.burned ? "top" : null, presetName: PRESET_NAME[preset], hlName: HL_NAME[hl.hl], why, hlWhy: hl.why, m };
  }

  g.SV_STYLEFIT = { measure, suggest };
})(globalThis);

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
    return { bandL, bandStd, busy, frameL, frameStd, hue, colour, portrait: h > w * 1.1 };
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
    if (m.portrait) { preset = "tiktok"; why = "an upright video: bold outlined words, like the apps it was made for"; }
    else if (m.bandL > 0.58) { preset = "classic"; why = "the bottom of the picture is bright, so a dark box keeps the words readable"; }
    else if (m.busy > 0.075 || m.bandStd > 0.2) { preset = "youtube"; why = "the picture under the words is busy, so a box per line cuts the clutter"; }
    else if (m.bandL < 0.32) { preset = "cinema"; why = "the bottom is dark and calm, so film-style text needs no box"; }
    else { preset = "classic"; why = "a mid-bright picture: a soft dark box is the safest read"; }
    const hl = pickHighlight(m);
    return { preset, hl: hl.hl, presetName: PRESET_NAME[preset], hlName: HL_NAME[hl.hl], why, hlWhy: hl.why, m };
  }

  g.SV_STYLEFIT = { measure, suggest };
})(globalThis);

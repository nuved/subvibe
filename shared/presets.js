// Subtitle style presets — one source of truth for the popup (preview tiles) and
// the content script (overlay CSS vars). Loaded before popup.js / content/common.js.
//
// A style is a bag of CSS custom properties applied to #copilot-subs. "classic"
// IS the pre-preset look: its values must stay byte-identical to the fallbacks
// in styles/overlay.css so users who never touch the picker see no change.
(function () {
  "use strict";

  const SANS = '"Vazirmatn", -apple-system, "Segoe UI", Roboto, Arial, sans-serif'; // Vazirmatn carries Latin too — one face for Persian AND originals
  const ROUNDED = '"Baloo 2", "Arial Rounded MT Bold", "Segoe UI", sans-serif';

  // Text outline via stacked shadows (works everywhere, incl. RTL). Em-scaled so
  // it tracks the font size across windowed/theater/fullscreen.
  const OUTLINE_HEAVY =
    "-.05em -.05em 0 #000, .05em -.05em 0 #000, -.05em .05em 0 #000, .05em .05em 0 #000, " +
    "0 .07em 0 #000, .07em 0 0 #000, 0 -.07em 0 #000, -.07em 0 0 #000";
  const OUTLINE_THIN =
    "-.03em -.03em 0 #000, .03em -.03em 0 #000, -.03em .03em 0 #000, .03em .03em 0 #000";
  const SHADOW_CLASSIC = "0 2px 6px rgba(0, 0, 0, 0.9)";

  // Base = classic. Every preset lists only what it changes.
  // pill: true → background hugs each WRAPPED line (inner span + box-decoration-break)
  //   instead of one box per caption.
  // fonts: bundled fonts the content script must inject (absolute extension URLs).
  const CLASSIC = {
    fontFamily: SANS, weight: "600", color: "#ffffff",
    bg: "rgba(8, 10, 14, 0.78)", radius: "7px", pad: "0.12em 0.5em",
    shadow: SHADOW_CLASSIC, lh: "1.32", maxWidth: "min(86%, 24em)",
    hl: "#ffd479", // karaoke fill — words already spoken (gold reads on dark bgs)
  };

  const PRESETS = {
    classic: { label: "Classic", pill: false, fonts: [], style: {} },
    youtube: {
      label: "YouTube", pill: true, fonts: [],
      style: { fontFamily: 'Roboto, "Segoe UI", Arial, sans-serif', weight: "400", bg: "rgba(8, 8, 8, 0.75)", radius: "0", pad: "0.1em 0.35em", shadow: "none", lh: "1.35" },
    },
    tiktok: {
      label: "TikTok", pill: false, fonts: ["baloo2"],
      style: { fontFamily: ROUNDED, weight: "800", bg: "transparent", pad: "0.12em 0.35em", shadow: OUTLINE_HEAVY, lh: "1.25", maxWidth: "min(80%, 18em)" },
    },
    pill: {
      label: "Pill", pill: true, fonts: ["baloo2"],
      style: { fontFamily: ROUNDED, weight: "800", color: "#000000", bg: "rgba(255, 255, 255, 0.96)", radius: "0.35em", pad: "0.1em 0.45em", shadow: "none", lh: "1.5", maxWidth: "min(80%, 18em)", hl: "#c47500" }, // dark amber — gold vanishes on the white pill
    },
    snapchat: {
      // banner: the line stretches edge-to-edge (Snapchat's full-width strip) —
      // maxWidth alone can't do it, the flex stack shrink-wraps lines.
      label: "Snap", pill: false, banner: true, fonts: [],
      style: { fontFamily: '"Avenir Next", Avenir, "Nunito Sans", "Segoe UI", Roboto, sans-serif', weight: "500", bg: "rgba(0, 0, 0, 0.55)", radius: "0", pad: "0.25em 0.6em", shadow: "none", lh: "1.4", maxWidth: "100%" },
    },
    cinema: {
      label: "Cinema", pill: false, fonts: [],
      style: { fontFamily: 'Helvetica, Arial, "Segoe UI", sans-serif', weight: "500", bg: "transparent", pad: "0.12em 0.35em", shadow: "0 0 7px rgba(0, 0, 0, 0.95), 0 2px 4px rgba(0, 0, 0, 0.85)", lh: "1.35", maxWidth: "min(86%, 26em)" },
    },
    minimal: {
      label: "Minimal", pill: false, fonts: [],
      style: { bg: "transparent", pad: "0.12em 0.35em", shadow: OUTLINE_THIN },
    },
  };

  // Custom font choices ("Customize" in the popup). System stacks cost nothing;
  // "rounded" leads with bundled Baloo 2 so it looks the same on every OS.
  const FONT_STACKS = {
    sans: { label: "Sans (default)", css: SANS, fonts: [] },
    rounded: { label: "Rounded", css: ROUNDED, fonts: ["baloo2"] },
    serif: { label: "Serif", css: 'Georgia, "Times New Roman", serif', fonts: [] },
    mono: { label: "Mono", css: "ui-monospace, Menlo, Consolas, monospace", fonts: [] },
    casual: { label: "Casual", css: '"Comic Sans MS", "Chalkboard SE", "Comic Neue", cursive', fonts: [] },
  };

  function hexToRgba(hex, alpha) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return null;
    const n = parseInt(m[1], 16);
    const a = typeof alpha === "number" && isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  // "rgba(8, 10, 14, 0.78)" / "#0a0b0c" → { hex, a } — the popup seeds its
  // background controls from this, and custom bg tweaks keep the preset's own
  // color/opacity for whatever the user DIDN'T change. null for transparent/none.
  function parseColor(v) {
    v = (v || "").trim();
    let m = /^#([0-9a-f]{6})$/i.exec(v);
    if (m) return { hex: "#" + m[1].toLowerCase(), a: 1 };
    m = /^#([0-9a-f]{3})$/i.exec(v);
    if (m) return { hex: "#" + [...m[1]].map((c) => c + c).join("").toLowerCase(), a: 1 };
    m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\s*\)$/i.exec(v);
    if (m) {
      const hex = "#" + [m[1], m[2], m[3]].map((n) => (+n).toString(16).padStart(2, "0")).join("");
      return { hex, a: m[4] == null ? 1 : Math.max(0, Math.min(1, parseFloat(m[4]))) };
    }
    return null;
  }

  // settings.stylePreset + settings.styleCustom (sparse overrides) → the effective
  // look: CSS vars for #copilot-subs, the pill flag, and bundled fonts to inject.
  // Unknown/missing values fall back to classic, so bad storage can't blank the overlay.
  function resolveStyle(settings) {
    const preset = PRESETS[settings && settings.stylePreset] || PRESETS.classic;
    const c = settings && settings.styleCustom && typeof settings.styleCustom === "object" ? settings.styleCustom : {};
    const st = { ...CLASSIC, ...preset.style };
    let fonts = preset.fonts.slice();

    const fc = FONT_STACKS[c.font];
    if (fc) { st.fontFamily = fc.css; fonts = fc.fonts.slice(); }
    if (typeof c.color === "string" && /^#[0-9a-f]{6}$/i.test(c.color)) st.color = c.color;
    if (c.bg === false) st.bg = "transparent";
    else if (c.bg === true || typeof c.bgColor === "string" || typeof c.bgOpacity === "number") {
      // Whatever the user didn't tweak keeps the PRESET's own background (a bare
      // opacity nudge on Pill must not swap its white for the classic dark);
      // presets without a background (tiktok/cinema/minimal) start from classic.
      const base = parseColor(st.bg) || { hex: "#080a0e", a: 0.78 };
      st.bg = hexToRgba(c.bgColor || base.hex, typeof c.bgOpacity === "number" ? c.bgOpacity : base.a) || st.bg;
    }
    if (c.edge === "none") st.shadow = "none";
    else if (c.edge === "outline") st.shadow = OUTLINE_HEAVY;
    else if (c.edge === "shadow") st.shadow = SHADOW_CLASSIC;

    return {
      pill: !!preset.pill,
      banner: !!preset.banner,
      fonts,
      vars: {
        "--cs-font-family": st.fontFamily,
        "--cs-weight": st.weight,
        "--cs-color": st.color,
        "--cs-bg": st.bg,
        "--cs-radius": st.radius,
        "--cs-pad": st.pad,
        "--cs-shadow": st.shadow,
        "--cs-lh": st.lh,
        "--cs-maxwidth": st.maxWidth,
        "--cs-hl": st.hl,
      },
    };
  }

  // Karaoke highlight styles (karaokeStyle setting). The LOOK lives in
  // styles/overlay.css (.copilot-hl-* on .sung); this map only feeds the
  // popup's swatch row — label + the css that paints the "Abc" tile.
  const HL_STYLES = {
    classic: { label: "Classic gold", css: "color:#ffd479" },
    "neon-cyan": { label: "Neon cyan", css: "color:#7df9ff;text-shadow:0 0 6px rgba(0,229,255,.9)" },
    "neon-magenta": { label: "Neon magenta", css: "color:#ff5ce1;text-shadow:0 0 6px rgba(255,0,200,.9)" },
    ember: { label: "Ember", css: "color:#ff9d4d;text-shadow:0 0 5px rgba(255,94,0,.85)" },
    aurora: { label: "Aurora", css: "background:linear-gradient(90deg,#4ade80,#22d3ee,#a78bfa,#f472b6);-webkit-background-clip:text;background-clip:text;color:transparent" },
  };

  window.SV_PRESETS = PRESETS;
  window.SV_HL_STYLES = HL_STYLES;
  window.SV_FONT_STACKS = FONT_STACKS;
  window.SV_RESOLVE_STYLE = resolveStyle;
  window.SV_PARSE_COLOR = parseColor;
})();

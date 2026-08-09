// tools/tests/design-tokens.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const css = fs.readFileSync(new URL("../../styles/tokens.css", import.meta.url), "utf8");

const LIGHT = {
  "--bg": "#FAF6F0", "--surface": "#FFFFFF", "--surface-2": "#F3EDE4",
  "--border": "#EDE5DA", "--ink": "#241F1A", "--ink-2": "#5B5348",
  "--muted": "#786D60", "--faint": "#A39684",
  "--coral-500": "#F45D48", "--coral-600": "#C93F2B", "--coral-700": "#A93521",
  "--coral-100": "#FDE8E4", "--teal-600": "#0D9488", "--teal-100": "#E4F2EF",
  "--green-600": "#15803D", "--red-600": "#DC2626", "--amber-600": "#B45309",
  "--karaoke": "#FFB35C", "--toggle-off": "#D8CFC2",
};
const DARK = {
  "--bg": "#191512", "--surface": "#241F1A", "--surface-2": "#2E2822",
  "--border": "#3A332B", "--ink": "#F3EDE4", "--muted": "#918679",
  "--coral-500": "#FF7A66", "--teal-600": "#2DD4BF",
};

test("light tokens present on :root with spec values", () => {
  const root = css.split("@media")[0];
  for (const [k, v] of Object.entries(LIGHT))
    assert.match(root, new RegExp(`${k}:\\s*${v}`, "i"), `${k} missing/wrong in :root`);
});

test("dark counterparts under prefers-color-scheme: dark", () => {
  const i = css.indexOf("prefers-color-scheme: dark");
  assert.ok(i > -1, "dark media block missing");
  const dark = css.slice(i);
  for (const [k, v] of Object.entries(DARK))
    assert.match(dark, new RegExp(`${k}:\\s*${v}`, "i"), `${k} missing/wrong in dark block`);
});

test("non-color scale tokens exist", () => {
  for (const k of ["--r-sm", "--r-md", "--r-lg", "--shadow-rest", "--shadow-raised", "--shadow-glow", "--t-fast", "--t-panel"])
    assert.ok(css.includes(k + ":"), `${k} missing`);
});

// --- WCAG 2.1 relative-luminance contrast, computed for real (not string-pinned) ---
function hexToRgb(hex) {
  const n = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16));
}
function relLuminance([r, g, b]) {
  const [R, G, B] = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}
function contrastRatio(hexA, hexB) {
  const La = relLuminance(hexToRgb(hexA));
  const Lb = relLuminance(hexToRgb(hexB));
  const [hi, lo] = La > Lb ? [La, Lb] : [Lb, La];
  return (hi + 0.05) / (lo + 0.05);
}
function tokenValue(source, name) {
  const m = source.match(new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`));
  assert.ok(m, `${name} not found in source`);
  return m[1];
}

test("text tokens meet WCAG AA on their backgrounds", () => {
  const root = css.split("@media")[0];
  const dark = css.slice(css.indexOf("prefers-color-scheme: dark"));

  const lightBg = tokenValue(root, "--bg");
  const lightSurface = tokenValue(root, "--surface");
  const lightMuted = tokenValue(root, "--muted");
  const lightInk2 = tokenValue(root, "--ink-2");
  const lightCoral600 = tokenValue(root, "--coral-600");
  const darkBg = tokenValue(dark, "--bg");
  const darkSurface = tokenValue(dark, "--surface");
  const darkMuted = tokenValue(dark, "--muted");

  const pairs = [
    ["light --muted vs --bg", lightMuted, lightBg],
    ["light --muted vs --surface", lightMuted, lightSurface],
    ["light --ink-2 vs --bg", lightInk2, lightBg],
    ["light --ink-2 vs --surface", lightInk2, lightSurface],
    ["dark --muted vs dark --bg", darkMuted, darkBg],
    ["dark --muted vs dark --surface", darkMuted, darkSurface],
    // .btn-primary is white text on --coral-600 in light mode (dark mode swaps to dark ink text)
    ["light --coral-600 button (white text)", "#FFFFFF", lightCoral600],
  ];

  for (const [label, fg, bg] of pairs) {
    const ratio = contrastRatio(fg, bg);
    assert.ok(ratio >= 4.5, `${label}: ${ratio.toFixed(2)}:1 fails WCAG AA (need >=4.5:1)`);
  }
});

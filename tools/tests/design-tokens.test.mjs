// tools/tests/design-tokens.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const css = fs.readFileSync(new URL("../../styles/tokens.css", import.meta.url), "utf8");

const LIGHT = {
  "--bg": "#FAF6F0", "--surface": "#FFFFFF", "--surface-2": "#F3EDE4",
  "--border": "#EDE5DA", "--ink": "#241F1A", "--ink-2": "#5B5348",
  "--muted": "#8A7F72", "--faint": "#A39684",
  "--coral-500": "#F45D48", "--coral-600": "#C93F2B", "--coral-700": "#A93521",
  "--coral-100": "#FDE8E4", "--teal-600": "#0D9488", "--teal-100": "#E4F2EF",
  "--green-600": "#15803D", "--red-600": "#DC2626", "--amber-600": "#B45309",
  "--karaoke": "#FFB35C", "--toggle-off": "#D8CFC2",
};
const DARK = {
  "--bg": "#191512", "--surface": "#241F1A", "--surface-2": "#2E2822",
  "--border": "#3A332B", "--ink": "#F3EDE4",
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

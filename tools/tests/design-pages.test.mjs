import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL("../../" + p, import.meta.url), "utf8");
const PAGES = ["library.html", "learn.html"];

// The old indigo palette (both pages carried local copies). Any of these left
// behind means a surface escaped the Daylight reskin.
const INDIGO = ["#0B0F19", "#161D30", "#0E1424", "#1C2438", "#26304A", "#262F49", "#1E2740",
  "#4F46E5", "#6366F1", "#818CF8", "#818cf8", "99,102,241"];

for (const page of PAGES) {
  test(`${page}: Daylight applied — tokens linked, shared theme, indigo gone`, () => {
    const html = read(page);
    assert.ok(html.includes('href="styles/tokens.css"'), "tokens.css not linked");
    assert.ok(html.includes('href="styles/components.css"'), "components.css not linked");
    assert.ok(html.includes('src="shared/theme.js"'), "shared/theme.js not loaded");
    for (const hex of INDIGO) assert.ok(!html.includes(hex), `old indigo ${hex} still present`);
    assert.ok(!/color-scheme:\s*dark/.test(html), "page still forces dark color-scheme");
  });
}

test("shared/theme.js: uiTheme contract (light default, storage-driven, auto via matchMedia)", () => {
  const js = read("shared/theme.js");
  assert.match(js, /uiTheme/);
  assert.match(js, /dataset\.theme/);
  assert.match(js, /prefers-color-scheme/);
  assert.match(js, /onChanged/, "must follow uiTheme changes from other pages");
});

test("popup.js delegates theme application to the shared module", () => {
  const js = read("popup.js");
  assert.match(js, /SV_THEME/);
  assert.ok(read("popup.html").includes('src="shared/theme.js"'), "popup must load shared/theme.js");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const js = fs.readFileSync(new URL("../../popup.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../../popup.html", import.meta.url), "utf8");

test("every id popup.js touches exists in popup.html", () => {
  const ids = new Set();
  for (const m of js.matchAll(/\bel\(\s*"([^"]+)"\s*\)/g)) ids.add(m[1]);
  for (const m of js.matchAll(/getElementById\(\s*"([^"]+)"\s*\)/g)) ids.add(m[1]);
  // Ids popup.js itself creates at runtime (innerHTML template strings) count
  // as defined — e.g. #liveIdle is built inside the livebtn's markup.
  const defined = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  for (const m of js.matchAll(/id="([^"]+)"/g)) defined.add(m[1]);
  const missing = [...ids].filter((id) => !defined.has(id));
  assert.deepEqual(missing, [], `popup.js references missing ids: ${missing.join(", ")}`);
});

test("panes are translate/style/learn/keys — no dub pane, tabs match", () => {
  const panes = [...html.matchAll(/data-pane="([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(panes, ["keys", "learn", "style", "translate"]);
  const tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(tabs, ["learn", "style", "translate"]);
});

test("Daylight applied: tokens linked, 460px, old indigo palette gone", () => {
  assert.ok(html.includes('href="styles/tokens.css"'), "tokens.css not linked");
  assert.ok(html.includes('href="styles/components.css"'), "components.css not linked");
  assert.match(html, /width:\s*460px/, "popup not pinned to 460px");
  for (const hex of ["#0B0F19", "#161D30", "#4F46E5", "#1C2438", "#24324F"])
    assert.ok(!html.includes(hex), `old indigo hex ${hex} still present`);
});

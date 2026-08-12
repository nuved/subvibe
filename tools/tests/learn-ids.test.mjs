import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const js = fs.readFileSync(new URL("../../learn.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../../learn.html", import.meta.url), "utf8");
const popupHtml = fs.readFileSync(new URL("../../popup.html", import.meta.url), "utf8");
const gameuiJs = fs.readFileSync(new URL("../../shared/gameui.js", import.meta.url), "utf8");

test("every id learn.js touches exists in learn.html", () => {
  const ids = new Set();
  for (const m of js.matchAll(/\bel\(\s*"([^"]+)"\s*\)/g)) ids.add(m[1]);
  for (const m of js.matchAll(/getElementById\(\s*"([^"]+)"\s*\)/g)) ids.add(m[1]);
  // Ids learn.js itself creates at runtime (innerHTML template strings) count
  // as defined — same pattern as popup-ids.test.mjs.
  const defined = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  for (const m of js.matchAll(/id="([^"]+)"/g)) defined.add(m[1]);
  const missing = [...ids].filter((id) => !defined.has(id));
  assert.deepEqual(missing, [], `learn.js references missing ids: ${missing.join(", ")}`);
});

// shared/gameui.js (SV_GAMEUI) drives the round loop for BOTH popup's arcade
// and learn.js's trainer — its qs()/getElementById lookups must resolve
// against either host page (carried-forward binding constraint from Task 1's
// review, since this file is shared and neither host's own ids test covers it).
test("every id shared/gameui.js touches (qs/getElementById) exists in BOTH popup.html and learn.html", () => {
  const ids = new Set();
  for (const m of gameuiJs.matchAll(/\bqs\(\s*"([^"]+)"\s*\)/g)) ids.add(m[1]);
  for (const m of gameuiJs.matchAll(/getElementById\(\s*"([^"]+)"\s*\)/g)) ids.add(m[1]);

  const ownDefined = new Set([...gameuiJs.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const popupDefined = new Set([...popupHtml.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const learnDefined = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

  const missingPopup = [...ids].filter((id) => !popupDefined.has(id) && !ownDefined.has(id));
  const missingLearn = [...ids].filter((id) => !learnDefined.has(id) && !ownDefined.has(id));
  assert.deepEqual(missingPopup, [], `shared/gameui.js references ids missing from popup.html: ${missingPopup.join(", ")}`);
  assert.deepEqual(missingLearn, [], `shared/gameui.js references ids missing from learn.html: ${missingLearn.join(", ")}`);
});

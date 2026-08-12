import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
const FILES = ["popup.html", "popup.js", "learn.html", "learn.js", "shared/game.js", "shared/gameui.js"];
test("generated UI never prints German low-quotes", () => {
  for (const f of FILES) {
    if (!fs.existsSync(new URL("../../" + f, import.meta.url))) continue;
    const s = fs.readFileSync(new URL("../../" + f, import.meta.url), "utf8");
    assert.ok(!s.includes("„"), f + " contains „ — UI must use curly/guillemets (spec rule)");
  }
});

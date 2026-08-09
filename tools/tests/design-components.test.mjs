// tools/tests/design-components.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const css = fs.readFileSync(new URL("../../styles/components.css", import.meta.url), "utf8");

test("component class contract", () => {
  for (const sel of [".btn-primary", ".btn-secondary", ".btn-quiet", ".btn-danger",
    ".card", ".chip", ".chip.on", ".chip.learn", ".field", ".switch", ".slider",
    ".overline", ".skeleton", ".empty-state", ".error-state", ".check-row"])
    assert.ok(css.includes(sel), `${sel} missing`);
});

test("focus ring and reduced motion are defined", () => {
  assert.ok(css.includes(":focus-visible"), "focus-visible ring missing");
  assert.ok(css.includes("prefers-reduced-motion"), "reduced-motion guard missing");
});

test("components use tokens, not raw palette hexes", () => {
  // Raw brand hexes belong in tokens.css only.
  for (const hex of ["#F45D48", "#C93F2B", "#0D9488", "#FAF6F0"])
    assert.ok(!css.includes(hex), `raw ${hex} found — use var()`);
});

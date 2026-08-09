import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../../welcome.html", import.meta.url), "utf8");
const js = fs.readFileSync(new URL("../../welcome.js", import.meta.url), "utf8");
const bg = fs.readFileSync(new URL("../../background.js", import.meta.url), "utf8");

test("welcome page structure: 3 steps, skippable, tokens linked", () => {
  assert.ok(html.includes('href="styles/tokens.css"'));
  for (const id of ["step1", "step2", "step3", "langGrid", "langSearch", "skipBtn"])
    assert.ok(html.includes(`id="${id}"`), `#${id} missing`);
  assert.ok(html.includes('src="shared/langs.js"'), "langs.js not loaded");
});

test("welcome.js writes the targets key popup reads", () => {
  assert.match(js, /storage\.local\.set\(\s*\{\s*targets:/);
});

test("background opens welcome on fresh install only", () => {
  assert.match(bg, /onInstalled/);
  assert.match(bg, /reason\s*===\s*"install"/);
  assert.match(bg, /welcome\.html/);
});

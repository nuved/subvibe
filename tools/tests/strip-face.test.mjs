// tools/tests/strip-face.test.mjs — the strip's face() (content/common.js) paints a found portrait and colours a
// nameless initial. The function lives inside the content script's closure, so its source is lifted out by
// text and run with stand-ins for the DOM helpers: a comment that swallows the painting statements
// (2026-09-04: every face came up as a blank grey box) fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import "../../shared/dossier.js";

const src = fs.readFileSync(new URL("../../content/common.js", import.meta.url), "utf8");
const lines = src.split("\n");
const start = lines.findIndex((l) => /^\s*const face = \(p, label, size, talk\) => \{/.test(l));
assert.ok(start >= 0, "face() is where the test expects it");
const indent = /^(\s*)/.exec(lines[start])[1];
let end = start; while (end < lines.length && lines[end] !== indent + "};") end++;
const faceSrc = lines.slice(start, end + 1).join("\n");

const el = (tag, cls, text) => ({ tag, className: cls || "", textContent: text == null ? "" : String(text), style: {}, dataset: {}, children: [], appendChild(c) { this.children.push(c); return c; } });
const build = (faces) => new Function("mk", "photoOf", "SV_DOSSIER", "nameHue", "cleanName", faceSrc + "\nreturn face;")(
  el, (p, nm) => (p && p.photo) || faces.get(nm) || "", globalThis.SV_DOSSIER, () => 210, (s) => String(s).replace(/\s*\(.*$/, "").trim());

test("a found portrait is painted on the face, with no initials over it", () => {
  const face = build(new Map([["Oleg", "https://static.wikia.nocookie.net/vikingstv/images/7/7e/OlegtheProphet.jpeg"]]));
  const f = face(null, "Oleg", "md", false);
  const av = f.children[0];
  assert.equal(av.tag, "i");
  assert.equal(av.textContent, "");
  assert.equal(av.style.backgroundImage, "url(https://static.wikia.nocookie.net/vikingstv/images/7/7e/OlegtheProphet.jpeg)");
  assert.equal(f.children[1].textContent, "Oleg");
});

test("without a portrait the face shows initials on its own colour; a role skips its article", () => {
  const face = build(new Map());
  const seer = face(null, "Seer", "md", false).children[0];
  assert.equal(seer.textContent, "S");
  assert.match(seer.style.background || "", /^hsl\(210 /);
  assert.equal(seer.style.backgroundImage, undefined);
  const teacher = face(null, "the French teacher", "sm", false).children[0];
  assert.equal(teacher.textContent, "FT");
  const person = face({ name: "Alex Høgh Andersen", character: "Ivar", photo: "" }, "", "lg", true);
  assert.equal(person.className, "svs-face lg talk");
  assert.equal(person.children[0].textContent, "I");
});

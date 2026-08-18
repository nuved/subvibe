import { test } from "node:test";
import assert from "node:assert/strict";
import "../../shared/simplify.js";

const S = globalThis.SV_SIMPLIFY;

test("prep trims and flags truncation", () => {
  const short = S.prep("  hello world \n\n\n\n again ");
  assert.equal(short.truncated, false);
  assert.equal(short.text, "hello world\n\nagain");
  const long = S.prep("word ".repeat(2000)); // 10000 chars
  assert.equal(long.truncated, true);
  assert.ok(long.text.length <= S.MAX_CHARS);
  assert.ok(!long.text.endsWith(" wor")); // word-boundary cut
});

test("buildMessages embeds level, language rule, and bullet rule by length", () => {
  const short = S.buildMessages("Ein kurzer Satz.", "B1");
  assert.equal(short[0].role, "system");
  assert.match(short[0].content, /SAME language/);
  assert.match(short[0].content, /B1/);
  assert.match(short[1].content, /Ein kurzer Satz\./);
  assert.match(short[0].content, /"points": \[\]/); // short input: empty points demanded
  const long = S.buildMessages("x".repeat(700), "A2");
  assert.match(long[0].content, /2.4 key.point/i); // long input: bullets demanded
});

test("parse accepts clean and fenced JSON, normalizes points", () => {
  const ok = S.parse('{"simple":"Easy text.","points":["  a ", "", "b", "c", "d", "e"]}');
  assert.equal(ok.simple, "Easy text.");
  assert.deepEqual(ok.points, ["a", "b", "c", "d"]); // trimmed, empties dropped, capped at 4
  const fenced = S.parse('```json\n{"simple":"S.","points":[]}\n```');
  assert.equal(fenced.simple, "S.");
  assert.deepEqual(fenced.points, []);
});

test("parse throws on garbage", () => {
  assert.throws(() => S.parse("not json"), /bad-response/);
  assert.throws(() => S.parse('{"points":[]}'), /bad-response/); // missing simple
  assert.throws(() => S.parse('{"simple":""}'), /bad-response/); // empty simple
});

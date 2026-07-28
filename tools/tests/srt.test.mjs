import { test } from "node:test";
import assert from "node:assert/strict";
import "../../shared/srt.js";

const S = globalThis.SV_SRT;

test("formats indexes, HH:MM:SS,mmm timestamps, blank-line separators", () => {
  const srt = S.cuesToSrt([
    { startMs: 0, endMs: 1500, text: "Hello" },
    { startMs: 3_661_042, endMs: 3_663_500, text: "سلام دنیا" },
  ]);
  assert.equal(srt,
    "1\n00:00:00,000 --> 00:00:01,500\nHello\n\n" +
    "2\n01:01:01,042 --> 01:01:03,500\nسلام دنیا\n");
});

test("null endMs defaults to start + 2.5s; empty cues → empty string", () => {
  assert.match(S.cuesToSrt([{ startMs: 1000, endMs: null, text: "x" }]), /00:00:01,000 --> 00:00:03,500/);
  assert.equal(S.cuesToSrt([]), "");
});

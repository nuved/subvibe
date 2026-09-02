// tools/tests/zip.test.mjs — the store-only ZIP writer (shared/zip.js), checked with the system's unzip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import "../../shared/zip.js";

const Z = globalThis.SV_ZIP;

test("crc32 matches the reference value for 'The quick brown fox…'", () => {
  assert.equal(Z.crc32(new TextEncoder().encode("The quick brown fox jumps over the lazy dog")), 0x414FA339);
  assert.equal(Z.crc32(new Uint8Array(0)), 0);
});

test("build: a two-file archive lists and tests clean with unzip", () => {
  const files = [{ name: "slide-01.txt", bytes: new TextEncoder().encode("hello slide one") }, { name: "slide-02.txt", bytes: new TextEncoder().encode("second") }];
  const zip = Z.build(files, new Date(2026, 8, 2, 12, 0, 0));
  assert.equal(zip[0], 0x50); assert.equal(zip[1], 0x4b); // PK
  const dir = mkdtempSync(join(tmpdir(), "svzip-")); const p = join(dir, "t.zip"); writeFileSync(p, zip);
  const list = execFileSync("unzip", ["-l", p]).toString();
  assert.match(list, /slide-01\.txt/); assert.match(list, /slide-02\.txt/);
  const t = execFileSync("unzip", ["-t", p]).toString();
  assert.match(t, /No errors detected/);
  const cat = execFileSync("unzip", ["-p", p, "slide-02.txt"]).toString();
  assert.equal(cat, "second");
});

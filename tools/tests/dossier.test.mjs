// tools/tests/dossier.test.mjs — the dossier block, sample, who→faces, tips-ahead window (shared/dossier.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import "../../shared/dossier.js";

const D = globalThis.SV_DOSSIER;
const netflix = { v: 1, site: "netflix", title: "", show: "The Block", season: 1, episode: 3, epTitle: "Raymond", year: 2024, runtimeMin: 44,
  synopsis: "Two men come to the block to pick something up for a friend who isn't around.", channel: "", description: "",
  kind: "crime drama series", about: "a street crew and a missing friend", register: "casual, slang", speakers: "young men outside a building",
  people: [{ name: "Ada Lee", character: "Boobie", role: "", photo: "", order: 0, src: "tmdb" }, { name: "Ben Ito", character: "Raymond", role: "", photo: "", order: 1, src: "tmdb" }],
  tmdb: { type: "tv", id: 1, matched: true }, poster: "", sample: ["No. Y'all know Boobie?", "Boobie, huh? Yeah, he ain't here, though."] };

test("block: byte-stable, one line per fact, the sample numbered, nothing per-call", () => {
  const a = D.block(netflix), b = D.block(JSON.parse(JSON.stringify(netflix)));
  assert.equal(a, b);
  assert.match(a, /^VIDEO DOSSIER \(context only — never explain or translate it\):\n/);
  assert.match(a, /- Title: The Block — S1E3 "Raymond" \(2024\)\n/);
  assert.match(a, /- Synopsis: Two men come to the block/);
  assert.match(a, /- Kind: crime drama series — a street crew and a missing friend\. Register: casual, slang\. Speakers: young men outside a building\n/);
  assert.match(a, /- People \(character — actor\): Boobie — Ada Lee; Raymond — Ben Ito\n/);
  assert.match(a, /SUBTITLE SAMPLE \(spread over the whole video\):\n1\. No\. Y'all know Boobie\?\n2\. Boobie, huh\?/);
  assert.ok(!/\b(at|tmdbAt|Date)\b/.test(a), "no timestamps in the prefix");
  assert.equal(D.block(null), "");
});

test("block: a YouTube dossier names the channel and description; people from the model read 'name (role)'", () => {
  const yt = { site: "youtube", title: "Interview with a climber", channel: "Peak TV", description: "Anna talks about her Everest attempt.\nLinks below.", kind: "interview", about: "mountaineering",
    register: "calm", speakers: "host and guest", people: [{ name: "Anna", character: "", role: "guest, climber", src: "model" }, { name: "Tom", character: "", role: "host", src: "model" }], sample: [] };
  const t = D.block(yt);
  assert.match(t, /- Title: Interview with a climber\n- Channel: Peak TV\n- Description: Anna talks about her Everest attempt\. Links below\.\n/);
  assert.match(t, /- People: Anna \(guest, climber\); Tom \(host\)\n/);
  assert.ok(!/SUBTITLE SAMPLE/.test(t), "no sample section when the sample is empty");
});

test("block: the description is cut at 600 chars, the synopsis at 400, the sample at 300 lines", () => {
  const long = { site: "youtube", title: "T", description: "x".repeat(2000), synopsis: "y".repeat(2000), people: [], sample: Array.from({ length: 500 }, (_, i) => "line " + i) };
  const t = D.block(long);
  assert.equal(t.match(/- Description: (x+)\n/)[1].length, 600); assert.equal(t.match(/- Synopsis: (y+)\n/)[1].length, 400);
  assert.ok(t.includes("300. line 299") && !t.includes("301. line"));
});

test("identityLine: show · S1 E3 · title, else the title", () => {
  assert.equal(D.identityLine(netflix), "The Block · S1 E3 · Raymond");
  assert.equal(D.identityLine({ title: "Only a title" }), "Only a title");
  assert.equal(D.identityLine(null), "");
});

test("sampleLines: spread evenly, trimmed, blanks dropped", () => {
  const lines = Array.from({ length: 100 }, (_, i) => (i % 10 === 5 ? "  " : "L" + i));
  const s = D.sampleLines(lines, 10);
  assert.equal(s.length, 10); assert.equal(s[0], "L0"); assert.ok(!s.includes("")); assert.ok(s.every((x) => x.length <= 160));
  assert.deepEqual(D.sampleLines(["a", "b"], 40), ["a", "b"]);
  assert.equal(D.sampleLines(["x".repeat(500)], 5)[0].length, 160);
});

test("whoFaces: matches a character or actor by whole name or first name, keeps unknown names as initials-only", () => {
  const f = D.whoFaces(["Boobie", "raymond", "the doorman", "Ada"], netflix.people);
  assert.equal(f.length, 4);
  assert.equal(f[0].person.character, "Boobie"); assert.equal(f[1].person.character, "Raymond");
  assert.equal(f[2].person, null); assert.equal(f[2].label, "the doorman");
  assert.equal(f[3].person.name, "Ada Lee");
  assert.equal(D.whoFaces(["a", "b", "c", "d", "e"], []).length, 4, "at most four faces");
  assert.deepEqual(D.whoFaces(null, netflix.people), []);
});

test("aheadWindow: the first unexplained chunk in [ki, ki+ahead), nothing before play, all = to the end", () => {
  const done = new Set([3, 4]);
  const ex = (k) => done.has(k);
  assert.equal(D.aheadWindow(3, 10, 3, ex), 5);
  assert.equal(D.aheadWindow(3, 10, 2, ex), -1, "3 and 4 are done, the window of 2 is satisfied");
  assert.equal(D.aheadWindow(-1, 10, 3, ex), -1, "nothing playing yet");
  assert.equal(D.aheadWindow(-1, 10, Infinity, ex), 0, "explain all starts at the top even before play");
  assert.equal(D.aheadWindow(8, 10, 3, ex), 8);
  assert.equal(D.aheadWindow(9, 10, Infinity, () => true), -1);
});

test("initials: two letters from two words, one from one, ? for nothing", () => {
  assert.equal(D.initials("Ada Lee"), "AL"); assert.equal(D.initials("boobie"), "B"); assert.equal(D.initials("the doorman"), "TD"); assert.equal(D.initials(""), "?");
});

test("sameName / speaks: whole name or a first name of 3+ letters; 'Emily / Madeline' names both", () => {
  assert.ok(D.sameName("Bjorn Ironside", "bjorn")); assert.ok(D.sameName("Ivar (the Boneless)", "Ivar"));
  assert.ok(!D.sameName("Bo Ito", "Bo Lee"), "two letters is not a match"); assert.ok(!D.sameName("", "Ivar"));
  assert.ok(D.speaks("Madeline", "Emily / Madeline")); assert.ok(D.speaks("Emily", "Emily and Gabriel")); assert.ok(!D.speaks("Oleg", "Ivar"));
  assert.ok(!D.speaks("Oleg", ""));
});

const vik = [{ name: "Alex Høgh Andersen", character: "Ivar", photo: "p-ivar" }, { name: "Danila Kozlovsky", character: "Oleg", photo: "p-oleg" }];
const who = (names) => D.whoFaces(names, vik);
const names = (r) => r.shown.map((f) => (f.person && f.person.character) || f.label + (f.talk ? "*" : "")).map((n, i) => (r.shown[i].talk ? n.replace(/\*?$/, "*") : n));

test("nowFaces: the speaker keeps their place and wears the ring; nobody else moves", () => {
  const r = D.nowFaces(who(["Oleg", "Ivar", "Ubbe"]), "Ivar", vik, 4);
  assert.deepEqual(names(r), ["Oleg", "Ivar*", "Ubbe"]); assert.equal(r.more, 0);
  assert.deepEqual(names(D.nowFaces(who(["Oleg", "Ivar", "Ubbe"]), "", vik, 4)), ["Oleg", "Ivar", "Ubbe"], "no speaker: as listed, no ring");
});

test("nowFaces: a speaker the scene list missed is added, with their picture when the cast knows them", () => {
  const r = D.nowFaces(who(["Ubbe", "Bjorn"]), "Ivar", vik, 4);
  assert.deepEqual(names(r), ["Ubbe", "Bjorn", "Ivar*"]); assert.equal(r.shown[2].person.photo, "p-ivar");
  const role = D.nowFaces(who(["Ubbe"]), "the French teacher", vik, 4);
  assert.deepEqual(names(role), ["Ubbe", "the French teacher*"]); assert.equal(role.shown[1].person, null);
});

test("nowFaces: four slots — four faces, or three and +N; a speaker behind +N takes the last visible slot", () => {
  const five = who(["Ubbe", "Bjorn", "Torvi", "Askold"]).concat(who(["Ivar"]));
  const r = D.nowFaces(five, "Ivar", vik, 4);
  assert.deepEqual(names(r), ["Ubbe", "Bjorn", "Ivar*"]); assert.equal(r.more, 2, "Torvi and Askold are behind +2");
  assert.deepEqual(names(D.nowFaces(five, "", vik, 4)), ["Ubbe", "Bjorn", "Torvi"]);
  const four = D.nowFaces(who(["Ubbe", "Bjorn", "Torvi", "Askold"]), "Ivar", vik, 4);
  assert.deepEqual(names(four), ["Ubbe", "Bjorn", "Ivar*"]); assert.equal(four.more, 2, "a fifth face added by the speaker folds the row to three and +2");
  const both = D.nowFaces(five, "Ivar / Askold", vik, 4);
  assert.deepEqual(names(both), ["Ubbe", "Askold*", "Ivar*"]); assert.equal(both.more, 2, "two speakers: both in view, the two quiet faces from the front stay");
});

test("dominantSpeaker: the name behind most sentences; 'A / B' counts for both; a tie goes to the first heard", () => {
  assert.equal(D.dominantSpeaker(["Oleg", "Ivar", "Oleg"]), "Oleg");
  assert.equal(D.dominantSpeaker(["Ivar", "Oleg / Ivar", "Oleg"]), "Ivar");
  assert.equal(D.dominantSpeaker(["", "Ivar (the Boneless)"]), "Ivar");
  assert.equal(D.dominantSpeaker(null), ""); assert.equal(D.dominantSpeaker(["", ""]), "");
});

test("tipKey: speaker marks, case, spacing and end punctuation don't make a new chunk", () => {
  const k = D.tipKey;
  assert.equal(k(">> I'm lost without you."), k("I'm lost without you"));
  assert.equal(k("- I'm   lost\nwithout you!"), k("i'm lost without you"));
  assert.equal(k("[Music] I'm lost without you…"), k("I'm lost without you"));
  assert.notEqual(k("I'm lost without you tonight."), k("I'm lost without you."));
  assert.equal(k(""), "");
  assert.equal(k("Ça va? — Oui."), k("ça va? — oui"));
  // ch.text is the chunk's sentences joined by " " (content/common.js:2055), so a mark can sit mid-chunk
  assert.equal(k(">> Stay with me. >> I'm lost without you."), k("Stay with me. I'm lost without you"));
  assert.equal(k("&gt;&gt; Stay with me."), k("Stay with me"));
});

test("isMusic: songs and DJ sets, not films about music", () => {
  assert.equal(D.isMusic({ kind: "Music mix (deep house DJ set with vocal tracks)" }), true);
  assert.equal(D.isMusic({ kind: "music video" }), true);
  assert.equal(D.isMusic({ kind: "song lyrics video" }), true);
  assert.equal(D.isMusic({ kind: "crime drama series", about: "a band on tour" }), false);
  assert.equal(D.isMusic({ kind: "documentary about a music festival" }), false);
  assert.equal(D.isMusic(null), false);
});

test("knownWords: every word already explained on this video, once, newest kept", () => {
  const ex = [{ words: [{ w: "drift away" }, { w: "City lights" }] }, { words: [{ w: "fade away" }, { w: "city lights" }] }, {}];
  assert.deepEqual(D.knownWords(ex, 10), ["drift away", "fade away", "city lights"]);
  assert.deepEqual(D.knownWords(ex, 2), ["fade away", "city lights"]);
  assert.deepEqual(D.knownWords([], 5), []);
});

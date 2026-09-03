// tools/tests/tmdb.test.mjs — shaping TMDb search/credits/episode answers (shared/tmdb.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import "../../shared/tmdb.js";

const T = globalThis.SV_TMDB;

test("pickTitle: an exact name beats popularity; the year breaks ties; nothing matches → the most popular", () => {
  const rs = [{ id: 1, name: "The Block", first_air_date: "2019-01-01", popularity: 50 }, { id: 2, name: "The Block", first_air_date: "2024-05-01", popularity: 10 }, { id: 3, name: "Block Party", popularity: 900 }];
  assert.equal(T.pickTitle(rs, "the block", 2024).id, 2);
  assert.equal(T.pickTitle(rs, "The Block", null).id, 1);
  assert.equal(T.pickTitle(rs, "Nothing like it", null).id, 3);
  assert.equal(T.pickTitle([], "x", null), null);
  assert.equal(T.pickTitle([{ id: 9, title: "A Movie", release_date: "2020-02-02", popularity: 1 }], "a movie", 2020).id, 9, "movies carry title/release_date");
});

test("cast: aggregate credits (roles[]) and plain credits (character) shape the same way, sorted by order, capped", () => {
  const agg = { cast: [{ name: "Ben Ito", roles: [{ character: "Raymond" }], profile_path: "/b.jpg", order: 1 }, { name: "Ada Lee", roles: [{ character: "Boobie" }], profile_path: null, order: 0 }] };
  assert.deepEqual(T.cast(agg, 12), [{ name: "Ada Lee", character: "Boobie", photo: "", order: 0, src: "tmdb" }, { name: "Ben Ito", character: "Raymond", photo: "https://image.tmdb.org/t/p/w185/b.jpg", order: 1, src: "tmdb" }]);
  const plain = { cast: [{ name: "C", character: "Cop", profile_path: "/c.jpg", order: 0 }, { name: "D", character: "", profile_path: "", order: 1 }] };
  assert.equal(T.cast(plain, 1).length, 1); assert.equal(T.cast(plain, 5)[0].character, "Cop");
  assert.deepEqual(T.cast(null, 5), []);
});

test("episode: title, overview and guest stars", () => {
  const e = T.episode({ name: "Raymond", overview: "Two men come to the block.", guest_stars: [{ name: "G", character: "Guest", profile_path: "/g.jpg", order: 3 }] });
  assert.equal(e.epTitle, "Raymond"); assert.equal(e.synopsis, "Two men come to the block.");
  assert.deepEqual(e.guests, [{ name: "G", character: "Guest", photo: "https://image.tmdb.org/t/p/w185/g.jpg", order: 3, src: "tmdb" }]);
  assert.deepEqual(T.episode(null), { epTitle: "", synopsis: "", guests: [] });
});

test("imageUrl and urls", () => {
  assert.equal(T.imageUrl("/x.jpg", "w185"), "https://image.tmdb.org/t/p/w185/x.jpg"); assert.equal(T.imageUrl("", "w185"), ""); assert.equal(T.imageUrl(null), "");
  const u = T.urls("KEY");
  assert.equal(u.search("tv", "The Block"), "https://api.themoviedb.org/3/search/tv?query=The%20Block&api_key=KEY");
  assert.equal(u.credits("tv", 7), "https://api.themoviedb.org/3/tv/7/aggregate_credits?api_key=KEY");
  assert.equal(u.credits("movie", 7), "https://api.themoviedb.org/3/movie/7/credits?api_key=KEY");
  assert.equal(u.episode(7, 1, 3), "https://api.themoviedb.org/3/tv/7/season/1/episode/3?api_key=KEY");
  assert.equal(u.configuration(), "https://api.themoviedb.org/3/configuration?api_key=KEY");
});

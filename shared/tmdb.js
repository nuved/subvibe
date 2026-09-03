// shared/tmdb.js — shaping TMDb (themoviedb.org) answers. Pure; the fetches
// live in background.js (tmdbLookup). Attribution is required wherever the
// data shows: "Cast & episode data · TMDB".
(function (g) {
  const API = "https://api.themoviedb.org/3", IMG = "https://image.tmdb.org/t/p/";
  const s = (v, n) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n || 200);
  const norm = (x) => s(x, 200).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const yearOf = (r) => parseInt(String(r.first_air_date || r.release_date || "").slice(0, 4), 10) || 0;
  function pickTitle(results, want, year) {
    const rs = (Array.isArray(results) ? results : []).filter((r) => r && r.id);
    if (!rs.length) return null;
    const w = norm(want), y = year | 0;
    const score = (r) => (norm(r.name || r.title) === w ? 100 : 0) + (y && yearOf(r) === y ? 10 : 0) + Math.min(9, (r.popularity || 0) / 100);
    return rs.slice().sort((a, b) => score(b) - score(a))[0];
  }
  const imageUrl = (path, size) => (path ? IMG + (size || "w185") + path : "");
  const person = (c) => ({ name: s(c.name, 80), character: s(c.character || (Array.isArray(c.roles) && c.roles[0] && c.roles[0].character) || "", 80), photo: imageUrl(c.profile_path, "w185"), order: c.order | 0, src: "tmdb" });
  function cast(credits, max) {
    const list = credits && Array.isArray(credits.cast) ? credits.cast.filter((c) => c && c.name) : [];
    return list.map(person).sort((a, b) => a.order - b.order).slice(0, Math.max(0, max | 0));
  }
  function episode(ep) {
    if (!ep) return { epTitle: "", synopsis: "", guests: [] };
    return { epTitle: s(ep.name, 120), synopsis: s(ep.overview, 600), guests: (Array.isArray(ep.guest_stars) ? ep.guest_stars : []).filter((c) => c && c.name).map(person).slice(0, 6) };
  }
  const urls = (key) => {
    const k = "api_key=" + encodeURIComponent(String(key || ""));
    return {
      search: (kind, q) => API + "/search/" + (kind === "movie" ? "movie" : "tv") + "?query=" + encodeURIComponent(String(q || "")) + "&" + k,
      credits: (kind, id) => API + "/" + (kind === "movie" ? "movie/" + id + "/credits" : "tv/" + id + "/aggregate_credits") + "?" + k,
      episode: (id, season, ep) => API + "/tv/" + id + "/season/" + season + "/episode/" + ep + "?" + k,
      configuration: () => API + "/configuration?" + k,
    };
  };
  g.SV_TMDB = { pickTitle, cast, episode, imageUrl, urls };
})(typeof globalThis !== "undefined" ? globalThis : this);

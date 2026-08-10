// First-run flow. Storage contract: { targets: [primaryLangCode] } — the same
// key/shape popup.js persists; DEFAULTS there fill in everything else.
// NOTE: SV_LANGS entries are TUPLES [code, name, flag] (shared/langs.js:14),
// not objects — destructure positionally.
const $ = (id) => document.getElementById(id);
const LANGS = window.SV_LANGS;
let chosen = null;

const POPULAR = ["fa", "de", "en", "tr", "ar", "es", "fr", "uk", "ru", "hi"];
function renderGrid(q) {
  const list = (q
    ? LANGS.filter(([code, name]) => name.toLowerCase().includes(q.toLowerCase()) || code === q.toLowerCase())
    : LANGS.filter(([code]) => POPULAR.includes(code))
  ).slice(0, 24);
  $("langGrid").replaceChildren(...list.map(([code, name, flag]) => {
    const b = document.createElement("button");
    b.className = "chip" + (chosen === code ? " on" : "");
    b.innerHTML = `<span class="fl">${flag || ""}</span> ${name}`;
    b.addEventListener("click", () => {
      chosen = code;
      chrome.storage.local.set({ targets: [chosen] });
      $("next1").disabled = false;
      $("chosenLang").textContent = name;
      renderGrid($("langSearch").value);
    });
    return b;
  }));
}
renderGrid("");
$("langSearch").addEventListener("input", (e) => renderGrid(e.target.value));

function goto(n) {
  for (const s of [1, 2, 3]) $("step" + s).hidden = s !== n;
  document.querySelectorAll(".stepdots i").forEach((d) => d.classList.toggle("on", +d.dataset.dot <= n));
}
$("next1").addEventListener("click", () => goto(2));
$("skip1").addEventListener("click", () => goto(2));
$("next2").addEventListener("click", () => goto(3));
$("tryYoutube").addEventListener("click", () => { chrome.tabs.create({ url: "https://www.youtube.com" }); goto(3); });
$("openKeys").addEventListener("click", () => { chrome.storage.local.set({ uiTab: "keys" }).then(() => window.close()); });
$("skipBtn").addEventListener("click", () => window.close());

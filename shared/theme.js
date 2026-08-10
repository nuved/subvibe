// Popup/page theme: light is the brand default — no data-theme attribute IS
// light, so first paint always matches the store screenshots. "dark" pins the
// warm-stone palette; "auto" follows the OS, resolved HERE via matchMedia so
// an explicit user choice always beats the system. Stored as uiTheme; every
// extension page loads this so a change in the popup's gear pane flips the
// Library/Learn tabs live via storage.onChanged.
(function (g) {
  const mq = matchMedia("(prefers-color-scheme: dark)");
  let pref = "light";
  function set(p) {
    pref = p || "light";
    document.documentElement.dataset.theme =
      pref === "dark" || (pref === "auto" && mq.matches) ? "dark" : "light";
  }
  // Guarded so the file is inert on non-extension pages (test harnesses).
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get("uiTheme").then((r) => set(r && r.uiTheme));
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === "local" && ch.uiTheme) set(ch.uiTheme.newValue);
    });
  }
  mq.addEventListener("change", () => { if (pref === "auto") set("auto"); });
  g.SV_THEME = { set };
})(window);

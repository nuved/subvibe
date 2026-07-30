// ZDF-shaped stream adapter for the harness: same shape as content/adapters/zdf.js
// (site "zdf", stream: true) but matching the harness page instead of zdf.de.
(function () {
  const adapter = {
    site: "zdf",
    stream: true,
    matches() { return true; },
    getVideoId() { return location.pathname.replace(/\/+$/, "") || location.pathname; },
    getVideoEl() { return document.getElementById("vid"); },
    getPlayerContainer() { return document.getElementById("player") || document.body; },
    readNativeText() { return ""; },
    onNavigate() {},
  };
  (window.__copilotAdapters = window.__copilotAdapters || []).push(adapter);
})();

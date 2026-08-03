// Grants the extension origin's microphone permission from a full tab — the
// one surface where the browser will ALWAYS show the prompt (and where the
// padlock menu can undo an earlier "Block"). The grant carries over to the
// popup and the offscreen capture document (same chrome-extension:// origin).
const out = document.getElementById("out");
const help = document.getElementById("help");
document.getElementById("ask").addEventListener("click", async () => {
  out.className = "";
  out.textContent = "Asking…";
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    out.className = "ok";
    out.textContent = "✓ Granted. Close this tab, open the SubVibe popup and press Start Live Translate.";
    help.hidden = true;
  } catch (e) {
    out.className = "err";
    out.textContent = "Still blocked (" + ((e && e.name) || e) + "). Follow the steps below, then try again.";
    help.hidden = false;
  }
});

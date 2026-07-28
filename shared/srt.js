// SubVibe — SubRip (.srt) formatter (pure logic, node-testable).
(function (g) {
  const pad = (n, w) => String(n).padStart(w, "0");
  function ts(ms) {
    ms = Math.max(0, Math.round(ms));
    const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
    return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms % 1000, 3)}`;
  }
  function cuesToSrt(cues) {
    let out = "";
    (cues || []).forEach((c, i) => {
      const end = c.endMs != null ? c.endMs : c.startMs + 2500;
      out += `${i + 1}\n${ts(c.startMs)} --> ${ts(end)}\n${c.text}\n\n`;
    });
    return out ? out.slice(0, -1) : ""; // single trailing newline
  }
  g.SV_SRT = { cuesToSrt };
})(globalThis);

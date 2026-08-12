// Shared word-game round runner — the ONE implementation behind both the
// popup's Learn tab and the learn.html trainer. Session build, card render,
// answer handling (incl. wrong-reveal + requeue), the speed ring, dots,
// streak, round end + records (fresh-read RMW), and the enrich-pointing
// empty state all live here now — extracted from what used to be a
// byte-for-byte duplicate of this whole section in popup.js and learn.js
// (word-game step 2, task 1; see the step-2 plan §T1 + its task report).
//
// Hosts supply chrome plumbing (storage, messaging) and keep their own DOM
// chrome (deck cards, scope sheet, entry buttons, the arcade↔game-view
// transition points); this module owns the round's DOM and flow exclusively
// via one entry point, SV_GAMEUI.start() — see its jsdoc below for the full
// adapter contract, and SKIN just below for the two hosts' small, genuine
// pixel/class differences (popup.html is a cramped extension popup, learn.html
// is a roomier full page) — preserved exactly as each host already rendered
// them, never standardized to either side.
(function (g) {
  const SKIN = {
    popup: {
      wordRowMargin: "4px 0 12px",
      emptyStateClass: "",
      emptyStateStyle: "text-align:center; color:var(--muted); padding:20px 0;",
      nextBtnMarginTop: "10px",
      roundEnd: {
        metaStyle: "text-align:center; color:var(--muted); font-size:11.5px; margin-top:6px;",
        stripStyle: "text-align:center; color:var(--muted); font-size:11px; margin-top:10px;",
        missedLblStyle: "margin-top:14px;", // rest of .lbl's look comes from popup.html's own CSS class
        missedRowMarginTop: "8px",
        missedWordStyle: "font-weight:700; font-size:13px;",
        btnRowMarginTop: "16px",
        doneBtnClass: "btn ghost",
      },
    },
    learn: {
      wordRowMargin: "4px 0 14px",
      emptyStateClass: "empty-state",
      emptyStateStyle: "",
      nextBtnMarginTop: "12px",
      roundEnd: {
        metaStyle: "text-align:center; color:var(--muted); font-size:12px; margin-top:8px;",
        stripStyle: "text-align:center; color:var(--muted); font-size:12px; margin-top:12px;",
        missedLblStyle: "margin-top:18px; font-size:12.5px; font-weight:700; color:var(--ink-2);",
        missedRowMarginTop: "10px",
        missedWordStyle: "font-weight:700; font-size:14px;",
        btnRowMarginTop: "18px",
        doneBtnClass: "btn-secondary",
      },
    },
  };

  const RECORD_LABEL = { streak: "New streak record!", bestRound: "New best round!", fastestPerfect: "Fastest perfect round!", speedBonuses: "Most speed bonuses in a round!" };
  const todayKey = () => new Date().toLocaleDateString("sv"); // "sv" formats as YYYY-MM-DD — the local ISO day key

  let current = null;       // the active adapter from the most recent start() call — see start()'s jsdoc
  let gameSession = null;   // { lang, scope, pool, queue, i, correct, streak, speedBonuses, missed, missedKeys, startedAt }
  let ringDeadline = 0;     // Date.now() cutoff for the current card's ⚡ speed-bonus window
  let ringRAF = 0;
  let advanceTimer = 0;     // pending 800ms auto-advance after a correct answer — cleared on any round teardown
  let backBound = false;    // ← Done is static HTML — bind its listener once, not on every start()
  let introCache = null;    // {lang: {day, count}} — seeded once from the host's cached gameIntro, kept
                             // current internally afterward (bumpIntro) so a second round played in the
                             // same page session sees what the first one already introduced today
  let lastRecords = null;   // {lang, records} from the most recently completed round (endRound) this session

  function qs(id) { return ((current && current.mount) || document).querySelector("#" + id); }
  function reducedMotion() { return !!(current.ui && typeof current.ui.reducedMotion === "function" && current.ui.reducedMotion()); }
  function skin() { return SKIN[(current.ui && current.ui.host) || "popup"] || SKIN.popup; }

  /**
   * Start (or restart) a round — call again with the same lang/scope for
   * "One more round", or a different lang/scope for a fresh "Play".
   *
   * opts:
   *   mount              element/document to resolve round-view ids within (both hosts pass `document`)
   *   cards               full VOCAB_LIST array (every language) — filtered here to `lang` to build the round pool
   *   lang                 language code for this round
   *   scope                {source, minLevel, pos}
   *   perDay                new-words/day pace for this lang (host resolves the default: gamePaceAll[lang] || 20)
   *   introSeed              host's own cached gameIntro map ({lang:{day,count}}) — used to seed this module's
   *                           internal count exactly once per page load; kept current internally afterward
   *   storage: {get, set}     promise-returning wrap of chrome.storage.local.get/set
   *   send                     host's existing promise-returning wrap of chrome.runtime.sendMessage
   *   foldEl                    optional DOM node hidden while the round plays, shown again back in the arcade
   *                              (popup: the video-words fold's ancestor <section>; learn: #scheduleFold)
   *   onExit                     ({lang, records} = {}) => void — called once the arcade DOM is restored;
   *                               `records` carries the freshly-written per-lang gameRecords object whenever a
   *                               round actually completed since the last exit, so the host can refresh its
   *                               own cached copy (e.g. a deck card's records strip) before it re-renders
   *   ui.reducedMotion             () => boolean
   *   ui.host                       "popup" | "learn" — selects the two hosts' pixel-identical-to-today skin
   */
  function start(opts) {
    current = opts;
    if (introCache === null) introCache = { ...(opts.introSeed || {}) };
    if (!backBound) { const b = qs("gameBack"); if (b) b.addEventListener("click", backToArcade); backBound = true; }
    startGameWithScope(opts.lang, opts.scope);
  }

  function isActive() { return !!gameSession; }

  function startGameWithScope(lang, scope) {
    clearTimeout(advanceTimer);
    current.lang = lang; current.scope = scope;
    const pace = current.perDay;
    const dayKey = todayKey();
    const introEntry = introCache[lang];
    const introducedToday = introEntry && introEntry.day === dayKey ? introEntry.count : 0;
    const pool = (current.cards || []).filter((c) => c.lang === lang);
    const built = SV_GAME.buildSession({ cards: pool, scope, perDay: pace, introducedToday, now: Date.now(), rng: Math.random, size: 10 });
    gameSession = {
      lang, scope, pool,
      queue: built.items.slice(),
      originalTotal: built.items.length, // fixed at start — requeues grow queue.length, this doesn't
      i: 0, correct: 0, streak: 0, speedBonuses: 0,
      missed: [], missedKeys: new Set(),
      startedAt: Date.now(),
    };
    qs("arcade").hidden = true;
    if (current.foldEl) current.foldEl.hidden = true;
    qs("gameView").hidden = false;
    qs("gameRing").hidden = true;
    renderCard();
  }

  function backToArcade() {
    gameSession = null;
    stopRing();
    clearTimeout(advanceTimer);
    qs("gameView").hidden = true;
    qs("arcade").hidden = false;
    if (current.foldEl) current.foldEl.hidden = false;
    const onExit = current.onExit;
    const payload = lastRecords && lastRecords.lang === current.lang ? { lang: current.lang, records: lastRecords.records } : { lang: current.lang };
    if (onExit) onExit(payload);
  }

  function renderDots() {
    const wrap = qs("gameDots");
    wrap.innerHTML = "";
    gameSession.queue.forEach((_, idx) => {
      const d = document.createElement("span");
      if (idx < gameSession.i) d.className = "done";
      else if (idx === gameSession.i) d.className = "current";
      wrap.appendChild(d);
    });
  }

  function stopRing() {
    if (ringRAF) cancelAnimationFrame(ringRAF);
    ringRAF = 0;
  }
  function startRing() {
    const ring = qs("gameRing");
    const RING_MS = 6000;
    ringDeadline = Date.now() + RING_MS;
    // Reduced motion: no sweep to watch, but the ⚡ speed-bonus window still
    // runs off ringDeadline underneath — the mechanic isn't purely decorative.
    if (reducedMotion()) { ring.hidden = true; return; }
    ring.hidden = false;
    ring.style.setProperty("--gr", "1");
    const tick = () => {
      const frac = Math.max(0, (ringDeadline - Date.now()) / RING_MS);
      ring.style.setProperty("--gr", String(frac));
      if (frac > 0) ringRAF = requestAnimationFrame(tick);
    };
    ringRAF = requestAnimationFrame(tick);
  }

  // Sentence with its target word lit amber, no surrounding quote marks at all
  // (design spec §1/§2). The inline style below matches learn.html's
  // ".gsent mark, .gsent .amk" CSS rule value-for-value (verified) — one
  // mechanism for both hosts, same rendered result either way.
  function gameSentenceEl(sentence, word) {
    const s = document.createElement("div");
    s.className = "gsent";
    const txt = sentence || "";
    const i = word ? txt.toLowerCase().indexOf(String(word).toLowerCase()) : -1;
    if (i < 0) { s.textContent = txt; return s; }
    s.append(txt.slice(0, i));
    const m = document.createElement("mark");
    m.style.cssText = "background:transparent; color:var(--amber-600); font-style:normal; font-weight:600;";
    m.textContent = txt.slice(i, i + word.length);
    s.append(m, txt.slice(i + word.length));
    return s;
  }

  // mm:ss for the find-card source citation ("you heard it in <title> at 04:12") —
  // minutes zero-padded too, matching the design spec's own example.
  function fmtMmSs(ms) {
    const totalSec = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0");
  }

  // Renders SV_GAME.builderHint/gapRule's array as stacked lines inside ONE
  // "ghint" container — the container keeps its existing styling (margin,
  // muted color), each line is its own textContent div underneath it.
  function renderHintLines(lines) {
    const hint = document.createElement("div");
    hint.className = "ghint";
    for (const line of lines || []) {
      const l = document.createElement("div");
      l.textContent = line;
      hint.appendChild(l);
    }
    qs("gameBody").appendChild(hint);
  }

  // Explicit ✗/✓ verdict — the FIRST thing appended to the feedback area for
  // EVERY card kind, both outcomes (playtest fix: a wrong grade must never
  // hide behind color-only cues — e.g. find's flashed-then-cleared wrong tap
  // otherwise leaves no visible trace once the eventual right tap lands —
  // and a correct-answer restatement, like builder's solution line below,
  // must never read as ambiguous praise). Same technique as wordCorrectBlock's
  // ✓ line below: inline style copied from .gopt.hit/.gopt.miss's own
  // declared colors — no CSS file touched. Short, symbol-led, no stress framing.
  // `text` overrides the default copy — word cards' retry mechanic uses this
  // for "✗ Not quite — try again"; every other caller omits it unchanged.
  function verdictLine(ok, text) {
    const v = document.createElement("div");
    v.className = "gopt";
    v.style.cssText = ok
      ? "background: var(--teal-100); color: var(--teal-600); font-weight: 700; cursor: default;"
      : "background: var(--coral-100); color: var(--coral-600); font-weight: 700; cursor: default;";
    v.textContent = text || (ok ? "✓" : "✗ Not quite");
    return v;
  }

  function renderCard() {
    const s = gameSession;
    if (!s.queue.length) return renderEmptyRound();
    if (s.i >= s.queue.length) return endRound();
    const card = s.queue[s.i];
    renderDots();
    qs("gameStreak").textContent = s.streak > 0 ? "🔥 " + s.streak : "";
    const body = qs("gameBody");
    body.innerHTML = "";

    // Kind picked per card at render time — mixing (or Words only / Sentences
    // only via the Game scope row) never changes buildSession's pool, only
    // which of the 4 templates a given card renders as this time round.
    const gameMode = (s.scope && s.scope.game) || "mixed";
    const kind = SV_GAME.pickKind(card, gameMode, Math.random);
    if (kind === "builder") renderBuilderCard(card, SV_GAME.builderFor(card, Math.random), body);
    else if (kind === "gap") renderGapCard(card, SV_GAME.gapFor(card), body);
    else if (kind === "find") renderFindCard(card, SV_GAME.findFor(card), body);
    else renderWordCard(card, body);

    if (!reducedMotion()) { body.classList.remove("gpop"); void body.offsetWidth; body.classList.add("gpop"); }
    startRing();
  }

  // ── Card type 1: word (meaning choice, retry-until-found) ───────────────────
  // The Leitner grade — and the speed-ring bonus — commit on the FIRST tap
  // only (ok = whether THAT tap was correct; identical semantics to find's
  // first-tap-decides). A wrong tap strikes that option and shows its own 💡
  // lesson, replacing any earlier one (only one shown at a time) — it never
  // reveals the correct answer or offers Next, so the player keeps guessing
  // among what's left, converging within at most 3 wrong taps. The eventual
  // correct tap — whichever attempt it is — shows the rich teaching block
  // (wordCorrectBlock); only a FIRST-try correct auto-advances, otherwise the
  // player reads the block via Next → (playtest fix: retry + rich block).
  function renderWordCard(card, body) {
    const s = gameSession;
    body.appendChild(gameSentenceEl(card.sentence, card.word));

    const wordRow = document.createElement("div");
    wordRow.style.cssText = "display:flex; align-items:center; gap:8px; margin:" + skin().wordRowMargin + ";";
    const wordEl = document.createElement("span");
    wordEl.className = "gword";
    wordEl.textContent = card.art ? card.art + " " + card.word : card.word;
    wordRow.appendChild(wordEl);
    if (card.cefr && card.cefr !== "?") {
      const lvl = document.createElement("span");
      lvl.className = "lvl";
      lvl.textContent = card.cefr;
      wordRow.appendChild(lvl);
    }
    body.appendChild(wordRow);

    // Options reshuffle position AND distractor set every appearance (spec §2).
    const picks = SV_GAME.distractors(card, s.pool, Math.random, 3);
    const options = SV_GAME.shuffle([card.meaning, ...picks], Math.random);
    const optWrap = document.createElement("div");
    const optionButtons = [];

    let graded = false;       // has the grade-deciding first tap happened yet?
    let firstTryOk = false;   // was THAT tap correct? — the only thing auto-advance depends on
    let firstTryFast = false; // was it within the ring? — the +1 badge only ever reflects the first tap
    let feedback = null;      // current verdict+lesson block — swapped wholesale, never stacked

    function swapFeedback(node) {
      if (feedback) feedback.remove();
      feedback = node;
      optWrap.appendChild(feedback);
    }

    async function onTap(picked, btn) {
      if (btn.disabled) return; // an already-struck option, or a resolved round, is inert
      const isCorrect = picked === card.meaning;

      if (!graded) {
        graded = true;
        firstTryOk = isCorrect;
        firstTryFast = Date.now() < ringDeadline;
        stopRing();
        await gradeCard(card, isCorrect);
        // Round exited mid-grade (← Done during this await) — same race the
        // pre-retry code guarded per-function; one check here covers it all,
        // since every later tap in this closure is fully synchronous (no
        // further await), so this is the ONLY staleness window that exists.
        if (gameSession !== s) return;
        settleAnswer(s, { ok: isCorrect, fast: firstTryFast });
        if (!isCorrect) { recordMiss(s, card); requeueCard(s, card); }
      }

      btn.disabled = true;
      if (isCorrect) {
        btn.classList.add("hit");
        if (!reducedMotion()) btn.classList.add("gpop");
        if (firstTryOk) showPlusOne(btn, firstTryFast); // scoring was already decided on the first tap
        swapFeedback(wordCorrectBlock(card));
        for (const b of optionButtons) b.disabled = true; // resolved — no more taps
        if (firstTryOk) {
          advanceTimer = setTimeout(() => { advanceTimer = 0; if (gameSession !== s) return; s.i++; renderCard(); }, 800);
        } else {
          showNextButton(); // found it, but not on the first try — let them read
        }
      } else {
        btn.classList.add("miss");
        if (!reducedMotion()) btn.classList.add("gshake");
        swapFeedback(wordWrongLesson(s, card, picked));
      }
    }

    for (const meaning of options) {
      const opt = document.createElement("button");
      opt.className = "gopt";
      opt.dir = "auto";
      opt.textContent = meaning;
      opt.addEventListener("click", () => onTap(meaning, opt));
      optionButtons.push(opt);
      optWrap.appendChild(opt);
    }
    body.appendChild(optWrap);
  }

  // ── Card type 2: sentence builder ───────────────────────────────────────────
  // Tap a tray chip → moves into the answer strip in tap order; tap a placed
  // chip → returns it to the tray. Check fires automatically once every chip
  // is placed (no explicit submit button) — correctness is judged against
  // `built.solution` array equality, never a rejoin-and-compare-strings shortcut
  // (see task-2 report: solution.join(" ") rebuilding the sentence is whitespace-
  // tokenization coincidence, not a contract).
  function renderBuilderCard(card, built, body) {
    const transEl = document.createElement("div");
    transEl.className = "gsent";
    transEl.dir = "auto";
    transEl.textContent = card.sentenceT || card.meaning || "";
    body.appendChild(transEl);

    const strip = document.createElement("div");
    strip.className = "gstrip";
    body.appendChild(strip);

    const tray = document.createElement("div");
    tray.className = "gtray";
    body.appendChild(tray);

    let locked = false;

    function trayChip(text) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "gopt gchip";
      chip.textContent = text;
      chip.addEventListener("click", () => {
        if (locked) return;
        chip.remove();
        strip.appendChild(stripChip(text));
        if (strip.children.length === built.chips.length) checkBuilder();
      });
      return chip;
    }
    function stripChip(text) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "gopt gchip placed";
      chip.textContent = text;
      chip.addEventListener("click", () => {
        if (locked) return;
        chip.remove();
        tray.appendChild(trayChip(text));
      });
      return chip;
    }
    for (const c of built.chips) tray.appendChild(trayChip(c));

    async function checkBuilder() {
      locked = true;
      const withinRing = Date.now() < ringDeadline;
      stopRing();
      strip.classList.add("glocked");
      tray.classList.add("glocked");
      const order = [...strip.children].map((c) => c.textContent);
      const ok = order.length === built.solution.length && order.every((t, i) => t === built.solution[i]);
      const s = gameSession;
      await gradeCard(card, ok);
      if (ok) {
        strip.classList.add("hit");
        if (!reducedMotion()) strip.classList.add("gpop");
        settleAnswer(s, { ok: true, fast: withinRing });
        qs("gameBody").appendChild(verdictLine(true));
        advanceTimer = setTimeout(() => { advanceTimer = 0; if (gameSession !== s) return; s.i++; renderCard(); }, 800);
      } else {
        // The user's OWN built order stays visible exactly as tapped — the
        // strip keeps its "miss" (coral) state, untouched below — so a wrong
        // attempt is never silently replaced by the correct one.
        strip.classList.add("miss");
        if (!reducedMotion()) strip.classList.add("gshake");
        settleAnswer(s, { ok: false });
        recordMiss(s, card);
        qs("gameBody").appendChild(verdictLine(false));
        renderHintLines(SV_GAME.builderHint(card));
        // Explicit "✓ correct order:" label — an unlabeled teal sentence
        // here previously read as ambiguous praise (playtest fix): the user
        // couldn't tell whether it was celebrating their (wrong) input or
        // correcting it.
        const correctRow = document.createElement("div");
        correctRow.className = "gcorrect";
        correctRow.textContent = "✓ correct order: " + built.solution.join(" ");
        qs("gameBody").appendChild(correctRow);
        requeueCard(s, card);
        showNextButton();
      }
    }
  }

  // ── Card type 3: grammar gap (article) ──────────────────────────────────────
  // before/after are exact slices of card.sentence (gapFor's contract) — render
  // verbatim, never rejoined, so original spacing/casing survives untouched.
  function renderGapCard(card, gap, body) {
    const sentEl = document.createElement("div");
    sentEl.className = "gsent";
    sentEl.append(gap.before);
    const blank = document.createElement("span");
    blank.className = "ggap";
    sentEl.append(blank);
    sentEl.append(gap.after);
    body.appendChild(sentEl);

    const row = document.createElement("div");
    row.className = "gartrow";
    for (const opt of gap.options) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "gopt gart";
      btn.textContent = opt;
      btn.addEventListener("click", () => handleGapAnswer(card, gap, opt, row));
      row.appendChild(btn);
    }
    body.appendChild(row);
  }

  async function handleGapAnswer(card, gap, picked, row) {
    const withinRing = Date.now() < ringDeadline;
    stopRing();
    [...row.children].forEach((btn) => { btn.disabled = true; });
    const pickedBtn = [...row.children].find((btn) => btn.textContent === picked);
    const correctBtn = [...row.children].find((btn) => btn.textContent === gap.correct);
    const ok = picked === gap.correct;
    const s = gameSession;

    await gradeCard(card, ok);

    if (ok) {
      pickedBtn.classList.add("hit");
      if (!reducedMotion()) pickedBtn.classList.add("gpop");
      settleAnswer(s, { ok: true, fast: withinRing });
      showPlusOne(pickedBtn, withinRing);
      qs("gameBody").appendChild(verdictLine(true));
      advanceTimer = setTimeout(() => { advanceTimer = 0; if (gameSession !== s) return; s.i++; renderCard(); }, 800);
    } else {
      pickedBtn.classList.add("miss");
      if (!reducedMotion()) pickedBtn.classList.add("gshake");
      if (correctBtn) correctBtn.classList.add("hit");
      settleAnswer(s, { ok: false });
      recordMiss(s, card);
      qs("gameBody").appendChild(verdictLine(false));
      renderHintLines(SV_GAME.gapRule(card));
      requeueCard(s, card);
      showNextButton();
    }
  }

  // ── Card type 4: find it (separable prefix / verb) ──────────────────────────
  // Sentence tokens (builder-tokenizer order, punctuation attached) rendered as
  // tappable inline spans — no pre-marking of the answer (that would give it
  // away). A wrong tap flashes and lets the round continue (no grade, no
  // lockout, ring keeps running); the FIRST tap decides the eventual grade —
  // later taps just help the player find it. Only the correct tap advances.
  // Names the specific target (found.word, from SV_GAME.findFor) instead of
  // a generic "Tap the verb" — ambiguous, and unfairly wrong however the
  // player guessed, on any sentence with more than one verb (playtest fix).
  const ASK_LABEL = {
    prefix: (word) => "Tap the prefix of " + word,
    verb: (word) => "Tap the form of " + word,
  };

  function renderFindCard(card, found, body) {
    let hadWrongTap = false;
    let resolved = false;

    const askLbl = document.createElement("div");
    askLbl.className = "ghint";
    const askLabelFn = ASK_LABEL[found.ask];
    askLbl.textContent = askLabelFn ? askLabelFn(found.word) : "Tap the word";
    body.appendChild(askLbl);

    const sentEl = document.createElement("div");
    sentEl.className = "gsent";
    const btns = [];
    found.tokens.forEach((tok, idx) => {
      if (idx) sentEl.append(" ");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "gtok";
      btn.textContent = tok;
      btn.addEventListener("click", () => onTap(idx, btn));
      btns.push(btn);
      sentEl.appendChild(btn);
    });
    body.appendChild(sentEl);

    async function onTap(idx, btn) {
      if (resolved) return;
      if (idx !== found.answerIndex) {
        hadWrongTap = true;
        btn.classList.add("miss");
        if (!reducedMotion()) { btn.classList.remove("gshake"); void btn.offsetWidth; btn.classList.add("gshake"); }
        setTimeout(() => btn.classList.remove("miss", "gshake"), 350);
        return;
      }
      resolved = true;
      const withinRing = Date.now() < ringDeadline;
      stopRing();
      btns.forEach((b) => { b.disabled = true; });
      btn.classList.add("hit");
      if (!reducedMotion()) btn.classList.add("gpop");
      const ok = !hadWrongTap;
      const s = gameSession;

      await gradeCard(card, ok);

      // A wrong grade must stay visible: the flash on an earlier wrong tap
      // already cleared itself, and the final tap always lands on the
      // (now teal) correct token either way — without this line the round
      // silently graded "wrong" behind what looked like a normal correct tap.
      qs("gameBody").appendChild(verdictLine(ok));

      if (ok) {
        settleAnswer(s, { ok: true, fast: withinRing });
        showPlusOne(btn, withinRing);
      } else {
        settleAnswer(s, { ok: false });
        recordMiss(s, card);
        requeueCard(s, card);
      }

      // Post-answer teaching — both outcomes, before the reward/advance:
      // what the tapped token actually IS, and (only when verifiable from
      // this sentence's own tokens) why it sits where it does.
      renderHintLines(SV_GAME.findTeaching(card, found));

      if (card.videoTitle) {
        const reward = document.createElement("div");
        reward.className = "greward";
        let txt = "you heard it in " + card.videoTitle;
        if (card.ms) txt += " at " + fmtMmSs(card.ms);
        reward.textContent = txt;
        qs("gameBody").appendChild(reward);
      }
      advanceTimer = setTimeout(() => { advanceTimer = 0; if (gameSession !== s) return; s.i++; renderCard(); }, 800);
    }
  }

  function renderEmptyRound() {
    qs("gameDots").innerHTML = "";
    qs("gameStreak").textContent = "";
    qs("gameRing").hidden = true;
    const body = qs("gameBody");
    body.innerHTML = "";
    const msg = document.createElement("div");
    const sk = skin();
    if (sk.emptyStateClass) msg.className = sk.emptyStateClass;
    if (sk.emptyStateStyle) msg.style.cssText = sk.emptyStateStyle;
    const s = gameSession;
    const inScope = (s.pool || []).filter((c) => SV_GAME.matchesScope(c, s.scope));
    const hasEnriched = inScope.some((c) => SV_GAME.isEnriched(c));
    msg.textContent = inScope.length && !hasEnriched
      ? "These words need enriching first — open the video's fold or tap ✨ Enrich."
      : "Nothing to play in this scope right now — try widening it.";
    body.appendChild(msg);
    const back = document.createElement("button");
    back.className = "btn-primary";
    back.style.cssText = "display:block; width:100%; margin-top:12px;";
    back.textContent = "← Back";
    back.addEventListener("click", backToArcade);
    body.appendChild(back);
  }

  async function bumpIntro(lang) {
    const dayKey = todayKey();
    // Re-read before writing — a trainer tab can sit open for hours, and a
    // boot-time-only copy would otherwise clobber a fresher count from the popup.
    const g2 = await current.storage.get(["gameIntro"]);
    const gameIntroAll = g2.gameIntro || {};
    const cur = gameIntroAll[lang];
    const next = cur && cur.day === dayKey ? { day: dayKey, count: cur.count + 1 } : { day: dayKey, count: 1 };
    gameIntroAll[lang] = next;
    introCache[lang] = next; // keep this session's in-memory count current too — see start()'s introSeed doc
    await current.storage.set({ gameIntro: gameIntroAll });
  }

  // Every answer commits instantly (closing the tab/popup mid-round loses
  // nothing) — the grade itself always goes through VOCAB_GRADE/SV_LEITNER.grade
  // worker-side.
  async function gradeCard(card, ok) {
    const wasNew = SV_GAME.status(card) === "new";
    const resp = await current.send({ type: "VOCAB_GRADE", key: card.key, ok });
    if (resp && resp.card) Object.assign(card, resp.card);
    if (wasNew) await bumpIntro(card.lang); // first grade of a "new" card counts as introduced
  }

  // Same per-answer streak/correct/speedBonus bookkeeping was duplicated
  // across all 4 kind handlers (and was exactly why fixing the auto-advance
  // race turned into a 4-site sweep) — one helper now, called with the
  // captured session `s`, never the global.
  function settleAnswer(s, { ok, fast }) {
    if (ok) {
      s.streak++; s.correct++;
      if (fast) s.speedBonuses++;
      qs("gameStreak").textContent = "🔥 " + s.streak + (fast ? " ⚡" : "");
    } else {
      s.streak = 0;
      qs("gameStreak").textContent = "";
    }
  }

  // recordMiss/requeueCard take the CAPTURED session `s` (not the global
  // `gameSession`) and bail out if it's gone stale — the global is
  // reassigned (to null by backToArcade, or to a new round's session) by the
  // time these run whenever the user hits "← Done" during a gradeCard()
  // await. Reading the global directly here used to throw in exactly that
  // sequence (review fix round 1). renderWordCard's onTap() checks the same
  // staleness once, right after its own gradeCard() await, before calling
  // either of these — every other tap in that closure is fully synchronous.
  function recordMiss(s, card) {
    if (!s || gameSession !== s) return;
    if (s.missedKeys.has(card.key)) return; // unique per round, however many times it's missed
    s.missedKeys.add(card.key);
    s.missed.push({ word: card.word, meaning: card.meaning, sentence: card.sentence, para: card.para });
  }

  function requeueCard(s, card) {
    if (!s || gameSession !== s) return;
    const pos = Math.min(s.queue.length, s.i + 4); // 3 cards in between before it comes back around
    s.queue.splice(pos, 0, card);
  }

  function showPlusOne(btn, withinRing) {
    if (reducedMotion()) return;
    const badge = document.createElement("span");
    badge.className = "gpop";
    badge.style.cssText = "float:right; font-weight:800;";
    badge.textContent = withinRing ? "+1 ⚡" : "+1";
    btn.appendChild(badge);
  }

  // The resolution block for renderWordCard — replaces the old bare
  // "✓ word=meaning" pairing line with a richer one. Line 1 is always
  // "✓ <word> = <meaning>" (teal, same visual family as .hit — inline style
  // copied from .gopt.hit, no CSS file touched); line 2 is the sentence's
  // own translation when the card carries one (card.sentenceT); line 3 is
  // the simple-language paraphrase ("≈ ") when present. Never bare when
  // either exists; cleanly minimal (just line 1) when neither does. One
  // wrapper div so onTap's swapFeedback can remove the whole thing as a unit
  // (playtest fix: rich correct-answer teaching block).
  function wordCorrectBlock(card) {
    const wrap = document.createElement("div");
    const head = document.createElement("div");
    head.className = "gopt";
    head.style.cssText = "background: var(--teal-100); color: var(--teal-600); font-weight: 700; cursor: default;";
    head.textContent = "✓ " + card.word + " = " + card.meaning;
    wrap.appendChild(head);
    if (card.sentenceT) {
      const tr = document.createElement("div");
      tr.className = "gsent";
      tr.dir = "auto";
      tr.textContent = card.sentenceT;
      wrap.appendChild(tr);
    }
    if (card.para) {
      const pa = document.createElement("div");
      pa.className = "ghint";
      pa.textContent = "≈ " + card.para;
      wrap.appendChild(pa);
    }
    return wrap;
  }

  // One wrong tap's lesson for renderWordCard: the tapped distractor's own
  // word, found by tracing its meaning back to the pool card it came from
  // ("💡 <meaning> = <its word> — <its sentence>"), preceded by the calm
  // retry verdict. The correct answer is deliberately never named here —
  // revealing it would defeat the retry mechanic, since the player is meant
  // to keep guessing among what's left; that only ever appears once they
  // find it, via wordCorrectBlock. One wrapper div, same swap-as-a-unit
  // reason as wordCorrectBlock above (playtest fix: retry mechanic).
  function wordWrongLesson(s, card, picked) {
    const wrap = document.createElement("div");
    wrap.appendChild(verdictLine(false, "✗ Not quite — try again"));
    const owner = s.pool.find((c) => c !== card && (c.meaning || "").trim() === picked);
    const reveal = document.createElement("div");
    reveal.className = "gopt reveal";
    const parts = ["💡 " + picked];
    if (owner) {
      parts.push(" = " + owner.word);
      if (owner.sentence) parts.push(" — " + owner.sentence);
    }
    reveal.textContent = parts.join(""); // textContent composition — never innerHTML for word-derived text
    wrap.appendChild(reveal);
    return wrap;
  }

  function showNextButton() {
    const body = qs("gameBody");
    const next = document.createElement("button");
    next.className = "btn-primary";
    next.style.cssText = "display:block; width:100%; margin-top:" + skin().nextBtnMarginTop + ";";
    next.textContent = "Next →";
    next.addEventListener("click", () => { gameSession.i++; renderCard(); });
    body.appendChild(next);
  }

  async function endRound() {
    stopRing();
    const s = gameSession;
    const seconds = Math.round((Date.now() - s.startedAt) / 1000);
    // total = the round's ORIGINAL size, not the live queue — requeues grow
    // queue.length on every miss, which would understate the score (e.g. a
    // 4-card round with one miss-then-retry showed "4/5" instead of "4/4").
    // perfect still reads the live queue: it only ever equals s.correct when
    // no requeue happened at all, i.e. zero mistakes anywhere in the round.
    const round = { correct: s.correct, total: s.originalTotal, seconds, perfect: s.correct === s.queue.length, speedBonuses: s.speedBonuses };
    const dayKey = todayKey();
    const g2 = await current.storage.get(["gameRecords"]); // re-read: see bumpIntro comment
    const gameRecordsAll = g2.gameRecords || {};
    const { records, newRecords } = SV_GAME.updateRecords(gameRecordsAll[s.lang] || {}, round, dayKey);
    gameRecordsAll[s.lang] = records;
    await current.storage.set({ gameRecords: gameRecordsAll });
    lastRecords = { lang: s.lang, records };
    renderRoundEnd(round, records, newRecords, s);
  }

  function renderRoundEnd(round, records, newRecords, s) {
    qs("gameDots").innerHTML = "";
    qs("gameStreak").textContent = "";
    qs("gameRing").hidden = true;
    const body = qs("gameBody");
    body.innerHTML = "";
    const sk = skin().roundEnd;

    const ring = document.createElement("div");
    ring.className = "ringbig";
    ring.style.setProperty("--gr", String(round.total ? round.correct / round.total : 0));
    const ringLbl = document.createElement("span");
    ringLbl.textContent = round.correct + "/" + round.total;
    ring.appendChild(ringLbl);
    body.appendChild(ring);

    const meta = document.createElement("div");
    meta.style.cssText = sk.metaStyle;
    meta.textContent = round.seconds + "s" + (round.speedBonuses ? " · ⚡" + round.speedBonuses : "");
    body.appendChild(meta);

    // Records strip — quiet meta, not a stress number: day streak, best round,
    // fastest perfect (design spec §2). Records only ever celebrate. bestRound
    // is a bare correct-count with no stored denominator, and it can be from a
    // DIFFERENT (larger or smaller) round than the one just played — pairing it
    // with round.total can read as "best round 8/3". No denominator at all,
    // not even this round's, is the only honest option.
    const stripBits = [];
    if (records.streakDays) stripBits.push(records.streakDays + "-day streak");
    if (records.bestRound) stripBits.push("best round: " + records.bestRound);
    if (records.fastestPerfectSec) stripBits.push("fastest perfect " + records.fastestPerfectSec + "s");
    if (stripBits.length) {
      const strip = document.createElement("div");
      strip.style.cssText = sk.stripStyle;
      strip.textContent = stripBits.join(" · ");
      body.appendChild(strip);
    }

    if (newRecords.length) {
      const banner = document.createElement("div");
      banner.className = "recordbanner" + (reducedMotion() ? "" : " gslide");
      banner.textContent = "🏆 " + newRecords.map((k) => RECORD_LABEL[k] || k).join(" · ");
      body.appendChild(banner);
    }

    if (s.missed.length) {
      const lbl = document.createElement("div");
      lbl.className = "lbl";
      lbl.style.cssText = sk.missedLblStyle;
      lbl.textContent = "Missed this round";
      body.appendChild(lbl);
      for (const m of s.missed) {
        const row = document.createElement("div");
        row.style.marginTop = sk.missedRowMarginTop;
        const w = document.createElement("div");
        w.style.cssText = sk.missedWordStyle;
        w.textContent = m.word + " · " + m.meaning;
        row.appendChild(w);
        row.appendChild(gameSentenceEl(m.sentence, m.word));
        if (m.para) {
          const p = document.createElement("div");
          p.className = "ghint";
          p.textContent = "≈ " + m.para;
          row.appendChild(p);
        }
        body.appendChild(row);
      }
    }

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex; gap:8px; margin-top:" + sk.btnRowMarginTop + ";";
    const again = document.createElement("button");
    again.className = "btn-primary";
    again.style.flex = "1";
    again.textContent = "One more round";
    again.addEventListener("click", () => startGameWithScope(s.lang, s.scope));
    const done = document.createElement("button");
    done.className = sk.doneBtnClass;
    done.style.flex = "1";
    done.textContent = "Done";
    done.addEventListener("click", backToArcade);
    btnRow.append(again, done);
    body.appendChild(btnRow);
  }

  g.SV_GAMEUI = { start, isActive };
})(globalThis);

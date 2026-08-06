// SubVibe — stopword lists + stopword-based language detection (pure logic,
// node-testable; globalThis pattern like shared/pricing.js). The top ~200
// function words per language: words that never belong in a vocabulary
// trainer. Languages without a list pass every word through.
(function (g) {
  const DE = ("der die das den dem des ein eine einen einem einer eines und oder aber doch denn wenn als wie wo " +
    "was wer wen wem wessen ich du er sie es wir ihr mich dich sich uns euch mir dir ihm ihnen mein dein sein " +
    "unser euer meine deine seine ihre unsere eure meinen deinen seinen ihren nicht kein keine keinen ja nein " +
    "auch noch schon nur sehr so dann da hier dort jetzt heute morgen gestern immer nie mal wieder zu zum zur " +
    "in im ins an am auf aus bei mit nach von vom vor über unter durch für gegen ohne um bis seit ist sind war " +
    "waren bin bist gewesen wird werden wurde wurden worden hat haben hatte hatten habe hast kann können konnte " +
    "konnten muss müssen musste mussten will wollen wollte wollten soll sollen sollte sollten darf dürfen " +
    "durfte mag mögen möchte möchten geht gehen ging gingen gibt geben gab macht machen machte man etwas nichts " +
    "alles alle allem allen jeder jede jedes jeden dieser diese dieses diesen diesem welcher welche welches ob " +
    "weil dass damit deshalb deswegen trotzdem also eben halt ganz mehr weniger viel viele wenig gut besser oben " +
    "unten links rechts her hin weg los ab dazu dabei dafür davon darauf darin darüber daran danach davor " +
    "dahinter warum wieso weshalb wann beim ans aufs übers unters vors hinters durchs fürs ums").split(" ");
  const EN = ("the a an and or but if when as like where what who whom whose why how i you he she it we they " +
    "me him her us them my your his its our their mine yours hers ours theirs this that these those which not " +
    "no nor yes also still only very so then there here now today tomorrow yesterday always never again to in " +
    "into on at from by with within after of off over under through for against without about until since is " +
    "are was were am be been being will would shall should can could must may might do does did done doing has " +
    "have had having go goes went gone going get gets got gotten give gives gave make makes made making " +
    "say says said see sees saw seen know knows knew known think thinks thought take takes took taken come " +
    "comes came coming want wants wanted use uses used one two three some any all each every this that these " +
    "those out up down more less much many few little good well just than too own same other another such both " +
    "between because while during before once really actually maybe okay oh yeah right let lets us").split(" ");

  const FA = ("از به با که در را و یا اما اگر چون تا هم نه بله آره من تو او ما شما این آن اینجا آنجا حالا الان " +
    "امروز فردا دیروز همیشه هرگز باز دوباره خیلی کم بیشتر کمتر خوب بد بالا پایین چپ راست هست نیست بود نبود " +
    "هستم هستی هستیم هستند شد میشه می‌شه میشد شده باشه باشد بشه بشود کن کنم کنی کنیم کنید کنند کرد کردم کردی " +
    "کردیم کردند کردن داره دارم داری داریم دارید دارند داشت داشتم گفت گفتم میگم می‌گم میگه می‌گه بگو برو بیا " +
    "رفت اومد اومدم میره می‌ره میاد می‌آد چی چه چرا کی کجا چطور چند یه یک دو سه واسه برای روی توی بین بدون " +
    "درباره بعد قبل پیش زیر شاید حتما البته یعنی فقط همین همون دیگه دیگر خب پس ولی اون وقتی چیز چیزی کس کسی " +
    "هیچ همه هر خودم خودت خودش بهش بهم ازش باهاش اینو اونو رو").split(" ");

  const SETS = { de: new Set(DE), en: new Set(EN), fa: new Set(FA) };

  // Stopword set for a language — EMPTY for languages without a list, so every
  // word passes through (the spec's "other languages pass through").
  function set(lang) {
    return SETS[(lang || "").split("-")[0].toLowerCase()] || new Set();
  }

  // Guess a token stream's language from stopword hit-rates. Function words are
  // >25% of natural text; 8% is a safe floor that still rejects name soups.
  // Ties keep the SETS declaration order (de before en, as before fa existed).
  function detect(words) {
    const n = (words || []).length;
    if (!n) return null;
    let best = null, bestHits = 0;
    for (const k in SETS) {
      let hits = 0;
      for (const w of words) if (SETS[k].has(String(w).toLowerCase())) hits++;
      if (hits > bestHits) { best = k; bestHits = hits; }
    }
    return bestHits / n >= 0.08 ? best : null;
  }

  g.SV_STOPWORDS = { set, detect };
})(globalThis);

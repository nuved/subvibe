# Builds data/freq/<lang>.txt: the 20,000 most frequent words per language, one per line, most frequent first
# (line number = frequency rank). Source: wordfreq 3.1.1 (pip install wordfreq==3.1.1), data CC BY-SA 4.0.
# Run: python3 tools/wordfreq/build.py   (from the repo root)
import os, re, wordfreq

N = 20000
SKIP = {"ja", "zh", "bn"}  # ja, zh need a word segmenter; bn vowel signs are marks, which tokenize() splits on
WORD = re.compile(r"^[^\W\d_]+(?:['’‌-][^\W\d_]+)*$")  # letters only, like shared/vocab.js tokenize
out = os.path.join(os.path.dirname(__file__), "..", "..", "data", "freq")
os.makedirs(out, exist_ok=True)
for lang in sorted(wordfreq.available_languages("large")):
    if lang in SKIP:
        continue
    words = [w for w in wordfreq.top_n_list(lang, N * 2, wordlist="large") if WORD.match(w)][:N]
    with open(os.path.join(out, lang + ".txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(words) + "\n")
    print(lang, len(words))

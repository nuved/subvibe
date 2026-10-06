package main

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

// The shape of shared tips, field by field (the extension's EXPLAIN_SCHEMA plus `lines`, the chunk's
// sentences translated). Anything else is dropped; links are refused as spam.

var (
	keyRe  = regexp.MustCompile(`^[0-9a-f]{64}$`)
	langRe = regexp.MustCompile(`(?i)^(?:same|[a-z]{2,3}(?:-[a-z0-9]{2,8})?)$`)
	linkRe = regexp.MustCompile(`(?i)https?://|www\.|\.(?:com|net|org|io|ru|xyz)\b`)
	regs   = map[string]bool{"": true, "formal": true, "neutral": true, "informal": true, "slang": true, "vulgar": true}
	tones  = map[string]bool{"": true, "positive": true, "neutral": true, "negative": true}
)

type Word struct {
	W        string   `json:"w"`
	M        string   `json:"m"`
	Pos      string   `json:"pos"`
	Level    string   `json:"level"`
	Forms    string   `json:"forms"`
	Parts    []string `json:"parts"`
	Register string   `json:"register"`
	Tone     string   `json:"tone"`
	Care     string   `json:"care"`
}

type Tips struct {
	Tr     string   `json:"tr"`
	Simple string   `json:"simple"`
	G      string   `json:"g"`
	Scene  string   `json:"scene"`
	Who    []string `json:"who"`
	Spk    []string `json:"spk"`
	Lang   string   `json:"lang"`
	Words  []Word   `json:"words"`
	Lines  []string `json:"lines"`
}

// str: a string field, trimmed and capped (in characters), with no links. ok=false breaks a rule.
func str(v any, max int, required bool) (string, bool) {
	if v == nil {
		v = ""
	}
	s, isStr := v.(string)
	if !isStr {
		return "", false
	}
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) > max || (required && s == "") || linkRe.MatchString(s) {
		return "", false
	}
	return s, true
}

func strList(v any, n, max int) ([]string, bool) {
	if v == nil {
		return []string{}, true
	}
	arr, isArr := v.([]any)
	if !isArr || len(arr) > n {
		return nil, false
	}
	out := make([]string, 0, len(arr))
	for _, x := range arr {
		s, ok := str(x, max, false)
		if !ok {
			return nil, false
		}
		out = append(out, s)
	}
	return out, true
}

// cleanTips validates a decoded JSON object. withTr=false (SHARE_TRANSLATIONS off) keeps the learning
// layer only: the passage translation, the retelling and the sentence translations are dropped.
func cleanTips(raw any, withTr bool) (*Tips, bool) {
	p, isObj := raw.(map[string]any)
	if !isObj {
		return nil, false
	}
	var t Tips
	var ok [9]bool
	t.Tr, ok[0] = str(p["tr"], 2000, withTr) // without translation sharing an upload carries none
	t.Simple, ok[1] = str(p["simple"], 2000, false)
	t.G, ok[2] = str(p["g"], 3000, false)
	t.Scene, ok[3] = str(p["scene"], 240, false)
	t.Who, ok[4] = strList(p["who"], 4, 60)
	t.Spk, ok[5] = strList(p["spk"], 8, 60)
	t.Lang, ok[6] = str(p["lang"], 12, false)
	t.Lines, ok[7] = strList(p["lines"], 8, 600)
	ok[8] = t.Lang == "" || langRe.MatchString(t.Lang)
	for _, b := range ok {
		if !b {
			return nil, false
		}
	}
	ws, isArr := p["words"].([]any)
	if !isArr || len(ws) > 8 {
		return nil, false
	}
	t.Words = make([]Word, 0, len(ws))
	for _, x := range ws {
		m, isObj := x.(map[string]any)
		if !isObj {
			return nil, false
		}
		var w Word
		var wk [9]bool
		w.W, wk[0] = str(m["w"], 60, true)
		w.M, wk[1] = str(m["m"], 200, true)
		w.Pos, wk[2] = str(m["pos"], 30, false)
		w.Level, wk[3] = str(m["level"], 4, false)
		w.Forms, wk[4] = str(m["forms"], 160, false)
		w.Parts, wk[5] = strList(m["parts"], 4, 40)
		w.Register, wk[6] = str(m["register"], 12, false)
		w.Tone, wk[7] = str(m["tone"], 12, false)
		w.Care, wk[8] = str(m["care"], 160, false)
		for _, b := range wk {
			if !b {
				return nil, false
			}
		}
		if !regs[w.Register] || !tones[w.Tone] {
			return nil, false
		}
		t.Words = append(t.Words, w)
	}
	if !withTr {
		t.stripTranslations()
	} else if t.Tr == "" {
		return nil, false
	}
	if len(t.Words) == 0 && t.G == "" { // nothing to learn from
		return nil, false
	}
	return &t, true
}

func (t *Tips) stripTranslations() { t.Tr, t.Simple, t.Lines = "", "", []string{} }

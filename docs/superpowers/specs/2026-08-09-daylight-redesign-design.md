# SubVibe "Daylight" redesign — design spec

Date: 2026-08-09 · Status: approved by operator (brainstorm session, visual companion)

## Goal

More installs. Two levers, in order: (1) the install funnel — store listing and
first-run experience; (2) a unified design system across all surfaces, which
drives retention and reviews that feed store ranking.

Feature priority everywhere (tabs, screenshots, copy): **Live Translate first,
subtitle translation second, vocabulary/Leitner learning third.**

Standing constraint: the brand and components must not assume video-only. A
future "translate and extract words on any page" feature reuses the same word
card, explain card, CEFR chips and Leitner actions against a text selection.
Nothing video-locked in the brand mark, taglines, or component APIs. That
feature itself is **out of scope** here.

## Approach (decided)

Staged, funnel-first — five phases, each an independently shippable PR:

- **a. Brand foundation** — `styles/tokens.css` (+ `styles/components.css`),
  replacing the three diverging inline palettes.
- **b. Popup restyle + onboarding** — new popup structure on the tokens;
  `welcome.html` first-run flow; adaptive hero.
- **c. Store listing re-shoot** — new screenshots, tile, icon, copy. Install
  impact starts here without waiting for d/e.
- **d. Library + Learn restyle** on the same tokens.
- **e. Overlay alignment** — default karaoke color, word/explain card skin.

Rejected alternatives: big-bang single release (weeks dark, giant PR); quick
re-shoot of the old indigo UI first (double asset work for little gain since a
full listing already exists).

## 1 · Brand foundation ("Daylight")

Direction chosen from three mockups (Signal / Daylight / Prism): **Daylight** —
warm light theme, coral primary, teal secondary, rounded display type. Friendly
and human; fits the learning story; light screenshots stand out on the white
store page where competitors are dark; generalizes beyond video ("watch ·
understand · learn").

### Color tokens — light (brand default)

| Token | Value | Role |
|---|---|---|
| `--bg` | `#FAF6F0` | warm paper canvas |
| `--surface` | `#FFFFFF` | cards, inputs |
| `--surface-2` | `#F3EDE4` | hover, wells |
| `--border` | `#EDE5DA` | hairlines |
| `--ink` | `#241F1A` | primary text (warm near-black) |
| `--ink-2` | `#5B5348` | secondary body text |
| `--muted` | `#8A7F72` | hints, meta |
| `--faint` | `#A39684` | overline labels |
| `--coral-500` | `#F45D48` | brand accents, glows — never small text |
| `--coral-600` | `#C93F2B` | button fills, links (AA with white text) |
| `--coral-100` | `#FDE8E4` | selected chips, soft fills |
| `--teal-600` | `#0D9488` | learning accents (vocab, Leitner, CEFR) |
| `--teal-100` | `#E4F2EF` | soft teal fills |
| `--green-600` | `#15803D` | ok / verified |
| `--red-600` | `#DC2626` | errors, destructive |
| `--amber-600` | `#B45309` | warnings on light surfaces |
| `--karaoke` | `#FFB35C` | karaoke sweep on video (dark scrim only) |

Accent roles, not decoration: **coral = act** (Live, primary buttons, active
nav), **teal = learn** (vocab, CEFR, Leitner). Everything else stays paper+ink.
All text/background pairs must pass WCAG AA (4.5:1 body, 3:1 large).

### Color tokens — dark counterpart

Same token names, swapped under `@media (prefers-color-scheme: dark)`. Warm
stone, not blue-black: `--bg #191512`, `--surface #241F1A`, `--surface-2
#2E2822`, `--border #3A332B`, `--ink #F3EDE4`, coral brightens to `#FF7A66`
(dark ink text on coral fills), teal to `#2DD4BF`. Rationale: SubVibe is used
at night over videos in dark rooms; a white-only popup is hostile there. Light
remains the brand and the only screenshot theme. The on-video overlay ignores
themes entirely — subtitles always render on their own dark scrim.

### Typography

- **Display**: Baloo 2 ExtraBold (already bundled in `fonts/`) — wordmark, tab
  labels, big metric numbers. Never body text.
- **UI**: system stack (as today); Vazirmatn injection for Persian unchanged.
- Scale: 11px/700 caps overline · 12px hints/meta · **13.5px body and labels**
  (up from 13) · 16px/700 section titles · 20px+ page titles · metric numbers
  in Baloo 2. Floor: nothing below 11px (today's 9.5–10.5px sizes are retired).
- Numbers always `tabular-nums`.

### Spacing · radius · shadows · motion

- 4px grid: 4/8/12/16/20/24/32. Section padding 16, card padding 12–16.
- Radius: `--r-sm 8` (buttons, inputs) · `--r-md 12` (cards) · `--r-lg 16`
  (page-level cards) · pill 999 (chips, nav).
- Shadows warm-tinted (brown, not gray): rest `0 1px 2px rgba(93,64,35,.08)`,
  raised `0 6px 18px -4px rgba(93,64,35,.18)`, coral glow `0 6px 18px
  rgba(244,93,72,.28)` — the glow is reserved for exactly one element per
  screen: the Live Translate button.
- Motion: 120ms ease-out hover/press, 180ms panels/folds, 2s breathing glow on
  the Live button while a session runs. Every interactive element has
  rest/hover/focus-visible (2px coral ring)/disabled. `prefers-reduced-motion`
  disables pulse and transitions (pattern already in the codebase — keep).

## 2 · Popup — layout and navigation (structure "A: hero above tabs")

Width **460px** (down from 520). Order top→bottom:

1. **Header**: coral rounded-square logo, Baloo wordmark, one-line scope text
   ("This video: <title> · defaults" — replaces the scope bar), gear icon
   opening the Keys pane. The header 🎓 Learn chip is retired (Learn is a tab).
2. **Hero card** (always visible, every tab): the Live Translate button with
   language pair pill and "🔒 tab audio only" note. Four states:
   - *setup*: replaced by a checklist card ("✓ free styled captions active ·
     ○ translation needs a key → Finish setup") until a key verifies;
   - *ready*: coral button, glow;
   - *running*: breathing pulse + Stop affordance (existing idle-ring/stop UI
     restyled, logic unchanged);
   - *live-elsewhere*: neutral slate, click to stop (existing behavior).
   Audio-language and input-device rows stay inside the hero, collapsed behind
   a "Live settings" fold to keep the card compact.
3. **Tab nav**: quiet pills — **Subtitles · Style · Learn**; active = ink
   capsule with paper text. (Dub tab gone: Live lives above; the hidden TTS
   dub section stays hidden DOM, untouched.)
4. **Panes**: current Translate/Style/Learn pane contents, restyled on tokens.
   White section cards on paper, folds keep chevron pattern. Keys becomes a
   gear-toggled pane (same inputs/IDs).
5. **Footer bar**: today's spend · Library entry (as today, reskinned).

Implementation constraint: **all element IDs and data-attributes referenced by
popup.js are preserved.** This is a restyle + reflow, not a JS rewrite; JS
changes are limited to: tab-bar wiring for the removed Dub tab, gear toggle,
scope-line text, and the setup-state hero swap.

## 3 · First-run & onboarding (decided: welcome page + adaptive hero)

- `welcome.html` + `welcome.js`, opened once from `chrome.runtime.onInstalled`
  (reason `install` only, never on update). Three steps, all skippable:
  1. **Pick your language** — one question; chip grid + search; sets the
     primary translate-to language in defaults.
  2. **Value before any key**: "Open any video — captions get beautiful, free."
     Platform logos + a "Try it on YouTube" button (opens youtube.com); makes
     the free styled-captions mode the first success moment.
  3. **The unlock**: connect a provider key, framed as upgrade ("pay cents
     directly to the provider, nothing to us, replays cached"). Checklist shows
     what's already done. "Later — start watching" is a first-class exit.
- Popup hero doubles as the setup checklist until a key verifies (see §2).
  After first successful verify it never reappears.

## 4 · Store listing (re-shoot + copy rewrite)

Screenshot story, in order (shot 1 carries ~10× the views):

1. **Hero** — real video frame, dual subtitles with karaoke sweep, coral
   waveform motif, wordmark. Line: **"Every video speaks your language."**
2. **Live** — popup mid-session, pulse glow: "Live voice translation for any
   site" (the differentiator).
3. **Subtitles** — platform grid + "40+ languages · your own key · replays
   cached free."
4. **Words** — on-video word card: meaning, CEFR chip, one-tap save.
5. **Learn** — Leitner trainer with real sentences from watched videos.
6. **Trust** — "Your key · your device · no account · no tracking · open
   source." Calls go browser → provider directly.

Copy: name line "SubVibe — Live translation & AI subtitles for any video";
short description "Hear and read any video in your language — live voice
translation, AI subtitles, and a vocabulary trainer built from what you
watch."; long description ordered Live → Subtitles → Style → Learn → Privacy →
sites, single-line scannable bullets, keywords woven naturally (live translate,
AI subtitles, dubbing, language learning, German, Persian, Netflix, YouTube).

Assets: screenshots 1280×800 shot from staged real pages on the Daylight UI;
promo tile 440×280 (paper bg, wordmark, coral waveform mark, hero line);
extension icon refreshed to the Daylight mark (coral rounded square "S",
16/48/128) so the toolbar icon matches the brand. Store dashboard upload
remains the operator's manual step.

## 5 · Library · Learn · Overlay

- **Library**: structure unchanged (sidebar, metric tiles, card grid, Activity
  table). Daylight skin: white sidebar on paper canvas, coral active nav,
  platform spine colors kept, warm shadows. Activity table: hairline rows, no
  zebra, tabular numbers, sticky header. Optional (may ship later within phase
  d): a 14-day spend sparkline in Activity — pure inline SVG, coral bars, no
  chart library.
- **Learn**: material-first. The review card leads with the real sentence
  (word lit in `--amber-600` on light), the word + CEFR chip, then grade
  buttons (Again = coral-100, Got it = teal-100). Stats collapse to one quiet
  strip (due · box movement · streak). Inbox/Dictionary panes reskinned; table
  per the shared table spec.
- **Overlay**: mechanics untouched. Default karaoke sweep becomes `--karaoke
  #FFB35C`; word card and explain-this-line card get the Daylight card skin
  (white, radius 12, warm shadow, teal CEFR chip, coral save action). All
  shipped presets (YouTube, Netflix, TikTok-white, …) render exactly as today.
  Overlay clicks keep the `elementFromPoint` pattern (drag capture retargeting).

## 6 · Shared components (`styles/components.css`)

Consumed by popup, welcome, library, learn (extension pages). The overlay
keeps its own self-contained CSS (content-script world) but uses the same
token values, duplicated knowingly with a comment cross-referencing tokens.css.

- **Buttons**: primary (coral-600 fill/white), secondary (white + border),
  quiet link (coral-600 text), destructive (white + red text/border). Four
  states each; min-height 32px; radius 8.
- **Cards**: white, radius 12–16, warm shadow, optional 3px platform spine.
- **Chips/pills**: neutral (`surface-2`) and selected (coral-100/coral-600 or
  teal-100/teal-600 by role); radius 999.
- **Forms**: white inputs, border `--border`, focus = coral ring; labels
  13.5/600; inline validation text under the field in red-600/green-600;
  selects keep the line-art chevron; toggles teal when on.
- **Tables**: header 11px caps muted, hairline row borders, right-aligned
  tabular numerics, sticky header.
- **Icons**: one inline Lucide-stroke SVG set (currentColor, 1.8 stroke)
  shared across pages; emoji retired from chrome UI (language flags stay).
- **States**: every async view defines loading (skeleton blocks, no spinners),
  empty (one sentence + one action), error (red-600 + retry). No view renders
  blank.

## Acceptance criteria

- Popup opens with no layout shift at exactly 460px; all popup.js
  `getElementById`/query targets resolve (scripted check in the PR).
- Contrast: all text pairs AA (spot-check coral-600/white, muted/paper,
  dark-mode counterparts).
- RTL: Persian strings render correctly in popup, welcome, learn (no
  direction-control characters; logical order).
- `prefers-reduced-motion` and `prefers-color-scheme: dark` verified per page.
- Firefox build (`build.sh`) produces a working popup — same markup/CSS, no
  Chrome-only CSS features without fallback (`color-mix` usage reviewed).
- Overlay presets pixel-match current rendering except the two intended
  changes (karaoke default, card skin).
- Welcome flow: opens once on fresh install, never on update; every step
  skippable; abandoning it leaves the extension fully usable in free mode.

## Out of scope

- Any-page translation/word-extraction feature (constraint only, see Goal).
- Reviving the hidden TTS dub UI; changing pricing/provider logic; renaming
  the extension; version-line scheme (1330.x stays); tribute card (restyle
  only if trivial, behavior untouched).

## Open items for the implementation plan

- Screenshot production tooling: staged HTML pages vs. live-site captures
  (decide in plan; assets sourced under `tools/store/`).
- Whether phase d ships the Activity sparkline or defers it.

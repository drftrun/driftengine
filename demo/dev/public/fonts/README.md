# SDF font atlases for `sdf-text.html`

Generated with `npm run sdf-font` (see `scripts/sdf-font.ts`) from the two system fonts named
below. Each directory holds `atlas.png` (the distance field) and `metrics.json` (glyph planes,
advances and kerning, in the format `src/render/sdfFont.ts` reads). Only the glyphs the demo
actually draws are baked in — not a full character range — which is why both atlases are a few
tens of kilobytes rather than megabytes.

A rasterised, distance-transformed atlas is a derivative of the original font's outlines, so it
carries the original's licence. Both are permissive and both allow this.

## `latin/`

- **Source:** DejaVu Sans, `/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf` (Debian package
  `fonts-dejavu-core`).
- **Licence:** Bitstream Vera License. Free to use, copy, merge, publish and distribute,
  including modified (the DejaVu changes themselves are public domain). Full text:
  `/usr/share/doc/fonts-dejavu-core/copyright` on a Debian/Ubuntu system, or
  <https://dejavu-fonts.github.io/License.html>.
- **Glyphs baked:** `A B C D E G L M N O R T U`, `e f g i n r t`, space, `(`, `)`, `-` — exactly
  what "Drift Engine", "MONTAGEM ABU (…)" and the twelve anchor labels ("L-T", "C-BL", …) need.

Regenerate with:

```sh
npm run sdf-font -- --font /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf \
  --out demo/dev/public/fonts/latin --family "DejaVu Sans" --size 128 \
  --glyphs path/to/latin-glyphs.txt
```

## `arabic-run/`

- **Source:** Noto Sans Arabic, `/usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf`
  (Debian package `fonts-noto-core`).
- **Licence:** SIL Open Font License, Version 1.1. Full text:
  `/usr/share/doc/fonts-noto-core/copyright` on a Debian/Ubuntu system, or
  <https://openfontlicense.org/>.
- **Glyphs baked:** `أ` (U+0623), `ب` (U+0628), `و` (U+0648) — the three characters of `أبو`,
  each rasterised in isolation, as before — plus a fourth cell, `أبو` itself, baked as one
  *run*: the whole string handed to `measureText`/`fillText` at bake time, so the browser's own
  text stack joined the letters into their contextual forms and set them right to left before
  the result was rasterised as a single cell with a single advance.

Regenerate with:

```sh
npm run sdf-font -- --font /usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf \
  --out demo/dev/public/fonts/arabic-run --family "Noto Sans Arabic" --size 128 \
  --glyphs path/to/arabic-glyphs.txt --runs path/to/arabic-runs.txt
```

`arabic-glyphs.txt` is unchanged: the three characters. `arabic-runs.txt` is new and holds one
line, `أبو` — the string `--runs` bakes whole rather than one character at a time; see
`scripts/sdf-font.ts`'s own comment on what a run is and why `--font` is repeatable alongside it.

**What baking a run buys, and what it does not.** The runtime still has no shaping engine —
`SdfTextLayout.set()` draws a string by walking it and matching the longest key it can find in
the glyph table at each position (`SdfFont.runs`). `أبو` is exactly one of the keys baked here,
so a caller handing that exact string to `setSdfText` gets the one glyph cell the browser already
shaped and reordered, drawn as a single quad — joined, right to left, correct. A string that is
*not* one of the runs baked in advance — any Arabic the page did not know about ahead of time,
typed by a user or arriving as data at runtime — still has no run to match, and is still laid out
one code point at a time, left to right, each glyph rasterised alone. Baking more runs does not
change that: a run is a fixed, known string decided before the atlas exists, not a shaping
engine, so a page whose Arabic is data rather than a known string still needs a shaper this
engine does not have. `sdf-text.html` draws both cases side by side — see the comments above
`arabicLabel` and `unshapedLabel` there.

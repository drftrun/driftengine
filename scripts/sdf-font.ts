#!/usr/bin/env node
/**
 * A TTF and a glyph set in, an SDF atlas and its metrics out. Dev-only, never imported.
 *
 * **Rasterise then transform, rather than parse outlines.** Reading a TTF properly means a
 * font parser in `package.json`, and the bar there is high for a thing only the build
 * needs. Drawing each glyph large through the platform's own text stack and running a
 * distance transform over the coverage gives a field good enough for text on a page, with
 * no dependency and no format to keep up with.
 *
 * The cost is honest and worth writing down: an outline-derived field is exact, and this
 * one is as good as the raster it came from. Draw at `--supersample` (default 4) and it
 * holds up to the sizes this engine draws text at. If a face is ever needed at billboard
 * scale, that is when an outline parser earns its place.
 *
 *   npm run sdf-font -- --font ./D4R.ttf --out ./public/fonts --glyphs ./glyphs.txt
 *
 * **The rasteriser runs in headless Chrome**, through the harness this repository already
 * has for `shots.mjs` and `frame-audit.mjs`. Node 22 has no `OffscreenCanvas`, and
 * `png.mjs` decodes PNG but does not encode it; both problems disappear inside a browser,
 * so the font goes in as a `FontFace` data URL and the atlas comes out as
 * `canvas.toDataURL`, decoded back to bytes here. No canvas library, no PNG encoder, no
 * font parser - and so no new entry in `package.json`.
 *
 * There are two round trips into the page rather than one: the first measures every glyph
 * and every kerning pair through `CanvasRenderingContext2D`, which is arithmetic Node needs
 * before it can decide where each glyph sits in the atlas; the second draws and transforms
 * each glyph once its cell is known. The `FontFace` stays registered on the page's own
 * `document.fonts` between the two, so the font is decoded once and drawn from twice.
 *
 * A *run* is an entry that is a whole string rather than one character, given in `--runs`.
 * It is measured and drawn by the same two calls every glyph uses, and that is the point:
 * `measureText` and `fillText` shape, join and reorder whatever string they are handed, so
 * a script the runtime cannot assemble arrives already assembled, as one cell. `--font` is
 * repeatable for the same reason — a face that has the Latin the site wants may have none
 * of the Arabic, and a stack lets the browser pick per character while keeping which face
 * drew what reproducible.
 *
 * Glyph metrics and kerning both come from measuring the browser's own text shaping rather
 * than from a table reader: a glyph's ink box is `TextMetrics.actualBoundingBox*` at a font
 * size chosen to equal `--em`, so a CSS pixel *is* a font unit at that size; a kerning pair's
 * adjustment is the gap between measuring `left+right` together and summing their two
 * advances apart, which is exactly what shaping applied and needs no GPOS reader to find.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { launch } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';
import { packGlyphs, metricsDocument, runSet } from './sdf-font-lib.mjs';
import type { GlyphMetric, KerningPair } from './sdf-font-lib.mjs';

const USAGE =
  'usage: npm run sdf-font -- --font <path.ttf> [--font <fallback.ttf>] --out <dir> --glyphs <path.txt>\n' +
  '  [--runs <path.txt>] [--family "Name"] [--size 512] [--padding 2] [--distance-range 4]\n' +
  '  [--texels-per-em 32] [--supersample 4] [--em 1000]';

interface Args {
  /** Every face, in fallback order. The first is the primary and names the family. */
  readonly fonts: readonly string[];
  readonly out: string;
  readonly glyphs: string;
  readonly runs: string | undefined;
  readonly family: string | undefined;
  readonly atlasWidth: number;
  readonly padding: number;
  readonly distanceRange: number;
  readonly texelsPerEm: number;
  readonly supersample: number;
  readonly unitsPerEm: number;
}

/**
 * `--flag=value`, the form the rest of this repository's tools use, and `--flag value`,
 * the form the usage line above shows - both accepted, so the example above is not a lie.
 * A bare `--flag` with nothing after it, of either shape, is a boolean flag set to true.
 */
function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string>();
  const fonts: string[] = [];
  /* `--font` is the one repeatable flag: a face stack, in fallback order. Every other flag
     keeps last-wins, which is what a Map gives for free. */
  const record = (name: string, value: string): void => {
    if (name === 'font') fonts.push(value);
    else flags.set(name, value);
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (match === null || match[1] === undefined) continue;
    const name = match[1];
    if (match[2] !== undefined) {
      record(name, match[2]);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      record(name, next);
      i++;
    } else {
      record(name, '1');
    }
  }
  const out = flags.get('out');
  const glyphs = flags.get('glyphs');
  if (fonts.length === 0 || out === undefined || glyphs === undefined) {
    throw new Error(`sdf-font: --font, --out and --glyphs are all required.\n${USAGE}`);
  }
  return {
    fonts,
    out,
    glyphs,
    runs: flags.get('runs'),
    family: flags.get('family'),
    atlasWidth: Number(flags.get('size') ?? '512'),
    padding: Number(flags.get('padding') ?? '2'),
    distanceRange: Number(flags.get('distance-range') ?? '4'),
    texelsPerEm: Number(flags.get('texels-per-em') ?? '32'),
    supersample: Number(flags.get('supersample') ?? '4'),
    unitsPerEm: Number(flags.get('em') ?? '1000'),
  };
}

/**
 * Unique characters from a glyph-set file, in the order they first appear.
 *
 * A line ending is formatting the file needed to be readable, not a glyph. Every other
 * character is one, including a literal space - a font's space glyph carries a real advance
 * and belongs in the set the same as any letter.
 */
function glyphSet(text: string): string[] {
  const seen = new Set<string>();
  const chars: string[] = [];
  for (const char of text) {
    if (char === '\n' || char === '\r') continue;
    if (seen.has(char)) continue;
    seen.add(char);
    chars.push(char);
  }
  return chars;
}

interface MeasureJob {
  /** Every face, base64, in fallback order. */
  readonly fontsBase64: readonly string[];
  /** Single characters and pre-shaped runs alike: each is measured as a whole string. */
  readonly entries: readonly string[];
  /** How many leading entries are single characters. Only those get kerning pairs. */
  readonly characterCount: number;
  readonly unitsPerEm: number;
}

interface MeasuredGlyph {
  readonly advance: number;
  readonly planeLeft: number;
  readonly planeBottom: number;
  readonly planeRight: number;
  readonly planeTop: number;
}

interface MeasureResult {
  readonly glyphs: Readonly<Record<string, MeasuredGlyph>>;
  readonly ascender: number;
  readonly descender: number;
  readonly kerning: KerningPair[];
}

/**
 * Register the font once per page and measure every glyph and every kerning pair.
 *
 * No canvas is drawn here - `measureText` alone answers both questions, which is why this
 * is the cheap half of the two round trips and can afford to be O(glyphs²) for kerning.
 */
function measureScript(job: MeasureJob): string {
  return `(async () => {
    const job = ${JSON.stringify(job)};
    if (!window.__sdfFontReady) {
      for (let i = 0; i < job.fontsBase64.length; i++) {
        const face = new FontFace('SdfSource' + i, 'url(data:font/ttf;base64,' + job.fontsBase64[i] + ')');
        await face.load();
        document.fonts.add(face);
      }
      await document.fonts.ready;
      window.__sdfFontReady = true;
    }
    // A CSS font stack, in the order the faces were given. The browser picks a face per
    // character exactly as it does on a page, so a primary that lacks a script falls
    // through to the one that has it, and which face drew what stays reproducible because
    // the stack is stated rather than left to whatever the machine happens to have.
    window.__sdfFontStack = job.fontsBase64.map((_, i) => '"SdfSource' + i + '"').join(', ');

    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = job.unitsPerEm + 'px ' + window.__sdfFontStack;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';

    const glyphs = {};
    for (const entry of job.entries) {
      // A run is measured as a whole string, which is the entire mechanism: the browser
      // joins, reorders and shapes it here, and what comes back is one box and one advance
      // for the finished word.
      const m = ctx.measureText(entry);
      glyphs[entry] = {
        advance: m.width,
        planeLeft: -m.actualBoundingBoxLeft,
        planeBottom: -m.actualBoundingBoxDescent,
        planeRight: m.actualBoundingBoxRight,
        planeTop: m.actualBoundingBoxAscent,
      };
    }

    // Vertical metrics from the *primary* face alone. fontBoundingBox* is a property of
    // whichever face drew the string it was measured against, so measuring it through the
    // stack would let a fallback face decide the line box for the whole font.
    //
    // Still measured against the first entry rather than a literal letter. A face that
    // covers no Latin at all is an ordinary input here (the Arabic-only bake is one), and
    // a hard-coded 'H' would fall through to whatever the machine happens to have and
    // report that font's line box instead. The glyph file is sorted by code point, so the
    // first entry is one the primary face was chosen for.
    const primary = document.createElement('canvas').getContext('2d');
    primary.font = job.unitsPerEm + 'px "SdfSource0"';
    primary.textBaseline = 'alphabetic';
    const fm = primary.measureText(job.entries[0]);
    const ascender = fm.fontBoundingBoxAscent;
    const descender = -fm.fontBoundingBoxDescent;

    // Kerning measured rather than parsed: the browser's own shaping has already applied
    // whatever a GPOS or kern table says about this pair, so the gap between "the pair, set
    // together" and "both advances, summed apart" is exactly that adjustment.
    //
    // Single characters only. A pair that includes a run crosses a script and often a
    // direction, and what measureText reports for "أبو)" is the width after bidi reordering
    // rather than a kerning adjustment. A run already carries its own shaping; treating a
    // reordering artefact as kerning would move the next glyph by a number that means
    // nothing.
    const kerning = [];
    for (let l = 0; l < job.characterCount; l++) {
      const left = job.entries[l];
      const leftAdvance = glyphs[left].advance;
      for (let r = 0; r < job.characterCount; r++) {
        const right = job.entries[r];
        const rightAdvance = glyphs[right].advance;
        const pairAdvance = ctx.measureText(left + right).width;
        const amount = pairAdvance - leftAdvance - rightAdvance;
        if (Math.abs(amount) > 0.5) kerning.push({ left, right, amount });
      }
    }

    return { glyphs, ascender, descender, kerning };
  })()`;
}

/** A glyph's cell in the atlas: its size and its ink's offset within that cell, in texels. */
interface Cell {
  readonly char: string;
  readonly advance: number;
  readonly width: number;
  readonly height: number;
  readonly paddedLeft: number;
  readonly paddedBottom: number;
  readonly paddedTop: number;
}

/**
 * A glyph's ink box, padded by the distance range and snapped to the texel grid, in atlas
 * texels rather than font units. This is the box `packGlyphs` places and the rasteriser
 * draws into - padded, because an SDF needs room outside the ink to show the falloff that
 * makes it one.
 */
function cellFor(char: string, glyph: MeasuredGlyph, scale: number, distanceRange: number): Cell {
  const paddedLeft = Math.floor(glyph.planeLeft * scale - distanceRange);
  const paddedBottom = Math.floor(glyph.planeBottom * scale - distanceRange);
  const paddedRight = Math.ceil(glyph.planeRight * scale + distanceRange);
  const paddedTop = Math.ceil(glyph.planeTop * scale + distanceRange);
  return {
    char,
    advance: glyph.advance,
    width: Math.max(1, paddedRight - paddedLeft),
    height: Math.max(1, paddedTop - paddedBottom),
    paddedLeft,
    paddedBottom,
    paddedTop,
  };
}

interface RasterPlacement {
  readonly char: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly paddedLeft: number;
  readonly paddedTop: number;
}

interface RasterJob {
  readonly atlasWidth: number;
  readonly atlasHeight: number;
  readonly texelsPerEm: number;
  readonly supersample: number;
  readonly distanceRange: number;
  readonly placements: readonly RasterPlacement[];
}

interface RasterResult {
  readonly png: string;
}

/**
 * Draw every glyph into its already-packed cell and run a signed distance transform over
 * each, using the font `measureScript` left registered on this same page.
 */
function rasterizeScript(job: RasterJob): string {
  return `(() => {
    const job = ${JSON.stringify(job)};
    const atlas = document.createElement('canvas');
    atlas.width = job.atlasWidth;
    atlas.height = job.atlasHeight;
    const actx = atlas.getContext('2d', { willReadFrequently: true });
    actx.clearRect(0, 0, job.atlasWidth, job.atlasHeight);

    // Exact squared-distance transform, two 1D passes - columns then rows - each the
    // lower-envelope-of-parabolas method (Felzenszwalb and Huttenlocher). Chosen over an
    // 8-point chamfer approximation because it costs the same and is exact rather than
    // merely close, and over a brute-force nearest-pixel search because that is the one
    // this tool's own brief warns could be "slower than usable": this one is linear in the
    // pixel count, so a few hundred glyphs cost milliseconds rather than minutes.
    function edt1d(f, n) {
      const d = new Float64Array(n);
      const v = new Int32Array(n);
      const z = new Float64Array(n + 1);
      let k = 0;
      v[0] = 0;
      z[0] = -Infinity;
      z[1] = Infinity;
      for (let q = 1; q < n; q++) {
        let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        while (s <= z[k]) {
          k--;
          s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        }
        k++;
        v[k] = q;
        z[k] = s;
        z[k + 1] = Infinity;
      }
      k = 0;
      for (let q = 0; q < n; q++) {
        while (z[k + 1] < q) k++;
        const dx = q - v[k];
        d[q] = dx * dx + f[v[k]];
      }
      return d;
    }

    function edt2d(mask, w, h) {
      const INF = 1e20;
      const g = new Float64Array(w * h);
      const col = new Float64Array(h);
      for (let x = 0; x < w; x++) {
        for (let y = 0; y < h; y++) col[y] = mask[y * w + x] ? 0 : INF;
        const d = edt1d(col, h);
        for (let y = 0; y < h; y++) g[y * w + x] = d[y];
      }
      const out = new Float64Array(w * h);
      const row = new Float64Array(w);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) row[x] = g[y * w + x];
        const d = edt1d(row, w);
        for (let x = 0; x < w; x++) out[y * w + x] = d[x];
      }
      return out;
    }

    for (const g of job.placements) {
      const rasterW = g.width * job.supersample;
      const rasterH = g.height * job.supersample;
      const c = document.createElement('canvas');
      c.width = rasterW;
      c.height = rasterH;
      const cx = c.getContext('2d', { willReadFrequently: true });
      cx.clearRect(0, 0, rasterW, rasterH);
      cx.font = (job.texelsPerEm * job.supersample) + 'px ' + window.__sdfFontStack;
      cx.textBaseline = 'alphabetic';
      cx.textAlign = 'left';
      cx.fillStyle = '#000';
      // The cell's padded-left and padded-top corner is its origin; the glyph's own
      // baseline sits that far inside it, in raster pixels. A run is drawn by the same
      // call: \`fillText\` shapes whatever string it is given, which is why a pre-shaped run
      // needs no shaping engine on this side.
      cx.fillText(g.char, -g.paddedLeft * job.supersample, g.paddedTop * job.supersample);

      // Threshold the anti-aliased raster into a binary mask before transforming it, rather
      // than solving a fractional-coverage field directly. The lost sub-pixel accuracy is
      // exactly what --supersample buys back: at 4x the threshold can only move the edge by
      // a quarter of a texel, which is the trade this whole tool makes in place of an
      // outline reader that would place it exactly.
      const img = cx.getImageData(0, 0, rasterW, rasterH);
      const n = rasterW * rasterH;
      const inside = new Uint8Array(n);
      const outside = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const covered = img.data[i * 4 + 3] > 127;
        inside[i] = covered ? 1 : 0;
        outside[i] = covered ? 0 : 1;
      }
      // Signed by which mask supplied the nearest edge: positive inside the glyph,
      // negative outside it, in raster pixels until the downsample below converts to texels.
      const distToOutside = edt2d(outside, rasterW, rasterH);
      const distToInside = edt2d(inside, rasterW, rasterH);

      const cellW = g.width;
      const cellH = g.height;
      const cell = new Uint8ClampedArray(cellW * cellH * 4);
      for (let ty = 0; ty < cellH; ty++) {
        for (let tx = 0; tx < cellW; tx++) {
          let sum = 0;
          for (let sy = 0; sy < job.supersample; sy++) {
            for (let sx = 0; sx < job.supersample; sx++) {
              const rx = tx * job.supersample + sx;
              const ry = ty * job.supersample + sy;
              const i = ry * rasterW + rx;
              const signed = inside[i] ? Math.sqrt(distToOutside[i]) : -Math.sqrt(distToInside[i]);
              sum += signed;
            }
          }
          const meanRasterDist = sum / (job.supersample * job.supersample);
          const texelDist = meanRasterDist / job.supersample;
          const norm = Math.max(-1, Math.min(1, texelDist / job.distanceRange));
          const byte = Math.round((norm * 0.5 + 0.5) * 255);
          const at = (ty * cellW + tx) * 4;
          cell[at] = byte;
          cell[at + 1] = byte;
          cell[at + 2] = byte;
          cell[at + 3] = 255;
        }
      }
      actx.putImageData(new ImageData(cell, cellW, cellH), g.x, g.y);
    }

    return { png: atlas.toDataURL('image/png') };
  })()`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const fontsBase64 = args.fonts.map((file) => readFileSync(file).toString('base64'));
  const chars = glyphSet(readFileSync(args.glyphs, 'utf8'));
  if (chars.length === 0) throw new Error(`sdf-font: ${args.glyphs} has no glyphs in it`);
  const runs = args.runs === undefined ? [] : runSet(readFileSync(args.runs, 'utf8'));
  /* Characters first, so `characterCount` above can bound the kerning loops with an index
     rather than a second list crossing into the page. */
  const entries = [...chars, ...runs];
  const family =
    args.family ?? path.basename(args.fonts[0] as string, path.extname(args.fonts[0] as string));
  /* Atlas texels per font unit, used both ways: forward to size each glyph's cell, and
     backward to write the plane box the atlas cell actually corresponds to. */
  const scale = args.texelsPerEm / args.unitsPerEm;

  /*
   * No `requireHardwareGpu` here on purpose. That check exists for `shots.mjs`, where a
   * software rasteriser silently produces a picture that looks plausible and is not what a
   * player sees. This is Canvas2D, drawn and transformed on the CPU either way - a GPU has
   * nothing to disagree about, so demanding one would only fail a machine that could do this
   * job perfectly well.
   */
  const browser = await launch();
  try {
    /*
     * `connect` is inside this `try` rather than beside `launch` above it, on purpose: if it
     * throws - the port never opens, the socket never connects - `launch` has already
     * started the process, and only a `finally` that covers this call closes it. The one
     * outside covering only what came after `connect` leaked exactly that browser.
     */
    const client = await connect(browser.port);
    try {
      const page = await client.page('about:blank', 64, 64);
      try {
        const measured = (await page.eval(
          measureScript({
            fontsBase64,
            entries,
            characterCount: chars.length,
            unitsPerEm: args.unitsPerEm,
          }),
        )) as MeasureResult;

        const cells = entries.map((entry) =>
          cellFor(entry, measured.glyphs[entry], scale, args.distanceRange),
        );
        const placed = packGlyphs(
          cells.map(({ char, width, height }) => ({ char, width, height })),
          { atlasWidth: args.atlasWidth, padding: args.padding },
        );
        const atlasHeight =
          placed.reduce((max, p) => Math.max(max, p.y + p.height), 0) + args.padding;

        const placements: RasterPlacement[] = placed.map((p, index) => {
          const cell = cells[index];
          return {
            char: cell.char,
            x: p.x,
            y: p.y,
            width: p.width,
            height: p.height,
            paddedLeft: cell.paddedLeft,
            paddedTop: cell.paddedTop,
          };
        });

        const raster = (await page.eval(
          rasterizeScript({
            atlasWidth: args.atlasWidth,
            atlasHeight,
            texelsPerEm: args.texelsPerEm,
            supersample: args.supersample,
            distanceRange: args.distanceRange,
            placements,
          }),
        )) as RasterResult;

        const glyphs: Record<string, GlyphMetric> = {};
        cells.forEach((cell, index) => {
          const p = placed[index];
          glyphs[cell.char] = {
            advance: cell.advance,
            planeLeft: cell.paddedLeft / scale,
            planeBottom: cell.paddedBottom / scale,
            planeRight: (cell.paddedLeft + cell.width) / scale,
            planeTop: (cell.paddedBottom + cell.height) / scale,
            atlasLeft: p.x,
            atlasRight: p.x + p.width,
            /*
             * Native texel space, unflipped -- see `SdfGlyph`'s own comment for why: this is
             * the PNG's own row order, which is also what `createSurfaceTexture` uploads
             * without flipping. `p.y` is this cell's top edge (nearer row 0) and `p.y +
             * p.height` its bottom edge (farther from row 0), exactly as the rasteriser above
             * placed them -- nothing here translates a convention, unlike the plane box above,
             * which genuinely does change axes (font units, y-up) from the pixels it was
             * measured against.
             */
            atlasBottom: p.y + p.height,
            atlasTop: p.y,
          };
        });

        const doc = metricsDocument({
          family,
          atlas: { width: args.atlasWidth, height: atlasHeight, distanceRange: args.distanceRange },
          metrics: {
            unitsPerEm: args.unitsPerEm,
            ascender: measured.ascender,
            descender: measured.descender,
            lineHeight: measured.ascender - measured.descender,
          },
          glyphs,
          kerning: measured.kerning,
        });

        mkdirSync(args.out, { recursive: true });
        const atlasPath = path.join(args.out, 'atlas.png');
        const metricsPath = path.join(args.out, 'metrics.json');
        const comma = raster.png.indexOf(',');
        writeFileSync(atlasPath, Buffer.from(raster.png.slice(comma + 1), 'base64'));
        writeFileSync(metricsPath, JSON.stringify(doc, null, 2));

        console.log(
          `sdf-font: ${family} - ${chars.length} glyphs, ${runs.length} runs, ` +
            `${Object.keys(doc.kerning).length} kerning pairs, atlas ${args.atlasWidth}x${atlasHeight}\n` +
            `  ${atlasPath}\n  ${metricsPath}`,
        );
      } finally {
        await page.close();
      }
    } finally {
      client.close();
    }
  } finally {
    /* Leaked headless Chrome instances have cost this project real debugging time - this
       runs even if connecting, measuring, packing or rasterising throws. */
    await browser.close();
  }
}

await main();

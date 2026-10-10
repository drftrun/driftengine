/**
 * Look at a running game on both backends and say, in words and in exit codes, what was seen.
 *
 * **Written for whoever cannot see the screen, which is a coding agent first.** An agent can
 * typecheck a game and run its tests and still have no idea whether anything drew: a renderer
 * that throws in a frame callback, a camera inside the ground, a material with no light on it and
 * an empty canvas all pass both. A person catches those by looking. This is the looking, done by
 * the instrument this repository already trusts for its own captures — `browser.mjs`, which refuses
 * a software rasteriser, and `cdp.mjs`, which reads the console from before the page loads — and
 * reduced to the four questions an agent needs answered before it says a change works:
 *
 *   1. Did the page throw or print an error or a warning?
 *   2. Did anything draw, or is the canvas one flat colour?
 *   3. Is it moving, or did the loop stop?
 *   4. Which backend drew it, and on which GPU?
 *
 * Each backend is photographed on its own, through `?backend=`, because the engine's own rule is
 * that a picture looked at on one backend has not been looked at: a uniform one backend never
 * uploads draws a plausible frame on that backend and a different one on the other.
 *
 * **What it gives up.** It sees one frame of a game after it boots, and nothing a player would
 * have to click or press to reach; a page that waits for input photographs its waiting screen. It
 * does not compare against a reference, because a game under construction has none — `frames.mjs`
 * is the instrument for a before-and-after. And it refuses to look at all without a hardware GPU,
 * which on a machine with none is a refusal rather than a picture: a frame from a software
 * rasteriser reads exactly like evidence and is not.
 *
 * **What would make it wrong**: a game whose first frame is meant to be one colour, a title card
 * on black. Then `nothing drew` is a false alarm, and the photograph says so at a glance.
 *
 *     import { look, formatLook } from '@driftengine/core/scripts/look.mjs';
 *
 *     const report = await look({ url: 'http://localhost:5173/' });
 *     console.log(formatLook(report));
 *     process.exitCode = report.ok ? 0 : 1;
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { launch, requireHardwareGpu } from './browser.mjs';
import { connect } from './cdp.mjs';
import { luminance } from './frames.mjs';
import { decodePng, rgbaOf } from './png.mjs';

/** The two backends, in the order a consumer runs them: WebGPU where it can, WebGL2 beneath. */
export const LOOK_BACKENDS = Object.freeze(['webgpu', 'webgl2']);

/**
 * At or above this share of one colour, the canvas is called empty.
 *
 * Measured over the canvas alone, with the page's own interface hidden, so a readout over a blank
 * canvas cannot carry it over the line. 99.5% leaves room for a few hundred pixels of a cursor or
 * a dithered edge on a 1280 by 720 frame and for nothing a scene would draw on purpose.
 */
export const EMPTY_SHARE = 0.995;

/**
 * The flags that reach the real GPU from a headless browser, by platform.
 *
 * Linux is the one measured: Vulkan through ANGLE, which is what `browser.mjs` defaults to and why,
 * since plain headless there selects a software rasteriser and says nothing. macOS takes Metal and
 * Windows takes Direct3D 11, each ANGLE's native path on that system, and neither has been run by
 * this module yet; `requireHardwareGpu` is what says so if one is wrong, and `headless: false` is the
 * answer it suggests. Any other platform gets `null`, and `look` refuses it by name.
 */
export function gpuFlagsFor(platform = process.platform) {
  if (platform === 'linux') return ['--use-angle=vulkan', '--enable-features=Vulkan'];
  if (platform === 'darwin') return ['--use-angle=metal'];
  if (platform === 'win32') return ['--use-angle=d3d11'];
  return null;
}

/**
 * The page's address with the backend forced and the boot badge declined.
 *
 * `set` rather than `append`: `URLSearchParams.get` answers with the *first* value, so a second
 * `backend` behind one the caller already wrote would be ignored by the page, and the capture
 * labelled WebGL2 would be whatever the caller asked for. The badge is declined because it holds
 * the loop for three seconds after the first frame and covers the canvas while it does.
 */
export function lookUrl(url, backend) {
  const next = new URL(url);
  next.searchParams.set('backend', backend);
  next.searchParams.set('splash', '0');
  return next.toString();
}

/**
 * What a frame is made of: its most common colour, how much of the frame that colour covers, and
 * its mean luminance.
 *
 * Exact colours rather than buckets, because an empty canvas is exactly one colour — the clear
 * colour — and anything a scene draws, lit and fogged, is a spread of them.
 */
export function frameStats(image) {
  const { width, height, rgba } = image;
  const counts = new Map();
  let top = 0;
  let topKey = 0;
  let luma = 0;
  for (let at = 0; at < rgba.length; at += 4) {
    const key = (rgba[at] << 16) | (rgba[at + 1] << 8) | rgba[at + 2];
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (count > top) {
      top = count;
      topKey = key;
    }
    luma += luminance(rgba, at);
  }
  const pixels = width * height;
  return {
    width,
    height,
    dominant: `#${topKey.toString(16).padStart(6, '0')}`,
    dominantShare: pixels === 0 ? 1 : top / pixels,
    meanLuminance: pixels === 0 ? 0 : luma / pixels,
  };
}

/** The share of pixels that differ between two frames of one size by more than `tolerance`. */
export function changedShare(a, b, tolerance = 2) {
  if (a.width !== b.width || a.height !== b.height) return 1;
  let changed = 0;
  for (let at = 0; at < a.rgba.length; at += 4) {
    if (
      Math.abs(a.rgba[at] - b.rgba[at]) > tolerance ||
      Math.abs(a.rgba[at + 1] - b.rgba[at + 1]) > tolerance ||
      Math.abs(a.rgba[at + 2] - b.rgba[at + 2]) > tolerance
    ) {
      changed += 1;
    }
  }
  return changed / (a.width * a.height);
}

/**
 * The console, sorted into what fails a look and what does not.
 *
 * By the level the browser reported rather than by matching words in the text, because a game is
 * entitled to log "0 errors" and `cdp.mjs`'s own `complaints()` would count it. A warning fails as
 * an error does: no console warnings at runtime is part of the engine's definition of done, and an
 * agent told a warning is harmless learns to stop reading them.
 */
export function sortConsole(lines) {
  const errors = [];
  const warnings = [];
  for (const line of lines) {
    if (/^(error|exception|assert):/.test(line)) errors.push(line);
    else if (/^(warning|warn):/.test(line)) warnings.push(line);
  }
  return { errors, warnings };
}

/**
 * Whether the browser offers a WebGPU adapter to this page, asked only when a capture that asked
 * for WebGPU drew with something else, so the report can say why.
 */
const ADAPTER = `(async () => {
  if (!('gpu' in navigator)) return 'no navigator.gpu';
  const adapter = await navigator.gpu.requestAdapter();
  return adapter === null ? 'no adapter' : 'an adapter';
})()`;

/**
 * Installed before the page's own scripts: notes every WebGPU and WebGL2 context a canvas asks for.
 *
 * **This is what says the game booted, and the obvious test does not.** A `<canvas>` has a drawing
 * buffer of 300 by 150 from the moment it is parsed, so "a canvas with a size" is true before any
 * renderer exists — the first version of this module asked exactly that, photographed a page still
 * reading "starting…", and called it a pass. A context on a canvas in the document is the renderer
 * itself, and its type is the backend that actually drew rather than the one the address asked
 * for: `createRenderer` falls back to WebGL2 quietly by design, and hands the reason to the game.
 *
 * A context on a canvas that is not in the document at the moment of asking is left out, because
 * that is a probe, not the game; one appended later is counted then.
 */
const WATCH = `(() => {
  const seen = (window.__driftengineLook = { contexts: [] });
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const context = getContext.call(this, type, ...rest);
    if (context !== null && (type === 'webgpu' || type === 'webgl2')) seen.contexts.push({ type, canvas: this });
    return context;
  };
})();`;

/** The backend of the last context asked for by a canvas that is in the document now, or null. */
const DRAWN_WITH = `(() => {
  const found = (window.__driftengineLook?.contexts ?? []).filter((entry) => entry.canvas.isConnected).at(-1);
  return found === undefined ? null : found.type;
})()`;

/** Hides everything on the page except its canvases, so a frame's statistics are the canvas's. */
const CANVAS_ONLY = `(() => {
  const style = document.createElement('style');
  style.id = 'driftengine-look';
  style.textContent = '* { visibility: hidden !important; } canvas { visibility: visible !important; }';
  document.head.append(style);
  return true;
})()`;
const RESTORE = `(() => { document.getElementById('driftengine-look')?.remove(); return true; })()`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function photograph(page, file) {
  await page.frames(2);
  await page.screenshot(file);
  return rgbaOf(decodePng(await readFile(file)));
}

/**
 * Open the game once per backend, wait for it to boot, and photograph it.
 *
 * `headless: false` opens a real window instead, for a machine whose headless browser cannot reach
 * its GPU; the photographs are the same, and the window closes when it is done.
 *
 * Writes into `out` a PNG of what a player sees per backend (`webgpu.png`, `webgl2.png`), the canvas
 * alone beside each (`webgpu.canvas.png`), and `look.json`, the report this returns. Throws only
 * when it cannot look at all — no browser, no hardware GPU, an unsupported platform — and the
 * message says which. Everything it saw, however bad, comes back in the report instead, with `ok`
 * false.
 *
 * `bootMs` bounds the wait for the renderer's context; `settleMs` is a pause after it for the first
 * frames; `drawMs` bounds the wait after that for the canvas to show more than one colour, since a
 * game that streams its world draws empty frames until it arrives; `moveMs` is the gap between the
 * two frames compared to tell whether it moves.
 */
export async function look({
  url,
  backends = LOOK_BACKENDS,
  out = '.driftengine/look',
  width = 1280,
  height = 720,
  bootMs = 30_000,
  settleMs = 1000,
  drawMs = 10_000,
  moveMs = 500,
  flags = gpuFlagsFor(),
  headless = true,
} = {}) {
  if (typeof url !== 'string') throw new Error('look: pass the address of the running game as url');
  if (flags === null) {
    throw new Error(
      `look: ${process.platform} is not supported. It runs on Windows, macOS and Linux; pass ` +
        '`flags` to choose the browser flags for another system.',
    );
  }
  await mkdir(out, { recursive: true });

  const browser = await launch({ flags, headless });
  const report = { url, gpu: '', captures: [], problems: [], ok: false };
  try {
    const client = await connect(browser.port);
    try {
      report.gpu = await requireHardwareGpu(client);
      const timing = { bootMs, settleMs, drawMs, moveMs };
      for (const backend of backends) {
        report.captures.push(await lookAt(client, { url, backend, out, width, height, ...timing }));
      }
    } finally {
      client.close();
    }
  } finally {
    await browser.close();
  }

  for (const capture of report.captures) {
    for (const problem of capture.problems) report.problems.push(`${capture.backend}: ${problem}`);
  }
  report.ok = report.problems.length === 0;
  await writeFile(path.join(out, 'look.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function lookAt(client, options) {
  const { url, backend, out, width, height, bootMs, settleMs, drawMs, moveMs } = options;
  const address = lookUrl(url, backend);
  const file = path.join(out, `${backend}.png`);
  const canvasFile = path.join(out, `${backend}.canvas.png`);
  const capture = {
    backend,
    url: address,
    file,
    drawnWith: null,
    stats: null,
    moved: null,
    errors: [],
    warnings: [],
    logs: [],
    problems: [],
  };
  const page = await client.page(address, width, height, { beforeLoad: WATCH });
  try {
    try {
      await page.settled(`${DRAWN_WITH} !== null`, { timeoutMs: bootMs, settleMs });
      capture.drawnWith = await page.eval(DRAWN_WITH);
    } catch {
      capture.problems.push(
        `no canvas in the page asked for a WebGPU or WebGL2 context within ${bootMs} ms: the renderer never started, or the page threw before it did`,
      );
    }
    if (capture.drawnWith !== null) {
      if (capture.drawnWith !== backend) {
        const adapter = backend === 'webgpu' ? await page.eval(ADAPTER) : null;
        const why =
          adapter === null || adapter === 'an adapter'
            ? 'the page chose its backend without reading ?backend='
            : `the browser offered ${adapter}`;
        capture.problems.push(
          `asked for ${backend} and drew with ${capture.drawnWith}, so ${backend} was not looked at: ${why}`,
        );
      }
      await page.eval(CANVAS_ONLY);
      let first = await photograph(page, canvasFile);
      const deadline = Date.now() + drawMs;
      while (frameStats(first).dominantShare >= EMPTY_SHARE && Date.now() < deadline) {
        await sleep(250);
        first = await photograph(page, canvasFile);
      }
      await sleep(moveMs);
      const second = await photograph(page, canvasFile);
      await page.eval(RESTORE);
      await photograph(page, file);
      capture.stats = frameStats(second);
      capture.moved = changedShare(first, second);
      if (capture.stats.dominantShare >= EMPTY_SHARE) {
        capture.problems.push(
          `nothing drew: ${percent(capture.stats.dominantShare)} of the canvas is ${capture.stats.dominant}`,
        );
      }
    }
  } finally {
    capture.logs = [...page.logs];
    await page.close();
  }
  const { errors, warnings } = sortConsole(capture.logs);
  capture.errors = errors;
  capture.warnings = warnings;
  if (errors.length > 0) capture.problems.push(count(errors.length, 'console error'));
  if (warnings.length > 0) capture.problems.push(count(warnings.length, 'console warning'));
  return capture;
}

const percent = (share) => `${(share * 100).toFixed(1)}%`;
const count = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** The report as lines a person or an agent reads top to bottom: the verdict is the last line. */
export function formatLook(report) {
  const lines = [`look: ${report.url}`, `gpu: ${report.gpu}`];
  for (const capture of report.captures) {
    lines.push(
      '',
      `${capture.backend}: ${capture.stats === null ? 'not photographed' : capture.file}`,
    );
    if (capture.drawnWith !== null) lines.push(`  drew with: ${capture.drawnWith}`);
    if (capture.stats !== null) {
      lines.push(
        `  canvas: ${percent(capture.stats.dominantShare)} is its most common colour ${capture.stats.dominant}, mean luminance ${capture.stats.meanLuminance.toFixed(0)} of 255`,
      );
    }
    if (capture.moved !== null) {
      lines.push(
        capture.moved > 0
          ? `  moving: ${percent(capture.moved)} of the canvas changed between two frames`
          : '  still: no pixel changed between two frames, so nothing animates or the loop stopped',
      );
    }
    for (const line of capture.errors) lines.push(`  ${line}`);
    for (const line of capture.warnings) lines.push(`  ${line}`);
    for (const problem of capture.problems) lines.push(`  problem: ${problem}`);
  }
  lines.push(
    '',
    report.ok
      ? 'ok: open the PNGs above and check they show what the game should'
      : `failed: ${count(report.problems.length, 'problem')}`,
  );
  return lines.join('\n');
}

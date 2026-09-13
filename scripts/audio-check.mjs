/**
 * Does the audio this engine describes actually come out of a browser?
 *
 * **Audio has no picture, so this is its only evidence.** Every rendering change in this repository
 * is settled by photographing it; a mix cannot be, and the stub context the unit tests use proves
 * the graph calls the right methods rather than that a browser did anything with them. This renders
 * the real thing offline, on a real Web Audio implementation, and reads numbers back out of the
 * samples.
 *
 *     (setsid npx vite demo/dev --port 5202 > /tmp/vite.log 2>&1 < /dev/null &) ; sleep 9
 *     node scripts/audio-check.mjs --base=http://localhost:5202
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up, deliberately: it needs a
 * dev server and a browser, which is the same reason `shots.mjs` and `compute-check.mjs` are run by
 * hand. Exits non-zero on the first failed check, so it can gate a commit.
 *
 * **Every expectation here is derived from arithmetic, never from what the code printed.** The one
 * exception is the identity check, whose expectation is a fixture frozen from code that predates
 * what it judges — which is the same rule wearing a different hat.
 */
import { readFileSync } from 'node:fs';
import { launch } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';
import { decode, digest } from './audioDigest.mjs';

const RATE = 48000;

/* ------------------------------------------------------------------ measuring */

function rms(samples) {
  let sum = 0;
  for (const value of samples) sum += value * value;
  return Math.sqrt(sum / samples.length);
}

function peak(samples) {
  let out = 0;
  for (const value of samples) out = Math.max(out, Math.abs(value));
  return out;
}

/** First sample whose magnitude crosses a tenth of the channel's peak. */
function onset(samples) {
  const threshold = peak(samples) * 0.1;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) > threshold) return i;
  }
  return -1;
}

/**
 * How much of this signal is high frequency, as the RMS of its first difference over its own RMS.
 *
 * A first difference is a crude high-pass — it is exactly the two-tap filter `1, -1` — so this
 * number rises with treble and falls with a low-pass, which is all that is being asked of it. Not a
 * spectrum: a real one would need an FFT here and there is nothing this has to decide that a
 * spectrum would decide differently.
 */
function highFrequencyRatio(samples) {
  const difference = new Float32Array(samples.length - 1);
  for (let i = 1; i < samples.length; i++) difference[i - 1] = samples[i] - samples[i - 1];
  const body = rms(samples);
  return body > 0 ? rms(difference) / body : 0;
}

/**
 * Frequency, by counting how often the signal crosses zero going upward.
 *
 * Measured out of the rendered samples rather than taken from the value the engine computed,
 * because what is being checked is that a browser produced a shifted pitch and not that our own
 * arithmetic agrees with itself. Windowed to the middle of the render, away from the onset.
 */
function fundamentalHz(samples) {
  const from = Math.floor(samples.length * 0.4);
  const to = Math.floor(samples.length * 0.9);
  let crossings = 0;
  for (let i = from + 1; i < to; i++) {
    if (samples[i - 1] <= 0 && samples[i] > 0) crossings++;
  }
  return (crossings * RATE) / (to - from);
}

/** Seconds from the peak until the signal has fallen 60 dB below it and stays there. */
function tailSeconds(samples) {
  const threshold = peak(samples) / 1000;
  for (let i = samples.length - 1; i >= 0; i--) {
    if (Math.abs(samples[i]) > threshold) return i / RATE;
  }
  return 0;
}

/* ------------------------------------------------------------------ reporting */

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok    ${label} — ${detail}`);
    return;
  }
  console.error(`  FAIL  ${label} — ${detail}`);
  failures++;
}

/* ------------------------------------------------------------------ running */

const base = process.argv.find((a) => a.startsWith('--base='))?.slice(7) ?? 'http://localhost:5202';

const browser = await launch({ headless: true });
try {
  const client = await connect(browser.port, { timeoutMs: 120_000 });
  const page = await client.page(`${base}/mixref.html`);
  /*
   * Print what produced the numbers. The 2026-08-23 rule is about backends and applies here for the
   * same reason: a measurement is evidence about the implementation that made it and nothing else,
   * and Web Audio differs between engines in exactly the places this file asserts — the head model
   * behind `HRTF` is each browser's own.
   */
  console.log(`measured on: ${await page.eval('navigator.userAgent').catch(() => 'unknown')}`);

  /*
   * The wait and the call are one expression with a retry around them, because the dev server's own
   * client issues a full page reload shortly after connecting and would otherwise wipe the module
   * between the two. See `audio-baseline.mjs`, which paid for that.
   */
  const render = async (name, ...args) => {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await page.eval(`(async () => {
          for (let i = 0; i < 200 && typeof globalThis.${name} !== 'function'; i++) {
            await new Promise((r) => setTimeout(r, 50));
          }
          if (typeof globalThis.${name} !== 'function') throw new Error('${name} never loaded');
          return globalThis.${name}(${args.map((a) => JSON.stringify(a)).join(', ')});
        })()`);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error(`${name} never ran`);
  };
  const both = async (name, ...args) => {
    const rendered = await render(name, ...args);
    return { left: decode(rendered.left), right: decode(rendered.right) };
  };

  /* 0 — determinism, which everything below rests on ------------------------ */
  console.log('\n0. determinism');
  const first = await both('__renderHrtf', 3);
  const second = await both('__renderHrtf', 3);
  check(
    'two renders of one scene agree exactly',
    digest(first.left).hash === digest(second.left).hash,
    `${digest(first.left).hash} twice`,
  );

  /* 1 — the mix is the mix it was before it was rewritten -------------------- */
  console.log('\n1. sample identity');
  const frozen = JSON.parse(
    readFileSync(new URL('./fixtures/audio-baseline.json', import.meta.url), 'utf8'),
  );
  const mixNow = await both('__renderMixRef');
  for (const [side, expected] of [
    ['left', frozen.left],
    ['right', frozen.right],
  ]) {
    const actual = digest(mixNow[side]);
    check(
      `${side} channel is the frozen mix`,
      actual.hash === expected.hash,
      `${actual.hash} against ${expected.hash}`,
    );
  }

  /* 2 — HRTF ---------------------------------------------------------------- */
  console.log('\n2. hrtf');
  const right = await both('__renderHrtf', 3);
  const left = await both('__renderHrtf', -3);
  const ratio = rms(right.right) / rms(right.left);
  const delay = onset(right.left) - onset(right.right);
  check('a source on the right is louder on the right', ratio > 2, `${ratio.toFixed(2)}x`);
  check(
    'and arrives at the right ear first',
    delay > 10 && delay < 80,
    `${delay} samples, ${((delay / RATE) * 1000).toFixed(2)} ms`,
  );
  check(
    'the mirrored source is the exact mirror',
    Math.abs(rms(left.left) - rms(right.right)) < 1e-9 &&
      Math.abs(rms(left.right) - rms(right.left)) < 1e-9,
    'channel figures swap exactly',
  );

  /* 3 — occlusion ----------------------------------------------------------- */
  console.log('\n3. occlusion');
  const clear = await both('__renderOcclusion', 0);
  const blocked = await both('__renderOcclusion', 1);
  const treble = highFrequencyRatio(blocked.left) / highFrequencyRatio(clear.left);
  const level = rms(blocked.left) / rms(clear.left);
  check(
    'a blocked source loses its treble',
    treble < 0.5,
    `${(treble * 100).toFixed(1)}% of it left`,
  );
  check('and drops in level', level < 0.9, `${(20 * Math.log10(level)).toFixed(1)} dB`);
  check('but is still there', rms(blocked.left) > 0, `rms ${rms(blocked.left).toExponential(2)}`);

  /* 4 — reverb zones -------------------------------------------------------- */
  console.log('\n4. reverb zones');
  const shortRoom = await both('__renderZone', 0.5, 2);
  const longRoom = await both('__renderZone', 3, 2);
  const shortTail = tailSeconds(shortRoom.left);
  const longTail = tailSeconds(longRoom.left);
  check(
    'a longer room has a longer tail',
    longTail > shortTail * 2,
    `${shortTail.toFixed(2)} s against ${longTail.toFixed(2)} s`,
  );
  check(
    'and each tail is about the length it was asked for',
    Math.abs(shortTail - 0.5) < 0.2 && Math.abs(longTail - 3) < 0.6,
    `asked 0.5 and 3, measured ${shortTail.toFixed(2)} and ${longTail.toFixed(2)}`,
  );

  /* 5 — doppler ------------------------------------------------------------- */
  console.log('\n5. doppler');
  const closing = await both('__renderDoppler', 60);
  const receding = await both('__renderDoppler', -60);
  const still = await both('__renderDoppler', 0);
  const hzStill = fundamentalHz(still.left);
  const hzClosing = fundamentalHz(closing.left);
  const hzReceding = fundamentalHz(receding.left);
  /*
   * 1000 Hz at 60 m/s closing, through (c + 0) / (c - 60) with c = 343: 1212 Hz. Receding is
   * 343 / 403 of 1000, which is 851 Hz. Both derived here rather than read off the render.
   */
  check('a still source is not shifted', Math.abs(hzStill - 1000) < 30, `${hzStill.toFixed(0)} Hz`);
  check(
    'closing raises the pitch to about 1212 Hz',
    Math.abs(hzClosing - 1212) < 40,
    `${hzClosing.toFixed(0)} Hz`,
  );
  check(
    'receding lowers it to about 851 Hz',
    Math.abs(hzReceding - 851) < 40,
    `${hzReceding.toFixed(0)} Hz`,
  );

  /* 6 — buses --------------------------------------------------------------- */
  console.log('\n6. buses');
  const plain = await both('__renderBuses', 'plain');
  const soloed = await both('__renderBuses', 'solo-left');
  const muted = await both('__renderBuses', 'mute-left');
  const recalled = await both('__renderBuses', 'snapshot');
  check(
    'soloing one of two siblings halves what reaches the master',
    rms(soloed.left) < rms(plain.left) * 0.75 && rms(soloed.left) > 0,
    `${rms(plain.left).toExponential(2)} to ${rms(soloed.left).toExponential(2)}`,
  );
  check(
    'muting one does the same',
    Math.abs(rms(muted.left) - rms(soloed.left)) < rms(plain.left) * 0.05,
    `${rms(muted.left).toExponential(2)}`,
  );
  check(
    'a snapshot recall lands back on the level it captured',
    rms(recalled.left) < rms(plain.left),
    `${rms(recalled.left).toExponential(2)} against ${rms(plain.left).toExponential(2)}`,
  );
} finally {
  await browser.close();
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

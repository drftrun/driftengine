/**
 * Freeze the mix, so a rewrite of it can be judged against something it did not write.
 *
 * **An expectation produced by the code under test agrees with that code however wrong it is.** The
 * house rule is that an expected value is a hand-derived literal; a mix is 384,000 floats and
 * cannot be hand-derived, so the substitute is a reference captured from code that *predates* the
 * thing it judges. Run this once, before the console replaces the graph, and commit what it writes.
 *
 *     (setsid npx vite demo/dev --port 5202 > /tmp/vite.log 2>&1 < /dev/null &) ; sleep 9
 *     node scripts/audio-baseline.mjs --base=http://localhost:5202            # freeze
 *     node scripts/audio-baseline.mjs --base=http://localhost:5202 --verify   # compare
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up, deliberately: it needs a
 * dev server and a browser, which is the same reason `shots.mjs` and `compute-check.mjs` are run by
 * hand.
 *
 * **A bare hash is a bad failure message**, so the digest carries statistics beside it. "The mix
 * changed" is where every investigation starts and it is worth nothing on its own; peak, RMS and
 * the first samples separate "everything moved a little" from "one stage is missing" before
 * anybody opens a file.
 *
 * Exits non-zero on any disagreement, so it can gate a commit.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { decode, digest } from './audioDigest.mjs';
import { launch } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';

const FIXTURE = new URL('./fixtures/audio-baseline.json', import.meta.url);

/** What changed, in the words somebody chasing it would want. */
function describe(label, expected, actual) {
  const lines = [`${label}: hash ${expected.hash} expected, ${actual.hash} rendered`];
  lines.push(`  peak ${expected.peak} → ${actual.peak}`);
  lines.push(`  rms  ${expected.rms} → ${actual.rms}`);
  lines.push(`  rms by quarter ${expected.quarters.join(' ')}`);
  lines.push(`              →  ${actual.quarters.join(' ')}`);
  const moved = expected.quarters
    .map((value, index) => (value === actual.quarters[index] ? null : index))
    .filter((index) => index !== null);
  lines.push(
    moved.length === 4
      ? '  every quarter moved, so look at a stage the whole render passes through'
      : `  quarter${moved.length === 1 ? '' : 's'} ${moved.join(', ')} moved and the rest did not, so look at what is scheduled there`,
  );
  return lines.join('\n');
}

const argument = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const base = argument('base', 'http://localhost:5202');
const verify = process.argv.includes('--verify');

const browser = await launch({ headless: true });
let failed = false;
try {
  const client = await connect(browser.port, { timeoutMs: 60_000 });
  const page = await client.page(`${base}/mixref.html`);

  /*
   * Waiting for the module and calling it are **one** expression, and a retry sits around them.
   *
   * The dev server's own client issues a full page reload shortly after it connects, which wipes
   * anything the module put on the global. Split across two evaluations, the wait can succeed and
   * the call can then land in a fresh context where nothing has loaded yet — which reads as "the
   * page is broken" and is nothing of the kind. Two runs of this got away with it before one did
   * not.
   */
  const render = async () => {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await page.eval(`(async () => {
          for (let i = 0; i < 200 && typeof globalThis.__renderMixRef !== 'function'; i++) {
            await new Promise((r) => setTimeout(r, 50));
          }
          if (typeof globalThis.__renderMixRef !== 'function') throw new Error('mixref never loaded');
          return globalThis.__renderMixRef();
        })()`);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error('the render never ran');
  };

  const once = await render();
  const twice = await render();

  const left = digest(decode(once.left));
  const right = digest(decode(once.right));
  const leftAgain = digest(decode(twice.left));

  /*
   * Determinism is asserted on every run rather than trusted from the day it was measured. Every
   * expectation this file writes or checks rests on it, and the thing that would quietly end it —
   * a stage that reaches for `Math.random`, a node whose state survives a render — is exactly the
   * kind of change somebody makes for a good reason without knowing this depended on them.
   */
  if (left.hash !== leftAgain.hash) {
    console.error(`two renders of one build disagree: ${left.hash} vs ${leftAgain.hash}`);
    console.error('the mix is not deterministic, and nothing built on sample identity can stand');
    failed = true;
  } else if (verify) {
    const frozen = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    for (const [label, expected, actual] of [
      ['left', frozen.left, left],
      ['right', frozen.right, right],
    ]) {
      if (expected.hash === actual.hash) {
        console.log(`${label}: identical (${actual.hash})`);
        continue;
      }
      console.error(describe(label, expected, actual));
      failed = true;
    }
    if (!failed) console.log('the mix is sample-identical to the frozen reference');
  } else {
    writeFileSync(
      FIXTURE,
      `${JSON.stringify(
        {
          note: 'The mix, frozen. Never regenerate this to make a check pass. It was first frozen from the mix as it stood before the console replaced it, and that rewrite came back bit-for-bit identical to it, which is what the freeze was for. It was re-frozen once, deliberately, at 3.0.0: removing AudioGraph.fadeMusic fixed a defect this render was sitting on. That method scheduled on context.currentTime rather than the graph clock, so offline the fade landed at instant zero however late it was asked for, and the whole four seconds rendered ducked to 0.2 instead of only the last half second. Measured at the moment of the change: rms 0.128556171 to 0.34368016, every quarter moved, the last one least.',
          renderedBy: 'demo/dev/mixref.ts, __renderMixRef',
          sampleRate: once.sampleRate,
          length: once.length,
          left,
          right,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`baseline frozen: left ${left.hash}, right ${right.hash}`);
    console.log(
      `peak ${left.peak}, rms ${left.rms}, ${once.length} samples at ${once.sampleRate} Hz`,
    );
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);

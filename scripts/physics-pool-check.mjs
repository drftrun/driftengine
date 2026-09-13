/**
 * Can a browser actually have the island worker pool, and which header buys it?
 *
 * **Node proves the pool is correct; only a page proves it can exist.** `workerPool.test.mjs`
 * compares bits across real threads and it runs where `SharedArrayBuffer` is always defined and
 * `Atomics.wait` is always allowed on the calling thread. Neither holds on a page, and those two
 * facts are the whole of what has kept this row closed since 2026-08-27.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up, deliberately: it needs a
 * dev server with cross-origin isolation turned on, which is a header that breaks every
 * cross-origin resource the other demo pages load. Run it against a server of its own.
 *
 *     DRIFT_COEP=require-corp (setsid npx vite demo/dev --config demo/dev/vite.isolated.config.ts \
 *       --port 5211 > /tmp/vite.log 2>&1 < /dev/null &) ; sleep 7
 *     node scripts/physics-pool-check.mjs --base=http://localhost:5211 --coep=require-corp
 *
 * and again with `credentialless`, which is the measurement this file exists to take. `executor.ts`
 * has said since 2026-08-27 that `require-corp` is the price, and `require-corp` stops every
 * cross-origin resource without CORP from loading anywhere on a consumer's site. `credentialless`
 * grants the same isolation without asking third parties to opt in. Whether it does so *here* is a
 * fact about a browser, and this repository has been wrong once already about this row by
 * remembering a constraint instead of measuring it.
 *
 * **The engagement claim comes before the agreement claim.** A pool that failed to start falls back
 * to serial and agrees with serial on every bit of every tick, so "the pool matches the serial
 * character" is a claim satisfied by nothing having happened — the shape the 2026-09-04 audit removed
 * 57 of. Every run here asserts that four workers are running and that each took islands before it
 * compares a fingerprint.
 *
 * Exits non-zero on the first failed check, so it can gate a commit.
 */
import { launch } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';

/** Workers the page asks for. Must match `demo/dev/pool.ts`. */
const WORKERS = 4;

function argOf(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const base = argOf('base', 'http://localhost:5211').replace(/\/$/, '');
const coep = argOf('coep', 'require-corp');

const browser = await launch();
const client = await connect(browser.port);
const page = await client.page(`${base}/pool.html`, 640, 480);
await page.settled('globalThis.__poolCheck', { settleMs: 4000 });
const result = JSON.parse(await page.eval('JSON.stringify(globalThis.__poolCheck)'));
const complaints = page.complaints().filter((line) => !line.includes('404'));
await page.close?.();
await browser.close?.();

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

console.log(`\nCross-Origin-Embedder-Policy: ${coep}\n`);
console.log(JSON.stringify(result, null, 2), '\n');

check('the page ran without complaint', complaints.length === 0, complaints.join(' | ') || 'clean');
check(
  'the page reported a result rather than an error',
  result.error === undefined,
  result.error ?? 'none',
);

/*
 * The environment, which is the part of this that is a measurement rather than an assertion about
 * the engine. A FAIL here is a finding about the header, not a defect in the pool.
 */
check(
  `${coep} makes the document cross-origin isolated`,
  result.crossOriginIsolated === true,
  String(result.crossOriginIsolated),
);
check(
  'and SharedArrayBuffer is therefore defined',
  result.sharedArrayBuffer === true,
  String(result.sharedArrayBuffer),
);
/*
 * **Asserted false on purpose.** The join spins rather than blocks because of this, and if a browser
 * ever permitted it the design could be simpler — so a PASS here would be the news, and writing the
 * claim the other way round would let the day it changes pass unnoticed.
 */
check(
  'Atomics.wait is still refused on the main thread, which is why the join spins',
  result.atomicsWaitOnMainThread === false,
  result.atomicsWaitOnMainThread ? 'permitted — the join could block' : 'refused, as designed',
);

/* The pool started, using the worker entry the package ships and a bundler resolved. */
check('the pool started with no reason given', result.reason === '', result.reason || 'none');
check(
  `${WORKERS} workers are running`,
  result.running === WORKERS,
  `${result.running} of ${WORKERS}`,
);
check('no worker gave up mid-run', result.failure === null, result.failure ?? 'none');

/*
 * Engagement, before agreement. Without these two the fingerprint claim below is satisfied by a
 * pool that quietly fell back, which is the exact defect class this file's header names.
 */
check(
  'the workers took islands off the main thread',
  result.islandsOffThisThread > 0,
  `${result.islandsOffThisThread} islands`,
);
check(
  'every worker took some, so none idled through the run',
  Array.isArray(result.solvedPerWorker) &&
    result.solvedPerWorker.length === WORKERS &&
    result.solvedPerWorker.every((n) => n > 0),
  JSON.stringify(result.solvedPerWorker),
);

check(
  'and the pooled world is bit-identical to the serial one, every tick',
  result.agreed === true,
  result.agreed ? 'identical for 120 ticks' : `diverged at tick ${result.firstDisagreement}`,
);

console.log(`\n${failed === 0 ? 'all checks passed' : `${failed} failed`}`);
process.exit(failed === 0 ? 0 : 1);

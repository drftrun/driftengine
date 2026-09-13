/**
 * Do the CPU binner and the GPU binner fill the same froxel table?
 *
 * **This is the gate the WebGL2 answer to clustered lighting rests on.** That backend has no
 * compute, so its table is filled by CPU code while WebGPU's is filled by a dispatch. The
 * 2026-08-17 rule was written after two detectors agreed on none of the three things both their
 * headers claimed, and its conclusion is that two implementations of one decision drift invisibly
 * when their constants are identical. This is that situation exactly, so the agreement is measured
 * rather than maintained by care.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up, deliberately: it needs a
 * dev server and a real GPU, which is the same reason `shots.mjs` is run by hand.
 *
 *     (setsid npx vite demo/dev --port 5202 > /tmp/vite.log 2>&1 < /dev/null &) ; sleep 7
 *     node scripts/cluster-check.mjs --base=http://localhost:5202
 *
 * **What it will not do is tell you the picture is right.** It compares two tables, and two
 * binners that are wrong in the same way agree perfectly. What proves the table is *correct* is
 * the unit tests in `clusteredLights.test.ts`, whose expectations are hand-derived; this proves
 * only that the second implementation matches the first. Both are needed and neither substitutes.
 *
 * Exits non-zero on the first failed check, so it can gate a commit.
 */
import { launch } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';

function argOf(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const base = argOf('base', 'http://localhost:5202').replace(/\/$/, '');

const browser = await launch();
const client = await connect(browser.port);
const page = await client.page(`${base}/cluster.html?backend=webgpu`, 640, 480);
await page.settled('globalThis.__clusterCheck', { settleMs: 6000 });
const result = JSON.parse(await page.eval('JSON.stringify(globalThis.__clusterCheck)'));
/* The favicon, which every page in demo/dev answers with a 404 and none of them owns. */
const complaints = page.complaints().filter((line) => !line.includes('404'));
await page.close?.();
await browser.close?.();

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

console.log(`\nbackend ${result.backend}, ${result.clusters} clusters compared\n`);
check('the page ran without complaint', complaints.length === 0, complaints.join(' | ') || 'clean');
check('no error was reported', result.error === null, result.error ?? 'none');
check('the backend can compute', result.supported === true, String(result.supported));
check(
  'the light records the dispatch wrote match the ones the CPU wrote, bit for bit',
  result.recordMismatches === 0,
  `${result.recordMismatches} of ${result.recordsCompared} uints differ`,
);
check(
  'no cluster disagrees for a reason a froxel boundary does not explain',
  result.real.length === 0,
  result.real.length === 0
    ? 'every cluster agrees'
    : result.real
        .filter((d) => d.cluster >= 0)
        .map((d) => `cluster ${d.cluster}: cpu [${d.cpu}] gpu [${d.gpu}]`)
        .join(' | '),
);
/*
 * Reported rather than asserted at zero. A light exactly on a froxel face is a real configuration
 * and both answers are defensible there; what would be a defect is the number growing, which is
 * only visible if it is printed on every run.
 */
console.log(`      borderline disagreements: ${result.borderline}`);

console.log(`\n${failed === 0 ? 'all checks passed' : `${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);

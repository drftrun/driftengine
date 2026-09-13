/**
 * Does a compute dispatch actually run on this machine?
 *
 * **A seam has no picture, so this is its only evidence.** Every other rendering change in this
 * repository is settled by photographing it; a stage that writes a buffer and draws nothing cannot
 * be, and the stub device the unit tests use proves the seam calls the right methods rather than
 * that a GPU did anything with them. This reads the numbers back off the device.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up, deliberately: it needs a
 * dev server and a real GPU, which is the same reason `shots.mjs` is run by hand.
 *
 *     (setsid npx vite demo/dev --port 5202 > /tmp/vite.log 2>&1 < /dev/null &) ; sleep 7
 *     node scripts/compute-check.mjs --base=http://localhost:5202
 *
 * **Both backends, every run, and the one consumers run first.** The 2026-08-23 rule exists
 * because three defects shipped on the WebGPU path and stayed invisible for two sessions while
 * every capture passed `?backend=webgl2`. Here the two backends are asserted to *disagree* — one
 * computes and one refuses — so running only one of them proves half of the contract.
 *
 * Exits non-zero on the first failed check, so it can gate a commit.
 */
import { launch } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';

/** Must match `COUNT` in `demo/dev/compute.ts`. */
const COUNT = 128;

/**
 * The first eight squares, written out.
 *
 * **Hand-written, never generated.** The house rule is that an expectation is a hand-derived
 * literal, and it earns its keep exactly here: `values[i] === i * i` computed in this file is the
 * same arithmetic the shader runs, so it would agree with a shader that had the wrong formula in
 * both places and with a buffer the CPU had filled.
 */
const FIRST_EIGHT = [0, 1, 4, 9, 16, 25, 36, 49];

/** The last one, which is what separates "one workgroup ran" from "both did". */
const LAST = 127 * 127;

function argOf(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

async function read(base, backend) {
  const browser = await launch();
  const client = await connect(browser.port);
  const page = await client.page(`${base}/compute.html?backend=${backend}`, 640, 480);
  await page.settled('globalThis.__computeCheck', { settleMs: 3000 });
  const result = JSON.parse(await page.eval('JSON.stringify(globalThis.__computeCheck)'));
  /* The favicon, which every page in demo/dev answers with a 404 and none of them owns. */
  const complaints = page.complaints().filter((line) => !line.includes('404'));
  await page.close?.();
  await browser.close?.();
  return { result, complaints };
}

const base = argOf('base', 'http://localhost:5202').replace(/\/$/, '');

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

/* WebGPU first: it is the backend consumers run and the only one that can compute at all. */
const gpu = await read(base, 'webgpu');
console.log(`\nwebgpu — reported backend ${gpu.result.backend}\n`);
check(
  'the page ran without complaint',
  gpu.complaints.length === 0,
  gpu.complaints.join(' | ') || 'clean',
);
check('no error was reported', gpu.result.error === null, gpu.result.error ?? 'none');
check(
  'the backend says it can compute',
  gpu.result.supported === true,
  String(gpu.result.supported),
);
/*
 * **A count of values is not a count of values that were written.** Measured 2026-09-04 with
 * `scripts/claimAudit.sh`: skipping the dispatch entirely left this claim green, because the
 * read-back buffer is `COUNT` long whether or not anything ran and every entry was zero. The
 * separated claim further down already names that exact failure; this one now rests on it, so the
 * length is asserted about a buffer something wrote rather than about a buffer.
 */
const dispatched = gpu.result.values.some((v) => v !== 0);
check(
  'the dispatch wrote every value, not just the first workgroup',
  dispatched && gpu.result.values.length === COUNT,
  `${gpu.result.values.length} of ${COUNT}`,
);
check(
  'the first eight are the squares, against a hand-written expectation',
  FIRST_EIGHT.every((want, i) => gpu.result.values[i] === want),
  gpu.result.values.slice(0, 8).join(' '),
);
check(
  'the last value is written, so both workgroups ran',
  gpu.result.values[COUNT - 1] === LAST,
  `${gpu.result.values[COUNT - 1]} (want ${LAST})`,
);
/*
 * The failure this separates out. A buffer that comes back all zero is the shape a dispatch that
 * never ran takes, and it is also what an invalid pipeline produces — which reports at `submit`
 * rather than at the call, so it is silent unless somebody reads the device console.
 */
check(
  'the values are not uniformly zero, which is what a dispatch that never ran looks like',
  dispatched,
  gpu.result.values.every((v) => v === 0) ? 'every value is zero' : 'varied',
);

const gl = await read(base, 'webgl2');
console.log(`\nwebgl2 — reported backend ${gl.result.backend}\n`);
check(
  'the backend says it cannot compute',
  gl.result.supported === false,
  String(gl.result.supported),
);
check('and computed nothing', gl.result.values.length === 0, `${gl.result.values.length} values`);
check(
  'and handed back the handle that names nothing',
  gl.result.refusedHandle === 0,
  String(gl.result.refusedHandle),
);
/*
 * The refusal is expected on this backend, so it is not a complaint. Asserting that it *arrives*
 * is the point: a silent no-op is what the 2026-08-13 rule forbids, and the console line is the
 * whole of the defined state.
 */
check(
  'and said so, naming the definition',
  gl.complaints.some((line) => line.includes('probe.squares')),
  gl.complaints.join(' | ') || 'nothing was said',
);

console.log(`\n${failed === 0 ? 'all checks passed' : `${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);

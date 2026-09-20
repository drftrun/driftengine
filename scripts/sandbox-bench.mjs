/**
 * How the voxel sandbox's two pipelines spend a frame, radius by radius, while the eye moves.
 *
 * **The port was built to buy view distance, and this is where that is measured or refuted.** At
 * render radius 6 the forward path submits a draw a visible chunk mesh and the second pipeline
 * submits two whatever the radius; the forward path's cost grows with what it submits and the
 * port's with what it holds. Neither shows on a camera that stands still over a ring already
 * built, so every run flies: `?fly=` moves the eye forward at a fixed speed, chunks arrive ahead
 * and leave behind, and the same chunks stream in the same order on both pipelines.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up: it needs a dev server
 * and a real GPU.
 *
 *     (setsid npx vite demo/dev --port 5202 > /tmp/vite.log 2>&1 < /dev/null &) ; sleep 9
 *     node scripts/sandbox-bench.mjs --base=http://localhost:5202 [--radii=6,8,10] [--frames=300]
 *         [--pipelines=forward,gpu-driven] [--query=&portshadow=1]
 *
 * `--query` is appended to every page, for a knob under measurement — `&portshadow=1` draws the
 * second pipeline's sun shadow, which the matched comparison leaves off.
 *
 * **`MB in buffers` is what the page holds in ArrayBuffers** once the run is over — the backing
 * stores `Runtime.getHeapUsage` reports, which is where a streaming scene's geometry sat until it
 * stopped keeping a copy. `--calibrate` allocates a known 256 MiB and prints what each of that
 * call's figures moved by: the JS heap's does not count a typed array's storage, so it is the
 * wrong one to read.
 *
 * **What a figure is.** `cpu` is the scene's whole `frame` on the main thread — streaming, the
 * budgeted chunk builds, and on the forward path every draw it encodes. `gpu` is what the scene
 * reports from device timestamps under `?gputiming=1`: the forward path's frame timer, and on the
 * port that plus the pass's own stages. Medians and ninety-fifth percentiles, because a frame
 * that builds a chunk and a frame that does not are two different frames and both happen.
 *
 * **What it fails on**: a chunk the port refused, a complaint on the console, and a page that could
 * not mount. Refusals are the port's capacity being wrong, which is a defect; a page that cannot
 * mount at a radius is where that radius stops being possible, and it is printed with the page's
 * own words. A radius either pipeline cannot hold at sixty is a result, and it is printed rather
 * than asserted.
 */
import { launch } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';

function argOf(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const base = argOf('base', 'http://localhost:5202').replace(/\/$/, '');
const radii = argOf('radii', '6,8,10,12').split(',').map(Number);
const frames = Number(argOf('frames', '300'));
/* Walking pace, which is what a chunk ring is budgeted for: a new row every three seconds or so. */
const speed = Number(argOf('fly', '5'));
const pipelines = argOf('pipelines', 'forward,gpu-driven').split(',');
const extraQuery = argOf('query', '');

if (process.argv.includes('--calibrate')) {
  /*
   * **A memory figure is trusted only after it is seen to move.** A JS heap size does not count a
   * typed array's storage, so the wrong figure would show a streaming scene's copy as nothing at
   * all. Allocate a known 256 MiB and print what each figure moved by; only one that moves by that
   * much is the one the column reports.
   */
  const browser = await launch();
  const client = await connect(browser.port);
  const page = await client.page(`${base}/`, 640, 360);
  const before = await page.call('Runtime.getHeapUsage');
  await page.eval('globalThis.__calibration = new Uint8Array(256 * 2 ** 20).fill(1); true');
  const after = await page.call('Runtime.getHeapUsage');
  for (const key of Object.keys(after)) {
    const moved = (after[key] - (before[key] ?? 0)) / 2 ** 20;
    console.log(`${key.padEnd(24)} moved ${moved.toFixed(1)} MiB`);
  }
  await page.close?.();
  await browser.close?.();
  process.exit(0);
}

/** What the dev harness writes over the page when a scene throws while it is being built. */
const MOUNT_FAILED = 'failed to mount';

function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

async function run(pipeline, radius) {
  const browser = await launch();
  const client = await connect(browser.port);
  const query =
    `scene=0&backend=webgpu&radius=${radius}&fly=${speed}&gputiming=1&bench=${frames}` +
    (pipeline === 'gpu-driven' ? '&pipeline=gpu-driven' : '') +
    extraQuery;
  const page = await client.page(`${base}/?${query}`, 1280, 720);
  /*
   * **Or the page said it could not mount**, which is an answer rather than a slow run. The port
   * at radius 32 failed that way — its vertex reservation is past what a browser will allocate —
   * and a wait on the bench alone sat out its whole ten minutes on a page that had stopped.
   */
  await page.settled(
    `globalThis.__bench?.done === true || document.body.innerText.includes('${MOUNT_FAILED}')`,
    { timeoutMs: 600_000, settleMs: 200 },
  );
  const text = await page.eval('document.body.innerText');
  const failure = text.includes(MOUNT_FAILED)
    ? text.slice(text.indexOf(MOUNT_FAILED)).replace(/\s+/g, ' ').trim()
    : null;
  const bench = JSON.parse(await page.eval('JSON.stringify(globalThis.__bench ?? null)'));
  /*
   * **What the page holds in buffers**, read once the run is over: the ArrayBuffers' backing
   * stores, which is where a streaming scene's geometry sat before it stopped keeping a copy.
   * `--calibrate` is what showed this is the figure that moves when a buffer is allocated and the
   * JS heap's is not.
   */
  const heap = failure === null ? await page.call('Runtime.getHeapUsage') : null;
  const complaints = page.complaints().filter((line) => !line.includes('404'));
  await page.close?.();
  await browser.close?.();
  return { bench, complaints, failure, heap };
}

let failed = 0;
const rows = [];
for (const radius of radii) {
  for (const pipeline of pipelines) {
    const { bench, complaints, failure, heap } = await run(pipeline, radius);
    if (failure !== null) {
      failed += 1;
      console.log(`FAIL  radius ${String(radius).padStart(2)}  ${pipeline}: ${failure}`);
      continue;
    }
    const refused = /(\d+) refused/.exec(bench.extra)?.[1];
    const row = {
      radius,
      pipeline,
      cpuMedian: quantile(bench.cpu, 0.5),
      cpuP95: quantile(bench.cpu, 0.95),
      gpuMedian: quantile(bench.gpu, 0.5),
      gpuP95: quantile(bench.gpu, 0.95),
      draws: bench.draws,
      extra: bench.extra,
      buffersMB: (heap?.backingStorageSize ?? Number.NaN) / 1e6,
    };
    rows.push(row);
    console.log(
      `radius ${String(radius).padStart(2)}  ${pipeline.padEnd(10)}  ` +
        `cpu ${row.cpuMedian.toFixed(2).padStart(6)} / ${row.cpuP95.toFixed(2).padStart(6)} ms  ` +
        `gpu ${row.gpuMedian.toFixed(2).padStart(6)} / ${row.gpuP95.toFixed(2).padStart(6)} ms  ` +
        `${String(row.draws).padStart(4)} draws  ${row.buffersMB.toFixed(0).padStart(5)} MB in buffers  ` +
        row.extra,
    );
    if (complaints.length > 0) {
      failed += 1;
      console.log(`FAIL  radius ${radius} ${pipeline} complained: ${complaints.join(' | ')}`);
    }
    if (pipeline === 'gpu-driven' && refused !== '0') {
      failed += 1;
      console.log(
        `FAIL  radius ${radius}: the port refused ${refused ?? 'an unknown number of'} chunks`,
      );
    }
  }
}

/*
 * **The largest radius each holds at sixty**, read off the ninety-fifth percentile of whichever of
 * its two sides is slower, because a frame is as long as the longer of them.
 */
const SIXTY = 1000 / 60;
for (const pipeline of pipelines) {
  const held = rows
    .filter((row) => row.pipeline === pipeline && Math.max(row.cpuP95, row.gpuP95) < SIXTY)
    .map((row) => row.radius);
  console.log(
    `${pipeline.padEnd(10)} holds sixty at ${held.length === 0 ? 'none of these radii' : `radius ${Math.max(...held)}`}`,
  );
}

console.log(`\n${failed === 0 ? 'no refusals and no complaints' : `${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);

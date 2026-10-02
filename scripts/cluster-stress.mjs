/**
 * Where a clustered frame's GPU time goes, pass by pass.
 *
 * **A total cannot say whether binning or shading is the cost, and that is the question.** The
 * renderer's own timer splits a frame three ways, shadows, reflection and the rest, and the rest
 * holds both the binner's dispatch and the lit pass. This puts a timestamp pair on every render
 * and compute pass the page records, by wrapping the WebGPU entry points before the page loads, so
 * it needs nothing from the engine and measures a build exactly as it ships. Each pass reports its
 * median over a run of frames, beside the froxel occupancy `demo/dev/clusterStress.ts` counts.
 *
 * It is how the 2026-10-02 work on the lit loop was measured: at 3840 by 2160 with 320 lamps of
 * radius 8, the main pass was 17.5 ms against the binner's 0.15, which put the cost in consuming
 * the froxels rather than building them.
 *
 * Not a `*.test.mjs`: it needs a dev server and a real GPU, like `cluster-lights-check.mjs`.
 *
 *     (setsid npx vite demo/dev --port 5202 > /tmp/vite.log 2>&1 < /dev/null &) ; sleep 7
 *     node scripts/cluster-stress.mjs --base=http://localhost:5202 --size=3840x2160 \
 *       "lights=0" "lights=320" "lights=320&radius=12"
 *
 * **Let the clock settle.** A GPU drops to a lower power state between pages, and a short warm-up
 * measured the same shader 2.5 ms apart on two runs; sixty frames each way read within 0.03 ms
 * across three interleaved rounds. `--warm` and `--frames` default to that.
 */
import { launch, rendererName, requireHardwareGpu } from '../packages/core/scripts/browser.mjs';
import { connect, sleep } from '../packages/core/scripts/cdp.mjs';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const BASE = arg('base', 'http://localhost:5202');
const [WIDTH, HEIGHT] = arg('size', '3840x2160').split('x').map(Number);
const WARM = Number(arg('warm', '60'));
const FRAMES = Number(arg('frames', '60'));
const QUERIES = process.argv.slice(2).filter((a) => !a.startsWith('--'));

/*
 * Injected before the page's own scripts. It asks for `timestamp-query` where the adapter has it,
 * gives every pass a pair of queries from one set per device, resolves them after each submit and
 * keeps `{ frame, label, ms }` on `globalThis.__gpuPasses`. A frame is a `requestAnimationFrame`
 * callback, which is how the stress page draws.
 */
const SHIM = `(() => {
  const CAP = 1024;
  const encoderDevice = new WeakMap();
  const queueDevice = new WeakMap();
  const state = new WeakMap();
  let frame = 0;
  globalThis.__gpuPasses = [];
  globalThis.__gpuFrame = () => frame;
  const raf = globalThis.requestAnimationFrame.bind(globalThis);
  globalThis.requestAnimationFrame = (cb) => raf((t) => { frame += 1; cb(t); });
  const requestDevice = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = function (desc = {}) {
    const features = new Set(desc.requiredFeatures ?? []);
    if (this.features.has('timestamp-query')) features.add('timestamp-query');
    globalThis.__timestamps = this.features.has('timestamp-query');
    return requestDevice.call(this, { ...desc, requiredFeatures: [...features] });
  };
  const context = (device) => {
    let s = state.get(device);
    if (s === undefined && device.features.has('timestamp-query')) {
      s = {
        set: device.createQuerySet({ type: 'timestamp', count: CAP }),
        resolve: device.createBuffer({ size: CAP * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
        free: [],
        next: 0,
        labels: [],
      };
      state.set(device, s);
    }
    return s;
  };
  const createCommandEncoder = GPUDevice.prototype.createCommandEncoder;
  GPUDevice.prototype.createCommandEncoder = function (desc) {
    const encoder = createCommandEncoder.call(this, desc);
    encoderDevice.set(encoder, this);
    queueDevice.set(this.queue, this);
    return encoder;
  };
  const stamped = (encoder, desc, kind) => {
    const device = encoderDevice.get(encoder);
    const s = device && context(device);
    if (!s || s.next + 2 > CAP) return desc;
    const at = s.next;
    s.next += 2;
    s.labels.push({ label: (desc && desc.label) || kind, at, frame });
    return { ...(desc || {}), timestampWrites: { querySet: s.set, beginningOfPassWriteIndex: at, endOfPassWriteIndex: at + 1 } };
  };
  const beginRenderPass = GPUCommandEncoder.prototype.beginRenderPass;
  GPUCommandEncoder.prototype.beginRenderPass = function (desc) {
    return beginRenderPass.call(this, stamped(this, desc, 'render'));
  };
  const beginComputePass = GPUCommandEncoder.prototype.beginComputePass;
  GPUCommandEncoder.prototype.beginComputePass = function (desc) {
    return beginComputePass.call(this, stamped(this, desc, 'compute'));
  };
  const submit = GPUQueue.prototype.submit;
  GPUQueue.prototype.submit = function (buffers) {
    const device = queueDevice.get(this);
    const s = device && state.get(device);
    if (!s || s.next === 0) return submit.call(this, buffers);
    const count = s.next;
    const labels = s.labels;
    s.next = 0;
    s.labels = [];
    const encoder = createCommandEncoder.call(device);
    encoder.resolveQuerySet(s.set, 0, count, s.resolve, 0);
    const staging = s.free.pop() || device.createBuffer({ size: CAP * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    encoder.copyBufferToBuffer(s.resolve, 0, staging, 0, count * 8);
    const result = submit.call(this, [...buffers, encoder.finish()]);
    staging.mapAsync(GPUMapMode.READ, 0, count * 8).then(() => {
      const t = new BigInt64Array(staging.getMappedRange(0, count * 8).slice(0));
      staging.unmap();
      s.free.push(staging);
      for (const { label, at, frame: f } of labels) {
        globalThis.__gpuPasses.push({ frame: f, label, ms: Number(t[at + 1] - t[at]) / 1e6 });
      }
    });
    return result;
  };
})();`;

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? Number.NaN : (sorted[Math.floor(sorted.length / 2)] ?? Number.NaN);
};

const browser = await launch({
  flags: [
    '--use-angle=vulkan',
    '--enable-features=Vulkan',
    '--enable-unsafe-webgpu',
    /* Timestamps unquantised. Chrome rounds them to 100 µs otherwise, a fraction of the binner. */
    '--enable-webgpu-developer-features',
  ],
});
try {
  const client = await connect(browser.port);
  await requireHardwareGpu(client);
  console.log(
    `# ${await rendererName(client)}, ${WIDTH}x${HEIGHT}, ${WARM} frames warm, ${FRAMES} measured`,
  );
  for (const query of QUERIES.length > 0 ? QUERIES : ['lights=320']) {
    const page = await client.page(`${BASE}/clusterStress.html?${query}`, WIDTH, HEIGHT, {
      beforeLoad: SHIM,
    });
    const start = Date.now();
    while (
      Date.now() - start < 120_000 &&
      !(await page.eval('globalThis.__stress !== undefined'))
    ) {
      await sleep(200);
    }
    const info = await page.eval(
      '({ ...globalThis.__stress, frames: undefined, timestamps: globalThis.__timestamps })',
    );
    if (info.timestamps !== true)
      throw new Error('this adapter offers no timestamp-query, so nothing can be timed');
    const settled = (await page.eval('globalThis.__gpuFrame()')) + WARM;
    while ((await page.eval('globalThis.__gpuFrame()')) < settled) await sleep(100);
    while ((await page.eval('globalThis.__gpuFrame()')) < settled + FRAMES) await sleep(100);
    await sleep(500);
    const rows = await page.eval(
      `globalThis.__gpuPasses.filter((r) => r.frame >= ${settled} && r.frame < ${settled + FRAMES})`,
    );
    const byLabel = new Map();
    const byFrame = new Map();
    for (const { frame, label, ms } of rows) {
      const perFrame = byLabel.get(label) ?? new Map();
      perFrame.set(frame, (perFrame.get(frame) ?? 0) + ms);
      byLabel.set(label, perFrame);
      byFrame.set(frame, (byFrame.get(frame) ?? 0) + ms);
    }
    const o = info.occupancy;
    console.log(`\n## ${query}  (${info.backend} ${info.width}x${info.height})`);
    console.log(
      `total GPU ${median(byFrame.values()).toFixed(2)} ms, median of ${byFrame.size} frames`,
    );
    console.log(
      `froxels: ${o.occupied} occupied, lights a froxel mean ${o.mean.toFixed(1)}, median ${o.median}, ` +
        `p95 ${o.p95}, max ${o.max}; ${o.full} full, ${o.references} references, ${o.dropped} dropped`,
    );
    const lines = [...byLabel].map(([label, frames]) => [label, median(frames.values())]);
    for (const [label, ms] of lines.sort((a, b) => b[1] - a[1])) {
      console.log(`  ${ms.toFixed(3).padStart(8)} ms  ${label}`);
    }
    await page.close();
  }
  client.close();
} finally {
  await browser.close();
}

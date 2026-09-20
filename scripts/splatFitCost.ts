/**
 * What an optimisation step of a splat fit costs on a device, beside what it costs on the CPU.
 *
 * **Shared by the native host's measurement and the browser's**, so the two run the same code on
 * their own `GPU` — the arrangement `modelCost.ts` established, and its `openDevice` and
 * `sustained` are what time it.
 *
 * **What is measured is the half that is per pixel.** A step of the fit is four things: project
 * every splat, draw the frame, carry the gradients back out of it, and take one Adam step. The
 * projection is per *splat* and stays on the host, where it can be differentiated by hand; the
 * other three are per *pixel* and per *splat parameter*, and are what
 * `packages/core/src/render/inference/splatRaster.wgsl.ts` does. So the figure below is the
 * rasterisation half of a step, on the device against `@driftengine/capture`'s own reference, on
 * the same cloud and the same frame.
 *
 * **The cloud is the one the fit actually produces**, not a scatter: `optimiseGaussians` is run
 * first on the synthetic room, and what it settles on is what both halves are then timed against.
 * A cloud of splats that all sit on top of each other and a cloud spread over the frame cost very
 * different amounts, and the second is the one a capture has.
 */
import {
  accumulateGradients,
  createGradients,
  imageLoss,
  lookAt,
  optimiseGaussians,
  rasteriseGaussians,
  renderTestScene,
  visibleGaussians,
  type GaussianSet,
  type RasterCamera,
  type TestScene,
} from '../packages/capture/src/index.ts';
import {
  countSplatTiles,
  fillSplatTiles,
  splatPairOffsets,
  splatTileGrid,
  splatTileOffsets,
  SPLAT_BIN_FLOATS,
} from '../packages/core/src/render/inference/splatTiles.ts';
import {
  SPLAT_BACKWARD_WGSL,
  SPLAT_FORWARD_WGSL,
  SPLAT_GRADIENT_FLOATS,
  SPLAT_RASTER_FLOATS,
  SPLAT_RASTER_GROUP,
  SPLAT_REDUCE_WGSL,
} from '../packages/core/src/render/inference/splatRaster.wgsl.ts';

export interface SplatFitCost {
  readonly label: string;
  readonly ms: number;
  readonly clock: 'timestamps' | 'wall' | 'cpu';
}

/* Usage flags by value: a host with no browser has no `GPUBufferUsage` global. */
const STORAGE = 0x0080;
const UNIFORM = 0x0040;
const COPY_DST = 0x0008;

const WIDTH = 256;
const HEIGHT = 192;
const INTRINSICS = [240, 240, WIDTH / 2, HEIGHT / 2] as const;
const BUDGET = 4000;
const SEEDS = 700;
/** Steps the cloud is fitted for before it is timed: enough that it has spread over the room. */
const SETTLE = 120;

const SCENE: TestScene = {
  boxes: [
    { min: [-0.7, -0.7, 3.4], max: [0.7, 0.7, 4.6], seed: 1 },
    { min: [-2.4, -1.1, 5.0], max: [-1.0, 1.0, 6.6], seed: 2 },
    { min: [1.0, -1.0, 4.4], max: [2.4, 0.6, 6.0], seed: 5 },
  ],
  planes: [{ normal: [0, 1, 0], offset: -1.3, seed: 3 }],
};

/** The engine's own generator, so the cloud timed is the same cloud every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The synthetic room from a short arc, as linear frames that cover themselves completely. */
function room(): { poses: Float64Array[]; targets: Float64Array[] } {
  const poses: Float64Array[] = [];
  const targets: Float64Array[] = [];
  for (let at = 0; at < 4; at += 1) {
    const t = at / 3;
    const worldToCamera = lookAt([-0.5 + t, 0.1, 0], [0, 0, 5]);
    const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
    renderTestScene(
      SCENE,
      { width: WIDTH, height: HEIGHT, intrinsics: INTRINSICS, worldToCamera },
      pixels,
    );
    const frame = new Float64Array(WIDTH * HEIGHT * 4);
    for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel += 1) {
      for (let c = 0; c < 3; c += 1) frame[pixel * 4 + c] = (pixels[pixel * 4 + c] as number) / 255;
      frame[pixel * 4 + 3] = 1;
    }
    poses.push(worldToCamera);
    targets.push(frame);
  }
  return { poses, targets };
}

/** A cloud that has been fitted to the room, which is what a step of a real fit costs. */
function settled(): { set: GaussianSet; camera: RasterCamera; target: Float64Array } {
  const { poses, targets } = room();
  const random = seeded(20260920);
  const seeds = new Float64Array(SEEDS * 3);
  for (let at = 0; at < SEEDS; at += 1) {
    seeds[at * 3] = -2.4 + random() * 4.8;
    seeds[at * 3 + 1] = -1.3 + random() * 2.4;
    seeds[at * 3 + 2] = 3.2 + random() * 3.6;
  }
  const fitted = optimiseGaussians(targets, poses, {
    intrinsics: INTRINSICS,
    width: WIDTH,
    height: HEIGHT,
    seeds,
    budget: BUDGET,
    iterations: SETTLE,
    initialScale: 0.12,
    refineEvery: 20,
    random: seeded(20260920),
  });
  return {
    set: {
      count: fitted.count,
      positions: Float64Array.from(fitted.positions),
      scales: Float64Array.from(fitted.scales),
      rotations: Float64Array.from(fitted.rotations),
      colors: Float64Array.from(fitted.colors),
      opacities: Float64Array.from(fitted.opacities),
    },
    camera: {
      width: WIDTH,
      height: HEIGHT,
      intrinsics: INTRINSICS,
      worldToCamera: poses[0] as Float64Array,
    },
    target: targets[0] as Float64Array,
  };
}

/** The cloud as the device takes it: projected, nearest first, with its tile lists beside it. */
function prepare(set: GaussianSet, camera: RasterCamera) {
  const { order, projected } = visibleGaussians(set, camera);
  const splats = new Float32Array(order.length * SPLAT_RASTER_FLOATS);
  const bins = new Float32Array(order.length * SPLAT_BIN_FLOATS);
  order.forEach((at, slot) => {
    const one = projected[at];
    if (one === null || one === undefined) return;
    const record = slot * SPLAT_RASTER_FLOATS;
    splats[record] = one.x;
    splats[record + 1] = one.y;
    splats[record + 2] = one.a;
    splats[record + 3] = one.b;
    splats[record + 4] = one.d;
    splats[record + 5] = set.opacities[at] as number;
    for (let c = 0; c < 3; c += 1) splats[record + 6 + c] = set.colors[at * 3 + c] as number;
    splats[record + 9] = one.radius;
    const bin = slot * SPLAT_BIN_FLOATS;
    bins[bin] = one.x;
    bins[bin + 1] = one.y;
    bins[bin + 2] = one.radius;
    bins[bin + 3] = one.depth;
  });

  const { across, down } = splatTileGrid(WIDTH, HEIGHT);
  const counts = new Uint32Array(across * down);
  const tilesPerSplat = new Uint32Array(order.length);
  const entries = countSplatTiles(bins, order.length, WIDTH, HEIGHT, counts, tilesPerSplat);
  const offsets = new Uint32Array(across * down);
  splatTileOffsets(counts, offsets);
  const pairOffsets = new Uint32Array(order.length);
  splatPairOffsets(tilesPerSplat, pairOffsets);
  const lists = new Uint32Array(entries);
  const pairOf = new Uint32Array(entries);
  fillSplatTiles(
    bins,
    order.length,
    WIDTH,
    HEIGHT,
    offsets,
    new Uint32Array(across * down),
    lists,
    { offsets: pairOffsets, pairOf },
  );
  return {
    splats,
    counts,
    offsets,
    lists,
    pairOf,
    pairOffsets,
    tilesPerSplat,
    entries,
    across,
    down,
    visible: order.length,
  };
}

function storage(device: GPUDevice, values: Float32Array | Uint32Array | number): GPUBuffer {
  const bytes = typeof values === 'number' ? values * 4 : Math.max(4, values.byteLength);
  const buffer = device.createBuffer({ size: bytes, usage: STORAGE | COPY_DST });
  if (typeof values !== 'number') device.queue.writeBuffer(buffer, 0, values);
  return buffer;
}

/**
 * A step's rasterisation on the device and on the CPU, on the same settled cloud.
 *
 * `openDevice` and `sustained` come from `modelCost.ts`, so the device figure is measured the way
 * every other device figure in this wave is: after as long again of the same work, because a device
 * idling between bursts clocks down.
 */
export async function measureSplatFit(
  gpu: GPU,
  helpers: {
    openDevice: (gpu: GPU) => Promise<{ device: GPUDevice; stamped: boolean }>;
    sustained: (
      device: GPUDevice,
      stamped: boolean,
      encode: (encoder: GPUCommandEncoder, writes?: GPUComputePassTimestampWrites) => void,
    ) => Promise<number>;
  },
): Promise<SplatFitCost[]> {
  const { set, camera, target } = settled();
  const prepared = prepare(set, camera);
  const out: SplatFitCost[] = [];

  /* The CPU's own step, which is what the device has to beat. */
  const frame = new Float64Array(WIDTH * HEIGHT * 4);
  const dPixels = new Float64Array(WIDTH * HEIGHT * 4);
  const gradients = createGradients(set.count);
  const cpuStarted = performance.now();
  const RUNS = 3;
  for (let run = 0; run < RUNS; run += 1) {
    rasteriseGaussians(set, camera, frame);
    imageLoss(frame, target, dPixels);
    accumulateGradients(set, camera, dPixels, gradients);
  }
  out.push({
    label: `reference, ${set.count} splats at ${WIDTH}x${HEIGHT}`,
    ms: (performance.now() - cpuStarted) / RUNS,
    clock: 'cpu',
  });

  const { device, stamped } = await helpers.openDevice(gpu);
  const params = device.createBuffer({ size: 16, usage: UNIFORM | COPY_DST });
  device.queue.writeBuffer(
    params,
    0,
    new Uint32Array([WIDTH, HEIGHT, prepared.across, prepared.visible]),
  );
  const splats = storage(device, prepared.splats);
  const offsets = storage(device, prepared.offsets);
  const counts = storage(device, prepared.counts);
  const lists = storage(device, prepared.lists);
  const pairOf = storage(device, prepared.pairOf);
  const pairOffsets = storage(device, prepared.pairOffsets);
  const tilesPerSplat = storage(device, prepared.tilesPerSplat);
  const frameBuffer = storage(device, WIDTH * HEIGHT * 4);
  const light = storage(device, WIDTH * HEIGHT);
  const dPixelBuffer = storage(device, Float32Array.from(dPixels));
  const partials = storage(device, prepared.entries * SPLAT_GRADIENT_FLOATS);
  const reduced = storage(device, prepared.visible * SPLAT_GRADIENT_FLOATS);

  const pass = (code: string, buffers: GPUBuffer[], groups: readonly [number, number]) => {
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code }), entryPoint: 'main' },
    });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
    return { pipeline, group, groups };
  };

  const forward = pass(
    SPLAT_FORWARD_WGSL,
    [params, splats, offsets, counts, lists, frameBuffer, light],
    [prepared.across, prepared.down],
  );
  const backward = pass(
    SPLAT_BACKWARD_WGSL,
    [params, splats, offsets, counts, lists, pairOf, dPixelBuffer, light, partials],
    [prepared.across, prepared.down],
  );
  const reduce = pass(
    SPLAT_REDUCE_WGSL,
    [params, pairOffsets, tilesPerSplat, partials, reduced],
    [Math.ceil(prepared.visible / 64), 1],
  );

  const run = (stages: readonly ReturnType<typeof pass>[], label: string): Promise<SplatFitCost> =>
    helpers
      .sustained(device, stamped, (encoder, writes) => {
        const compute = encoder.beginComputePass(
          writes === undefined ? {} : { timestampWrites: writes },
        );
        for (const stage of stages) {
          compute.setPipeline(stage.pipeline);
          compute.setBindGroup(0, stage.group);
          compute.dispatchWorkgroups(stage.groups[0], stage.groups[1]);
        }
        compute.end();
      })
      .then((ms) => ({ label, ms, clock: stamped ? ('timestamps' as const) : ('wall' as const) }));

  /*
   * **The first figure of a run is warm-up and is thrown away.** Measured: with the passes timed in
   * the order they are written, the first came back at 0.60 ms and the same pass measured second at
   * 0.05 — an order of magnitude, entirely in the pipeline being built and the device coming up to
   * clock. A set of figures whose first is the slowest is a set nobody can compare.
   */
  await run([forward, backward, reduce], 'discarded');

  /*
   * **The floor, measured rather than assumed.** A pass with one workgroup of the reduce kernel in
   * it does no work worth naming, so what it costs is what a submission costs — and a figure below
   * or near it is the harness rather than the shader. Without this control, three shaders that all
   * came back at the same number would read as three shaders that cost the same.
   */
  const empty = pass(
    SPLAT_REDUCE_WGSL,
    [params, pairOffsets, tilesPerSplat, partials, reduced],
    [1, 1],
  );
  out.push(await run([empty], 'one workgroup — the submission floor'));
  out.push(await run([forward], `device forward, ${prepared.entries} tile entries`));
  out.push(await run([backward, reduce], 'device backward and reduce'));
  out.push(await run([forward, backward, reduce], 'device, a whole step'));
  device.destroy();
  return out;
}

export const SPLAT_FIT_SHAPE = {
  width: WIDTH,
  height: HEIGHT,
  tile: SPLAT_RASTER_GROUP,
  budget: BUDGET,
};

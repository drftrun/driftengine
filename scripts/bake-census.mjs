#!/usr/bin/env node
/**
 * Where a traced probe's rays go, counted rather than argued about.
 *
 * **`scripts/bounce-check.mjs` says the traced grid puts the right colour on the far wall and a
 * thirty-fifth of the light.** Task 9 of `plans/2026-09-17-indirect-light.md` names two suspects
 * and refuses to pick between them by reasoning: the **sky**, which every ray that leaves the room
 * reads and which `demo/dev/bounce.html` sets near black on purpose, and the **shadow march**,
 * which calls any hit a shadow with no partial term. This is the count that separates them.
 *
 * **The room is `demo/dev/bounce.html`'s, rebuilt here from the same numbers**, and the shader is
 * the production one — `probeBakeWgsl()` with one entry point appended, which reports per ray what
 * `traceMain` would have consumed. Nothing about the trace is restated: the census calls
 * `probeTraceField`, `probeFieldConfidence`, `probeFieldNormal` and `probeSunVisible` exactly as
 * `probeSurfaceRadiance` does.
 *
 * **The probe array is zero at every level**, so `probeVolumeIrradianceAt` answers nothing and what
 * is counted is the *first* bounce alone. A grid reading back its own output would fold the thing
 * being measured into the measurement.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up: it needs a real GPU,
 * which is why `probe-bake-parity.mjs` and `ghost-check.mjs` are run by hand too.
 *
 *     node scripts/bake-census.mjs
 */

import { openGpuCompute } from '../packages/core/scripts/gpuCompute.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const { composeGlobalField, createGlobalField } = await import(
  `${ROOT}packages/core/src/render/gi/globalField.ts`
);
const { DistanceFieldScene, distanceFieldBounds } = await import(
  `${ROOT}packages/core/src/render/gi/fieldScene.ts`
);
const { fitProbeGrid } = await import(`${ROOT}packages/core/src/render/gi/probeGridFit.ts`);
const { MAX_ENV_PROBES, ProbeGrid } = await import(`${ROOT}packages/core/src/render/probeGrid.ts`);
const { PROBE_DIRECTIONS } = await import(`${ROOT}packages/core/src/render/gi/probeTrace.ts`);
const { FIELD_MARCH } = await import(`${ROOT}packages/core/src/render/gi/traceField.ts`);
const { irradianceLevelFor } = await import(`${ROOT}packages/core/src/render/prefilterEnvMap.ts`);
const { PROBE_MARCH_FLOATS } = await import(
  `${ROOT}packages/core/src/render/shaders/gi/probeTrace.wgsl.ts`
);
const {
  PROBE_VOLUME_FLOATS,
  VOLUME_COUNTS,
  VOLUME_EDGE,
  VOLUME_INV_SPACING,
  VOLUME_LEVEL,
  VOLUME_ORIGIN,
  VOLUME_RADIANCE_EDGE,
  VOLUME_RADIANCE_LEVEL,
} = await import(`${ROOT}packages/core/src/render/shaders/gi/probeVolume.wgsl.ts`);
const {
  BAKE_COUNTS,
  BAKE_EDGE,
  BAKE_FRAME,
  BAKE_ORIGIN,
  BAKE_SCHEDULED,
  BAKE_SKY_COLOUR,
  BAKE_SPACING,
  BAKE_SUN_COLOUR,
  BAKE_SUN_DIR,
  PROBE_BAKE_FLOATS,
  PROBE_BAKE_WORKGROUP,
  probeBakeWgsl,
} = await import(`${ROOT}packages/core/src/render/shaders/gi/probeBake.wgsl.ts`);
const { DEFAULT_FIELD_COMPOSE } = await import(
  `${ROOT}packages/core/src/render/backend/webgpu/fieldCompose.ts`
);

/* ---- The room, from `demo/dev/bounce.ts`'s own numbers. ---- */

const ROOM = [2, 1.5, 2];
const WALL = 0.2;
const SLAB_STEP = 0.1;
const SLAB_PAD = 0.4;
/** Where the camera stands, which is what the cascades are centred on. */
const EYE = [0, 0, 1.5];
/** `INDIRECT_PROBE_SPACING` in `backend/webgpu/renderer.ts`. */
const PROBE_SPACING = 2;
/** `reflectionProbeSize` the page asks for. */
const PROBE_EDGE = 64;

const WHITE = [0.82, 0.82, 0.82];
const RED = [0.9, 0.06, 0.06];
const SUN_DIR = [0.75, 0.2, 0.63];
const SUN_COLOUR = [4, 3.88, 3.68];
const SKY = [0.01, 0.01, 0.012];

/** A box's exact field on a grid, at one step with a count an axis. The page's own function. */
function boxField(half, pad, step) {
  const low = [-half[0] - pad, -half[1] - pad, -half[2] - pad];
  const dims = [0, 1, 2].map((axis) => Math.round((2 * (half[axis] + pad)) / step) + 1);
  const [nx, ny, nz] = dims;
  const field = new Float32Array(nx * ny * nz);
  for (let iz = 0; iz < nz; iz += 1) {
    for (let iy = 0; iy < ny; iy += 1) {
      for (let ix = 0; ix < nx; ix += 1) {
        const p = [ix, iy, iz].map((whole, axis) => low[axis] + whole * step);
        const gap = [Math.abs(p[0]) - half[0], Math.abs(p[1]) - half[1], Math.abs(p[2]) - half[2]];
        const outside = Math.hypot(Math.max(gap[0], 0), Math.max(gap[1], 0), Math.max(gap[2], 0));
        const inside = Math.min(Math.max(gap[0], gap[1], gap[2]), 0);
        field[ix + nx * (iy + ny * iz)] = outside + inside;
      }
    }
  }
  return {
    field,
    dims: [nx, ny, nz],
    bounds: new Float32Array([
      low[0],
      low[1],
      low[2],
      low[0] + (nx - 1) * step,
      low[1] + (ny - 1) * step,
      low[2] + (nz - 1) * step,
    ]),
  };
}

function at(x, y, z) {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
}

const wallX = boxField([WALL, ROOM[1], ROOM[2]], SLAB_PAD, SLAB_STEP);
const wallZ = boxField([ROOM[0], ROOM[1], WALL], SLAB_PAD, SLAB_STEP);
const deck = boxField([ROOM[0], WALL, ROOM[2]], SLAB_PAD, SLAB_STEP);

const declared = [
  { source: deck, model: at(0, -ROOM[1], 0), albedo: WHITE },
  { source: deck, model: at(0, ROOM[1], 0), albedo: WHITE },
  { source: wallZ, model: at(0, 0, -ROOM[2]), albedo: WHITE },
  { source: wallX, model: at(-ROOM[0], 0, 0), albedo: RED },
  { source: wallX, model: at(ROOM[0], 0, 0), albedo: WHITE },
];

/* ---- The field and the grid, fitted exactly as the renderer fits them. ---- */

const scene = new DistanceFieldScene();
for (const entry of declared) scene.record(entry.source, entry.model, entry.albedo);

const RESOLUTION = DEFAULT_FIELD_COMPOSE.resolution;
const CASCADES = DEFAULT_FIELD_COMPOSE.cascades;
const RADIUS = DEFAULT_FIELD_COMPOSE.radius;

const field = createGlobalField(RESOLUTION, CASCADES);
composeGlobalField(
  declared.map((entry) => ({
    source: entry.source,
    transform: entry.model,
    albedo: entry.albedo,
  })),
  EYE,
  RADIUS,
  field,
);

const boundsMin = new Float32Array(3);
const boundsMax = new Float32Array(3);
if (!distanceFieldBounds(scene, boundsMin, boundsMax)) {
  throw new Error('the declared fields have no bounds, so no grid can be fitted');
}
/**
 * The two grids, because the page declares one and a consumer who declares nothing gets the other.
 *
 * `demo/dev/bounce.html` calls `setProbeGrid` with an eighteen-probe lattice standing inside the
 * room, and `indirectGrid()` only fits a grid when none was declared. Counting both is what says
 * whether a finding belongs to the feature or to the scene that asked for it.
 */
const DECLARED_SPACING = 1.2;
const grids = [
  {
    label: 'declared by the page',
    grid: new ProbeGrid({
      origin: [
        -ROOM[0] + DECLARED_SPACING,
        -ROOM[1] + DECLARED_SPACING,
        -ROOM[2] + DECLARED_SPACING,
      ],
      spacing: [DECLARED_SPACING, DECLARED_SPACING, DECLARED_SPACING],
      counts: [3, 2, 3],
    }),
  },
  {
    label: 'fitted by the renderer, which a scene that declares nothing gets',
    grid: new ProbeGrid(
      fitProbeGrid({ min: boundsMin, max: boundsMax }, PROBE_SPACING, MAX_ENV_PROBES),
    ),
  },
];

const LEVEL = irradianceLevelFor(PROBE_EDGE);
const LEVEL_EDGE = Math.max(1, PROBE_EDGE >> LEVEL);

/* ---- The buffers, in the layout the production module reads. ---- */

const samples = RESOLUTION ** 3;
const cascades = new Float32Array(CASCADES * 8);
const fields = new Float32Array(CASCADES * samples);
for (let level = 0; level < CASCADES; level += 1) {
  const cascade = field.cascades[level];
  cascades.set(cascade.bounds, level * 8);
  cascades[level * 8 + 6] = cascade.step;
  fields.set(cascade.field, level * samples);
}

const outer = field.cascades[CASCADES - 1];
const march = new Float32Array(PROBE_MARCH_FLOATS);
const marchInts = new Uint32Array(march.buffer);
marchInts[0] = FIELD_MARCH.steps;
marchInts[1] = CASCADES;
marchInts[2] = RESOLUTION;
march[4] = FIELD_MARCH.reachM;
march[5] = FIELD_MARCH.hitEpsilonM;
march[6] = field.cascades[0].step;
march[7] = FIELD_MARCH.coneAngle;
march[8] = outer.bounds[0];
march[9] = outer.bounds[1];
march[10] = outer.bounds[2];
march[12] = outer.bounds[3];
march[13] = outer.bounds[4];
march[14] = outer.bounds[5];

/** Which frame's direction set. Zero is the base Fibonacci set, which is the most even of them. */
const FRAME = 0;

/**
 * The production module with one entry point appended.
 *
 * **Appended rather than edited into the module**, so what runs here is the text the renderer
 * compiles plus a reader. WGSL resolves a module-scope name after its declaration, so the census
 * binding is declared here and used only below it.
 */
const CENSUS_FLOATS = 8;
const WGSL = `${probeBakeWgsl()}
@group(0) @binding(11) var<storage, read_write> census: array<f32>;

@compute @workgroup_size(${String(PROBE_BAKE_WORKGROUP)})
fn censusMain(@builtin(global_invocation_id) id: vec3<u32>) {
  let total = u32(bake.scheduled) * PROBE_BAKE_DIRECTIONS;
  if (id.x >= total) { return; }
  let slot = id.x / PROBE_BAKE_DIRECTIONS;
  let ray = id.x % PROBE_BAKE_DIRECTIONS;

  let layer = schedule[slot];
  let point = bakeProbePosition(layer);
  let direction = bakeDirection(ray, bake.frame);

  let hit = probeTraceField(point, direction, direction, march.coneAngle);
  var share = 0.0;
  var facing = 0.0;
  var lit = 0.0;
  var depth = 0.0;
  if (hit.hit) {
    share = probeFieldConfidence(hit.point);
    let n = probeFieldNormal(hit.point);
    facing = max(0.0, dot(n, bake.sunDir));
    lit = probeSunVisible(hit.point, n);
    depth = probeFieldAt(hit.point);
  }

  let out = id.x * ${String(CENSUS_FLOATS)}u;
  census[out] = select(0.0, 1.0, hit.hit);
  census[out + 1u] = share;
  census[out + 2u] = facing;
  census[out + 3u] = lit;
  census[out + 4u] = hit.point.x;
  census[out + 5u] = hit.point.y;
  census[out + 6u] = hit.point.z;
  census[out + 7u] = depth;
}
`;

console.log(
  `field ${CASCADES} cascades of ${RESOLUTION}, finest step ${field.cascades[0].step.toFixed(4)} m, ` +
    `outer ${[...outer.bounds].map((v) => v.toFixed(1)).join(', ')}`,
);
console.log(
  `room bounds ${[...boundsMin].map((v) => v.toFixed(2)).join(', ')} to ` +
    `${[...boundsMax].map((v) => v.toFixed(2)).join(', ')}`,
);

const pct = (n, of) => (of === 0 ? '—' : `${((100 * n) / of).toFixed(1)}%`);
const SUN_LUMINANCE = (SUN_COLOUR[0] + SUN_COLOUR[1] + SUN_COLOUR[2]) / 3;
const SKY_LUMINANCE = (SKY[0] + SKY[1] + SKY[2]) / 3;

const gpu = await openGpuCompute();
try {
  for (const entry of grids) {
    const grid = entry.grid;
    const rays = grid.layers * PROBE_DIRECTIONS;

    marchInts[3] = rays;

    /* Every probe of the grid, not the five a frame the schedule picks: this is a census. */
    const schedule = new Uint32Array(grid.layers);
    for (let layer = 0; layer < grid.layers; layer += 1) schedule[layer] = layer;

    const bake = new Float32Array(PROBE_BAKE_FLOATS);
    for (let axis = 0; axis < 3; axis += 1) {
      bake[BAKE_ORIGIN + axis] = grid.origin[axis];
      bake[BAKE_SPACING + axis] = grid.spacing[axis];
      bake[BAKE_COUNTS + axis] = grid.counts[axis];
      bake[BAKE_SUN_DIR + axis] = SUN_DIR[axis];
      bake[BAKE_SUN_COLOUR + axis] = SUN_COLOUR[axis];
      bake[BAKE_SKY_COLOUR + axis] = SKY[axis];
    }
    bake[BAKE_EDGE] = LEVEL_EDGE;
    bake[BAKE_FRAME] = FRAME;
    bake[BAKE_SCHEDULED] = grid.layers;

    const volume = new Float32Array(PROBE_VOLUME_FLOATS);
    for (let axis = 0; axis < 3; axis += 1) {
      volume[VOLUME_ORIGIN + axis] = grid.origin[axis];
      volume[VOLUME_INV_SPACING + axis] = grid.invSpacing[axis];
      volume[VOLUME_COUNTS + axis] = grid.counts[axis];
    }
    volume[VOLUME_EDGE] = LEVEL_EDGE;
    volume[VOLUME_LEVEL] = LEVEL;
    volume[VOLUME_RADIANCE_EDGE] = PROBE_EDGE;
    volume[VOLUME_RADIANCE_LEVEL] = 0;

    const run = await gpu.run({
      wgsl: WGSL,
      entryPoint: 'censusMain',
      workgroups: [Math.ceil(rays / PROBE_BAKE_WORKGROUP)],
      buffers: [
        { type: 'f32', values: cascades, readOnly: true },
        { type: 'f32', values: fields, readOnly: true },
        { kind: 'uniform', type: 'u32', values: Array.from(new Uint32Array(march.buffer)) },
        { kind: 'uniform', type: 'u32', values: Array.from(new Uint32Array(bake.buffer)) },
        { type: 'u32', values: schedule, readOnly: true },
        /* The two the census never writes, sized to nothing in particular. */
        { type: 'f32', length: 3 },
        { type: 'f32', length: 3 },
        { kind: 'uniform', type: 'u32', values: Array.from(new Uint32Array(volume.buffer)) },
        /*
         * **A probe array of zeros**, so `probeVolumeIrradianceAt` answers nothing and what is
         * counted is the *first* bounce. A grid reading back its own output would fold the thing
         * being measured into the measurement.
         */
        {
          kind: 'texture2dArray',
          size: PROBE_EDGE,
          layers: grid.layers,
          levels: Array.from({ length: LEVEL + 1 }, (_unused, level) => {
            const edge = Math.max(1, PROBE_EDGE >> level);
            return new Uint8Array(edge * edge * grid.layers * 4);
          }),
        },
        { kind: 'sampler' },
        /* The albedo, which `censusMain` never reads: it counts rays rather than colouring them. */
        { type: 'f32', values: [1, 1, 1], readOnly: true },
        { type: 'f32', length: rays * CENSUS_FLOATS, read: true },
      ],
    });
    report(entry.label, grid, rays, run[11]);
  }
} finally {
  await gpu.close();
}

/** What one grid's count says. */
function report(label, grid, rays, values) {
  let hits = 0;
  let shareSum = 0;
  let facingRays = 0;
  let facingSum = 0;
  let litRays = 0;
  let litFacingSum = 0;
  let insideHits = 0;
  const perProbe = Array.from({ length: grid.layers }, () => ({ hits: 0, lit: 0 }));

  for (let ray = 0; ray < rays; ray += 1) {
    const base = ray * CENSUS_FLOATS;
    if (values[base] < 0.5) continue;
    const probe = Math.floor(ray / PROBE_DIRECTIONS);
    hits += 1;
    perProbe[probe].hits += 1;
    shareSum += values[base + 1];
    if (values[base + 7] < -1e-4) insideHits += 1;
    const facing = values[base + 2];
    if (facing <= 0) continue;
    facingRays += 1;
    facingSum += facing;
    if (values[base + 3] > 0.5) {
      litRays += 1;
      litFacingSum += facing;
      perProbe[probe].lit += 1;
    }
  }

  const escaped = rays - hits;
  console.log('');
  console.log(`## ${label}`);
  console.log(
    `${grid.counts.join('x')} = ${grid.layers} probes at ${grid.spacing[0].toFixed(2)} m, ` +
      `origin ${[...grid.origin].map((v) => v.toFixed(2)).join(', ')}, ${rays} rays`,
  );
  console.log(`hit the field        ${hits} of ${rays}, ${pct(hits, rays)}`);
  console.log(`escaped to the sky   ${escaped} of ${rays}, ${pct(escaped, rays)}`);
  console.log(`mean confidence at a hit  ${(hits === 0 ? 0 : shareSum / hits).toFixed(4)}`);
  console.log(`hits behind a surface     ${insideHits}, ${pct(insideHits, hits)} of hits`);
  console.log(`hits facing the sun  ${facingRays} of ${hits}, ${pct(facingRays, hits)}`);
  console.log(`of those, lit        ${litRays} of ${facingRays}, ${pct(litRays, facingRays)}`);
  console.log(
    `mean N·L where facing     ${(facingRays === 0 ? 0 : facingSum / facingRays).toFixed(4)}`,
  );

  /*
   * **The two shares side by side, before any albedo.** A ray is worth the sun's irradiance over
   * pi times `N·L` where it struck a lit surface, and the sky where it left — so these are the two
   * numbers the missing energy has to come out of, and the counts above say which is starving.
   */
  const sun = ((litFacingSum / rays) * SUN_LUMINANCE) / Math.PI;
  const sky = (escaped / rays) * SKY_LUMINANCE;
  console.log(`sun into a probe     ${sun.toExponential(3)}`);
  console.log(`sky into a probe     ${sky.toExponential(3)}`);
  console.log(`the sun is ${(sun / Math.max(1e-12, sky)).toFixed(2)} times the sky`);
  const dark = perProbe.filter((probe) => probe.lit === 0).length;
  console.log(`probes no ray of which struck a lit surface: ${dark} of ${grid.layers}`);
}

#!/usr/bin/env node
/**
 * A probe's whole bake on a device, against the three references that define it.
 *
 * **`indirect-parity.mjs` checks the trace; this checks the three spellings around it.** A probe's
 * bake is a Fibonacci direction set, a march down the chain, and a cosine convolution into an
 * octahedral map — and the march is the only one of the three that was already checked. The other
 * two exist twice: `gi/probeTrace.ts` holds the direction set and `shaders/octahedral.ts` holds the
 * mapping, in TypeScript and in GLSL, while `shaders/gi/probeBake.wgsl.ts` holds both again in
 * WGSL because a hand-written compute shader cannot include a generated one.
 *
 * **Each piece is checked on its own, which is why the shader carries three probe entry points.**
 * A direction set off by a thousandth and an octahedral fold off by a thousandth produce the same
 * symptom — a texel slightly wrong — and one end-to-end number cannot say which to go and read.
 *
 * **The radiance comparison is fed the device's own directions**, deliberately. The reference
 * accumulates `i * GOLDEN_ANGLE` in double precision and the shader in single, so by direction 255
 * the two angles differ by about 4e-5 radians — which is nothing, until a ray near a silhouette
 * lands on the other side of it and the two disagree by the whole difference between a hit and a
 * miss. That is a property of the arithmetic rather than a fault in either copy, so the direction
 * set is checked against its own tolerance and the trace is then checked on equal terms.
 *
 * **Two things it cannot see, and both were found by breaking the shader on purpose.**
 *
 * **The direction the volume is read along survives being reversed.** `probeIndirect` reads a hit's
 * radiance back down the ray — what that surface sends *towards* the probe — and section 6 gives
 * every layer one flat colour so that a filtered sample is predictable without modelling a filter.
 * A flat layer answers the same in every direction, so flipping the sign changes nothing here. It
 * is checked by nothing else either, and saying so is better than a corpus that appears to cover
 * it: a map that varied per texel would make the sampler's own interpolation the thing being
 * compared, which is a tolerance on a filter rather than a check of an expression.
 *
 * **And what a probe volume answers in production** is a texture this builds, not the one a frame
 * bakes. `gi/probeVolume.test.ts` and `gi/leak.test.ts` hold the volume's own behaviour.
 *
 * Run by hand, like `gpu-parity.mjs`, `gi-parity.mjs`, `recon-parity.mjs` and
 * `indirect-parity.mjs`, because it needs a device and `npm run test:scripts` deliberately does not.
 *
 *     node scripts/probe-bake-parity.mjs
 */

import { openGpuCompute } from '../packages/core/scripts/gpuCompute.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const { composeGlobalField, createGlobalField } = await import(
  `${ROOT}packages/core/src/render/gi/globalField.ts`
);
const { newIndirectResult, traceIndirect } = await import(
  `${ROOT}packages/core/src/render/gi/chain.ts`
);
const { FIELD_MARCH } = await import(`${ROOT}packages/core/src/render/gi/traceField.ts`);
const { ProbeGrid } = await import(`${ROOT}packages/core/src/render/probeGrid.ts`);
const { PROBE_DIRECTIONS, convolveProbe, probeDirection } = await import(
  `${ROOT}packages/core/src/render/gi/probeTrace.ts`
);
const { probeUpdateSchedule } = await import(`${ROOT}packages/core/src/render/gi/probeVolume.ts`);
const { octInsetDir, octInsetUv } = await import(
  `${ROOT}packages/core/src/render/shaders/octahedral.ts`
);
const { createProbeBlend, nearestProbes } = await import(
  `${ROOT}packages/core/src/render/probeGrid.ts`
);
const { sampleProbeVolume } = await import(`${ROOT}packages/core/src/render/gi/probeVolume.ts`);
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
const { PROBE_MARCH_FLOATS } = await import(
  `${ROOT}packages/core/src/render/shaders/gi/probeTrace.wgsl.ts`
);
const {
  BAKE_COUNTS,
  BAKE_EDGE,
  BAKE_FRAME,
  BAKE_ORIGIN,
  BAKE_SCHEDULED,
  BAKE_SPACING,
  PROBE_BAKE_FLOATS,
  BAKE_SKY_COLOUR,
  BAKE_SUN_COLOUR,
  BAKE_SUN_DIR,
  PROBE_BAKE_WORKGROUP,
  probeBakeParityWgsl,
  probeBakeWgsl,
} = await import(`${ROOT}packages/core/src/render/shaders/gi/probeBake.wgsl.ts`);

const WGSL = probeBakeParityWgsl();

/** A reproducible stream, so a failure is a failure rather than a seed. */
function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** A sphere's exact field on a grid, which is what a bake approximates. */
function sphereField(radius, half, resolution) {
  const field = new Float32Array(resolution ** 3);
  const step = (2 * half) / (resolution - 1);
  for (let iz = 0; iz < resolution; iz += 1) {
    for (let iy = 0; iy < resolution; iy += 1) {
      for (let ix = 0; ix < resolution; ix += 1) {
        field[ix + resolution * (iy + resolution * iz)] =
          Math.hypot(-half + ix * step, -half + iy * step, -half + iz * step) - radius;
      }
    }
  }
  return {
    field,
    dims: [resolution, resolution, resolution],
    bounds: new Float32Array([-half, -half, -half, half, half, half]),
  };
}

/** A placement with a rotation and a uniform scale, column-major. */
function placement(x, y, z, yaw, scale) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // prettier-ignore
  return new Float32Array([
    c * scale, 0, -s * scale, 0,
    0, scale, 0, 0,
    s * scale, 0, c * scale, 0,
    x, y, z, 1,
  ]);
}

/** The same expression the shader evaluates. See `indirect-parity.mjs` for why it is a sine. */
function radianceAt(x, y, z, out) {
  out[0] = 0.5 + 0.4 * Math.sin(x * 1.3);
  out[1] = 0.5 + 0.4 * Math.sin(y * 1.7 + 1);
  out[2] = 0.5 + 0.4 * Math.sin(z * 2.3 + 2);
  return out;
}

const failures = [];
const counts = new Map();
let worst = 0;
let worstAt = '';

function check(what, at, want, got, tolerance) {
  counts.set(what, (counts.get(what) ?? 0) + 1);
  const off = Math.abs(want - got);
  if (off > worst) {
    worst = off;
    worstAt = `${what} ${at}`;
  }
  if (off <= tolerance) return;
  if (failures.length < 12) {
    failures.push(`${what} ${at}: reference ${want.toFixed(6)}, device ${got.toFixed(6)}`);
  }
}

const gpu = await openGpuCompute();
try {
  const RESOLUTION = 25;
  const CASCADES = 3;
  const RADIUS = 4;
  const EDGE = 16;
  const FRAME = 7;
  const random = lcg(0x2b7d19a3);

  /* A field with something in it at every cascade: a ring of spheres a probe's rays can hit. */
  const source = sphereField(0.9, 2, RESOLUTION);
  const instances = [];
  for (let i = 0; i < 18; i += 1) {
    const angle = (i / 18) * Math.PI * 2;
    instances.push({
      source,
      transform: placement(
        Math.cos(angle) * 2.6,
        (random() - 0.5) * 2.5,
        Math.sin(angle) * 2.6,
        random() * Math.PI * 2,
        0.7 + random() * 0.7,
      ),
    });
  }
  const field = createGlobalField(RESOLUTION, CASCADES);
  composeGlobalField(instances, [0, 0, 0], RADIUS, field);

  /*
   * **A grid that is not cubic and whose origin is not the world's**, because both are places the
   * lattice arithmetic can be right by accident. A 4x3x2 grid at a fractional origin with a
   * different spacing on every axis makes `x fastest, then y, then z` a claim that can fail.
   */
  const grid = new ProbeGrid({
    origin: [-3.25, 0.5, -2.75],
    spacing: [1.7, 2.3, 1.1],
    counts: [4, 3, 2],
  });

  const PER_FRAME = 5;
  const scheduleOut = new Int32Array(PER_FRAME);
  const scheduled = probeUpdateSchedule(grid.layers, PER_FRAME, FRAME, scheduleOut);
  const schedule = new Uint32Array(scheduleOut.slice(0, scheduled));

  /* The field's own buffers, in the layout `sampleField` reads: cascades then samples. */
  const cascades = new Float32Array(CASCADES * 8);
  const samples = RESOLUTION ** 3;
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
  marchInts[3] = scheduled * PROBE_DIRECTIONS;
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

  const bake = new Float32Array(PROBE_BAKE_FLOATS);
  bake.set(grid.origin, BAKE_ORIGIN);
  bake.set(grid.spacing, BAKE_SPACING);
  bake[BAKE_COUNTS] = grid.counts[0];
  bake[BAKE_COUNTS + 1] = grid.counts[1];
  bake[BAKE_COUNTS + 2] = grid.counts[2];
  bake[BAKE_EDGE] = EDGE;
  bake[BAKE_FRAME] = FRAME;
  bake[BAKE_SCHEDULED] = scheduled;

  const RAY_COUNT = scheduled * PROBE_DIRECTIONS;
  const TEXELS = EDGE * EDGE;

  /*
   * The volume the blend is checked over: the same grid, a distinct value in every layer, and a
   * corpus of points that reaches inside the grid, outside it and exactly on a probe.
   *
   * **A distinct value a layer is what makes a wrong layer index visible.** With every probe
   * carrying the same colour, an eight-corner blend that picked the wrong eight corners would
   * still return that colour, and the check would pass while the lattice was wrong — which is the
   * mistake row 139 records in a different guise.
   */
  const volume = new Float32Array(PROBE_VOLUME_FLOATS);
  volume.set(grid.origin, VOLUME_ORIGIN);
  for (let axis = 0; axis < 3; axis += 1) {
    volume[VOLUME_INV_SPACING + axis] = 1 / grid.spacing[axis];
    volume[VOLUME_COUNTS + axis] = grid.counts[axis];
  }
  volume[VOLUME_EDGE] = EDGE;
  volume[VOLUME_LEVEL] = 0;
  volume[VOLUME_RADIANCE_EDGE] = EDGE;
  volume[VOLUME_RADIANCE_LEVEL] = 0;

  const probeValues = new Float32Array(grid.layers * 3);
  for (let layer = 0; layer < grid.layers; layer += 1) {
    probeValues[layer * 3] = 0.05 + layer * 0.031;
    probeValues[layer * 3 + 1] = 0.9 - layer * 0.017;
    probeValues[layer * 3 + 2] = 0.2 + ((layer * 7) % 13) * 0.043;
  }

  const QUERIES = 256;
  const queries = new Float32Array(QUERIES * 6);
  const probeAt = [0, 0, 0];
  for (let i = 0; i < QUERIES; i += 1) {
    const at = i * 6;
    if (i % 8 === 0) {
      /* Exactly on a probe, where every fraction is 0 or 1 and one corner takes the whole weight. */
      grid.positionOf(i % grid.layers, probeAt);
      queries[at] = probeAt[0];
      queries[at + 1] = probeAt[1];
      queries[at + 2] = probeAt[2];
    } else {
      /* Half inside the grid and half well outside it, so the clamp at the edge is reached. */
      const spread = i % 2 === 0 ? 1 : 2.5;
      for (let axis = 0; axis < 3; axis += 1) {
        const low = grid.origin[axis];
        const high = low + grid.spacing[axis] * (grid.counts[axis] - 1);
        const mid = (low + high) / 2;
        queries[at + axis] = mid + (random() - 0.5) * (high - low) * spread;
      }
    }
    const d = [random() - 0.5, random() - 0.5, random() - 0.5];
    const dl = Math.hypot(...d) || 1;
    for (let axis = 0; axis < 3; axis += 1) queries[at + 3 + axis] = d[axis] / dl;
  }

  /** One dispatch of the parity module, with every binding it declares. */
  async function dispatch(entryPoint, groups, rayValues, irradianceLength) {
    return gpu.run({
      wgsl: WGSL,
      entryPoint,
      workgroups: [groups],
      buffers: [
        { type: 'f32', values: cascades, readOnly: true },
        { type: 'f32', values: fields, readOnly: true },
        { kind: 'uniform', type: 'u32', values: Array.from(new Uint32Array(march.buffer)) },
        { kind: 'uniform', type: 'u32', values: Array.from(new Uint32Array(bake.buffer)) },
        { type: 'u32', values: schedule, readOnly: true },
        rayValues === null
          ? { type: 'f32', length: RAY_COUNT * 3, read: true }
          : { type: 'f32', values: rayValues, read: true },
        { type: 'f32', length: irradianceLength, read: true },
        { kind: 'uniform', type: 'u32', values: Array.from(new Uint32Array(volume.buffer)) },
        { type: 'f32', values: probeValues, readOnly: true },
        { type: 'f32', values: queries, readOnly: true },
      ],
    });
  }

  const echo = await dispatch('echoMain', 1, null, 16);
  console.log(
    'uniform as the device unpacked it:',
    echo[6]
      .slice(0, 12)
      .map((v) => Number(v.toFixed(4)))
      .join(' '),
  );

  /* ---- 1. The direction set, on its own. ---- */
  const directionRun = await dispatch(
    'directionMain',
    Math.ceil(PROBE_DIRECTIONS / PROBE_BAKE_WORKGROUP),
    null,
    Math.max(PROBE_DIRECTIONS, TEXELS, scheduled) * 3,
  );
  const deviceDirections = directionRun[6];
  const wantDirection = new Float32Array(3);
  for (let i = 0; i < PROBE_DIRECTIONS; i += 1) {
    probeDirection(i, FRAME, wantDirection);
    for (let c = 0; c < 3; c += 1) {
      /*
       * **1e-4, and it is derived rather than chosen.** The angle is `i * GOLDEN_ANGLE` plus the
       * frame's turn, which by direction 255 is about 612 radians; a single-precision float holds
       * that to about 4e-5, and the sine of an angle moves by at most the error in the angle.
       */
      check(`direction ${i}`, `channel ${c}`, wantDirection[c], deviceDirections[i * 3 + c], 1e-4);
    }
  }

  /* ---- 2. The octahedral texel fold, on its own. ---- */
  const texelRun = await dispatch(
    'texelMain',
    Math.ceil(TEXELS / PROBE_BAKE_WORKGROUP),
    null,
    Math.max(PROBE_DIRECTIONS, TEXELS, scheduled) * 3,
  );
  const deviceTexels = texelRun[6];
  const wantTexel = [0, 0, 0];
  for (let v = 0; v < EDGE; v += 1) {
    for (let u = 0; u < EDGE; u += 1) {
      octInsetDir((u + 0.5) / EDGE, (v + 0.5) / EDGE, EDGE, wantTexel);
      const at = (v * EDGE + u) * 3;
      for (let c = 0; c < 3; c += 1) {
        /* A fold and a normalise, with no accumulation in them: single precision to six places. */
        check(`texel ${u},${v}`, `channel ${c}`, wantTexel[c], deviceTexels[at + c], 1e-6);
      }
    }
  }

  /* ---- 3. The lattice, on its own. ---- */
  const positionRun = await dispatch(
    'positionMain',
    Math.ceil(scheduled / PROBE_BAKE_WORKGROUP),
    null,
    Math.max(PROBE_DIRECTIONS, TEXELS, scheduled) * 3,
  );
  const devicePositions = positionRun[6];
  const wantPosition = [0, 0, 0];
  for (let slot = 0; slot < scheduled; slot += 1) {
    grid.positionOf(schedule[slot], wantPosition);
    for (let c = 0; c < 3; c += 1) {
      check(
        `probe ${schedule[slot]} position`,
        `axis ${c}`,
        wantPosition[c],
        devicePositions[slot * 3 + c],
        1e-5,
      );
    }
  }

  /* ---- 3b. The octahedral encode, which is not the fold and needs its own check. ---- */
  const uvRun = await dispatch(
    'uvMain',
    Math.ceil(QUERIES / PROBE_BAKE_WORKGROUP),
    null,
    QUERIES * 3,
  );
  const deviceUv = uvRun[6];
  const wantUv = [0, 0];
  for (let i = 0; i < QUERIES; i += 1) {
    const at = i * 6;
    octInsetUv(queries[at + 3], queries[at + 4], queries[at + 5], EDGE, wantUv);
    for (let c = 0; c < 2; c += 1) {
      check(`uv ${i}`, `axis ${c}`, wantUv[c], deviceUv[i * 3 + c], 1e-6);
    }
  }

  /* ---- 3c. The eight-probe blend, against `nearestProbes` and `sampleProbeVolume`. ---- */
  const volumeRun = await dispatch(
    'volumeMain',
    Math.ceil(QUERIES / PROBE_BAKE_WORKGROUP),
    null,
    QUERIES * 3,
  );
  const deviceVolume = volumeRun[6];
  const blend = createProbeBlend();
  const wantVolume = new Float32Array(3);
  for (let i = 0; i < QUERIES; i += 1) {
    const at = i * 6;
    nearestProbes(grid, queries[at], queries[at + 1], queries[at + 2], blend);
    sampleProbeVolume(blend, probeValues, 3, wantVolume);
    for (let c = 0; c < 3; c += 1) {
      check(`volume ${i}`, `channel ${c}`, wantVolume[c], deviceVolume[i * 3 + c], 1e-5);
    }
  }

  /* ---- 4. The trace, on the device's own directions. ---- */
  const traceRun = await dispatch(
    'traceMain',
    Math.ceil(RAY_COUNT / PROBE_BAKE_WORKGROUP),
    null,
    TEXELS * scheduled * 3,
  );
  const deviceRays = traceRun[5];

  const scratch = new Float32Array(3);
  const result = newIndirectResult();
  const resources = {
    eye: [0, 0, 0],
    project: () => false,
    sceneDistance: () => Infinity,
    screenRadiance: (_u, _v, out) => out.fill(0),
    field,
    fieldRadiance: (x, y, z, out) => radianceAt(x, y, z, out),
    grid: new ProbeGrid({ origin: [0, 0, 0], spacing: [1, 1, 1], counts: [1, 1, 1] }),
    visibility: null,
    probeValues: new Float32Array(3),
    probeChannels: 3,
  };

  const visited = { fieldHits: 0, escaped: 0, faded: 0 };
  for (let slot = 0; slot < scheduled; slot += 1) {
    grid.positionOf(schedule[slot], wantPosition);
    const point = [wantPosition[0], wantPosition[1], wantPosition[2]];
    for (let i = 0; i < PROBE_DIRECTIONS; i += 1) {
      const at = i * 3;
      const direction = [deviceDirections[at], deviceDirections[at + 1], deviceDirections[at + 2]];
      /* Its own direction as its normal, which is what the shader passes and why. */
      traceIndirect(
        { point, normal: direction, direction, coneAngle: FIELD_MARCH.coneAngle },
        resources,
        result,
      );
      const fieldShare = result.blend[1];
      if (fieldShare > 0) visited.fieldHits += 1;
      if (fieldShare > 0 && fieldShare < 1) visited.faded += 1;
      if (fieldShare === 0) visited.escaped += 1;

      /* The probe share, which the parity module answers with the same sine of position. */
      radianceAt(
        point[0] + direction[0] * FIELD_MARCH.reachM,
        point[1] + direction[1] * FIELD_MARCH.reachM,
        point[2] + direction[2] * FIELD_MARCH.reachM,
        scratch,
      );
      const rayAt = (slot * PROBE_DIRECTIONS + i) * 3;
      for (let c = 0; c < 3; c += 1) {
        const want = result.radiance[c] + scratch[c] * (1 - fieldShare);
        check(
          `probe ${schedule[slot]} ray ${i}`,
          `channel ${c}`,
          want,
          deviceRays[rayAt + c],
          2e-3,
        );
      }
    }
  }

  /* ---- 5. The convolution, on the device's own rays. ---- */
  const convolveRun = await dispatch(
    'convolveMain',
    Math.ceil((scheduled * TEXELS) / PROBE_BAKE_WORKGROUP),
    deviceRays,
    TEXELS * scheduled * 3,
  );
  const deviceIrradiance = convolveRun[6];

  const wantMap = new Float32Array(TEXELS * 3);
  const slotRays = new Float32Array(PROBE_DIRECTIONS * 3);
  for (let slot = 0; slot < scheduled; slot += 1) {
    /* `slice` rather than `subarray`: the harness hands back plain arrays, not typed ones. */
    slotRays.set(deviceRays.slice(slot * PROBE_DIRECTIONS * 3, (slot + 1) * PROBE_DIRECTIONS * 3));
    convolveProbe(slotRays, deviceDirections, PROBE_DIRECTIONS, EDGE, wantMap);
    for (let texel = 0; texel < TEXELS; texel += 1) {
      for (let c = 0; c < 3; c += 1) {
        check(
          `probe ${schedule[slot]} texel ${texel}`,
          `channel ${c}`,
          wantMap[texel * 3 + c],
          deviceIrradiance[(slot * TEXELS + texel) * 3 + c],
          2e-4,
        );
      }
    }
  }

  /*
   * **What the corpus reached**, because a check that never entered a branch proved nothing about
   * it. A bake whose rays all escaped would compare the probe level and nothing else.
   */
  console.log(
    `${scheduled} probes of ${grid.layers} scheduled on frame ${FRAME}: ` +
      `${visited.fieldHits} rays hit the field, ${visited.escaped} escaped, ${visited.faded} faded`,
  );
  /* ---- 6. The production module itself, over a real texture on a real device. ---- */

  /*
   * **Everything above checks the parity module, which binds a buffer where production binds a
   * texture.** That is what makes each piece comparable, and it is also what leaves the module the
   * renderer actually runs unchecked — its bindings, its sampler, and `probeRadianceAt` reading
   * the probe volume rather than a sine. A module that does not compile, or whose bind group does
   * not match its layout, fails at the first frame and not before.
   *
   * **Every layer is one flat colour**, so the reference can predict what a filtered sample of it
   * returns without modelling a filter: the octahedral coordinate cannot matter when every texel of
   * a layer is the same, and what is left is exactly the trilinear blend `sampleProbeVolume`
   * computes. The colours are eighths of 255 so the eight-bit texture holds them exactly.
   */
  const LAYER_BYTES = new Uint8Array(grid.layers * 4);
  const layerColour = new Float32Array(grid.layers * 3);
  for (let layer = 0; layer < grid.layers; layer += 1) {
    const step = 32 * (1 + (layer % 7));
    for (let c = 0; c < 3; c += 1) {
      const byte = (step + c * 16) % 256;
      LAYER_BYTES[layer * 4 + c] = byte;
      layerColour[layer * 3 + c] = byte / 255;
    }
    LAYER_BYTES[layer * 4 + 3] = 255;
  }
  /* Every texel of a layer is that layer's colour, at level 0, which is the level named below. */
  const level0 = new Uint8Array(TEXELS * grid.layers * 4);
  for (let layer = 0; layer < grid.layers; layer += 1) {
    for (let texel = 0; texel < TEXELS; texel += 1) {
      const at = (layer * TEXELS + texel) * 4;
      for (let c = 0; c < 4; c += 1) level0[at + c] = LAYER_BYTES[layer * 4 + c];
    }
  }
  /*
   * **A second mip holding something else, so `volume.level` is a line that can fail.** With one
   * level the sampler clamps every level request to it, and a perturbation that asked for the
   * wrong mip returned the right answer — which is the shape of a check that proves nothing about
   * the line it was aimed at. The real module names the irradiance level out of six.
   */
  const halfEdge = Math.max(1, EDGE >> 1);
  const level1 = new Uint8Array(halfEdge * halfEdge * grid.layers * 4);
  for (let at = 0; at < level1.length; at += 4) {
    level1[at] = 255 - level0[at];
    level1[at + 1] = 255 - level0[at + 1];
    level1[at + 2] = 255 - level0[at + 2];
    level1[at + 3] = 255;
  }

  const productionVolume = Float32Array.from(volume);
  productionVolume[VOLUME_LEVEL] = 0;

  /*
   * **Every surface white and the sun off**, which is what keeps the reference one function.
   *
   * The production module shades what a ray struck — albedo, the sun, a shadow march, and what has
   * already bounced — and `traceIndirect` does none of that, so a corpus with a sun in it would
   * need a second reference written to match a shader, which is the arrangement every check here
   * exists to avoid. With white albedo and no sun the shading collapses to `irradiance / pi`, which
   * the reference can supply through the accessor it already has.
   *
   * **So the sun term and the shadow march are not checked here**, and nothing else checks them
   * either except `scripts/bounce-check.mjs`, which measures whether a bounce follows a wall that
   * changes colour. Said rather than left implicit.
   */
  const whiteAlbedo = new Float32Array(CASCADES * samples * 3).fill(1);
  const SKY = [0.21, 0.34, 0.47];
  const productionBake = Float32Array.from(bake);
  for (let axis = 0; axis < 3; axis += 1) {
    productionBake[BAKE_SUN_DIR + axis] = 0;
    productionBake[BAKE_SUN_COLOUR + axis] = 0;
    /* And a sky the reference can name, for the rays that leave the field entirely. */
    productionBake[BAKE_SKY_COLOUR + axis] = SKY[axis];
  }

  const productionRun = await gpu.run({
    wgsl: probeBakeWgsl(),
    entryPoint: 'traceMain',
    workgroups: [Math.ceil(RAY_COUNT / PROBE_BAKE_WORKGROUP)],
    buffers: [
      { type: 'f32', values: cascades, readOnly: true },
      { type: 'f32', values: fields, readOnly: true },
      { kind: 'uniform', type: 'u32', values: Array.from(new Uint32Array(march.buffer)) },
      { kind: 'uniform', type: 'u32', values: Array.from(new Uint32Array(productionBake.buffer)) },
      { type: 'u32', values: schedule, readOnly: true },
      { type: 'f32', length: RAY_COUNT * 3, read: true },
      { type: 'f32', length: TEXELS * scheduled * 3, read: true },
      {
        kind: 'uniform',
        type: 'u32',
        values: Array.from(new Uint32Array(productionVolume.buffer)),
      },
      { kind: 'texture2dArray', size: EDGE, layers: grid.layers, levels: [level0, level1] },
      { kind: 'sampler' },
      { type: 'f32', values: whiteAlbedo, readOnly: true },
    ],
  });
  const productionRays = productionRun[5];

  /* The same chain, with the volume as its probe level and as what a field hit is worth. */
  const volumeBlend = createProbeBlend();
  const volumeOut = new Float32Array(3);
  const production = {
    eye: [0, 0, 0],
    project: () => false,
    sceneDistance: () => Infinity,
    screenRadiance: (_u, _v, out) => out.fill(0),
    field,
    fieldRadiance: (x, y, z, out) => {
      /*
       * White albedo and no sun, so the production shading collapses to the bounced term alone —
       * and that term is **not** divided by pi, because what a probe stores is already the
       * cosine-weighted mean radiance rather than the irradiance. Only the sun's own irradiance is
       * divided, and there is no sun here.
       */
      nearestProbes(grid, x, y, z, volumeBlend);
      sampleProbeVolume(volumeBlend, layerColour, 3, volumeOut);
      for (let c = 0; c < 3; c += 1) out[c] = volumeOut[c];
      return out;
    },
    grid,
    visibility: null,
    /*
     * **Zero, and the probe share is added below instead**, which is `indirect-parity.mjs`'s own
     * arrangement and for the same reason: the chain's level 2 answers at the ray's *origin*, and
     * the shader answers at the point the ray reached. Left as the real colours, the reference
     * would return one constant for every ray a probe casts — which is what the first run of this
     * check reported, and it was the reference that was wrong.
     */
    probeValues: new Float32Array(grid.layers * 3),
    probeChannels: 3,
  };

  for (let slot = 0; slot < scheduled; slot += 1) {
    grid.positionOf(schedule[slot], wantPosition);
    const point = [wantPosition[0], wantPosition[1], wantPosition[2]];
    for (let i = 0; i < PROBE_DIRECTIONS; i += 1) {
      const at = i * 3;
      const direction = [deviceDirections[at], deviceDirections[at + 1], deviceDirections[at + 2]];
      traceIndirect(
        { point, normal: direction, direction, coneAngle: FIELD_MARCH.coneAngle },
        production,
        result,
      );
      /* A ray that left the field finds the sky, which is a constant the reference can name. */
      const fieldShare = result.blend[1];
      const rayAt = (slot * PROBE_DIRECTIONS + i) * 3;
      for (let c = 0; c < 3; c += 1) {
        const want = result.radiance[c] + SKY[c] * (1 - fieldShare);
        check(
          `production probe ${schedule[slot]} ray ${i}`,
          `channel ${c}`,
          want,
          productionRays[rayAt + c],
          2e-3,
        );
      }
    }
  }

  /*
   * **The fade is `indirect-parity.mjs`'s to hold, not this one's.** That script builds a second
   * ring of geometry straddling the outermost cascade's face precisely to reach the band where the
   * field's confidence is between zero and one. A probe grid standing inside the field does not
   * reach it, and saying so is better than a corpus that silently never enters the branch.
   */
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  console.log(`${total} values compared, ${failures.length} disagreements`);
  console.log(`worst absolute difference ${worst.toExponential(2)} at ${worstAt}`);

  if (visited.fieldHits === 0) {
    console.error('no ray ever hit the field: the corpus checks the probe level and nothing else');
    process.exitCode = 1;
  }
  if (failures.length > 0) {
    for (const line of failures) console.error(line);
    process.exitCode = 1;
  } else {
    console.log('the references and the device agree');
  }
} finally {
  await gpu.close();
}

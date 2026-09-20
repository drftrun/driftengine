#!/usr/bin/env node
/**
 * A probe's own rays on a device, against the chain that defines them.
 *
 * **`gi-parity.mjs`'s arrangement, for the level of Wave 4A that lights a surface.** `gi/chain.ts`
 * is the three-level trace and `shaders/gi/probeTrace.wgsl.ts` is levels 1 and 2 of it for the
 * device — the screen level is entered with a projector that answers "off screen" for every point,
 * because a probe's rays mostly leave the frame and the few that do not would make a cached probe
 * depend on where the camera is. Two spellings of one decision drift, and the only thing that stops
 * them is running both over the same rays and comparing every number.
 *
 * **The radiance is a function of position on purpose.** A march that lands one voxel from where
 * the reference landed would return almost the right answer from a smooth field and exactly the
 * right one from a constant — so a constant radiance would check the level blend and nothing at all
 * about the march. A sine of the hit's position turns a wrong hit into a wrong colour.
 *
 * **What this does not check, and both were found by breaking the shader on purpose.**
 *
 * What a probe *volume* answers is an accessor here, supplied by the including module, so this is a
 * check of the march and the two-level blend alone; `gi/probeVolume.test.ts` and `gi/leak.test.ts`
 * are what hold the volume itself, including the control that the leak returns without the
 * visibility term.
 *
 * And **the guard that stops a march at the outermost cascade's face survives being deleted here.**
 * Outside that face the sampler clamps to the edge, so a march allowed to continue keeps reading
 * whatever the boundary holds — which only becomes a *hit* where the ray crosses the face within a
 * voxel of a surface standing on it, and a corpus of random rays reaches that almost never. Two
 * corpora were built trying: a ring of geometry at the face, and then one straddling it. The rule
 * is real and `gi/traceField.test.ts` is what holds it, on rays aimed at the boundary on purpose;
 * this says it cannot see it rather than counting it as covered.
 *
 * Run by hand, like `gpu-parity.mjs`, `gi-parity.mjs` and `recon-parity.mjs`, because it needs a
 * device and `npm run test:scripts` deliberately does not.
 *
 *     node scripts/indirect-parity.mjs
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
const { createProbeGrid } = await import(`${ROOT}packages/core/src/render/probeGrid.ts`).then(
  (module) => ({ createProbeGrid: module.ProbeGrid }),
);
const { PROBE_MARCH_FLOATS, PROBE_TRACE_WORKGROUP, probeTraceParityWgsl } = await import(
  `${ROOT}packages/core/src/render/shaders/gi/probeTrace.wgsl.ts`
);

const WGSL = probeTraceParityWgsl();

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
  return new Float32Array([
    c * scale,
    0,
    -s * scale,
    0,
    0,
    scale,
    0,
    0,
    s * scale,
    0,
    c * scale,
    0,
    x,
    y,
    z,
    1,
  ]);
}

/** The same expression the shader evaluates. See the header for why it is a sine of position. */
function radianceAt(x, y, z, out) {
  out[0] = 0.5 + 0.4 * Math.sin(x * 1.3);
  out[1] = 0.5 + 0.4 * Math.sin(y * 1.7 + 1);
  out[2] = 0.5 + 0.4 * Math.sin(z * 2.3 + 2);
  return out;
}

const failures = [];
let compared = 0;
let worst = 0;
let worstAt = '';
/* What the corpus reached, because a check that never entered a branch proved nothing about it. */
const visited = { fieldHits: 0, escaped: 0, faded: 0 };

function check(what, at, want, got, tolerance) {
  compared += 1;
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
  const random = lcg(0x51f3b2c7);

  /* A field with something in it at every cascade: a ring of spheres the rays can actually hit. */
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
  /*
   * **A second ring straddling the outermost cascade's face**, for two reasons the first corpus
   * reached neither of. Without geometry out there no ray ever finds a surface where the field's
   * confidence is less than one, and that fade is what stops a seam sweeping through the picture as
   * the camera turns. And without geometry *on* the face, the guard that stops a march at the
   * boundary cannot be seen to matter: outside it the sampler clamps to the edge, and it is only
   * where the edge holds a surface that a march allowed to continue converges on one made of
   * nothing.
   */
  const field = createGlobalField(RESOLUTION, CASCADES);
  composeGlobalField(instances, [0.21, -0.13, 0.37], RADIUS, field);
  const outerFace = field.cascades[CASCADES - 1].bounds[3];
  for (let i = 0; i < 12; i += 1) {
    const angle = (i / 12) * Math.PI * 2;
    instances.push({
      source,
      transform: placement(
        Math.cos(angle) * outerFace,
        (random() - 0.5) * 2,
        Math.sin(angle) * outerFace,
        random() * Math.PI * 2,
        1.4,
      ),
    });
  }
  composeGlobalField(instances, [0.21, -0.13, 0.37], RADIUS, field);

  /* The rays: points scattered through the field, each with a normal and a direction of its own. */
  const RAYS = 512;
  const outerFaceSpread = outerFace * 1.7;
  const rays = new Float32Array(RAYS * 9);
  for (let i = 0; i < RAYS; i += 1) {
    const at = i * 9;
    /* Half the rays near the middle and half out near the face, so both confidences are reached. */
    const spread = i % 2 === 0 ? 7 : outerFaceSpread;
    for (let axis = 0; axis < 3; axis += 1) rays[at + axis] = (random() - 0.5) * spread;
    const n = [random() - 0.5, random() - 0.5, random() - 0.5];
    const nl = Math.hypot(...n) || 1;
    for (let axis = 0; axis < 3; axis += 1) rays[at + 3 + axis] = n[axis] / nl;
    const d = [random() - 0.5, random() - 0.5, random() - 0.5];
    const dl = Math.hypot(...d) || 1;
    for (let axis = 0; axis < 3; axis += 1) rays[at + 6 + axis] = d[axis] / dl;
  }

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
  const params = new Float32Array(PROBE_MARCH_FLOATS);
  const ints = new Uint32Array(params.buffer);
  ints[0] = FIELD_MARCH.steps;
  ints[1] = CASCADES;
  ints[2] = RESOLUTION;
  ints[3] = RAYS;
  params[4] = FIELD_MARCH.reachM;
  params[5] = FIELD_MARCH.hitEpsilonM;
  params[6] = field.cascades[0].step;
  params[7] = FIELD_MARCH.coneAngle;
  params[8] = outer.bounds[0];
  params[9] = outer.bounds[1];
  params[10] = outer.bounds[2];
  params[12] = outer.bounds[3];
  params[13] = outer.bounds[4];
  params[14] = outer.bounds[5];

  const got = await gpu.run({
    wgsl: WGSL,
    entryPoint: 'traceMain',
    workgroups: [Math.ceil(RAYS / PROBE_TRACE_WORKGROUP)],
    buffers: [
      { type: 'f32', values: cascades, readOnly: true },
      { type: 'f32', values: fields, readOnly: true },
      { kind: 'uniform', type: 'u32', values: Array.from(new Uint32Array(params.buffer)) },
      { type: 'f32', values: rays, readOnly: true },
      { type: 'f32', length: RAYS * 3, read: true },
    ],
  });
  const device = got[4];

  /*
   * The reference, entered with a projector that answers "off screen" everywhere — which is what
   * makes this levels 1 and 2 of the same function rather than a second function.
   */
  const scratch = new Float32Array(3);
  const result = newIndirectResult();
  const grid = new createProbeGrid({ origin: [0, 0, 0], spacing: [1, 1, 1], counts: [1, 1, 1] });
  const resources = {
    eye: [0, 0, 0],
    project: () => false,
    sceneDistance: () => Infinity,
    screenRadiance: (_u, _v, out) => out.fill(0),
    field,
    fieldRadiance: (x, y, z, out) => radianceAt(x, y, z, out),
    grid,
    visibility: null,
    probeValues: new Float32Array(3),
    probeChannels: 3,
  };

  for (let i = 0; i < RAYS; i += 1) {
    const at = i * 9;
    const point = [rays[at], rays[at + 1], rays[at + 2]];
    const normal = [rays[at + 3], rays[at + 4], rays[at + 5]];
    const direction = [rays[at + 6], rays[at + 7], rays[at + 8]];
    /*
     * The probe level, as the shader takes it: the volume's answer along the ray, read at the
     * reach. With one probe carrying nothing the reference's own level 2 is zero, so the probe
     * share is added here in the same place the shader adds it.
     */
    traceIndirect(
      { point, normal, direction, coneAngle: FIELD_MARCH.coneAngle },
      resources,
      result,
    );
    const fieldShare = result.blend[1];
    if (fieldShare > 0) visited.fieldHits += 1;
    if (fieldShare > 0 && fieldShare < 1) visited.faded += 1;
    if (fieldShare === 0) visited.escaped += 1;

    const want = new Float32Array(3);
    for (let c = 0; c < 3; c += 1) want[c] = result.radiance[c];
    radianceAt(
      point[0] + direction[0] * FIELD_MARCH.reachM,
      point[1] + direction[1] * FIELD_MARCH.reachM,
      point[2] + direction[2] * FIELD_MARCH.reachM,
      scratch,
    );
    for (let c = 0; c < 3; c += 1) want[c] += scratch[c] * (1 - fieldShare);

    for (let c = 0; c < 3; c += 1) {
      check(`ray ${i}`, `channel ${c}`, want[c], device[i * 3 + c], 2e-3);
    }
  }
} finally {
  await gpu.close();
}

console.log(`compared ${compared} values over ${compared / 3} rays`);
console.log(
  `visited: ${visited.fieldHits} rays that found a surface, ${visited.faded} of them faded at the ` +
    `outermost cascade's face, ${visited.escaped} that fell to the probes entirely`,
);
console.log(`worst disagreement ${worst.toExponential(2)} at ${worstAt}`);
if (failures.length > 0) {
  console.error(`\n${failures.length} disagreements, the first few:`);
  for (const line of failures) console.error(`  ${line}`);
  process.exitCode = 1;
} else {
  console.log('the device and the reference agree on every value');
}

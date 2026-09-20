#!/usr/bin/env node
/**
 * The composed distance field, on a device, against the TypeScript that defines it.
 *
 * **`gpu-parity.mjs`'s arrangement, for the one shader Wave 4A's plan never scheduled.** A shader
 * and a TypeScript function cannot share a struct, so `composeField.wgsl.ts` and
 * `gi/globalField.ts` are two spellings of one decision — the eight-corner blend, the box bound
 * outside a source, the minimum that makes a union. Two spellings of one decision drift, and the
 * only thing that stops them is running both over the same input and comparing every number.
 *
 * **Run by hand, like `gpu-parity.mjs` and `ibl-check.mjs`**, because it needs a device and
 * `npm run test:scripts` deliberately does not. It serves its own loopback page through
 * `gpuCompute.mjs`, so there is no dev server to start and nothing to build.
 *
 *     node scripts/gi-parity.mjs
 */

import { openGpuCompute } from '../packages/core/scripts/gpuCompute.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const { composeGlobalField, createGlobalField, sampleGlobalField } = await import(
  `${ROOT}packages/core/src/render/gi/globalField.ts`
);
const { CASCADE_FLOATS, SAMPLE_FIELD_PARITY_WGSL, SAMPLE_PARAM_FLOATS } = await import(
  `${ROOT}packages/core/src/render/shaders/gi/sampleField.wgsl.ts`
);
const {
  COMPOSE_FIELD_WGSL,
  COMPOSE_INSTANCE_FLOATS,
  INSTANCE_ALBEDO,
  COMPOSE_PARAM_FLOATS,
  COMPOSE_WORKGROUP,
  INSTANCE_BOUNDS,
  INSTANCE_DIMS,
  INSTANCE_OFFSET,
  INSTANCE_SCALE,
} = await import(`${ROOT}packages/core/src/render/shaders/gi/composeField.wgsl.ts`);

/** A reproducible stream, so a failure is a failure rather than a seed. */
function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** A sphere's exact field on a grid, which is what `bakeObjectSdf` approximates. */
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

/** A box's exact field, so the corpus is not one shape with its symmetry hiding a transform. */
function boxField(hx, hy, hz, half, resolution) {
  const field = new Float32Array(resolution ** 3);
  const step = (2 * half) / (resolution - 1);
  for (let iz = 0; iz < resolution; iz += 1) {
    for (let iy = 0; iy < resolution; iy += 1) {
      for (let ix = 0; ix < resolution; ix += 1) {
        const p = [-half + ix * step, -half + iy * step, -half + iz * step];
        const gap = [Math.abs(p[0]) - hx, Math.abs(p[1]) - hy, Math.abs(p[2]) - hz];
        const outside = Math.hypot(Math.max(gap[0], 0), Math.max(gap[1], 0), Math.max(gap[2], 0));
        const inside = Math.min(Math.max(gap[0], gap[1], gap[2]), 0);
        field[ix + resolution * (iy + resolution * iz)] = outside + inside;
      }
    }
  }
  return {
    field,
    dims: [resolution, resolution, resolution],
    bounds: new Float32Array([-half, -half, -half, half, half, half]),
  };
}

/** A world-from-object matrix with a rotation and a uniform scale, column-major. */
function placement(x, y, z, yaw, pitch, scale) {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  /* Rotate about y then about x, then scale. Written out because a library here would be a third
     spelling of an arrangement the shader and the reference already spell twice. */
  const r = [cy, sp * sy, -cp * sy, 0, cp, sp, sy, -sp * cy, cp * cy];
  return new Float32Array([
    r[0] * scale,
    r[1] * scale,
    r[2] * scale,
    0,
    r[3] * scale,
    r[4] * scale,
    r[5] * scale,
    0,
    r[6] * scale,
    r[7] * scale,
    r[8] * scale,
    0,
    x,
    y,
    z,
    1,
  ]);
}

/** The inverse of such a matrix: transpose the rotation, divide by the scale squared, re-place. */
function inverseOf(m) {
  const scale = Math.hypot(m[0], m[1], m[2]);
  const inv = 1 / (scale * scale);
  const out = new Float32Array(16);
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) out[col * 4 + row] = m[row * 4 + col] * inv;
  }
  for (let row = 0; row < 3; row += 1) {
    out[12 + row] = -(out[row] * m[12] + out[4 + row] * m[13] + out[8 + row] * m[14]);
  }
  out[15] = 1;
  return out;
}

const failures = [];
let compared = 0;
/* How many cascades had a sample nothing was near, which exercises the fill rather than an instance. */
let reachedItsReach = 0;
function check(what, at, want, got, tolerance) {
  compared += 1;
  if (Math.abs(want - got) <= tolerance) return;
  if (failures.length < 12) {
    failures.push(`${what} sample ${at}: reference ${want.toFixed(6)}, device ${got.toFixed(6)}`);
  }
}

const gpu = await openGpuCompute();
try {
  const random = lcg(0x4a17c3d9);
  const sources = [sphereField(0.9, 2, 25), boxField(0.8, 0.4, 1.2, 2, 25)];

  const instances = [];
  for (let i = 0; i < 24; i += 1) {
    const angle = (i / 24) * Math.PI * 2;
    instances.push({
      source: sources[i % sources.length],
      /*
       * **A distinct colour an instance**, because the albedo the composer keeps is the *winning*
       * instance's and a corpus where every instance is the same colour cannot tell that from the
       * last one's. Values well apart so a wrong instance is a visibly wrong number.
       */
      albedo: [0.05 + (i % 7) * 0.13, 0.9 - (i % 5) * 0.17, 0.2 + (i % 3) * 0.29],
      transform: placement(
        Math.cos(angle) * 2.5,
        (random() - 0.5) * 3,
        Math.sin(angle) * 2.5,
        random() * Math.PI * 2,
        (random() - 0.5) * 1.2,
        0.6 + random() * 0.8,
      ),
    });
  }

  const RESOLUTION = 33;
  const CASCADES = 3;
  const RADIUS = 4;
  const reference = createGlobalField(RESOLUTION, CASCADES);
  composeGlobalField(instances, [0.37, -0.21, 0.58], RADIUS, reference);

  /* Every source's samples in one buffer, with each instance carrying where its own start. */
  const offsets = new Map();
  const packedSources = [];
  for (const source of sources) {
    offsets.set(source, packedSources.length);
    for (const value of source.field) packedSources.push(value);
  }
  const sourceBuffer = Float32Array.from(packedSources);

  const packedInstances = new Float32Array(instances.length * COMPOSE_INSTANCE_FLOATS);
  for (let i = 0; i < instances.length; i += 1) {
    const at = i * COMPOSE_INSTANCE_FLOATS;
    const instance = instances[i];
    packedInstances.set(inverseOf(instance.transform), at);
    packedInstances[at + INSTANCE_SCALE] = Math.hypot(
      instance.transform[0],
      instance.transform[1],
      instance.transform[2],
    );
    packedInstances.set(instance.source.bounds, at + INSTANCE_BOUNDS);
    packedInstances[at + INSTANCE_DIMS] = instance.source.dims[0];
    packedInstances[at + INSTANCE_DIMS + 1] = instance.source.dims[1];
    packedInstances[at + INSTANCE_DIMS + 2] = instance.source.dims[2];
    packedInstances[at + INSTANCE_OFFSET] = offsets.get(instance.source);
    /* The colour this placement paints, which the composer carries with the winning distance. */
    const albedo = instance.albedo ?? [1, 1, 1];
    packedInstances[at + INSTANCE_ALBEDO] = albedo[0];
    packedInstances[at + INSTANCE_ALBEDO + 1] = albedo[1];
    packedInstances[at + INSTANCE_ALBEDO + 2] = albedo[2];
  }

  for (let level = 0; level < CASCADES; level += 1) {
    const cascade = reference.cascades[level];
    const samples = RESOLUTION ** 3;
    const params = new Float32Array(COMPOSE_PARAM_FLOATS);
    params[0] = cascade.bounds[0];
    params[1] = cascade.bounds[1];
    params[2] = cascade.bounds[2];
    params[3] = cascade.step;
    params[4] = RESOLUTION;
    params[5] = RESOLUTION;
    params[6] = RESOLUTION;
    /* The reach is the cascade's half-extent, which is what the reference fills with. */
    params[7] = (cascade.bounds[3] - cascade.bounds[0]) / 2;
    params[8] = instances.length;

    const out = await gpu.run({
      wgsl: COMPOSE_FIELD_WGSL,
      workgroups: [Math.ceil(samples / COMPOSE_WORKGROUP)],
      buffers: [
        { type: 'f32', values: params, readOnly: true },
        { type: 'f32', values: packedInstances, readOnly: true },
        { type: 'f32', values: sourceBuffer, readOnly: true },
        { type: 'f32', length: samples, read: true },
        { type: 'f32', length: samples * 3, read: true },
      ],
    });

    /*
     * **A tenth of a millimetre, and the tolerance is float32 rather than slack.** Both sides do
     * the same arithmetic in the same order; what they do not share is how a compiler contracts a
     * multiply and an add, which moves the last bits of a trilinear blend of eight products.
     */
    let lowest = Infinity;
    let highest = -Infinity;
    for (let at = 0; at < samples; at += 1) {
      const want = cascade.field[at];
      lowest = Math.min(lowest, want);
      highest = Math.max(highest, want);
      check(`cascade ${level}`, at, want, out[3][at], 1e-4);
      /*
       * **And the colour that came with it.** The albedo is not interpolated or blended — it is
       * whichever instance won the minimum, carried across — so the two sides must agree exactly
       * rather than to a tolerance. A difference here is a different instance winning, which is a
       * field of the right shape in the wrong colours.
       */
      for (let c = 0; c < 3; c += 1) {
        check(
          `cascade ${level} albedo`,
          at * 3 + c,
          cascade.albedo[at * 3 + c],
          out[4][at * 3 + c],
          0,
        );
      }
    }

    /*
     * **A cascade that is all reach compares two constants**, so every one of them has to contain
     * geometry. The reach itself is checked once across the set rather than per cascade: the
     * innermost is small enough that the instances fill it, and 2.709 against a reach of 4 is the
     * scene being dense rather than the path being unexercised.
     */
    if (!(lowest < 0)) failures.push(`cascade ${level}: nothing is inside anything`);
    if (highest >= params[7] - 1e-6) reachedItsReach += 1;
    console.log(
      `cascade ${level}  ${samples} samples, step ${cascade.step.toFixed(4)} m, ` +
        `range ${lowest.toFixed(3)} to ${highest.toFixed(3)}`,
    );
  }

  if (reachedItsReach === 0) {
    failures.push('no cascade had a sample at its own reach, so the fill path is unexercised');
  }

  /* And the whole point: the device's field marches the same way the reference's does. */
  const probe = sampleGlobalField(reference, 1.1, 0.2, -0.7);
  console.log(`sampleGlobalField at a point inside the innermost cascade: ${probe.toFixed(4)}`);

  /*
   * **What it is not: a frame time.** `gpuCompute.mjs` compiles the shader, creates every buffer
   * and maps the result back to the CPU on each call, and a frame does none of those — a pass
   * compiles once, keeps its buffers and leaves the field in memory the next stage samples. Timing
   * a whole call and comparing it with the reference would say the device is three times slower,
   * which is a statement about this harness.
   *
   * **So the dispatch is timed against itself.** Running it once and running it five times differ
   * by four dispatches; the slope is what a dispatch costs once everything fixed has been paid
   * for, and it is an upper bound on the compute rather than the compute. The real figure needs
   * the pass wired into the renderer with timestamp queries, which `GpuDrivenPass` is the pattern
   * for and which is the next piece of work.
   */
  const cascade = reference.cascades[0];
  const params = new Float32Array(COMPOSE_PARAM_FLOATS);
  params[0] = cascade.bounds[0];
  params[1] = cascade.bounds[1];
  params[2] = cascade.bounds[2];
  params[3] = cascade.step;
  params[4] = RESOLUTION;
  params[5] = RESOLUTION;
  params[6] = RESOLUTION;
  params[7] = (cascade.bounds[3] - cascade.bounds[0]) / 2;
  params[8] = instances.length;
  const dispatch = async (times) => {
    const started = performance.now();
    for (let at = 0; at < times; at += 1) {
      await gpu.run({
        wgsl: COMPOSE_FIELD_WGSL,
        workgroups: [Math.ceil(RESOLUTION ** 3 / COMPOSE_WORKGROUP)],
        buffers: [
          { type: 'f32', values: params, readOnly: true },
          { type: 'f32', values: packedInstances, readOnly: true },
          { type: 'f32', values: sourceBuffer, readOnly: true },
          { type: 'f32', length: RESOLUTION ** 3, read: true },
          { type: 'f32', length: RESOLUTION ** 3 * 3, read: true },
        ],
      });
    }
    return performance.now() - started;
  };
  const once = await dispatch(1);
  const fiveTimes = await dispatch(5);
  const marginal = (fiveTimes - once) / 4;

  const cpuStart = performance.now();
  composeGlobalField(instances, [0.37, -0.21, 0.58], RADIUS, reference);
  const cpuMs = performance.now() - cpuStart;

  /* ------------------------------------------------------- the sampler, on its own */
  {
    /*
     * **The sampler is checked apart from anything using it**, because a march that agrees could
     * be two wrong readings cancelling. `sampleGlobalField` picks the finest cascade holding a
     * point, fades into the one outside across the outer tenth, and clamps past the last — three
     * decisions a second implementation gets subtly differently, and the fade is the one that
     * shows, as a seam that moves with the camera.
     */
    const levels = reference.cascades.length;
    const cascadeBuffer = new Float32Array(levels * CASCADE_FLOATS);
    let fieldFloats = 0;
    for (const cascade of reference.cascades) fieldFloats += cascade.field.length;
    const fieldBuffer = new Float32Array(fieldFloats);
    let at = 0;
    for (let level = 0; level < levels; level += 1) {
      const cascade = reference.cascades[level];
      cascadeBuffer.set(cascade.bounds, level * CASCADE_FLOATS);
      cascadeBuffer[level * CASCADE_FLOATS + 6] = cascade.step;
      fieldBuffer.set(cascade.field, at);
      at += cascade.field.length;
    }

    /*
     * Points spread well past the outermost cascade as well as inside the innermost, so the fade,
     * the clamp and the plain read are all exercised. A corpus that stayed in the middle would
     * compare one branch.
     */
    const COUNT = 4096;
    const pick = lcg(0x7d31a05f);
    const points = new Float32Array(COUNT * 3);
    const outer = reference.cascades[levels - 1];
    const inner = reference.cascades[0];
    const span = (outer.bounds[3] - outer.bounds[0]) * 0.75;
    const band = 0.1 * (inner.bounds[3] - inner.bounds[0]);
    for (let i = 0; i < COUNT; i += 1) {
      if (i % 2 === 0) {
        /* Spread, which lands mostly past the outermost cascade and sometimes deep inside. */
        for (let axis = 0; axis < 3; axis += 1) points[i * 3 + axis] = (pick() - 0.5) * 2 * span;
        continue;
      }
      /*
       * **Aimed at the fade**, because a uniform spread barely touches it: the band is a tenth of
       * one cascade's extent and a shell that thin is a few points in four thousand. Seven of them
       * would catch a wrong fade, and a branch checked by seven samples is one nobody should trust
       * a refactor to.
       */
      const face = Math.floor(pick() * 6);
      const axis = face % 3;
      for (let other = 0; other < 3; other += 1) {
        const low = inner.bounds[other];
        const high = inner.bounds[other + 3];
        points[i * 3 + other] = low + pick() * (high - low);
      }
      const depth = pick() * band;
      points[i * 3 + axis] = face < 3 ? inner.bounds[axis] + depth : inner.bounds[axis + 3] - depth;
    }

    const params = new Float32Array(SAMPLE_PARAM_FLOATS);
    params[0] = levels;
    params[1] = RESOLUTION;
    params[2] = COUNT;

    const sampled = await gpu.run({
      wgsl: SAMPLE_FIELD_PARITY_WGSL,
      workgroups: [Math.ceil(COUNT / 64)],
      buffers: [
        { type: 'f32', values: params, readOnly: true },
        { type: 'f32', values: cascadeBuffer, readOnly: true },
        { type: 'f32', values: fieldBuffer, readOnly: true },
        { type: 'f32', values: points, readOnly: true },
        { type: 'f32', length: COUNT, read: true },
      ],
    });

    let faded = 0;
    let clamped = 0;
    for (let i = 0; i < COUNT; i += 1) {
      const p = [points[i * 3], points[i * 3 + 1], points[i * 3 + 2]];
      const want = sampleGlobalField(reference, p[0], p[1], p[2]);
      check('sampleField', i, want, sampled[4][i], 1e-4);
      /* Which branch each point took, so the corpus can be shown to cover all three. */
      const innerBand = 0.1 * (reference.cascades[0].bounds[3] - reference.cascades[0].bounds[0]);
      let inside = Infinity;
      for (let axis = 0; axis < 3; axis += 1) {
        inside = Math.min(
          inside,
          p[axis] - reference.cascades[0].bounds[axis],
          reference.cascades[0].bounds[axis + 3] - p[axis],
        );
      }
      if (inside > 0 && inside < innerBand) faded += 1;
      let outside = false;
      for (let axis = 0; axis < 3; axis += 1) {
        if (p[axis] < outer.bounds[axis] || p[axis] > outer.bounds[axis + 3]) outside = true;
      }
      if (outside) clamped += 1;
    }
    if (faded === 0) failures.push('sampleField: no point landed in the fade between cascades');
    if (clamped === 0) failures.push('sampleField: no point landed past the outermost cascade');
    console.log(
      `sampleField   ${COUNT} points, ${faded} in a cascade fade, ${clamped} past the outermost`,
    );
  }

  /*
   * **Measured, and the answer is that this harness cannot time this shader.** The marginal cost
   * of a dispatch came out at about what the whole reference costs, and it is not compute: every
   * call recompiles the shader and re-uploads the source fields, which are 125 KB here and would be
   * megabytes in a scene. A frame uploads them once when an instance streams in.
   *
   * That is worth printing rather than hiding, because the next person to want a number will reach
   * for this script first.
   */
  console.log(
    `\n${instances.length} instances, ${RESOLUTION} cubed: the reference composes all ` +
      `${CASCADES} cascades in ${cpuMs.toFixed(0)} ms. One dispatch costs ` +
      `${marginal.toFixed(1)} ms marginal **in this harness**, which recompiles and re-uploads ` +
      'every call — so it times the harness, not the shader. A frame time needs the pass wired ' +
      'into the renderer with timestamp queries.',
  );
} finally {
  await gpu.close();
}

console.log(`\n${compared} samples compared, ${failures.length} disagreements`);
for (const failure of failures) console.log(`  ${failure}`);
if (failures.length > 0) {
  console.log('\nthe reference and the device disagree');
  process.exitCode = 1;
} else {
  console.log('\nthe reference and the device agree');
}

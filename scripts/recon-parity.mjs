#!/usr/bin/env node
/**
 * DriftTR's resolve on a device, against the TypeScript that defines it.
 *
 * **`gi-parity.mjs`'s arrangement, for reconstruction.** `recon/resolve.ts` is the whole
 * per-output-pixel resolve and `shaders/recon/resolve.wgsl.ts` is the same arithmetic for the
 * device. Two spellings of one decision drift, and the only thing that stops them is running both
 * over the same frames and comparing every number.
 *
 * **The corpus is a rendered scene, not a random buffer.** A plane and a sphere are ray-cast
 * through the very uv each render texel is observed at, so the depths invert back to the points
 * they came from, the normals differenced from them are a real surface's, and the sphere's
 * silhouette is a real disocclusion when the camera moves. A random depth buffer would exercise the
 * arithmetic and prove nothing about it: every neighbour would disagree, so every history would be
 * refused and the disocclusion's whole band would go unvisited.
 *
 * **Five frames, and each is chosen for something.** The first has no history at all; the second
 * has one and a camera that turns, rises and closes in, because a camera stepping sideways leaves
 * the reprojected w at exactly one and hides a row of the matrix; the third doubles the ratio; the
 * fourth holds the camera still, where the motion is zero; the fifth takes the jitter away as well.
 *
 * **A rounding tie is not comparable and the corpus keeps away from one.** The resolve rounds four
 * quantities, and where one of them is exactly a half in exact arithmetic the reference in double
 * precision and the shader in single land on *opposite sides of it* — not because their tie-breaks
 * differ but because the value itself does, by a part in ten million. The first corpus written here
 * put the camera exactly at rest with no jitter at three output pixels to two render texels, which
 * puts the reprojected row on an exact half for one output row in three: the two implementations
 * then read the previous depth a whole texel apart, one trusting the history completely and the
 * other refusing it, and the pixel disagrees by everything. **So the unjittered case runs at two
 * output pixels to one**, where every rounding sits on a quarter, and the rounding *rule* —
 * `floor(x + 0.5)` against WGSL's round-half-to-even — is checked directly by `roundMain` over a
 * sweep of exact halves, where the two precisions agree about the input and can only differ about
 * the answer. A renderer is safe from the tie for a different reason: the jitter is never zero.
 *
 * **What this does not check, and both were found by breaking the shader on purpose.**
 *
 * The production module reads its bilinear taps through a filtering sampler and this check does them
 * itself, because no 32-bit float format is filterable and a comparison against a device's sampler
 * is a tolerance rather than an equality. The five-tap Catmull-Rom is only cheaper than the
 * sixteen-tap while that bilinear is the sampler's, so the renderer integration is what has to
 * measure the sampler's agreement with `sampleBilinear` — and until it does, the production module's
 * two bilinear accessors are the one part of this shader with a reference and no measurement.
 *
 * And **the variance box's flat-channel shortcut is below what any parity check can resolve.**
 * Taking it out — so nine identical samples give a mean that is not quite one of them — moves a
 * pixel by about a part in ten million, and the disagreement between a double-precision reference
 * and a single-precision shader is already seven parts in a hundred thousand. `clamp.test.ts` is
 * what holds that rule, exactly, over numbers chosen for it; this cannot and does not.
 *
 * **Run by hand, like `gpu-parity.mjs` and `gi-parity.mjs`**, because it needs a device and
 * `npm run test:scripts` deliberately does not. It serves its own loopback page through
 * `gpuCompute.mjs`, so there is no dev server to start and nothing to build.
 *
 *     node scripts/recon-parity.mjs
 */

import { mat4, vec3 } from 'gl-matrix';

import { openGpuCompute } from '../packages/core/scripts/gpuCompute.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const { DEFAULT_RECON_QUALITY, resolvePixel, resolveFrame } = await import(
  `${ROOT}packages/core/src/render/recon/resolve.ts`
);
const { DEFAULT_DISOCCLUSION } = await import(
  `${ROOT}packages/core/src/render/recon/disocclusion.ts`
);
const { jitterOffset } = await import(`${ROOT}packages/core/src/render/recon/jitter.ts`);
const { RECON_PARAM_FLOATS, RECON_WORKGROUP, reconResolveParityWgsl } = await import(
  `${ROOT}packages/core/src/render/shaders/recon/resolve.wgsl.ts`
);

const WGSL = reconResolveParityWgsl();

/* ------------------------------------------------------------------ the scene, cast through the uv */

/**
 * Where a ray through `(u, v)` first meets the world: a ground plane at `y = 0` and a sphere.
 *
 * The sphere is the object with its own motion — a drawn thing the renderer would have written
 * motion for — and the plane is the surface whose motion the resolve has to derive from the camera.
 */
function castScene(inverse, u, v, sphereCentre, sphereRadius) {
  const near = unproject(inverse, u, v, -1);
  const far = unproject(inverse, u, v, 1);
  if (near === null || far === null) return null;
  const direction = vec3.subtract(vec3.create(), far, near);
  vec3.normalize(direction, direction);

  let distance = Infinity;
  let onSphere = false;
  if (Math.abs(direction[1]) > 1e-9) {
    const t = -near[1] / direction[1];
    if (t > 1e-4) distance = t;
  }
  const toCentre = vec3.subtract(vec3.create(), near, sphereCentre);
  const b = vec3.dot(toCentre, direction);
  const c = vec3.dot(toCentre, toCentre) - sphereRadius * sphereRadius;
  const discriminant = b * b - c;
  if (discriminant > 0) {
    const t = -b - Math.sqrt(discriminant);
    if (t > 1e-4 && t < distance) {
      distance = t;
      onSphere = true;
    }
  }
  if (!Number.isFinite(distance)) return null;
  return {
    point: vec3.scaleAndAdd(vec3.create(), near, direction, distance),
    onSphere,
  };
}

/** A clip position back to the world, or null where the matrix has no answer there. */
function unproject(inverse, u, v, z) {
  const clip = [u * 2 - 1, v * 2 - 1, z, 1];
  const out = new Float64Array(4);
  for (let r = 0; r < 4; r += 1) {
    out[r] =
      inverse[r] * clip[0] +
      inverse[4 + r] * clip[1] +
      inverse[8 + r] * clip[2] +
      inverse[12 + r] * clip[3];
  }
  if (!(Math.abs(out[3]) > 1e-12)) return null;
  return vec3.fromValues(out[0] / out[3], out[1] / out[3], out[2] / out[3]);
}

/** A world point through a view-projection: its normalised device coordinates and its view depth. */
function project(m, p) {
  const out = new Float64Array(4);
  for (let r = 0; r < 4; r += 1) {
    out[r] = m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r];
  }
  return {
    u: (out[0] / out[3]) * 0.5 + 0.5,
    v: (out[1] / out[3]) * 0.5 + 0.5,
    z: out[2] / out[3],
    w: out[3],
  };
}

/** The colour a surface shows: a checker on the plane, a lit gradient with a highlight on the sphere. */
function shade(hit, sphereCentre) {
  if (!hit) return [0.02, 0.03, 0.05];
  const p = hit.point;
  if (!hit.onSphere) {
    const checker = (Math.floor(p[0]) + Math.floor(p[2])) % 2 === 0 ? 0.65 : 0.12;
    return [checker, checker * 0.85, checker * 0.6];
  }
  const n = vec3.normalize(vec3.create(), vec3.subtract(vec3.create(), p, sphereCentre));
  const light = vec3.normalize(vec3.create(), vec3.fromValues(0.4, 0.8, 0.3));
  const lambert = Math.max(0, vec3.dot(n, light));
  /* A small very bright lobe, which is what the neighbourhood box and the negative lobes are for. */
  const specular = Math.pow(lambert, 48) * 7;
  return [
    0.2 + lambert * 0.7 + specular,
    0.25 + lambert * 0.4 + specular,
    0.9 * lambert + specular,
  ];
}

/* --------------------------------------------------------------------------- one frame's buffers */

/**
 * The images a resolve reads, rendered at `width` by `height` for one camera and one sphere place.
 *
 * `motion` carries the sphere's own motion where a texel is on it, as a renderer's motion target
 * would, and nothing at all elsewhere — so the plane exercises the camera path and the sphere
 * exercises the drawn-object path in one frame.
 */
function renderFrame(camera, previous, sphere, previousSphere, width, height, jitter) {
  const scene = new Float32Array(width * height * 3);
  const depth = new Float32Array(width * height);
  const motion = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const u = (x + 0.5 - jitter[0]) / width;
      const v = (y + 0.5 - jitter[1]) / height;
      const hit = castScene(camera.inverseViewProj, u, v, sphere.centre, sphere.radius);
      const colour = shade(hit, sphere.centre);
      const at = y * width + x;
      scene[at * 3] = colour[0];
      scene[at * 3 + 1] = colour[1];
      scene[at * 3 + 2] = colour[2];
      /* Nothing hit is the far plane, which under this convention is +1. */
      depth[at] = hit === null ? 1 : project(camera.viewProj, hit.point).z;
      if (hit !== null && hit.onSphere && previous !== null) {
        const delta = vec3.subtract(vec3.create(), previousSphere.centre, sphere.centre);
        const was = vec3.add(vec3.create(), hit.point, delta);
        const there = project(previous.viewProj, was);
        motion[at * 4] = there.u - u;
        motion[at * 4 + 1] = there.v - v;
        motion[at * 4 + 2] = there.w;
        motion[at * 4 + 3] = 1;
      }
    }
  }
  return { scene, depth, motion };
}

/** A camera as the three matrices and the eye a resolve is handed. */
function cameraAt(eye, centre, aspect) {
  const view = mat4.lookAt(new Float64Array(16), eye, centre, [0, 1, 0]);
  const lens = mat4.perspective(new Float64Array(16), Math.PI / 3, aspect, 0.1, 60);
  const viewProj = mat4.multiply(new Float64Array(16), lens, view);
  return {
    eye: Float64Array.from(eye),
    viewProj,
    inverseViewProj: mat4.invert(new Float64Array(16), viewProj),
  };
}

/* ------------------------------------------------------------------------------- the comparison */

/**
 * What a double-precision reference and a single-precision shader may differ by.
 *
 * **The colours' bound is measured**: 5.9e-5 on 2026-09-17, held at 2e-4. **The gathered weight's is derived from it**, because that
 * channel is `kept + gathered` and `kept` is a stored history weight multiplying a smoothstep of
 * two single-precision depths: the stored weight is capped at `(1 - alpha) / alpha`, nine at the
 * default, so the weight channel carries up to ten times the colour's error and is held at ten
 * times its bound.
 */
const COLOUR_TOLERANCE = 2e-4;
const WEIGHT_TOLERANCE = 2e-3;

const failures = [];
let compared = 0;
let frames = 0;
const worst = new Map([
  ['colour', { off: 0, at: '' }],
  ['weight', { off: 0, at: '' }],
]);
/* What the corpus actually visited, because a check that never reached a branch proved nothing. */
const visited = { objectMotion: 0, cameraMotion: 0, refusedHistory: 0, clipped: 0, bicubicFill: 0 };

function check(what, at, want, got, tolerance) {
  compared += 1;
  const off = Math.abs(want - got);
  const scale = Math.max(1, Math.abs(want));
  const kind = tolerance === WEIGHT_TOLERANCE ? 'weight' : 'colour';
  const worstOfKind = worst.get(kind);
  if (off / scale > worstOfKind.off) {
    worstOfKind.off = off / scale;
    worstOfKind.at = `${what} ${at}`;
  }
  if (off <= tolerance * scale) return;
  if (failures.length < 12) {
    failures.push(`${what} ${at}: reference ${want.toFixed(6)}, device ${got.toFixed(6)}`);
  }
}

/** The uniform block, laid out as `ReconParams` is: floats, with `hasHistory` written as bits. */
function packParams(frame) {
  const bytes = new ArrayBuffer(RECON_PARAM_FLOATS * 4);
  const f = new Float32Array(bytes);
  const u = new Uint32Array(bytes);
  u[0] = frame.renderWidth;
  u[1] = frame.renderHeight;
  u[2] = frame.outputWidth;
  u[3] = frame.outputHeight;
  f[4] = frame.jitter[0];
  f[5] = frame.jitter[1];
  f[6] = frame.previousJitter[0];
  f[7] = frame.previousJitter[1];
  f.set(frame.inverseViewProj, 8);
  f.set(frame.previousViewProj, 24);
  f.set(frame.previousInverseViewProj, 40);
  f.set(frame.eye, 56);
  f.set(frame.previousEye, 60);
  f[64] = frame.quality.alpha;
  f[65] = frame.quality.sharpen;
  f[66] = frame.quality.clampGamma;
  u[67] = frame.hasHistory ? 1 : 0;
  f[68] = frame.disocclusion.depthTolerance;
  f[69] = frame.disocclusion.motionScale;
  f[70] = frame.disocclusion.normalFloor;
  f[71] = frame.disocclusion.normalCeiling;
  return Array.from(u);
}

/** A three-channel image widened to four, which is what an `rgba32float` texture takes. */
function widen(image, channels, count) {
  const out = new Float32Array(count * 4);
  for (let i = 0; i < count; i += 1) {
    for (let c = 0; c < channels; c += 1) out[i * 4 + c] = image[i * channels + c];
  }
  return out;
}

function textures(frame) {
  const renderTexels = frame.renderWidth * frame.renderHeight;
  const outputTexels = frame.outputWidth * frame.outputHeight;
  return [
    {
      kind: 'texture2d',
      width: frame.renderWidth,
      height: frame.renderHeight,
      format: 'rgba32float',
      values: Array.from(widen(frame.scene, 3, renderTexels)),
    },
    {
      kind: 'texture2d',
      width: frame.renderWidth,
      height: frame.renderHeight,
      format: 'r32float',
      values: Array.from(frame.depth),
    },
    {
      kind: 'texture2d',
      width: frame.renderWidth,
      height: frame.renderHeight,
      format: 'rgba32float',
      values: Array.from(frame.motion),
    },
    {
      kind: 'texture2d',
      width: frame.renderWidth,
      height: frame.renderHeight,
      format: 'r32float',
      values: Array.from(frame.previousDepth),
    },
    {
      kind: 'texture2d',
      width: frame.outputWidth,
      height: frame.outputHeight,
      format: 'rgba32float',
      values: Array.from(frame.history),
    },
    { kind: 'uniform', type: 'u32', values: packParams(frame) },
    { length: outputTexels * 4, read: true },
  ];
}

/** What the corpus reached, counted from the reference so the shader cannot flatter itself. */
function countVisits(frame) {
  const out = new Float32Array(4);
  for (let y = 0; y < frame.outputHeight; y += 1) {
    for (let x = 0; x < frame.outputWidth; x += 1) {
      resolvePixel(frame, x, y, out);
      if (out[3] < 1) visited.bicubicFill += 1;
    }
  }
  for (let i = 3; i < frame.motion.length; i += 4) {
    if (frame.motion[i] > 0.5) visited.objectMotion += 1;
    else visited.cameraMotion += 1;
  }
}

const gpu = await openGpuCompute();
try {
  /*
   * The rounding rule first, because no corpus reaches it: a sweep of exact halves and integers
   * from -8 to 8, where JavaScript rounds a half away from zero and WGSL's own `round` would send
   * -2.5 to -2 and 2.5 to 2.
   */
  {
    const count = 33;
    const rounded = await gpu.run({
      wgsl: WGSL,
      entryPoint: 'roundMain',
      workgroups: [Math.ceil(count / RECON_WORKGROUP), 1, 1],
      buffers: [
        { kind: 'texture2d', width: 1, height: 1, format: 'rgba32float', values: [0, 0, 0, 0] },
        { kind: 'texture2d', width: 1, height: 1, format: 'r32float', values: [0] },
        { kind: 'texture2d', width: 1, height: 1, format: 'rgba32float', values: [0, 0, 0, 0] },
        { kind: 'texture2d', width: 1, height: 1, format: 'r32float', values: [0] },
        { kind: 'texture2d', width: 1, height: 1, format: 'rgba32float', values: [0, 0, 0, 0] },
        { kind: 'uniform', type: 'u32', values: new Array(RECON_PARAM_FLOATS).fill(0) },
        { length: Math.ceil(count / RECON_WORKGROUP) * RECON_WORKGROUP, read: true },
      ],
    });
    for (let i = 0; i < count; i += 1) {
      const value = i * 0.5 - 8;
      /* `+ 0` because Math.round(-0.5) is minus zero, and minus zero is zero. */
      check('rounding', `${value}`, Math.round(value) + 0, rounded[6][i], 0);
    }
  }

  const sphere = { centre: vec3.fromValues(0, 1.2, 0), radius: 1.2 };
  const wasSphere = { centre: vec3.fromValues(-0.35, 1.05, 0.2), radius: 1.2 };

  const cases = [
    {
      name: 'first frame, no history',
      render: [24, 18],
      output: [36, 27],
      hasHistory: false,
      /* One camera, so the second frame below has somewhere to have come from. */
      previousEye: [3.4, 2.6, 4.2],
      eye: [3.4, 2.6, 4.2],
      centre: [0, 1, 0],
      previousCentre: [0, 1, 0],
      frameIndex: 0,
    },
    {
      name: 'a camera that turns, rises and closes in',
      render: [24, 18],
      output: [36, 27],
      hasHistory: true,
      previousEye: [3.4, 2.6, 4.2],
      eye: [2.7, 3.1, 3.3],
      centre: [0.35, 1.1, -0.2],
      previousCentre: [0, 1, 0],
      frameIndex: 1,
    },
    {
      name: 'twice the output a side, where every sample lands on a half',
      render: [20, 15],
      output: [40, 30],
      hasHistory: true,
      previousEye: [3.4, 2.6, 4.2],
      eye: [2.7, 3.1, 3.3],
      centre: [0.35, 1.1, -0.2],
      previousCentre: [0, 1, 0],
      frameIndex: 1,
    },
    {
      name: 'a camera at rest, where the only motion is the sphere’s',
      render: [24, 18],
      output: [36, 27],
      hasHistory: true,
      previousEye: [3.4, 2.6, 4.2],
      eye: [3.4, 2.6, 4.2],
      centre: [0, 1, 0],
      previousCentre: [0, 1, 0],
      frameIndex: 2,
    },
    {
      /*
       * **The cap on what a history may be worth**, which two frames of accumulation cannot reach:
       * the weight is what a long-converged picture holds, so `min((1 - alpha) / alpha, …)` is the
       * only thing between the history and a frame that never changes again.
       *
       * Twelve, not fifty: a stored weight is last frame's `kept + gathered`, so it can never
       * exceed the cap of nine plus one frame's gathering, and an unphysical weight only inflates
       * the single-precision error it multiplies.
       */
      name: 'a history that has converged for two hundred frames',
      render: [24, 18],
      output: [36, 27],
      hasHistory: true,
      historyWeight: 12,
      previousEye: [3.4, 2.6, 4.2],
      eye: [2.7, 3.1, 3.3],
      centre: [0.35, 1.1, -0.2],
      previousCentre: [0, 1, 0],
      frameIndex: 1,
    },
    {
      /*
       * **A swing large enough that the edges have no history at all.** Every other camera here
       * moves gently, and with a gentle camera no pixel reprojects off last frame's picture — so
       * the rule that refuses a history outside `0..1` went unvisited, and taking it out entirely
       * changed nothing that this check could see.
       */
      name: 'a camera swung far enough to throw the edges off last frame\u2019s picture',
      render: [24, 18],
      output: [36, 27],
      hasHistory: true,
      previousEye: [3.4, 2.6, 4.2],
      eye: [3.4, 2.6, 4.2],
      centre: [2.6, 1.0, -1.4],
      previousCentre: [0, 1, 0],
      frameIndex: 1,
    },
    {
      /*
       * **A resolve with no jitter is a real configuration and the one that has no ties.** At two
       * output pixels to one every rounding sits on a quarter, so the reference and the shader round
       * the same way however they differ in the last bits. At three to two, one output row in three
       * lands on an exact half and they do not — the header says what that cost to find.
       */
      name: 'no jitter at all, at two output pixels to one',
      render: [18, 14],
      output: [36, 28],
      hasHistory: true,
      unjittered: true,
      previousEye: [3.4, 2.6, 4.2],
      eye: [3.4, 2.6, 4.2],
      centre: [0, 1, 0],
      previousCentre: [0, 1, 0],
      frameIndex: 2,
    },
  ];

  for (const one of cases) {
    frames += 1;
    const [renderWidth, renderHeight] = one.render;
    const [outputWidth, outputHeight] = one.output;
    const aspect = outputWidth / outputHeight;
    const camera = cameraAt(one.eye, one.centre, aspect);
    const previousCamera = cameraAt(one.previousEye, one.previousCentre, aspect);

    const phases = 8;
    const jitter = new Float32Array(2);
    const previousJitter = new Float32Array(2);
    if (one.unjittered !== true) {
      jitterOffset(one.frameIndex, phases, jitter);
      jitterOffset(one.frameIndex - 1, phases, previousJitter);
    }

    const current = renderFrame(
      camera,
      previousCamera,
      sphere,
      wasSphere,
      renderWidth,
      renderHeight,
      jitter,
    );
    const before = renderFrame(
      previousCamera,
      null,
      wasSphere,
      wasSphere,
      renderWidth,
      renderHeight,
      previousJitter,
    );

    /* The history is a real accumulation: the reference's own first frame at this size. */
    const history = new Float32Array(outputWidth * outputHeight * 4);
    if (one.hasHistory) {
      const shown = new Float32Array(outputWidth * outputHeight * 3);
      resolveFrame(
        {
          renderWidth,
          renderHeight,
          outputWidth,
          outputHeight,
          scene: before.scene,
          depth: before.depth,
          motion: before.motion,
          previousDepth: before.depth,
          history: new Float32Array(outputWidth * outputHeight * 4),
          hasHistory: false,
          inverseViewProj: previousCamera.inverseViewProj,
          previousViewProj: previousCamera.viewProj,
          previousInverseViewProj: previousCamera.inverseViewProj,
          eye: previousCamera.eye,
          previousEye: previousCamera.eye,
          jitter: previousJitter,
          previousJitter,
          quality: DEFAULT_RECON_QUALITY,
          disocclusion: DEFAULT_DISOCCLUSION,
        },
        history,
        shown,
      );
    }

    if (one.historyWeight !== undefined) {
      for (let i = 3; i < history.length; i += 4) history[i] = one.historyWeight;
    }

    const frame = {
      renderWidth,
      renderHeight,
      outputWidth,
      outputHeight,
      scene: current.scene,
      depth: current.depth,
      motion: current.motion,
      previousDepth: before.depth,
      history,
      hasHistory: one.hasHistory,
      inverseViewProj: camera.inverseViewProj,
      previousViewProj: previousCamera.viewProj,
      previousInverseViewProj: previousCamera.inverseViewProj,
      eye: camera.eye,
      previousEye: previousCamera.eye,
      jitter,
      previousJitter,
      quality: DEFAULT_RECON_QUALITY,
      disocclusion: DEFAULT_DISOCCLUSION,
    };
    countVisits(frame);

    const groups = [
      Math.ceil(outputWidth / RECON_WORKGROUP),
      Math.ceil(outputHeight / RECON_WORKGROUP),
      1,
    ];
    const resolved = await gpu.run({
      wgsl: WGSL,
      entryPoint: 'resolveMain',
      workgroups: groups,
      buffers: textures(frame),
    });
    const device = resolved[6];

    const want = new Float32Array(4);
    const nextHistory = new Float32Array(outputWidth * outputHeight * 4);
    for (let y = 0; y < outputHeight; y += 1) {
      for (let x = 0; x < outputWidth; x += 1) {
        resolvePixel(frame, x, y, want);
        nextHistory.set(want, (y * outputWidth + x) * 4);
        for (let c = 0; c < 4; c += 1) {
          check(
            `${one.name} resolve`,
            `(${x}, ${y}) channel ${c}`,
            want[c],
            device[(y * outputWidth + x) * 4 + c],
            c === 3 ? WEIGHT_TOLERANCE : COLOUR_TOLERANCE,
          );
        }
      }
    }

    /* The sharpen reads the history the resolve has just written, so it is checked over that. */
    const sharpenBuffers = textures({ ...frame, history: nextHistory });
    sharpenBuffers[6] = { length: outputWidth * outputHeight * 3, read: true };
    const sharpened = await gpu.run({
      wgsl: WGSL,
      entryPoint: 'sharpenMain',
      workgroups: groups,
      buffers: sharpenBuffers,
    });
    const shownDevice = sharpened[6];
    const shownWant = new Float32Array(outputWidth * outputHeight * 3);
    resolveFrame({ ...frame, history: frame.history }, new Float32Array(nextHistory), shownWant);
    for (let i = 0; i < shownWant.length; i += 1) {
      check(`${one.name} sharpen`, `value ${i}`, shownWant[i], shownDevice[i], COLOUR_TOLERANCE);
    }
  }
} finally {
  await gpu.close();
}

console.log(`compared ${compared} values over ${frames} frames`);
console.log(
  `visited: ${visited.objectMotion} texels of drawn-object motion, ${visited.cameraMotion} of camera motion, ` +
    `${visited.bicubicFill} output pixels below one sample of gathered weight`,
);
for (const [kind, { off, at }] of worst) {
  console.log(`worst relative disagreement in a ${kind}: ${off.toExponential(2)} at ${at}`);
}
if (failures.length > 0) {
  console.error(`\n${failures.length} disagreements, the first few:`);
  for (const line of failures) console.error(`  ${line}`);
  process.exitCode = 1;
} else {
  console.log('the device and the reference agree on every value');
}

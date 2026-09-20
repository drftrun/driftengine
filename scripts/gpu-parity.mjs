/**
 * Do the two halves of the GPU-driven pipeline's arithmetic agree?
 *
 * **Every compute pass here is written twice** — once in TypeScript as the reference and once in
 * WGSL for the device — and until this script existed there was no way to compare them. The
 * TypeScript half had unit tests and the WGSL half had nothing at all: it was read by a generator
 * check that confirms a committed file matches its source, which says nothing about whether the
 * arithmetic is right.
 *
 * **It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up, deliberately**: it
 * needs a real GPU, the same reason `probe-check.mjs` and `ibl-check.mjs` are run by hand. What it
 * does need is nothing else — `gpuCompute.mjs` serves its own page, so there is no dev server to
 * start first.
 *
 *     node scripts/gpu-parity.mjs
 *
 * Exits non-zero on the first disagreement, naming the case and both answers.
 */
import { openGpuCompute } from '../packages/core/scripts/gpuCompute.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const { FRUSTUM_FLOATS, frustumPlanes, sphereOutsideFrustum } = await import(
  `${ROOT}packages/core/src/render/gpudriven/frustum.ts`
);
const { clusterSelected } = await import(`${ROOT}packages/core/src/render/gpudriven/lodCut.ts`);
const { INSTANCE_HIDDEN, selectClusters } = await import(
  `${ROOT}packages/core/src/render/gpudriven/instances.ts`
);
const { hzbMipSize, hzbReduce, shadowPyramidBase } = await import(
  `${ROOT}packages/core/src/render/gpudriven/hzb.ts`
);
const {
  CLUSTER_KEEP,
  clusterOccluded,
  coneBackfacing,
  cullClusters,
  hzbLevelFor,
  sphereScreenBounds,
} = await import(`${ROOT}packages/core/src/render/gpudriven/cullClusters.ts`);
const { VIS_MAX_TRIANGLES, packVisibility, unpackVisibility } = await import(
  `${ROOT}packages/core/src/render/gpudriven/visbuffer.ts`
);
const { BIN_DISPATCH_WORDS, BIN_GROUP_SIZE, binDispatchArgs, binOffsets, countBins, fillBins } =
  await import(`${ROOT}packages/core/src/render/gpudriven/materialBin.ts`);
const { MATERIAL_COUNT_WGSL, MATERIAL_OFFSETS_WGSL, MATERIAL_SCATTER_WGSL } = await import(
  `${ROOT}packages/core/src/render/shaders/gpudriven/materialBin.wgsl.ts`
);
const {
  SCREEN_VERTEX_FLOATS,
  attributeGradients,
  barycentricGradients,
  interpolate,
  perspectiveBarycentrics,
  screenBarycentrics,
  screenVertex,
} = await import(`${ROOT}packages/core/src/render/gpudriven/shadeBins.ts`);
const {
  LIT_ENVIRONMENT_FLOATS,
  LIT_SURFACE_FLOATS,
  SHADE_LIGHTING_PARITY_WGSL,
  SHADE_RECONSTRUCT_WGSL,
  SURFACE_FRAME_CASE_FLOATS,
  SURFACE_FRAME_PARITY_WGSL,
} = await import(`${ROOT}packages/core/src/render/shaders/gpudriven/shade.wgsl.ts`);
const { derivedTangentFrame, surfaceLod } = await import(
  `${ROOT}packages/core/src/render/gpudriven/surfaceFrame.ts`
);
const { litColour } = await import(`${ROOT}packages/core/src/render/gpudriven/lit.ts`);
const { shadowFactor } = await import(`${ROOT}packages/core/src/render/gpudriven/shadow.ts`);
const { receiverPlaneDepthGradient, receiverPlaneFromWeights } = await import(
  `${ROOT}packages/core/src/render/gpudriven/shadow.ts`
);
const {
  RECEIVER_PLANE_FLOATS,
  RECEIVER_PLANE_PARITY_WGSL,
  SHADOW_PARITY_WGSL,
  SHADOW_RECEIVER_FLOATS,
  SHADOW_SETTINGS_FLOATS,
} = await import(`${ROOT}packages/core/src/render/shaders/gpudriven/shadow.wgsl.ts`);
const {
  ENVIRONMENT_CASE_FLOATS,
  ENVIRONMENT_CHECK_EDGE,
  ENVIRONMENT_CHECK_LEVELS,
  ENVIRONMENT_PARITY_WGSL,
} = await import(`${ROOT}packages/core/src/render/shaders/gpudriven/environment.wgsl.ts`);
const { octInsetUv } = await import(`${ROOT}packages/core/src/render/shaders/octahedral.ts`);
const { probeLevelEdge, probeLevelMix } = await import(
  `${ROOT}packages/core/src/render/prefilterEnvMap.ts`
);
const { ALPHA_TEST_OFF, alphaKept } = await import(
  `${ROOT}packages/core/src/render/gpudriven/alphaTest.ts`
);
const { VISBUFFER_ALPHA_WGSL, VISBUFFER_PACK_WGSL } = await import(
  `${ROOT}packages/core/src/render/shaders/gpudriven/visbufferRaster.wgsl.ts`
);
const {
  CULL_CLUSTERS_WGSL,
  CULL_INSTANCES_WGSL,
  HZB_REDUCE_WGSL,
  LOD_CUT_WGSL,
  SHADOW_HZB_SEED_FLOAT_WGSL,
} = await import(`${ROOT}packages/core/src/render/shaders/gpudriven/cull.wgsl.ts`);
const { COMPACT_CLUSTERS_WGSL } = await import(
  `${ROOT}packages/core/src/render/shaders/gpudriven/compact.wgsl.ts`
);
const { DRAW_INDIRECT_WORDS, PHASE_ONE, PHASE_TWO, compactPhase } = await import(
  `${ROOT}packages/core/src/render/gpudriven/compact.ts`
);
const { CLUSTER_INDEX_CAP } = await import(`${ROOT}packages/core/src/render/gpudriven/indirect.ts`);
const { GPU_DRIVEN_MATERIAL_FLOATS, MATERIAL_BLEND, writeMaterialTable } = await import(
  `${ROOT}packages/core/src/render/gpudriven/materialTable.ts`
);
const { MATERIAL_SLOTS } = await import(
  `${ROOT}packages/core/src/render/shaders/gpudriven/materialTable.wgsl.ts`
);
const { BLEND_OIT_PARITY_WGSL } = await import(
  `${ROOT}packages/core/src/render/shaders/gpudriven/blendRaster.wgsl.ts`
);
const { oitWeight, resolveOit } = await import(
  `${ROOT}packages/core/src/render/orderIndependent.ts`
);
const { LINEAR_FOG, MEDIUM_FOG, mediumColour, mediumFog } = await import(
  `${ROOT}packages/core/src/render/fog.ts`
);
const { FOG_CASE_FLOATS, FOG_PARITY_WGSL } = await import(
  `${ROOT}packages/core/src/render/shaders/gpudriven/fog.wgsl.ts`
);
const { ADDRESS_MODE, DECODE_OP, createDecodeRegisters, decodeCpu, validateDecodeGraph } =
  await import(`${ROOT}packages/texture/src/index.ts`);
const { DECODE_CASE_FLOATS, DECODE_PARITY_WGSL } = await import(
  `${ROOT}packages/core/src/render/shaders/gpudriven/decode.wgsl.ts`
);
const { packDecodeTables } = await import(
  `${ROOT}packages/core/src/render/gpudriven/decodeTables.ts`
);
const {
  activationBound,
  evalNetwork,
  evalNetworkHalf,
  halfPrecisionErrorBound,
  halfWeights,
  networkWeightCount,
} = await import(`${ROOT}packages/texture/src/index.ts`);
const {
  NETWORK_CASE_WORDS,
  NETWORK_PARITY_HIDDEN,
  NETWORK_PARITY_WIDTH,
  networkFixedParityWgsl,
  networkParityWgsl,
} = await import(`${ROOT}packages/core/src/render/shaders/network.wgsl.ts`);

/*
 * **The splat fit's device half**, whose reference lives in `@driftengine/capture` rather than in
 * core. That is the one import here that crosses a package boundary, and it is the whole point: the
 * rasteriser a fit descends is written twice, once in TypeScript where it can be differentiated by
 * hand and once in WGSL where it is fast, and nothing but this script compares them.
 */
const { rasteriseGaussians } = await import(`${ROOT}packages/capture/src/gaussians/rasterise.ts`);
const { visibleGaussians } = await import(`${ROOT}packages/capture/src/gaussians/project.ts`);
const { accumulateGradients, createGradients, imageLoss, SCREEN_GRADIENTS } = await import(
  `${ROOT}packages/capture/src/gaussians/gradients.ts`
);
const { adamStep, createAdamState, createFamily } = await import(
  `${ROOT}packages/capture/src/gaussians/adam.ts`
);
const {
  countSplatTiles,
  fillSplatTiles,
  splatPairOffsets,
  splatTileGrid,
  splatTileOffsets,
  SPLAT_BIN_FLOATS,
} = await import(`${ROOT}packages/core/src/render/inference/splatTiles.ts`);
const {
  SPLAT_ADAM_WGSL,
  SPLAT_BACKWARD_WGSL,
  SPLAT_FORWARD_WGSL,
  SPLAT_GRADIENT_FLOATS,
  SPLAT_RASTER_FLOATS,
  SPLAT_REDUCE_WGSL,
} = await import(`${ROOT}packages/core/src/render/inference/splatRaster.wgsl.ts`);

/** `Settings` as the Adam kernel reads it: a count, then a rate and two bias corrections. */
function adamSettings(count, rate, state) {
  const words = new ArrayBuffer(16);
  new Uint32Array(words, 0, 1)[0] = count;
  new Float32Array(words, 4, 3).set([rate, 1 - state.unbias1, 1 - state.unbias2]);
  return new Uint32Array(words);
}

/** A deterministic generator, so a disagreement is reproducible from its seed alone. */
function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** A perspective view-projection looking down −z, column-major, clip depth in [0, 1]. */
function viewProj(near = 0.1, far = 100, fovY = Math.PI / 4, aspect = 16 / 9) {
  const f = 1 / Math.tan(fovY / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = far / (near - far);
  m[11] = -1;
  m[14] = (far * near) / (near - far);
  return m;
}

/**
 * The same camera with the depth range reversed: the near plane at 1 and the far at 0.
 *
 * **The conventional one above is fine for everything that does not read a depth value** — the
 * frustum planes bound the same volume either way — and wrong for everything that does. The
 * cluster pass reports the nearest clip depth a sphere reaches and compares it against a pyramid
 * whose reduction takes the *minimum*, and both of those are only right under the convention
 * `depthConvention.ts` ships. Built with the conventional matrix, the occlusion arm of that check
 * fired exactly zero times out of 512 and the parity comparison passed anyway, which is an
 * agreement between two branches neither of which ran.
 */
function reversedViewProj(near = 0.1, far = 100, fovY = Math.PI / 4, aspect = 16 / 9) {
  const m = viewProj(near, far, fovY, aspect);
  m[10] = near / (far - near);
  m[14] = (far * near) / (far - near);
  return m;
}

const failures = [];
/**
 * One check's summary line, counted as it is printed.
 *
 * **The count is derived rather than written down**, because a written one drifts: on 2026-09-17
 * this script's own comment called its last check "the fourteenth" while it was the thirteenth, and
 * three documents in this repository stated three different numbers — nine, thirteen and fourteen.
 * What the run prints at the end is now the only claim about how many checks there are.
 */
let reported = 0;
function report(line) {
  reported += 1;
  console.log(line);
}

function check(name, index, want, got) {
  if (want === got) return;
  failures.push(`${name}[${index}]: reference ${String(want)}, device ${String(got)}`);
}

/** A unit vector from three numbers, for the parity corpus. */
function normalise(x, y, z) {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

/** The one environment the lit parity check runs against, in the shape `lit.ts` takes. */
const LIT_ENVIRONMENT = {
  lightDir: [0.3714, 0.7428, 0.5571],
  lightColour: [1.0, 0.92, 0.83],
  sky: [0.31, 0.42, 0.61],
  ground: [0.09, 0.08, 0.07],
};

const gpu = await openGpuCompute();
try {
  /* ---------------------------------------------------------------- instance culling */
  {
    const COUNT = 256;
    const random = lcg(0x51ed270b);
    const m = viewProj();
    const planes = new Float32Array(FRUSTUM_FLOATS);
    frustumPlanes(m, planes);

    const spheres = new Float32Array(COUNT * 4);
    for (let i = 0; i < COUNT; i += 1) {
      /* Spread well past the frustum in every direction, so both answers occur often. */
      spheres[i * 4] = (random() - 0.5) * 80;
      spheres[i * 4 + 1] = (random() - 0.5) * 80;
      spheres[i * 4 + 2] = -random() * 140;
      spheres[i * 4 + 3] = random() * 6;
    }

    const out = await gpu.run({
      wgsl: CULL_INSTANCES_WGSL,
      workgroups: [Math.ceil(COUNT / 64)],
      buffers: [
        { type: 'f32', values: m, readOnly: true },
        { type: 'f32', values: spheres, readOnly: true },
        { type: 'u32', length: COUNT, read: true },
      ],
    });

    let culledCount = 0;
    for (let i = 0; i < COUNT; i += 1) {
      const want = sphereOutsideFrustum(
        planes,
        spheres[i * 4],
        spheres[i * 4 + 1],
        spheres[i * 4 + 2],
        spheres[i * 4 + 3],
      );
      if (want) culledCount += 1;
      check('cullInstances', i, want ? 1 : 0, out[2][i]);
    }
    /* Both answers have to occur, or the agreement is between two constants. */
    if (culledCount === 0 || culledCount === COUNT) {
      failures.push(`cullInstances: ${culledCount} of ${COUNT} culled, so the cases are not mixed`);
    }
    report(`cullInstances  ${COUNT} spheres, ${culledCount} culled`);
  }

  /* ---------------------------------------------------------------- the level cut */
  {
    const COUNT = 256;
    const random = lcg(0x2b1c9d4f);
    const screenHeight = 1080;
    const fovY = Math.PI / 3;
    const threshold = 1.5;
    const eye = [0, 2, 12];

    const clusters = new Float32Array(COUNT * 6);
    for (let i = 0; i < COUNT; i += 1) {
      clusters[i * 6] = (random() - 0.5) * 60;
      clusters[i * 6 + 1] = (random() - 0.5) * 20;
      clusters[i * 6 + 2] = -random() * 90;
      clusters[i * 6 + 3] = 0.2 + random() * 3;
      const own = random() * 0.4;
      clusters[i * 6 + 4] = own;
      /* A parent is always coarser than its child, which is what the bake guarantees. */
      clusters[i * 6 + 5] = own + random() * 0.6;
    }

    /*
     * **Five meshes, two of them hidden by the instance cull**, so the cut's first test — a hidden
     * mesh has no cluster in the cut — fires on clusters the level rule alone would have chosen.
     * The mesh is the fourth of each cluster's meta words, as the frame uploads them.
     */
    const MESHES = 5;
    const hidden = new Uint32Array([0, INSTANCE_HIDDEN, 0, INSTANCE_HIDDEN, 0]);
    const meta = new Uint32Array(COUNT * 4);
    for (let i = 0; i < COUNT; i += 1) meta[i * 4 + 3] = i % MESHES;

    /*
     * **Two materials, one of them blended, because the cut now chooses a half of the frame too.**
     * A visibility buffer holds one surface a pixel, so a blended cluster cannot go through it; the
     * cut is where they are separated, and this corpus puts every fourth cluster on the other side
     * so the filter is exercised rather than assumed. The reference `selectClusters` knows nothing
     * about materials, so it is compared against the opaque run and the blended run is asserted to
     * be its exact complement — which is the property that matters: every live cluster is drawn by
     * one half and no cluster by both.
     */
    const materialOf = new Uint32Array(COUNT);
    for (let i = 0; i < COUNT; i += 1) materialOf[i] = i % 4 === 0 ? 1 : 0;
    const table = new Float32Array(
      writeMaterialTable(
        [
          { tint: [1, 1, 1], emissive: 0 },
          { tint: [1, 1, 1], emissive: 0, blend: true },
        ],
        new Uint32Array(6).fill(0xffffffff),
        MATERIAL_SLOTS,
      ),
    );
    if (table[GPU_DRIVEN_MATERIAL_FLOATS + MATERIAL_BLEND] !== 1) {
      failures.push('lodCut: the corpus built no blended material, so the filter is untested');
    }

    const cutRun = async (wantBlend) =>
      gpu.run({
        wgsl: LOD_CUT_WGSL,
        workgroups: [Math.ceil(COUNT / 64)],
        buffers: [
          {
            type: 'f32',
            values: [screenHeight, fovY, threshold, eye[0], eye[1], eye[2], wantBlend],
            readOnly: true,
          },
          { type: 'f32', values: clusters, readOnly: true },
          { type: 'u32', length: COUNT, read: true },
          { type: 'u32', values: meta, readOnly: true },
          { type: 'u32', values: hidden, readOnly: true },
          { type: 'u32', values: materialOf, readOnly: true },
          { kind: 'uniform', type: 'f32', values: table },
        ],
      });
    const out = await cutRun(0);
    const blendOut = await cutRun(1);

    const want = new Uint32Array(COUNT);
    const chosen = selectClusters(
      clusters,
      meta,
      hidden,
      screenHeight,
      fovY,
      threshold,
      eye[0],
      eye[1],
      eye[2],
      want,
    );
    let dropped = 0;
    let blendedInCut = 0;
    for (let i = 0; i < COUNT; i += 1) {
      /* The opaque run is the reference minus whatever the blend filter took out of it. */
      const isBlended = materialOf[i] === 1;
      check('lodCut', i, isBlended ? 0 : want[i], out[2][i]);
      check('lodCutBlend', i, isBlended ? want[i] : 0, blendOut[2][i]);
      /* Never both, which is the invariant: a cluster is drawn by one half of the frame. */
      check('lodCutHalves', i, 0, out[2][i] & blendOut[2][i]);
      if (isBlended && blendOut[2][i] === 1) blendedInCut += 1;
      const distance = Math.hypot(
        clusters[i * 6] - eye[0],
        clusters[i * 6 + 1] - eye[1],
        clusters[i * 6 + 2] - eye[2],
      );
      const inCut = clusterSelected(
        clusters[i * 6 + 4],
        clusters[i * 6 + 5],
        distance,
        clusters[i * 6 + 3],
        screenHeight,
        fovY,
        threshold,
      );
      if (inCut && hidden[meta[i * 4 + 3]] !== 0) dropped += 1;
    }
    if (chosen === 0 || chosen === COUNT) {
      failures.push(`lodCut: ${chosen} of ${COUNT} selected, so the cases are not mixed`);
    }
    if (dropped === 0) failures.push('lodCut: no cluster of a hidden mesh was ever in the cut');
    if (blendedInCut === 0) {
      failures.push('lodCut: the blended half of the cut came back empty, so nothing tested it');
    }
    report(
      `lodCut         ${COUNT} clusters, ${chosen} selected, ${dropped} of hidden meshes, ` +
        `${blendedInCut} in the blended half`,
    );
  }

  /* ---------------------------------------------------------------- the depth pyramid */
  {
    /* An odd size on purpose: the extra row and column are what a reduction gets wrong. */
    const width = 37;
    const height = 21;
    const random = lcg(0x7f4a7c15);
    const src = new Float32Array(width * height);
    for (let i = 0; i < src.length; i += 1) src[i] = random();

    const size = hzbMipSize(width, height);
    const want = new Float32Array(size.width * size.height);
    hzbReduce(src, width, height, want);

    /*
     * **One buffer holding both levels**, because that is how the pipeline binds it: the whole
     * pyramid is one allocation and a level is an offset into it, since a buffer bound read-only
     * and writable in one compute pass is refused by the device. The source sits at zero and the
     * output at `width * height`, and the shader is told both.
     */
    const pyramid = new Float32Array(width * height + size.width * size.height);
    pyramid.set(src, 0);

    const out = await gpu.run({
      wgsl: HZB_REDUCE_WGSL,
      workgroups: [Math.ceil(size.width / 8), Math.ceil(size.height / 8)],
      buffers: [
        { type: 'u32', values: [width, height, 0, width * height], readOnly: true },
        { type: 'f32', values: pyramid, read: true },
      ],
    });

    for (let i = 0; i < want.length; i += 1) {
      check('hzbReduce', i, want[i], out[1][width * height + i]);
    }
    report(`hzbReduce      ${width}x${height} to ${size.width}x${size.height}`);
  }

  /* ---------------------------------------------------------- a light's pyramid, from its map */
  {
    /*
     * **The seed a light's pyramid starts from, turned over and folded.** The shader's body is the
     * pass's own; only where the depth comes from differs, an `r32float` texture here because a
     * depth texture cannot be written by a copy. Odd on purpose, as the reduction's is, and a fifth
     * of the map left at the clear, which is what an empty region of a real map holds.
     */
    for (const [width, height] of [
      [37, 21],
      [64, 64],
    ]) {
      const random = lcg(0x5bd1e995 + width);
      const depth = new Float32Array(width * height);
      for (let i = 0; i < depth.length; i += 1) depth[i] = random() < 0.2 ? 1 : random();
      const size = hzbMipSize(width, height);
      const want = new Float32Array(size.width * size.height);
      shadowPyramidBase(depth, width, height, want);
      const out = await gpu.run({
        wgsl: SHADOW_HZB_SEED_FLOAT_WGSL,
        workgroups: [Math.ceil(size.width / 8), Math.ceil(size.height / 8)],
        buffers: [
          { type: 'u32', values: [width, height], readOnly: true },
          { kind: 'texture2d', width, height, format: 'r32float', values: Array.from(depth) },
          { type: 'f32', length: size.width * size.height, read: true },
        ],
      });
      for (let i = 0; i < want.length; i += 1) {
        check('shadowSeed', i, want[i], out[2][i]);
      }
      report(`shadowSeed     ${width}x${height} to ${size.width}x${size.height}, turned over`);
    }
  }

  /* ---------------------------------------------------------- cluster culling, all three tests */
  {
    /*
     * The three tests run as one dispatch, so the generated clusters have to make every one of
     * them fire and every one of them decline. Spread across and past the frustum, aimed in every
     * direction, and at depths both in front of and behind the pyramid built below.
     */
    const COUNT = 512;
    const random = lcg(0x9e3779b1);
    const m = reversedViewProj();
    const planes = new Float32Array(FRUSTUM_FLOATS);
    frustumPlanes(m, planes);

    const clusters = new Float32Array(COUNT * 8);
    for (let i = 0; i < COUNT; i += 1) {
      const at = i * 8;
      clusters[at] = (random() - 0.5) * 60;
      clusters[at + 1] = (random() - 0.5) * 40;
      clusters[at + 2] = -random() * 90 - 0.2;
      clusters[at + 3] = random() * 3 + 0.05;
      /* A direction on the sphere, so the cone test sees every orientation. */
      const z = random() * 2 - 1;
      const phi = random() * Math.PI * 2;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      clusters[at + 4] = r * Math.cos(phi);
      clusters[at + 5] = r * Math.sin(phi);
      clusters[at + 6] = z;
      /* sin of a half-angle from flat to a full hemisphere. */
      clusters[at + 7] = random();
    }

    /* A pyramid over a small screen, random at the base, reduced the way the reference does. */
    const baseWidth = 64;
    const baseHeight = 64;
    const levels = [];
    let levelWidth = baseWidth;
    let levelHeight = baseHeight;
    let level = new Float32Array(levelWidth * levelHeight);
    /*
     * **A gradient rather than noise, and the reason is the reduction.** Every level takes the
     * *minimum* of the four below it, so a random base collapses toward zero within two levels and
     * a coarse texel then occludes nothing at all — which is how the first run of this block
     * reported 512 clusters kept and the occlusion arm never firing. A ramp across x survives the
     * reduction with its shape intact, and it puts the occluder above some clusters' depth and
     * below others: 0.0002 to 0.0102 against a field running from 0.0001 to about 0.5.
     */
    for (let i = 0; i < level.length; i += 1) {
      level[i] = 0.0002 + 0.01 * ((i % baseWidth) / baseWidth);
    }
    levels.push({ data: level, width: levelWidth, height: levelHeight });
    while (levelWidth > 1 || levelHeight > 1) {
      const next = hzbMipSize(levelWidth, levelHeight);
      const out = new Float32Array(next.width * next.height);
      hzbReduce(level, levelWidth, levelHeight, out);
      levels.push({ data: out, width: next.width, height: next.height });
      level = out;
      levelWidth = next.width;
      levelHeight = next.height;
    }
    const total = levels.reduce((sum, l) => sum + l.data.length, 0);
    const depths = new Float32Array(total);
    const offsets = new Int32Array(levels.length);
    let cursor = 0;
    for (let i = 0; i < levels.length; i += 1) {
      offsets[i] = cursor;
      depths.set(levels[i].data, cursor);
      cursor += levels[i].data.length;
    }

    const eye = [0, 0, 0];
    const keep = new Uint32Array(COUNT);
    const list = new Uint32Array(COUNT);
    /* One cluster in five left out of the cut, which the cull must neither test nor keep. */
    const selected = new Uint32Array(COUNT);
    for (let i = 0; i < COUNT; i += 1) selected[i] = i % 5 === 3 ? 0 : 1;
    const kept = cullClusters(
      clusters,
      planes,
      eye[0],
      eye[1],
      eye[2],
      { depths, offsets, width: baseWidth, height: baseHeight, viewProj: m },
      keep,
      list,
      selected,
    );

    const out = await gpu.run({
      wgsl: CULL_CLUSTERS_WGSL,
      workgroups: [Math.ceil(COUNT / 64)],
      buffers: [
        { type: 'f32', values: planes, readOnly: true },
        { type: 'f32', values: m, readOnly: true },
        {
          type: 'f32',
          /* The ninth float is the cone switch, on as the visibility raster's two phases run. */
          values: [eye[0], eye[1], eye[2], 1, baseWidth, baseHeight, levels.length, COUNT, 1],
          readOnly: true,
        },
        { type: 'f32', values: clusters, readOnly: true },
        { type: 'f32', values: depths, readOnly: true },
        { type: 'u32', values: Array.from(offsets), readOnly: true },
        { type: 'u32', length: COUNT, read: true },
        { type: 'u32', values: selected, readOnly: true },
      ],
    });

    for (let i = 0; i < COUNT; i += 1) check('cullClusters', i, keep[i], out[6][i]);

    /*
     * **And with the cones off**, as the blended half runs, because its raster draws both sides.
     * The same field against the reference told the same thing, and it has to keep more than the
     * run above did — a switch that changed nothing would agree with the reference just as well.
     */
    const keepAll = new Uint32Array(COUNT);
    const keptAll = cullClusters(
      clusters,
      planes,
      eye[0],
      eye[1],
      eye[2],
      { depths, offsets, width: baseWidth, height: baseHeight, viewProj: m },
      keepAll,
      new Uint32Array(COUNT),
      selected,
      false,
    );
    const outAll = await gpu.run({
      wgsl: CULL_CLUSTERS_WGSL,
      workgroups: [Math.ceil(COUNT / 64)],
      buffers: [
        { type: 'f32', values: planes, readOnly: true },
        { type: 'f32', values: m, readOnly: true },
        {
          type: 'f32',
          values: [eye[0], eye[1], eye[2], 1, baseWidth, baseHeight, levels.length, COUNT, 0],
          readOnly: true,
        },
        { type: 'f32', values: clusters, readOnly: true },
        { type: 'f32', values: depths, readOnly: true },
        { type: 'u32', values: Array.from(offsets), readOnly: true },
        { type: 'u32', length: COUNT, read: true },
        { type: 'u32', values: selected, readOnly: true },
      ],
    });
    for (let i = 0; i < COUNT; i += 1) check('cullClusters', i, keepAll[i], outAll[6][i]);
    if (!(keptAll > kept)) {
      failures.push(
        `cullClusters: with the cones off ${keptAll} were kept against ${kept} with them on`,
      );
    }
    /* Every arm has to fire, or the agreement is between two constants again. Counted through the
       reference's own helpers rather than by re-deriving the tests here. */
    const bounds = new Float32Array(5);
    let frustumCulled = 0;
    let coneCulled = 0;
    let occluded = 0;
    let unselected = 0;
    for (let i = 0; i < COUNT; i += 1) {
      const at = i * 8;
      /* Counted among what the device actually tests, which is only what the cut selected. */
      if (selected[i] === 0) {
        unselected += 1;
        continue;
      }
      if (
        sphereOutsideFrustum(
          planes,
          clusters[at],
          clusters[at + 1],
          clusters[at + 2],
          clusters[at + 3],
        )
      ) {
        frustumCulled += 1;
        continue;
      }
      if (
        coneBackfacing(
          clusters[at + 4],
          clusters[at + 5],
          clusters[at + 6],
          clusters[at + 7],
          clusters[at],
          clusters[at + 1],
          clusters[at + 2],
          clusters[at + 3],
          eye[0],
          eye[1],
          eye[2],
        )
      ) {
        coneCulled += 1;
        continue;
      }
      if (
        sphereScreenBounds(
          m,
          clusters[at],
          clusters[at + 1],
          clusters[at + 2],
          clusters[at + 3],
          bounds,
        ) &&
        clusterOccluded(
          depths,
          offsets,
          baseWidth,
          baseHeight,
          bounds[0],
          bounds[1],
          bounds[2],
          bounds[3],
          bounds[4],
        )
      ) {
        occluded += 1;
      }
    }
    for (const [name, value] of [
      ['frustum', frustumCulled],
      ['cone', coneCulled],
      ['occlusion', occluded],
      ['selection', unselected],
    ]) {
      if (value === 0) failures.push(`cullClusters: the ${name} test never fired`);
    }
    if (kept === 0 || kept === COUNT) {
      failures.push(`cullClusters: ${kept} of ${COUNT} kept, so the cases are not mixed`);
    }
    if (keep.reduce((sum, value) => sum + (value === CLUSTER_KEEP ? 1 : 0), 0) !== kept) {
      failures.push('cullClusters: the flags and the compacted count disagree');
    }
    /* The level chooser is arithmetic the shader repeats, so its ends are checked here too. */
    if (hzbLevelFor(1, 1, baseWidth, baseHeight) !== 0) {
      failures.push('cullClusters: a one-texel rectangle should read level zero');
    }
    report(
      `cullClusters   ${COUNT} clusters, ${kept} kept — ${unselected} not in the cut, ` +
        `${frustumCulled} frustum, ${coneCulled} cone, ${occluded} occluded; ` +
        `${keptAll} kept with the cones off`,
    );
  }

  /* ------------------------------------------------- the near plane, which needs its own field */
  {
    /*
     * **A generated field cannot reach this case and the field above did not.** Deleting the
     * shader's `cw <= 1e-6` refusal left all 512 clusters agreeing, because a sphere that
     * straddles the near plane is by definition close, its valid corners still report a large
     * clip depth, and the wrapped rectangle then reads the coarsest level — whose value is the
     * minimum of the whole pyramid and occludes nothing. So the case is built rather than hoped
     * for: a single-level pyramid holding a *near* occluder, which culls anything that reaches
     * the comparison at all. The reference never reaches it, and a shader that has lost the
     * refusal culls every one of them.
     */
    const COUNT = 8;
    const m = reversedViewProj();
    const planes = new Float32Array(FRUSTUM_FLOATS);
    frustumPlanes(m, planes);

    const clusters = new Float32Array(COUNT * 8);
    for (let i = 0; i < COUNT; i += 1) {
      const at = i * 8;
      /* Centred just in front of the eye with a radius that reaches behind it. */
      clusters[at] = (i - 3.5) * 0.02;
      clusters[at + 1] = 0;
      clusters[at + 2] = -0.05 - i * 0.005;
      clusters[at + 3] = 0.5;
      /* Facing the camera, so the cone test cannot be what keeps them. */
      clusters[at + 4] = 0;
      clusters[at + 5] = 0;
      clusters[at + 6] = 1;
      clusters[at + 7] = 0;
    }

    const depths = new Float32Array([0.9]);
    const offsets = new Int32Array([0]);
    const keep = new Uint32Array(COUNT);
    const list = new Uint32Array(COUNT);
    const kept = cullClusters(
      clusters,
      planes,
      0,
      0,
      0,
      { depths, offsets, width: 1, height: 1, viewProj: m },
      keep,
      list,
    );
    if (kept !== COUNT) {
      failures.push(
        `nearPlane: the reference culled ${COUNT - kept} of ${COUNT} straddling clusters`,
      );
    }

    const out = await gpu.run({
      wgsl: CULL_CLUSTERS_WGSL,
      workgroups: [1],
      buffers: [
        { type: 'f32', values: planes, readOnly: true },
        { type: 'f32', values: m, readOnly: true },
        /* The cone switch on, as the reference call above leaves it. */
        { type: 'f32', values: [0, 0, 0, 1, 1, 1, 1, COUNT, 1], readOnly: true },
        { type: 'f32', values: clusters, readOnly: true },
        { type: 'f32', values: depths, readOnly: true },
        { type: 'u32', values: [0], readOnly: true },
        { type: 'u32', length: COUNT, read: true },
        { type: 'u32', values: new Uint32Array(COUNT).fill(1), readOnly: true },
      ],
    });
    for (let i = 0; i < COUNT; i += 1) check('nearPlane', i, keep[i], out[6][i]);
    report(`nearPlane      ${COUNT} straddling clusters, ${kept} kept by both`);
  }
  /* ------------------------------------------- compacting three flag buffers into one draw */
  {
    /*
     * **The one stage whose answer is a list rather than a flag, and therefore the one whose
     * order is not part of the answer.** The device appends with an atomic and arrives in
     * whatever order the scheduler produced; the reference appends in cluster order because a
     * loop has one. So both are sorted before they are compared, and what is compared as written
     * is the count, the recorded history and the draw block.
     *
     * The three flags are generated independently so every combination occurs: a cluster the cut
     * rejected, one the cull rejected, one rejected by both, and one rejected by neither in each
     * phase. A fixture where the flags agree tests one flag three times.
     *
     * **And each phase has its own cull**, as on the device: phase two's is phase one's with the
     * pyramid added, so it drops a share of what phase one kept. One `keep` for both phases could
     * not tell a history written by phase two from one written by both — which is the defect this
     * check missed until 2026-09-18, when the city found it by where the camera had been.
     */
    const COUNT = 1024;
    const random = lcg(0x6f2ab913);
    const selected = new Uint32Array(COUNT);
    const keepOne = new Uint32Array(COUNT);
    const keepTwo = new Uint32Array(COUNT);
    const history = new Uint32Array(COUNT);
    let hidden = 0;
    for (let i = 0; i < COUNT; i += 1) {
      selected[i] = random() < 0.75 ? 1 : 0;
      keepOne[i] = random() < 0.6 ? 1 : 0;
      history[i] = random() < 0.5 ? 1 : 0;
      /* The pyramid only ever takes away: a quarter of what the frustum and the cones kept. */
      keepTwo[i] = keepOne[i] === 1 && random() < 0.25 ? 0 : keepOne[i];
      if (keepOne[i] === 1 && keepTwo[i] === 0 && history[i] === 1 && selected[i] === 1)
        hidden += 1;
    }

    const phaseCounts = [];
    const drawnDevice = new Uint32Array(COUNT);
    const drawnReference = new Uint32Array(COUNT);
    for (const phase of [PHASE_ONE, PHASE_TWO]) {
      const keep = phase === PHASE_ONE ? keepOne : keepTwo;
      const out = await gpu.run({
        wgsl: COMPACT_CLUSTERS_WGSL,
        workgroups: [Math.ceil(COUNT / 64)],
        buffers: [
          { type: 'u32', values: [phase, COUNT], readOnly: true },
          { type: 'u32', values: Array.from(selected), readOnly: true },
          { type: 'u32', values: Array.from(keep), readOnly: true },
          { type: 'u32', values: Array.from(history), readOnly: true },
          { type: 'u32', length: COUNT, read: true },
          { type: 'u32', values: Array.from(drawnDevice), read: true },
          { type: 'u32', values: [CLUSTER_INDEX_CAP, 0, 0, 0], read: true },
        ],
      });

      const list = new Uint32Array(COUNT);
      const args = new Uint32Array(DRAW_INDIRECT_WORDS);
      const wanted = compactPhase(
        phase,
        selected,
        keep,
        history,
        COUNT,
        list,
        drawnReference,
        args,
      );

      check(`compactCount${phase}`, 0, wanted, out[6][1]);
      for (let word = 0; word < DRAW_INDIRECT_WORDS; word += 1) {
        check(`compactArgs${phase}`, word, args[word], out[6][word]);
      }
      const got = Array.from(out[4].slice(0, out[6][1])).sort((a, b) => a - b);
      const want = Array.from(list.slice(0, wanted)).sort((a, b) => a - b);
      for (let i = 0; i < Math.max(got.length, want.length); i += 1) {
        check(`compactList${phase}`, i, want[i], got[i]);
      }
      drawnDevice.set(out[5].slice(0, COUNT));
      phaseCounts.push(wanted);
    }
    for (let i = 0; i < COUNT; i += 1) {
      check('compactHistory', i, drawnReference[i], drawnDevice[i]);
    }
    /* Both phases have to do work, or one of the two arms of the partition never ran. */
    if (phaseCounts[0] === 0 || phaseCounts[1] === 0) {
      failures.push(`compact: phases drew ${phaseCounts[0]} and ${phaseCounts[1]}`);
    }
    /* And some of phase one's clusters are hidden by phase two's pyramid, or the history's rule
       is never exercised. */
    if (hidden === 0) failures.push('compact: no cluster phase one drew was hidden by phase two');
    report(
      `compact        ${COUNT} clusters, ${phaseCounts[0]} in phase one and ${phaseCounts[1]} in phase two, ` +
        `${hidden} drawn by phase one and hidden by phase two's pyramid`,
    );
  }
  /* --------------------------------------------------------- the visibility buffer's packing */
  {
    /*
     * **The one thing that goes wrong in a visibility buffer is a field overflowing its
     * neighbour**, silently, on the one asset whose clusters are full. The rasterisation is the
     * hardware's and cannot be compared against a model; the bit layout can, so it is lifted out
     * of the raster shader and run over the ends of both fields.
     */
    const COUNT = 512;
    const random = lcg(0x1b873593);
    const clusters = new Uint32Array(COUNT);
    const triangles = new Uint32Array(COUNT);
    const maxCluster = (1 << (32 - 7)) - 1;
    for (let i = 0; i < COUNT; i += 1) {
      clusters[i] = Math.floor(random() * maxCluster);
      triangles[i] = Math.floor(random() * VIS_MAX_TRIANGLES);
    }
    /*
     * Both ends of both fields by hand, because a generator reaches neither reliably — and then
     * **four triangle indices that do not fit**, which is the case the mask exists for and the one
     * a generated field can never produce. A cluster is baked to 128 triangles; an asset that
     * arrives with 129 writes a bit into the cluster field and moves the whole cluster somewhere
     * else in the scene, which draws a plausible picture of the wrong geometry. The reference
     * refuses such a pair outright, so what is compared for these is the property the shader has
     * to keep: the *cluster* comes back unchanged.
     */
    const corners = [
      [0, 0],
      [0, VIS_MAX_TRIANGLES - 1],
      [maxCluster, 0],
      [maxCluster, VIS_MAX_TRIANGLES - 1],
    ];
    for (let i = 0; i < corners.length; i += 1) {
      clusters[i] = corners[i][0];
      triangles[i] = corners[i][1];
    }
    const overRange = [VIS_MAX_TRIANGLES, VIS_MAX_TRIANGLES + 1, 255, 1000];
    for (let i = 0; i < overRange.length; i += 1) {
      clusters[corners.length + i] = 12345 + i;
      triangles[corners.length + i] = overRange[i];
    }
    const firstOverRange = corners.length;
    const lastOverRange = corners.length + overRange.length;

    const out = await gpu.run({
      wgsl: VISBUFFER_PACK_WGSL,
      workgroups: [Math.ceil(COUNT / 64)],
      buffers: [
        { type: 'u32', values: Array.from(clusters), readOnly: true },
        { type: 'u32', values: Array.from(triangles), readOnly: true },
        { type: 'u32', length: COUNT, read: true },
        { type: 'u32', length: COUNT, read: true },
      ],
    });

    for (let i = 0; i < COUNT; i += 1) {
      const back = unpackVisibility(out[2][i]);
      if (i >= firstOverRange && i < lastOverRange) {
        /* The triangle is not representable, so only the neighbouring field is asserted — and
           the round trip must say so rather than claim the pair survived. */
        check('visOverRange', i, clusters[i], back.cluster);
        check('visOverRangeRoundTrip', i, 0, out[3][i]);
        check('visOverRangeMask', i, triangles[i] & (VIS_MAX_TRIANGLES - 1), back.triangle);
        continue;
      }
      check('visPack', i, packVisibility(clusters[i], triangles[i]), out[2][i]);
      check('visRoundTrip', i, 1, out[3][i]);
      check('visCluster', i, clusters[i], back.cluster);
      check('visTriangle', i, triangles[i], back.triangle);
    }
    report(
      `visbuffer      ${COUNT} identifiers, both ends of both fields and ${overRange.length} that overflow`,
    );
  }
  /* ------------------------------------------------------------------------ the alpha test */
  {
    /*
     * **The boundary, from both sides, at every scale a texture's alpha actually arrives at.**
     * What goes wrong in an alpha test is never the comparison in the middle of its range — it is
     * the texel sitting exactly on the cutoff, which one side keeps and the other discards, and
     * the difference is a seam one texel wide around every leaf that reads as a mipmap problem.
     *
     * So the corpus is built around cutoffs rather than sampled uniformly: for each cutoff, the
     * value itself, a thousandth either side, an eighth-bit either side, zero and one. Plus the
     * cases that are about the rule rather than the comparison — a cutoff of zero, a negative one,
     * a cutoff above one, and a NaN alpha on each.
     */
    const cases = [];
    const CUTOFFS = [0.001, 0.05, 0.25, 1 / 3, 0.5, 0.75, 0.9999, 1];
    for (const cutoff of CUTOFFS) {
      for (const alpha of [
        cutoff,
        cutoff - 0.001,
        cutoff + 0.001,
        cutoff - 1 / 255,
        cutoff + 1 / 255,
        0,
        1,
        Number.NaN,
      ]) {
        cases.push([alpha, cutoff]);
      }
    }
    for (const cutoff of [ALPHA_TEST_OFF, -1, 2, Number.NaN]) {
      for (const alpha of [0, 0.5, 1, Number.NaN]) cases.push([alpha, cutoff]);
    }

    const out = await gpu.run({
      wgsl: VISBUFFER_ALPHA_WGSL,
      workgroups: [Math.ceil(cases.length / 64)],
      buffers: [
        { type: 'f32', values: cases.map((c) => c[0]), readOnly: true },
        { type: 'f32', values: cases.map((c) => c[1]), readOnly: true },
        { type: 'f32', length: cases.length, read: true },
      ],
    });

    let onBoundary = 0;
    for (let i = 0; i < cases.length; i += 1) {
      const [alpha, cutoff] = cases[i];
      if (alpha === cutoff && cutoff > 0) onBoundary += 1;
      check(`alphaKept(${alpha},${cutoff})`, i, alphaKept(alpha, cutoff) ? 1 : 0, out[2][i]);
    }
    report(
      `alpha test     ${cases.length} pairs across ${CUTOFFS.length} cutoffs, ` +
        `${onBoundary} of them exactly on one`,
    );
  }
  /* ------------------------------------------------------------------------------ the haze */
  {
    /*
     * **Both modes, both guards, and the crossfade**, because the two guards are the whole reason
     * this term has a reference at all: each is observable at exactly one input and invisible
     * everywhere else. A level ray — a fragment at the eye's own height, which in a flat world is
     * most of them — divides zero by zero in the height falloff; a span of zero does the same at
     * exactly the cut distance. Neither turns up in a corpus of random numbers, so both are placed.
     */
    const cases = [];
    const push = (dist, pointY, o) =>
      cases.push(
        dist,
        pointY,
        o.colour[0],
        o.colour[1],
        o.colour[2],
        o.eyeY,
        o.underwaterColour[0],
        o.underwaterColour[1],
        o.underwaterColour[2],
        o.underwaterFactor,
        o.heightFalloff,
        o.density,
        o.near,
        o.far,
        o.mode,
        o.underwaterDensity,
      );
    const base = {
      colour: [0.7, 0.82, 0.92],
      density: 0.02,
      heightFalloff: 0.1,
      eyeY: 10,
      underwaterColour: [0, 0.2, 0.3],
      underwaterDensity: 0.05,
      underwaterFactor: 0,
      mode: MEDIUM_FOG,
      near: 50,
      far: 100,
    };
    const media = [];
    for (const mode of [MEDIUM_FOG, LINEAR_FOG]) {
      for (const underwaterFactor of [0, 0.5, 1]) {
        for (const heightFalloff of [0, 0.02, 0.1]) {
          for (const density of [0, 0.002, 0.05]) {
            media.push({ ...base, mode, underwaterFactor, heightFalloff, density });
          }
        }
      }
      /* A span of zero, which is a consumer asking for a hard cut rather than a ramp. */
      media.push({ ...base, mode, near: 60, far: 60 });
    }
    let levelRays = 0;
    let atTheCut = 0;
    let fogWorst = 0;
    for (const o of media) {
      for (const [dist, pointY] of [
        [0, o.eyeY],
        /* Exactly the eye's height: the falloff's quotient is zero over zero here. */
        [40, o.eyeY],
        [60, o.eyeY],
        [100, o.eyeY],
        [40, o.eyeY + 30],
        [40, o.eyeY - 30],
        [1e4, o.eyeY + 1],
      ]) {
        if (pointY === o.eyeY) levelRays += 1;
        if (o.near === o.far && dist === o.near) atTheCut += 1;
        push(dist, pointY, o);
      }
    }
    const count = cases.length / FOG_CASE_FLOATS;

    const out = await gpu.run({
      wgsl: FOG_PARITY_WGSL,
      workgroups: [Math.ceil(count / 64)],
      buffers: [
        { type: 'f32', values: cases, readOnly: true },
        { type: 'f32', length: count * 4, read: true },
      ],
    });

    for (let c = 0; c < count; c += 1) {
      const at = c * FOG_CASE_FLOATS;
      const dist = cases[at];
      const pointY = cases[at + 1];
      const o = {
        colour: [cases[at + 2], cases[at + 3], cases[at + 4]],
        eyeY: cases[at + 5],
        underwaterColour: [cases[at + 6], cases[at + 7], cases[at + 8]],
        underwaterFactor: cases[at + 9],
        heightFalloff: cases[at + 10],
        density: cases[at + 11],
        near: cases[at + 12],
        far: cases[at + 13],
        mode: cases[at + 14],
        underwaterDensity: cases[at + 15],
      };
      const want = mediumFog(o, dist, pointY);
      const got = out[1][c * 4];
      /*
       * **Absolute, because the answer is a fraction between zero and one**, and at 2e-4 — which
       * is an order of magnitude above the worst this corpus produces and three below anything a
       * wrong operation could be.
       *
       * **The level-ray guard is what sets the floor.** It divides `1 - exp(-1e-4)` by `1e-4`, and
       * in float32 that subtraction cancels four of the seven digits it had; the reference works in
       * float64 and does not. The forward path has carried the same conditioning since the haze was
       * written, so this is the term's own accuracy rather than a defect in the transcription — and
       * the worst is reported beside the count so drift in it would be visible.
       */
      fogWorst = Math.max(fogWorst, Math.abs(want - got));
      if (!(Math.abs(want - got) <= 2e-4)) {
        failures.push(`mediumFog[${c}]: reference ${want}, device ${got} at ${dist}m, y ${pointY}`);
      }
      const wantColour = mediumColour(o);
      for (let k = 0; k < 3; k += 1) {
        const gotColour = out[1][c * 4 + 1 + k];
        if (!(Math.abs(wantColour[k] - gotColour) <= 2e-4)) {
          failures.push(
            `mediumColour[${c}] channel ${k}: reference ${wantColour[k]}, device ${gotColour}`,
          );
        }
      }
    }
    if (levelRays === 0) {
      failures.push('fog: no case sits on the level ray, so that guard is untested');
    }
    if (atTheCut === 0) {
      failures.push('fog: no case sits on a zero span, so that guard is untested');
    }
    report(
      `fog            ${count} samples over ${media.length} media, ${levelRays} on the level ` +
        `ray, ${atTheCut} on a zero span, worst ${fogWorst.toExponential(1)}`,
    );
  }
  /* --------------------------------------------------------------- an ordinary image */
  {
    /*
     * **A check that builds nothing, because the capability was already there.**
     *
     * §6 of the design says an ordinary picture on a surface needs no second texture kind: a
     * `DriftTexture` program whose only instruction is `SAMPLE_BLOCK` is that picture, and the
     * block table is raw bytes rather than a network's latent. Four places in the code said so —
     * the operation's own name in `decodeGraph.ts`, `decodeTables.ts` packing `blocks` into the
     * same array as the latents, the device interpreter taking `SAMPLE_LATENT` and `SAMPLE_BLOCK`
     * through one branch, and the CPU reference doing the same — and **none of them had ever been
     * run**. This runs it.
     *
     * **The sample points are the ones a half-texel error shows at and nowhere else**: the four
     * corners, and every texel centre along both diagonals. Sampled in the middle of a texel, a
     * picture offset by half a texel still returns the right value; sampled at a corner it does not.
     */
    const EDGE = 64;
    const levels = [new Uint8Array(EDGE * EDGE * 4)];
    for (let y = 0; y < EDGE; y += 1) {
      for (let x = 0; x < EDGE; x += 1) {
        const at = (y * EDGE + x) * 4;
        /* A distinct value in every texel, so a sample from the wrong one is a wrong number. */
        levels[0][at] = (x * 4) % 256;
        levels[0][at + 1] = (y * 4) % 256;
        levels[0][at + 2] = (x + y) % 256;
        levels[0][at + 3] = (x ^ y) % 256;
      }
    }
    for (let edge = EDGE >> 1; edge >= 1; edge >>= 1) {
      const from = levels[levels.length - 1];
      const wide = edge * 2;
      const next = new Uint8Array(edge * edge * 4);
      for (let y = 0; y < edge; y += 1) {
        for (let x = 0; x < edge; x += 1) {
          for (let k = 0; k < 4; k += 1) {
            let sum = 0;
            for (let dy = 0; dy < 2; dy += 1) {
              for (let dx = 0; dx < 2; dx += 1) {
                sum += from[((y * 2 + dy) * wide + (x * 2 + dx)) * 4 + k];
              }
            }
            next[(y * edge + x) * 4 + k] = Math.round(sum / 4);
          }
        }
      }
      levels.push(next);
    }
    const block = { width: EDGE, height: EDGE, components: 4, levels };
    const program = {
      graph: {
        nodes: Uint32Array.from([DECODE_OP.SAMPLE_BLOCK, 0, 0, 0]),
        count: 1,
        result: 0,
        addressMode: ADDRESS_MODE.CENTRE_CLAMP,
      },
      blocks: [block],
      /* Declared empty rather than absent: `packDecodeTables` iterates all four lists. */
      latents: [],
      networks: [],
      constants: new Float32Array(0),
    };
    if (validateDecodeGraph(program.graph) !== null) {
      failures.push('image: the one-instruction program did not validate');
    }
    const tables = packDecodeTables([program]);

    const points = [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ];
    for (let i = 0; i < EDGE; i += 1) {
      const centre = (i + 0.5) / EDGE;
      points.push([centre, centre]);
      points.push([centre, (EDGE - 1 - i + 0.5) / EDGE]);
    }
    /* Past the edge on both sides, which is what the clamp is for. */
    for (let i = 0; i < 16; i += 1) points.push([-0.25 - i / 32, 1.25 + i / 32]);
    while (points.length < 256) {
      points.push([points.length / 256, ((points.length * 7) % 256) / 256]);
    }

    const cases = [];
    for (const [u, v] of points) cases.push(0, u, v, 0, 0);
    const count = cases.length / DECODE_CASE_FLOATS;

    const out = await gpu.run({
      wgsl: DECODE_PARITY_WGSL,
      workgroups: [Math.ceil(count / 64)],
      buffers: [
        { type: 'f32', values: [count, EDGE], readOnly: true },
        { type: 'f32', values: cases, readOnly: true },
        { kind: 'uniform', type: 'u32', values: tables.nodes },
        { kind: 'uniform', type: 'f32', values: tables.weights },
        { kind: 'texture2dArray', size: EDGE, layers: tables.layerCount, levels: tables.levels },
        { kind: 'sampler', address: 'clamp-to-edge' },
        { kind: 'sampler', address: 'repeat' },
        { type: 'f32', length: count * 4, read: true },
      ],
    });

    const image = {
      data: Float32Array.from(levels[0], (value) => value / 255),
      width: EDGE,
      height: EDGE,
      channels: 4,
      mips: levels.slice(1).map((level, k) => ({
        data: Float32Array.from(level, (value) => value / 255),
        width: EDGE >> (k + 1),
        height: EDGE >> (k + 1),
      })),
    };
    const want = new Float32Array(4);
    let worstImage = 0;
    const distinct = new Set();
    for (let c = 0; c < count; c += 1) {
      const [, u, v] = cases
        .slice(c * DECODE_CASE_FLOATS, (c + 1) * DECODE_CASE_FLOATS)
        .map(Math.fround);
      decodeCpu(
        program.graph,
        { latents: [], blocks: [image], networks: [], constants: undefined },
        u,
        v,
        0,
        want,
        createDecodeRegisters(),
        0,
      );
      distinct.add(want.join(','));
      for (let k = 0; k < 4; k += 1) {
        const got = out[7][c * 4 + k];
        const error = Math.abs(want[k] - got);
        worstImage = Math.max(worstImage, error);
        if (!(error <= 2e-4)) {
          failures.push(
            `image[${c}] channel ${k}: reference ${want[k]}, device ${got} at ${u},${v}`,
          );
        }
      }
    }
    if (distinct.size < 64) {
      failures.push(`image: only ${distinct.size} distinct texels sampled, so the points collapse`);
    }
    report(
      `image          ${count} points on a ${EDGE}x${EDGE} picture, ${distinct.size} distinct ` +
        `texels, worst ${worstImage.toExponential(1)}`,
    );
  }
  /* ------------------------------------------------------- the weighted transparency blend */
  {
    /*
     * **What a picture cannot show is whether the weight is the forward path's.** Two panes blended
     * by a weight twice as steep still look like two panes; what it changes is how much a far layer
     * keeps, and nothing about the frame says so. `render/orderIndependent.ts` is the reference
     * both paths are written against, and this is the blended raster's copy of it on a device.
     *
     * The corpus straddles both clamps deliberately — the ceiling a fragment on the near plane
     * would take, and the floor a distant one would round through — because the clamps are the only
     * part of the expression that is a decision rather than a formula.
     */
    const cases = [];
    for (const depth of [0, 0.5, 2, 10, 50, 120, 200, 400, 1000]) {
      for (const alpha of [0, 0.05, 0.25, 0.5, 0.9, 1]) {
        cases.push([depth, alpha, 0.8, 0.3, 0.15, 0.05, 0.6, 0.9]);
      }
    }
    const flat = new Float32Array(cases.length * 8);
    cases.forEach((one, i) => flat.set(one, i * 8));

    const out = await gpu.run({
      wgsl: BLEND_OIT_PARITY_WGSL,
      workgroups: [Math.ceil(cases.length / 64)],
      buffers: [
        { type: 'f32', values: flat, readOnly: true },
        { type: 'f32', length: cases.length * 4, read: true },
      ],
    });

    /*
     * **Relatively, because both sides are float32 and the falloff is a fourth power.** The weight
     * runs from a hundredth to three thousand across this corpus, so an absolute bound would be
     * meaningless at one end and vacuous at the other.
     */
    const close = (name, index, want, got, scale) => {
      const size = Math.max(Math.abs(want), Math.abs(scale), 1e-6);
      if (Math.abs(want - got) / size < 2e-3) return;
      failures.push(`${name}[${index}]: reference ${want}, device ${got}`);
    };

    let clamped = 0;
    for (let i = 0; i < cases.length; i += 1) {
      const [depth, alpha, r, g, b, br, bg, bb] = cases[i];
      const weight = oitWeight(depth, alpha);
      if (alpha > 0 && (weight / alpha === 3e3 || weight / alpha === 1e-2)) clamped += 1;
      close('oitWeight', i, weight, out[1][i * 4], Math.max(weight, 1));
      /* One fragment folded in and resolved, which is the anchor: for a single layer this is over. */
      const state = { accum: [0, 0, 0, 0], reveal: 1 };
      state.accum[0] = r * alpha * weight;
      state.accum[1] = g * alpha * weight;
      state.accum[2] = b * alpha * weight;
      state.accum[3] = alpha * weight;
      state.reveal = 1 - alpha;
      const want = resolveOit(state, [br, bg, bb]);
      for (let c = 0; c < 3; c += 1) close('oitResolve', i, want[c], out[1][i * 4 + 1 + c], 1);
    }
    if (clamped === 0) failures.push('oit: no case reached either clamp, so neither was tested');
    report(`oit blend      ${cases.length} fragments, ${clamped} against a clamp`);
  }
  /* ------------------------------------------------------------------ binning by material */
  {
    /*
     * A frame of pixels over a scene of clusters, with one material that never appears — which is
     * the case the arguments have to keep a zero block for rather than dropping.
     */
    const PIXELS = 4096;
    const CLUSTERS = 97;
    const MATERIALS = 6;
    const random = lcg(0x85ebca6b);
    const materialOf = new Uint32Array(CLUSTERS);
    for (let i = 0; i < CLUSTERS; i += 1) {
      /* Materials 0 to 4 only, so material 5 is declared and absent. */
      materialOf[i] = Math.floor(random() * (MATERIALS - 1));
    }
    const visibility = new Uint32Array(PIXELS);
    let past = 0;
    for (let i = 0; i < PIXELS; i += 1) {
      /* A third of the frame uncovered, which is what a scene with a sky looks like. */
      if (random() < 0.33) {
        visibility[i] = 0xffffffff;
        continue;
      }
      /*
       * **And a few whose cluster is past the table**, which is a visibility buffer left over
       * from a frame with more geometry in it. Without them the range check never fires on its
       * own: an uncovered pixel's cluster field is 33.5 million, so the sentinel test and the
       * range test mask each other and a perturbation of either survives.
       */
      const stale = random() < 0.02;
      if (stale) past += 1;
      visibility[i] = packVisibility(
        stale ? CLUSTERS + Math.floor(random() * 20) : Math.floor(random() * CLUSTERS),
        Math.floor(random() * VIS_MAX_TRIANGLES),
      );
    }

    const counts = new Uint32Array(MATERIALS);
    const covered = countBins(visibility, materialOf, counts);
    const offsets = new Uint32Array(MATERIALS);
    const cursors = new Uint32Array(MATERIALS);
    const total = binOffsets(counts, offsets);
    const pixels = new Uint32Array(total);
    fillBins(visibility, materialOf, offsets, cursors, pixels);
    const args = new Uint32Array(MATERIALS * BIN_DISPATCH_WORDS);
    binDispatchArgs(counts, args);

    const settings = [PIXELS, MATERIALS, BIN_GROUP_SIZE, 0];
    const counted = await gpu.run({
      wgsl: MATERIAL_COUNT_WGSL,
      workgroups: [Math.ceil(PIXELS / 64)],
      buffers: [
        { type: 'u32', values: settings, readOnly: true },
        { type: 'u32', values: Array.from(visibility), readOnly: true },
        { type: 'u32', values: Array.from(materialOf), readOnly: true },
        { type: 'u32', length: MATERIALS, read: true },
      ],
    });
    for (let i = 0; i < MATERIALS; i += 1) check('binCount', i, counts[i], counted[3][i]);

    const summed = await gpu.run({
      wgsl: MATERIAL_OFFSETS_WGSL,
      workgroups: [1],
      buffers: [
        { type: 'u32', values: settings, readOnly: true },
        { type: 'u32', values: [], readOnly: true },
        { type: 'u32', values: [], readOnly: true },
        { type: 'u32', values: Array.from(counts), readOnly: true },
        { type: 'u32', length: MATERIALS, read: true },
        { type: 'u32', length: MATERIALS * BIN_DISPATCH_WORDS, read: true },
      ],
    });
    for (let i = 0; i < MATERIALS; i += 1) check('binOffset', i, offsets[i], summed[4][i]);
    for (let i = 0; i < args.length; i += 1) check('binDispatch', i, args[i], summed[5][i]);

    const scattered = await gpu.run({
      wgsl: MATERIAL_SCATTER_WGSL,
      workgroups: [Math.ceil(PIXELS / 64)],
      buffers: [
        { type: 'u32', values: settings, readOnly: true },
        { type: 'u32', values: Array.from(visibility), readOnly: true },
        { type: 'u32', values: Array.from(materialOf), readOnly: true },
        { type: 'u32', values: Array.from(offsets), read: false },
        { type: 'u32', length: total, read: true },
      ],
    });

    /*
     * **Compared as sets.** The order inside a bin is whatever the atomics produced, and nothing
     * downstream may depend on it — so the reference's order is not the claim. What is the claim
     * is that each bin holds the same pixels.
     */
    for (let material = 0; material < MATERIALS; material += 1) {
      const from = offsets[material];
      const to = from + counts[material];
      const want = Array.from(pixels.subarray(from, to)).sort((a, b) => a - b);
      const got = Array.from(scattered[4].slice(from, to)).sort((a, b) => a - b);
      for (let i = 0; i < want.length; i += 1) {
        check(`binPixels[m${material}]`, i, want[i], got[i]);
      }
    }

    if (counts[MATERIALS - 1] !== 0) {
      failures.push(
        'materialBin: the absent material was not absent, so its zero block is untested',
      );
    }
    if (past === 0) {
      failures.push(
        'materialBin: no pixel named a cluster past the table, so the range check is untested',
      );
    }
    report(
      `materialBin    ${PIXELS} pixels, ${covered} covered, ${past} stale, ${MATERIALS} materials, one empty`,
    );
  }
  /* --------------------------------------------- rebuilding a surface from a visibility record */
  {
    /*
     * **The interpolation is the only part of the shading the two pipelines do differently**, so
     * it is the part that can drift and the part that is checked. Generated triangles rather than
     * a fixture, because a fixture with a symmetry in it tests less than it looks like it does:
     * the reference's own test had two vertices at one depth, which makes the perspective
     * correction's denominator constant along x and hides every gradient term that reads it.
     */
    const WIDTH = 64;
    const HEIGHT = 64;
    /*
     * **Fifty, and the dispatch covers sixty-four.** A bin is not a multiple of the group size and
     * the spare lanes have to do nothing; at sixty-four there were no spare lanes and the bound
     * that stops them was a line no perturbation could reach. The fourteen slots past the end are
     * pointed at a covered pixel and asserted to stay zero.
     */
    const TRIANGLES = 50;
    const SLOTS = 64;
    const random = lcg(0xc2b2ae35);

    const vertices = new Float32Array(TRIANGLES * 3 * 4);
    const indices = new Uint32Array(TRIANGLES * 3);
    const clusterMeta = new Uint32Array(TRIANGLES * 4);
    for (let t = 0; t < TRIANGLES; t += 1) {
      for (let corner = 0; corner < 3; corner += 1) {
        const vertex = t * 3 + corner;
        indices[vertex] = vertex;
        const at = vertex * 4;
        /* A clip position whose w is well clear of zero and differs between all three corners,
           so the perspective correction has something to do on every axis. */
        vertices[at] = (random() - 0.5) * 2;
        vertices[at + 1] = (random() - 0.5) * 2;
        vertices[at + 2] = 1 + random() * 8;
        vertices[at + 3] = (random() - 0.5) * 10;
      }
      /* One cluster a triangle, so the record's triangle field is always zero and the index
         offset is what selects. */
      clusterMeta[t * 4] = t * 3;
      clusterMeta[t * 4 + 1] = 3;
      clusterMeta[t * 4 + 2] = t;
      clusterMeta[t * 4 + 3] = 0;
    }

    /* One pixel per triangle, at its screen centroid, so every sample is inside its own triangle. */
    const screen = new Float32Array(3 * SCREEN_VERTEX_FLOATS);
    const binPixels = new Uint32Array(SLOTS);
    const visibility = new Uint32Array(WIDTH * HEIGHT).fill(0xffffffff);
    const wanted = [];
    const taken = new Set();
    let usable = 0;
    for (let t = 0; t < TRIANGLES; t += 1) {
      let ok = true;
      for (let corner = 0; corner < 3; corner += 1) {
        const at = (t * 3 + corner) * 4;
        ok =
          screenVertex(
            vertices[at],
            vertices[at + 1],
            vertices[at + 2],
            WIDTH,
            HEIGHT,
            screen,
            corner * SCREEN_VERTEX_FLOATS,
          ) && ok;
      }
      const cx = (screen[0] + screen[3] + screen[6]) / 3;
      const cy = (screen[1] + screen[4] + screen[7]) / 3;
      const px = Math.min(WIDTH - 1, Math.max(0, Math.floor(cx)));
      const py = Math.min(HEIGHT - 1, Math.max(0, Math.floor(cy)));
      const pixel = py * WIDTH + px;
      /*
       * **One triangle a pixel.** Two centroids landing on the same pixel means the second
       * overwrites the first's record, so the device reconstructs the winner while the reference
       * expects the loser — which reads as the arithmetic disagreeing and is the fixture colliding
       * with itself. Sixty-four triangles over four thousand pixels collide about two times in
       * five, so this is the ordinary case rather than a rare one.
       */
      if (taken.has(pixel)) {
        binPixels[t] = pixel;
        wanted.push(null);
        continue;
      }
      const lambda = new Float32Array(3);
      const corrected = new Float32Array(3);
      const gradients = new Float32Array(6);
      if (
        !ok ||
        !screenBarycentrics(screen, px + 0.5, py + 0.5, lambda) ||
        !perspectiveBarycentrics(screen, lambda, corrected) ||
        !barycentricGradients(screen, lambda, gradients)
      ) {
        binPixels[t] = pixel;
        wanted.push(null);
        continue;
      }
      const a0 = vertices[t * 3 * 4 + 3];
      const a1 = vertices[(t * 3 + 1) * 4 + 3];
      const a2 = vertices[(t * 3 + 2) * 4 + 3];
      const gradient = attributeGradients(a0, a1, a2, gradients);
      visibility[pixel] = packVisibility(t, 0);
      taken.add(pixel);
      binPixels[t] = pixel;
      wanted.push({
        value: interpolate(a0, a1, a2, corrected),
        dx: gradient.dx,
        dy: gradient.dy,
        weights: corrected,
      });
      usable += 1;
    }

    /* The spare slots name a pixel that *is* covered, so a lane running past the bin would write
       something rather than return at the sentinel and prove nothing. */
    const firstCovered = binPixels[wanted.findIndex((entry) => entry !== null)];
    for (let slot = TRIANGLES; slot < SLOTS; slot += 1) binPixels[slot] = firstCovered;

    const out = await gpu.run({
      wgsl: SHADE_RECONSTRUCT_WGSL,
      workgroups: [Math.ceil(SLOTS / 64)],
      buffers: [
        { type: 'u32', values: [0, TRIANGLES, WIDTH, HEIGHT], readOnly: true },
        { type: 'u32', values: Array.from(binPixels), readOnly: true },
        { type: 'u32', values: Array.from(visibility), readOnly: true },
        { type: 'u32', values: Array.from(clusterMeta), readOnly: true },
        { type: 'u32', values: Array.from(indices), readOnly: true },
        { type: 'f32', values: Array.from(vertices), readOnly: true },
        { type: 'f32', length: SLOTS * 6, read: true },
      ],
    });

    /*
     * **Compared relatively.** Both sides are float32 and the quotient rule is a difference of
     * products, so the last bits will not match; a gradient that chooses a different mip level is
     * wrong by percents, not by parts per million.
     */
    const near = (name, index, want, got, scale) => {
      const size = Math.max(Math.abs(want), Math.abs(scale), 1e-4);
      if (Math.abs(want - got) / size < 2e-3) return;
      failures.push(`${name}[${index}]: reference ${want}, device ${got}`);
    };
    for (let t = 0; t < TRIANGLES; t += 1) {
      const expected = wanted[t];
      if (expected === null) continue;
      const at = t * 6;
      near('shadeValue', t, expected.value, out[6][at], 1);
      near('shadeDx', t, expected.dx, out[6][at + 1], expected.dy);
      near('shadeDy', t, expected.dy, out[6][at + 2], expected.dx);
      for (let i = 0; i < 3; i += 1) {
        near(`shadeWeight${i}`, t, expected.weights[i], out[6][at + 3 + i], 1);
      }
    }
    for (let slot = TRIANGLES * 6; slot < SLOTS * 6; slot += 1) {
      check('shadeSpareLane', slot, 0, out[6][slot]);
    }
    if (usable < TRIANGLES / 2) {
      failures.push(`shadeBins: only ${usable} of ${TRIANGLES} triangles were usable`);
    }
    report(`shadeBins      ${usable} of ${TRIANGLES} triangles reconstructed at their centroid`);
  }
  /* ---------------------------------------------------------------- the lit expression */
  {
    /*
     * **The second pipeline's lit expression had no reference at all until 2026-09-16.** The
     * reconstruction has one — `shadeBins.ts`, checked above — and the shading pass's header argued
     * that the interpolation is the only part that can differ between the pipelines, so it is the
     * only part worth checking. That is true of an expression of four lines and stops being true
     * the moment it grows a term. `gpudriven/lit.ts` is the twin and this runs both.
     */
    const COUNT = 512;
    const random = lcg(0x3f0a71c5);
    /*
     * **A room a surface, not a room a corpus.** The irradiance, the radiance and the two
     * selectors are per-pixel quantities in the shading pass, so a check that held them constant
     * would run the image-based term at exactly one configuration and the split sum at none.
     */
    const env = new Float32Array(COUNT * LIT_ENVIRONMENT_FLOATS);
    const rooms = [];

    const surfaces = new Float32Array(COUNT * LIT_SURFACE_FLOATS);
    let shaded = 0;
    let unshaded = 0;
    for (let i = 0; i < COUNT; i += 1) {
      const at = i * LIT_SURFACE_FLOATS;
      for (let c = 0; c < 3; c += 1) surfaces[at + c] = random();
      /*
       * **Shade before the peak branch below, which continues.** A third fully lit, a sixth fully
       * shadowed and the rest partial: the two ends matter because a shadow term applied to the
       * wrong factor still agrees at 1, and a corpus of ones is a corpus that cannot see it.
       */
      const roll = random();
      surfaces[at + 12] = roll < 0.34 ? 1 : roll < 0.5 ? 0 : random();
      if (surfaces[at + 12] < 1) shaded += 1;
      else unshaded += 1;
      /*
       * **A third reflect nothing, a third reflect a gradient and a third a prefiltered room**,
       * because the two weights are different expressions and the selector between them decides
       * which — a corpus that took one branch would be checking half the term.
       */
      const kind = i % 3;
      surfaces[at + 13] = kind === 0 ? 0 : 0.2 + random() * 1.2;
      /*
       * **A quarter are metal and a quarter are part way, because metalness enters four expressions
       * and two of them collapse at both ends.** The diffuse it removes and the side of the blend
       * the highlight lands on are only visible in between; the colour it gives the highlight and
       * the `f0` it raises are only visible at the top.
       */
      const metalRoll = i % 4;
      surfaces[at + 14] =
        metalRoll === 0 ? 0 : metalRoll === 1 ? 1 : metalRoll === 2 ? random() : 0;
      /* A third unoccluded, which is every surface with no ORM map, and the rest anywhere. */
      surfaces[at + 15] = i % 3 === 0 ? 1 : random();
      /*
       * **The emitted colour: a third the albedo, a third black and a third anything.** The albedo
       * is every surface with no emissive map, which must be the glow that shipped; black is a
       * wall between lit windows, which must glow nowhere whatever its emissive; and anything is a
       * lit window. Taken after every draw above, so the rest of the corpus is the one it was.
       */
      const emittedRoll = (i + 1) % 3;
      for (let c = 0; c < 3; c += 1) {
        surfaces[at + 16 + c] =
          emittedRoll === 0 ? surfaces[at + c] : emittedRoll === 1 ? 0 : random();
      }
      const room = {
        ...LIT_ENVIRONMENT,
        irradiance: [random(), random(), random()],
        radiance: [random() * 2, random() * 2, random() * 2],
        /* Half the corpus takes the room's own irradiance and half keeps the gradient. */
        irradianceAmount: i % 2 === 0 ? 0 : random(),
        /*
         * And a third keep the mirror-direction gradient rather than a probe's radiance, which is
         * the default a metal is black without.
         */
        radianceAmount: i % 3 === 0 ? 0 : 1,
        prefiltered: kind === 2 ? 1 : 0,
        /*
         * A fifth of the frames say it is day, where nothing glows, a fifth are the default, and
         * the rest scale the glow anywhere up to twice — flat/main.ts's gain times its clock.
         */
        emission: i % 5 === 0 ? 0 : i % 5 === 1 ? 1 : random() * 2,
      };
      rooms.push(room);
      const block = i * LIT_ENVIRONMENT_FLOATS;
      env.set(room.lightDir, block);
      env.set(room.lightColour, block + 3);
      env.set(room.sky, block + 6);
      env.set(room.ground, block + 9);
      env.set(room.irradiance, block + 12);
      env.set(room.radiance, block + 15);
      env[block + 18] = room.irradianceAmount;
      env[block + 19] = room.radianceAmount;
      env[block + 20] = room.prefiltered;
      env[block + 21] = room.emission;
      /* Normals and eye directions over the whole sphere, so the clamps at zero both occur. */
      const n = normalise(random() - 0.5, random() - 0.5, random() - 0.5);
      const e = normalise(random() - 0.5, random() - 0.5, random() - 0.5);
      surfaces.set(n, at + 3);
      surfaces.set(e, at + 6);
      /*
       * **A fifth of them sit exactly at the lobe's peak**, with the normal *on* the half vector
       * and the roughness low. Without those the corpus never reaches `max(d * d, 1e-8)` — that
       * floor only bites where `d` is `a * a`, which is the peak — so the check passed a shader
       * with it deleted, and the deletion is worth 256 times the highlight at roughness 0.05.
       */
      if (i % 5 === 0) {
        const peak = normalise(
          LIT_ENVIRONMENT.lightDir[0] + e[0],
          LIT_ENVIRONMENT.lightDir[1] + e[1],
          LIT_ENVIRONMENT.lightDir[2] + e[2],
        );
        surfaces.set(peak, at + 3);
        surfaces[at + 9] = 0.02 + random() * 0.12;
        surfaces[at + 10] = 0.5 + random() * 0.5;
        surfaces[at + 11] = 0;
        continue;
      }
      /* Roughness across the range including under 0.1, where the lobe's own floor takes over. */
      surfaces[at + 9] = random();
      surfaces[at + 10] = random() < 0.4 ? 0 : random();
      surfaces[at + 11] = random() < 0.7 ? 0 : random() * 2;
    }

    const params = new Float32Array([COUNT, 0, 0, 0]);
    const out = await gpu.run({
      wgsl: SHADE_LIGHTING_PARITY_WGSL,
      workgroups: [Math.ceil(COUNT / 64)],
      buffers: [
        { type: 'f32', values: params, readOnly: true },
        { type: 'f32', values: env, readOnly: true },
        { type: 'f32', values: surfaces, readOnly: true },
        { type: 'f32', length: COUNT * 3, read: true },
      ],
    });

    const colour = new Float32Array(3);
    let shiny = 0;
    for (let i = 0; i < COUNT; i += 1) {
      const at = i * LIT_SURFACE_FLOATS;
      const surface = {
        albedo: [surfaces[at], surfaces[at + 1], surfaces[at + 2]],
        normal: [surfaces[at + 3], surfaces[at + 4], surfaces[at + 5]],
        toEye: [surfaces[at + 6], surfaces[at + 7], surfaces[at + 8]],
        roughness: surfaces[at + 9],
        specular: surfaces[at + 10],
        emissive: surfaces[at + 11],
        shade: surfaces[at + 12],
        reflectivity: surfaces[at + 13],
        metalness: surfaces[at + 14],
        occlusion: surfaces[at + 15],
        emissiveColour: [surfaces[at + 16], surfaces[at + 17], surfaces[at + 18]],
      };
      if (surface.specular > 0) shiny += 1;
      litColour(surface, rooms[i], colour);
      /*
       * **The peak is stiff, and how stiff is arithmetic rather than a feeling.** At the lobe's
       * centre `d` is `a * a`, so a last-bit difference in `ndh` lands on `d` as
       * `(1 - ndh²) / a²` and on `d * d` as twice that. Float32 rounding puts `1 - ndh²` around
       * 1e-7, and this corpus's smallest `a²` is 1e-6 — so a peak case can differ by a few parts
       * in a thousand with both sides computing the same expression correctly. The device works in
       * float32 and the reference in float64, and no tolerance tight enough to exclude that would
       * be measuring the shader.
       *
       * It is not only a property of the check: the two pipelines drawing one smooth surface
       * disagree by the same fraction at the centre of a highlight, which is smaller than a level
       * of an 8-bit channel and is the reason `IMPROVEMENTS.md` carries the lobe's own entry.
       */
      const tolerance = i % 5 === 0 ? 6e-3 : 2e-3;
      for (let c = 0; c < 3; c += 1) {
        /*
         * **Relatively, for the reason the reconstruction is**: both sides are float32 and the
         * lobe is a quotient of fourth powers, so the last bits will not match. A term that is
         * actually wrong is wrong by percents.
         */
        const want = colour[c];
        const got = out[3][i * 3 + c];
        const size = Math.max(Math.abs(want), 1e-4);
        if (Math.abs(want - got) / size >= tolerance) {
          failures.push(`litColour[${i}].${['r', 'g', 'b'][c]}: reference ${want}, device ${got}`);
        }
      }
    }
    if (shiny === 0 || shiny === COUNT) {
      failures.push(
        `litColour: ${shiny} of ${COUNT} surfaces are shiny, so the cases are not mixed`,
      );
    }
    if (shaded === 0) failures.push('litColour: no surface was shadowed at all');
    if (unshaded === 0) failures.push('litColour: no surface was fully lit');
    const metals = Array.from({ length: COUNT }, (_, i) => surfaces[i * LIT_SURFACE_FLOATS + 14]);
    if (!metals.some((m) => m === 1)) failures.push('litColour: no surface was fully metallic');
    if (!metals.some((m) => m > 0 && m < 1)) {
      failures.push('litColour: no surface was part way to metal, where two terms only show');
    }
    const occluded = Array.from(
      { length: COUNT },
      (_, i) => surfaces[i * LIT_SURFACE_FLOATS + 15],
    ).filter((o) => o < 1).length;
    if (occluded === 0) failures.push('litColour: no surface was occluded');
    /* A glow the clock scales and a shadow dims, which is where both factors show at once. */
    const glowing = rooms.filter(
      (room, i) =>
        surfaces[i * LIT_SURFACE_FLOATS + 11] > 0 &&
        surfaces[i * LIT_SURFACE_FLOATS + 12] < 1 &&
        room.emission !== 0 &&
        room.emission !== 1,
    ).length;
    if (glowing === 0) failures.push('litColour: no glow was both scaled and shadowed');
    /* And a glow whose colour is not the albedo's, which is the only place the map can show. */
    const mapped = rooms.filter((room, i) => {
      const at = i * LIT_SURFACE_FLOATS;
      return (
        surfaces[at + 11] > 0 &&
        room.emission !== 0 &&
        [0, 1, 2].some((c) => surfaces[at + 16 + c] !== surfaces[at + c])
      );
    }).length;
    if (mapped === 0) failures.push('litColour: no glow took a colour other than its albedo');
    const reflecting = rooms.filter((room, i) => surfaces[i * LIT_SURFACE_FLOATS + 13] > 0).length;
    const prefiltered = rooms.filter((room) => room.prefiltered === 1).length;
    if (reflecting === 0 || prefiltered === 0) {
      failures.push('litColour: the environment weight was never exercised on both branches');
    }
    report(
      `litColour     ${COUNT} surfaces, ${shiny} with a highlight, ${shaded} shadowed, ` +
        `${reflecting} reflecting (${prefiltered} of them a prefiltered room), ` +
        `${metals.filter((m) => m > 0).length} metal, ${occluded} occluded, ` +
        `${glowing} glowing in shadow, ${mapped} glowing through a map`,
    );
  }
  /* ---------------------------------------------------------------- the directional shadow */
  {
    /*
     * **A shadow lookup is a stack of guards and every one of them answers "fully lit".** A guard
     * that fires when it should not does nothing a viewer can see except remove a shadow, which
     * reads as the scene never having had one — so the corpus has to land receivers in each band
     * rather than in the middle of the map, and the counts below say it did.
     */
    const COUNT = 1024;
    const SIZE = 64;
    const random = lcg(0x6ba1c07d);

    const settings = new Float32Array(SHADOW_SETTINGS_FLOATS);
    settings[0] = 1; /* strength */
    settings[1] = SIZE;
    settings[2] = 80; /* depth span */
    settings[3] = 25; /* max distance, short enough that the reach fade is reachable */
    settings[4] = 4; /* max slope */
    settings[5] = 12; /* taps */
    settings[8] = 0.2;
    settings[9] = 0.96;
    settings[10] = 0.2;
    const reference = {
      strength: settings[0],
      mapSize: settings[1],
      depthSpan: settings[2],
      maxDistance: settings[3],
      maxSlope: settings[4],
      taps: settings[5],
      lightDir: [settings[8], settings[9], settings[10]],
    };

    /* A map with an occluder over part of it, so taps straddle its edge and the filter is read. */
    const map = new Float32Array(SIZE * SIZE);
    for (let y = 0; y < SIZE; y += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        const inside = x > 12 && x < 44 && y > 8 && y < 52;
        map[y * SIZE + x] = inside ? 0.18 + (x % 5) * 0.01 : 1;
      }
    }
    const depthAt = (u, v) => {
      const x = Math.min(Math.max(Math.floor(u * SIZE), 0), SIZE - 1);
      const y = Math.min(Math.max(Math.floor(v * SIZE), 0), SIZE - 1);
      return map[y * SIZE + x];
    };

    const receivers = new Float32Array(COUNT * SHADOW_RECEIVER_FLOATS);
    const gradients = new Float32Array(COUNT * 6);
    let outside = 0;
    let inBand = 0;
    for (let i = 0; i < COUNT; i += 1) {
      const at = i * SHADOW_RECEIVER_FLOATS;
      /* A tenth land past the map's edge, a tenth in the terminator band, the rest spread. */
      const u = i % 10 === 0 ? -0.2 + random() * 1.4 : random();
      const v = i % 10 === 0 ? -0.2 + random() * 1.4 : random();
      const d = i % 17 === 0 ? 0.9 + random() * 0.3 : random() * 0.95;
      if (u < 0 || u > 1 || v < 0 || v > 1 || d > 1) outside += 1;
      receivers[at] = u * 2 - 1;
      receivers[at + 1] = v * 2 - 1;
      /* WebGPU depth, unremapped — see `shadowFactor`. */
      receivers[at + 2] = d;
      receivers[at + 3] = 1;
      /*
       * The two derivatives of the light-space position, which the shader solves into a plane. A
       * seventh of them are near-degenerate so the ill-conditioned refusal is exercised, and a
       * seventh are steep so the downstream clamp is.
       */
      const degenerate = i % 7 === 0;
      const steep = i % 11 === 0;
      const gat = i * 6;
      gradients[gat] = 0.01 + (random() - 0.5) * 0.004;
      gradients[gat + 1] = (random() - 0.5) * 0.004;
      gradients[gat + 2] = steep ? (random() - 0.5) * 4 : (random() - 0.5) * 0.02;
      gradients[gat + 3] = degenerate ? gradients[gat] * (1 + 1e-7) : (random() - 0.5) * 0.004;
      gradients[gat + 4] = degenerate
        ? gradients[gat + 1] * (1 + 1e-7)
        : 0.01 + (random() - 0.5) * 0.004;
      gradients[gat + 5] = steep ? (random() - 0.5) * 4 : (random() - 0.5) * 0.02;
      const ndl = i % 9 === 0 ? random() * 0.26 : random();
      if (ndl > 0.08 && ndl < 0.2) inBand += 1;
      receivers[at + 6] = ndl;
    }

    const params = new Float32Array([COUNT, 0, 0, 0]);
    const out = await gpu.run({
      wgsl: SHADOW_PARITY_WGSL,
      workgroups: [Math.ceil(COUNT / 64)],
      buffers: [
        { type: 'f32', values: params, readOnly: true },
        { type: 'f32', values: settings, readOnly: true },
        { type: 'f32', values: receivers, readOnly: true },
        { type: 'f32', values: map, readOnly: true },
        { type: 'f32', values: gradients, readOnly: true },
        { type: 'f32', length: COUNT, read: true },
      ],
    });

    let shadowed = 0;
    let refused = 0;
    const gradient = new Float32Array(2);
    for (let i = 0; i < COUNT; i += 1) {
      const at = i * SHADOW_RECEIVER_FLOATS;
      const gat = i * 6;
      receiverPlaneDepthGradient(
        [gradients[gat], gradients[gat + 1], gradients[gat + 2]],
        [gradients[gat + 3], gradients[gat + 4], gradients[gat + 5]],
        gradient,
      );
      if (gradient[0] === 0 && gradient[1] === 0) refused += 1;
      const want = shadowFactor(
        [receivers[at], receivers[at + 1], receivers[at + 2], receivers[at + 3]],
        [gradient[0], gradient[1]],
        receivers[at + 6],
        reference,
        depthAt,
      );
      if (want < 0.999) shadowed += 1;
      const got = out[5][i];
      if (Math.abs(want - got) >= 2e-3) {
        failures.push(`shadowFactor[${i}]: reference ${want}, device ${got}`);
      }
    }
    if (shadowed === 0 || shadowed === COUNT) {
      failures.push(
        `shadowFactor: ${shadowed} of ${COUNT} receivers are shadowed, so nothing varies`,
      );
    }
    if (outside === 0) failures.push('shadowFactor: no receiver landed outside the map');
    if (inBand === 0) failures.push('shadowFactor: no receiver landed in the terminator band');
    if (refused === 0) failures.push('shadowFactor: no receiver plane was ill-conditioned');
    report(
      `shadowFactor  ${COUNT} receivers, ${shadowed} shadowed, ${outside} off the map, ` +
        `${inBand} in the terminator band, ${refused} planes refused`,
    );
  }

  {
    /*
     * **The twelfth: the gradient the shading pass builds for itself.**
     *
     * The eleventh hands the solve two derivative vectors. This is the step before it — three
     * light-space corners and the two barycentric gradients turned into those vectors — and it is
     * the one piece of the shadow that exists because a compute invocation has no neighbours. What
     * lives here is a factor of two and a transposed weight, neither of which draws as anything but
     * a bias that wants tuning.
     */
    const COUNT = 512;
    const random = lcg(0x51ad0e11);
    const cases = new Float32Array(COUNT * RECEIVER_PLANE_FLOATS);
    let degenerates = 0;
    for (let i = 0; i < COUNT; i += 1) {
      const at = i * RECEIVER_PLANE_FLOATS;
      /* Corners spread over the light's clip box, which is where a receiver actually lands. */
      for (let corner = 0; corner < 3; corner += 1) {
        cases[at + corner * 3] = random() * 2 - 1;
        cases[at + corner * 3 + 1] = random() * 2 - 1;
        cases[at + corner * 3 + 2] = random();
      }
      /*
       * Barycentric gradients as `shadeBins.ts` produces them: the three sum to zero, because a
       * weight the triangle gains is one another loses. A corpus that missed that would exercise
       * an input the shading pass cannot produce.
       */
      const degenerate = i % 8 === 0;
      const gx0 = (random() - 0.5) * 0.06;
      const gx1 = (random() - 0.5) * 0.06;
      const gy0 = degenerate ? gx0 * (1 + 1e-7) : (random() - 0.5) * 0.06;
      const gy1 = degenerate ? gx1 * (1 + 1e-7) : (random() - 0.5) * 0.06;
      if (degenerate) degenerates += 1;
      cases[at + 9] = gx0;
      cases[at + 10] = gx1;
      cases[at + 11] = -gx0 - gx1;
      cases[at + 12] = gy0;
      cases[at + 13] = gy1;
      cases[at + 14] = -gy0 - gy1;
    }

    const out = await gpu.run({
      wgsl: RECEIVER_PLANE_PARITY_WGSL,
      workgroups: [Math.ceil(COUNT / 64)],
      buffers: [
        { type: 'f32', values: new Float32Array([COUNT, 0, 0, 0]), readOnly: true },
        { type: 'f32', values: cases, readOnly: true },
        { type: 'f32', length: COUNT * 2, read: true },
      ],
    });

    const plane = new Float32Array(2);
    let refused = 0;
    let sloped = 0;
    for (let i = 0; i < COUNT; i += 1) {
      const at = i * RECEIVER_PLANE_FLOATS;
      const corner = (n) => [cases[at + n * 3], cases[at + n * 3 + 1], cases[at + n * 3 + 2]];
      receiverPlaneFromWeights(
        corner(0),
        corner(1),
        corner(2),
        [cases[at + 9], cases[at + 10], cases[at + 11]],
        [cases[at + 12], cases[at + 13], cases[at + 14]],
        plane,
      );
      if (plane[0] === 0 && plane[1] === 0) refused += 1;
      else sloped += 1;
      for (let axis = 0; axis < 2; axis += 1) {
        const want = plane[axis];
        const got = out[2][i * 2 + axis];
        /* Relative, because a well-conditioned plane still carries tens of units of slope. */
        if (Math.abs(want - got) >= 1e-3 * Math.max(1, Math.abs(want))) {
          failures.push(`receiverPlaneFromWeights[${i}].${axis}: reference ${want}, device ${got}`);
        }
      }
    }
    if (refused === 0) failures.push('receiverPlaneFromWeights: no case was ill-conditioned');
    if (sloped === 0) failures.push('receiverPlaneFromWeights: every case was refused');
    report(
      `receiverPlane ${COUNT} cases, ${sloped} solved, ${refused} refused ` +
        `(${degenerates} built degenerate)`,
    );
  }

  {
    /*
     * **The surface frame: the mip level and the tangent frame a textured pixel is read with.** A
     * sixth of the cases have no UVs, where the frame must vanish rather than divide, a sixth have a
     * UV triangle collapsed to a line, where the determinant is zero and the fold picks a side, and
     * a sixth are magnified, where the level must stop at zero.
     */
    const COUNT = 512;
    const random = lcg(0x2f6e2b1d);
    const cases = [];
    for (let i = 0; i < COUNT; i += 1) {
      const n = normalise(random() - 0.5, random() - 0.5, random() - 0.5);
      const dp1 = [random() - 0.5, random() - 0.5, random() - 0.5];
      const dp2 = [random() - 0.5, random() - 0.5, random() - 0.5];
      const scale = i % 6 === 1 ? 1e-4 : 0.05;
      let duv1 = [(random() - 0.5) * scale, (random() - 0.5) * scale];
      let duv2 = [(random() - 0.5) * scale, (random() - 0.5) * scale];
      /* A mesh with no UVs, which must give no frame at all. */
      if (i % 6 === 0)
        [duv1, duv2] = [
          [0, 0],
          [0, 0],
        ];
      /* A UV triangle collapsed to a line: zero determinant, a rank-one frame, and the fold's edge. */
      if (i % 6 === 2) duv2 = [duv1[0] * 2, duv1[1] * 2];
      cases.push(...n, ...dp1, ...dp2, ...duv1, ...duv2, 256);
    }
    const out = await gpu.run({
      wgsl: SURFACE_FRAME_PARITY_WGSL,
      workgroups: [Math.ceil(COUNT / 64)],
      buffers: [
        { type: 'f32', values: [COUNT], readOnly: true },
        { type: 'f32', values: cases, readOnly: true },
        { type: 'f32', length: COUNT * 7, read: true },
      ],
    });
    const frame = new Float32Array(6);
    let flat = 0;
    let degenerate = 0;
    for (let i = 0; i < COUNT; i += 1) {
      const c = cases
        .slice(i * SURFACE_FRAME_CASE_FLOATS, (i + 1) * SURFACE_FRAME_CASE_FLOATS)
        .map(Math.fround);
      const lod = surfaceLod(c[9], c[10], c[11], c[12], c[13]);
      derivedTangentFrame(
        [c[0], c[1], c[2]],
        [c[3], c[4], c[5]],
        [c[6], c[7], c[8]],
        [c[9], c[10]],
        [c[11], c[12]],
        frame,
      );
      if (lod === 0) flat += 1;
      if (frame.every((x) => Math.abs(x) < 1e-6)) degenerate += 1;
      const want = [lod, ...frame];
      for (let k = 0; k < 7; k += 1) {
        const got = out[2][i * 7 + k];
        if (!(Math.abs(want[k] - got) <= 1e-4 * Math.max(1, Math.abs(want[k])))) {
          failures.push(`surfaceFrame[${i}].${k}: reference ${want[k]}, device ${got}`);
        }
      }
    }
    if (flat === 0) failures.push('surfaceFrame: no case was magnified');
    if (degenerate === 0) failures.push('surfaceFrame: no UV triangle was degenerate');
    report(`surfaceFrame  ${COUNT} cases, ${flat} at level 0, ${degenerate} with no frame`);
  }

  {
    /*
     * **The thirteenth: where a direction lands in a probe, and which levels a roughness reads.**
     *
     * The octahedral mapping is now written three times — GLSL for the forward path, TypeScript in
     * `shaders/octahedral.ts`, and WGSL for this one — and three copies of one mapping stay honest
     * only if something runs them against each other. What a wrong one produces is not a broken
     * picture: it is a reflection of the wrong part of the room, which looks like a room.
     *
     * The chain is synthetic and its levels are constants, so what comes back names the level it
     * was read from: 3.25 is level 3 and level 4 mixed a quarter of the way, and no filter can
     * produce that by accident.
     */
    const COUNT = 512;
    const random = lcg(0x2d9a37f1);
    const MAX_LOD = ENVIRONMENT_CHECK_LEVELS - 1;
    const levels = new Float32Array(ENVIRONMENT_CHECK_LEVELS);
    for (let level = 0; level < ENVIRONMENT_CHECK_LEVELS; level += 1) levels[level] = level + 1;

    const cases = new Float32Array(COUNT * ENVIRONMENT_CASE_FLOATS);
    let seams = 0;
    let past = 0;
    for (let i = 0; i < COUNT; i += 1) {
      const at = i * ENVIRONMENT_CASE_FLOATS;
      /*
       * **A twelfth of them on the octahedral seam**, where `n.z` changes sign and the mapping
       * folds. That fold is the half of `octEncode` a uniform sphere of directions reaches
       * rarely and the half a transcription gets wrong.
       */
      const seam = i % 12 === 0;
      const direction = seam
        ? normalise(random() * 2 - 1, random() * 2 - 1, (random() - 0.5) * 1e-3)
        : normalise(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1);
      if (seam) seams += 1;
      cases[at] = direction[0];
      cases[at + 1] = direction[1];
      cases[at + 2] = direction[2];
      cases[at + 3] = ENVIRONMENT_CHECK_EDGE;
      /* Across the chain and past both ends, because the clamp is what stops a read off it. */
      const lod = i % 7 === 0 ? -1 + random() * 0.5 : random() * (MAX_LOD + 1.5);
      if (lod < 0 || lod > MAX_LOD) past += 1;
      cases[at + 4] = lod;
      cases[at + 5] = MAX_LOD;
    }

    const out = await gpu.run({
      wgsl: ENVIRONMENT_PARITY_WGSL,
      workgroups: [Math.ceil(COUNT / 64)],
      buffers: [
        { type: 'f32', values: new Float32Array([COUNT, 0, 0, 0]), readOnly: true },
        { type: 'f32', values: cases, readOnly: true },
        { type: 'f32', values: levels, readOnly: true },
        { type: 'f32', length: COUNT * 4, read: true },
      ],
    });

    const uv = new Float32Array(2);
    const mix = new Float32Array(3);
    for (let i = 0; i < COUNT; i += 1) {
      const at = i * ENVIRONMENT_CASE_FLOATS;
      const dir = [cases[at], cases[at + 1], cases[at + 2]];
      octInsetUv(dir[0], dir[1], dir[2], ENVIRONMENT_CHECK_EDGE, uv);
      const got = out[3];
      if (Math.abs(uv[0] - got[i * 4]) > 2e-5 || Math.abs(uv[1] - got[i * 4 + 1]) > 2e-5) {
        failures.push(
          `octInsetUv[${i}]: reference ${uv[0]},${uv[1]}, device ${got[i * 4]},${got[i * 4 + 1]}`,
        );
      }

      probeLevelMix(cases[at + 4], MAX_LOD, mix);
      const lo = levels[mix[0]];
      const hi = levels[mix[1]];
      const want = lo + (hi - lo) * mix[2];
      if (Math.abs(want - got[i * 4 + 2]) > 1e-4) {
        failures.push(`probeRadiance[${i}]: reference level ${want}, device ${got[i * 4 + 2]}`);
      }

      /* And the finer level's coordinate carries that level's own inset, not the map's. */
      octInsetUv(dir[0], dir[1], dir[2], probeLevelEdge(ENVIRONMENT_CHECK_EDGE, mix[0]), uv);
      if (Math.abs(uv[0] - got[i * 4 + 3]) > 2e-5) {
        failures.push(`probeLevelEdge[${i}]: reference ${uv[0]}, device ${got[i * 4 + 3]}`);
      }
    }
    if (seams === 0) failures.push('environment: no direction landed on the octahedral seam');
    if (past === 0) failures.push('environment: no lod fell outside the chain');
    report(`environment   ${COUNT} directions, ${seams} on the seam, ${past} lods off the chain`);
  }

  {
    /*
     * **The decode interpreter, on a real texture array and real samplers.**
     *
     * Generated programs over all nine operations and all four address modes, generated latents
     * with full chains, networks up to the hidden limit, constants — and two kinds of coordinate.
     * A lattice case may land anywhere, because the device filters those by hand and the
     * arithmetic is exact. A **centre** case goes through the hardware's own filter, whose
     * sub-texel and mip-blend precision is the implementation's business down to four bits, so its
     * coordinates sit on a sixteenth-of-a-texel grid at both levels it reads and its level
     * fractions are sixteenths too. Off that grid a correct sampler disagrees with a correct
     * reference by a sixteenth of a texel's difference, which no tolerance could tell from a bug.
     */
    const SIZE = 16;
    const LEVELS = 5;
    const PROGRAMS = 64;
    const CASES_PER = 12;
    const random = lcg(0x6d2b79f5);
    const int = (n) => Math.floor(random() * n);

    /* A latent: random bytes at level 0, and the chain built by buildMips' own 2x2 rounding rule. */
    const makeLatent = () => {
      const components = 1 + int(4);
      const levels = [Uint8Array.from({ length: SIZE * SIZE * components }, () => int(256))];
      for (let edge = SIZE >> 1; edge >= 1; edge >>= 1) {
        const from = levels[levels.length - 1];
        const wide = edge * 2;
        const next = new Uint8Array(edge * edge * components);
        for (let y = 0; y < edge; y += 1) {
          for (let x = 0; x < edge; x += 1) {
            for (let k = 0; k < components; k += 1) {
              let sum = 0;
              for (let dy = 0; dy < 2; dy += 1) {
                for (let dx = 0; dx < 2; dx += 1) {
                  sum += from[((y * 2 + dy) * wide + (x * 2 + dx)) * components + k];
                }
              }
              next[(y * edge + x) * components + k] = Math.round(sum / 4);
            }
          }
        }
        levels.push(next);
      }
      return { width: SIZE, height: SIZE, components, levels };
    };

    const makeNetwork = () => {
      const inputs = 1 + int(4);
      const outputs = 1 + int(4);
      const depth = int(3);
      const hidden = Array.from({ length: depth }, () => 1 + int(random() < 0.3 ? 16 : 8));
      let count = 0;
      let previous = inputs;
      for (const width of hidden) {
        count += previous * width + width;
        previous = width;
      }
      count += previous * outputs + outputs;
      return {
        shape: { inputs, hidden, outputs },
        weights: Float32Array.from({ length: count }, () => random() - 0.5),
      };
    };

    /* A valid graph: every register a node reads was written by an earlier node. */
    const makeGraph = (latents, blocks, networks, constants) => {
      for (;;) {
        const nodes = [];
        const written = [];
        const length = 2 + int(7);
        for (let i = 0; i < length; i += 1) {
          const options = [DECODE_OP.PROCEDURAL_FBM, DECODE_OP.FLIPBOOK_INDEX];
          if (latents > 0) options.push(DECODE_OP.SAMPLE_LATENT, DECODE_OP.SAMPLE_LATENT);
          if (blocks > 0) options.push(DECODE_OP.SAMPLE_BLOCK);
          if (constants > 0) options.push(DECODE_OP.CONSTANT);
          if (written.length > 0) {
            options.push(DECODE_OP.LATENT_LERP, DECODE_OP.REMAP_CHANNEL, DECODE_OP.COMPOSITE);
            if (networks > 0) options.push(DECODE_OP.EVAL_NETWORK, DECODE_OP.EVAL_NETWORK);
          }
          const op = options[int(options.length)];
          const pick = () => written[int(written.length)];
          const dst = int(16);
          let a = 0;
          let b = 0;
          if (op === DECODE_OP.SAMPLE_LATENT) a = int(latents);
          else if (op === DECODE_OP.SAMPLE_BLOCK) a = int(blocks);
          else if (op === DECODE_OP.PROCEDURAL_FBM) [a, b] = [int(65536), 1 + int(6)];
          else if (op === DECODE_OP.FLIPBOOK_INDEX) [a, b] = [1 + int(12), 1 + int(30)];
          else if (op === DECODE_OP.CONSTANT) a = int(constants);
          else if (op === DECODE_OP.EVAL_NETWORK) [a, b] = [pick(), int(networks)];
          else if (op === DECODE_OP.REMAP_CHANNEL) [a, b] = [pick(), (int(12) << 4) | int(5)];
          else [a, b] = [pick(), pick()];
          nodes.push(op, a, b, dst);
          written.push(dst);
        }
        const graph = {
          nodes: Uint32Array.from(nodes),
          count: length,
          result: written[written.length - 1],
          addressMode: int(4),
        };
        if (validateDecodeGraph(graph) === null) return graph;
      }
    };

    const programs = [];
    for (let p = 0; p < PROGRAMS; p += 1) {
      const latents = Array.from({ length: int(3) }, makeLatent);
      const blocks = Array.from({ length: int(2) }, makeLatent);
      const networks = Array.from({ length: int(3) }, makeNetwork);
      const constants = Float32Array.from({ length: int(3) * 4 }, () => random() * 2 - 1);
      /* A fifth are the bake's own shape: one latent through one linear network. */
      if (p % 5 === 0) {
        const latent = makeLatent();
        const inputs = latent.components;
        const outputs = 1 + int(4);
        programs.push({
          graph: {
            nodes: Uint32Array.from([
              DECODE_OP.SAMPLE_LATENT,
              0,
              0,
              0,
              DECODE_OP.EVAL_NETWORK,
              0,
              0,
              1,
            ]),
            count: 2,
            result: 1,
            addressMode: p % 10 === 0 ? ADDRESS_MODE.CENTRE_WRAP : ADDRESS_MODE.CENTRE_CLAMP,
          },
          latents: [latent],
          networks: [
            {
              shape: { inputs, hidden: [], outputs },
              weights: Float32Array.from(
                { length: inputs * outputs + outputs },
                () => random() * 2 - 1,
              ),
            },
          ],
          linear: true,
        });
        continue;
      }
      programs.push({
        graph: makeGraph(latents.length, blocks.length, networks.length, constants.length / 4),
        latents,
        blocks,
        networks,
        constants,
      });
    }
    const tables = packDecodeTables(programs);

    /* A coordinate on a sixteenth-texel grid at level `grid`, and so at every finer level too. */
    const onGrid = (grid) => {
      const edge = Math.max(1, SIZE >> grid);
      return (int(edge) + 0.5 + int(16) / 16) / edge;
    };
    const cases = [];
    for (let p = 0; p < PROGRAMS; p += 1) {
      const mode = programs[p].graph.addressMode;
      for (let k = 0; k < CASES_PER; k += 1) {
        const t = int(512) / 64;
        let u;
        let v;
        let lod;
        if (mode >= 2) {
          const level = int(LEVELS);
          const fraction = level < LEVELS - 1 && k % 2 === 1 ? (1 + int(15)) / 16 : 0;
          lod = level + fraction;
          const grid = fraction > 0 ? level + 1 : level;
          u = onGrid(grid);
          v = onGrid(grid);
          /* Outside the square: whole tiles for wrap, and well past the edge for clamp. */
          if (mode === 3 && k % 3 === 0) u += int(5) - 2;
          if (mode === 2 && k % 4 === 0) u = k % 8 === 0 ? -0.75 : 1.5;
        } else {
          lod = k % 3 === 0 ? -1 : random() * (LEVELS - 1);
          u = random() * 3 - 1;
          v = random() * 3 - 1;
        }
        cases.push(p, u, v, lod, t);
      }
    }
    const count = cases.length / DECODE_CASE_FLOATS;

    const out = await gpu.run({
      wgsl: DECODE_PARITY_WGSL,
      workgroups: [Math.ceil(count / 64)],
      buffers: [
        { type: 'f32', values: [count, SIZE], readOnly: true },
        { type: 'f32', values: cases, readOnly: true },
        { kind: 'uniform', type: 'u32', values: tables.nodes },
        { kind: 'uniform', type: 'f32', values: tables.weights },
        { kind: 'texture2dArray', size: SIZE, layers: tables.layerCount, levels: tables.levels },
        { kind: 'sampler', address: 'clamp-to-edge' },
        { kind: 'sampler', address: 'repeat' },
        { type: 'f32', length: count * 4, read: true },
      ],
    });

    const imageOf = (latent) => ({
      data: Float32Array.from(latent.levels[0], (value) => value / 255),
      width: latent.width,
      height: latent.height,
      channels: latent.components,
      mips: latent.levels.slice(1).map((level, k) => ({
        data: Float32Array.from(level, (value) => value / 255),
        width: SIZE >> (k + 1),
        height: SIZE >> (k + 1),
      })),
    });
    const resourcesOf = (program) => ({
      latents: program.latents.map(imageOf),
      blocks: (program.blocks ?? []).map(imageOf),
      networks: program.networks,
      constants: program.constants,
    });

    const want = new Float32Array(4);
    const texel = new Float32Array(4);
    let worst = 0;
    let anchored = 0;
    let multiples = 0;
    const seen = new Set();
    for (let c = 0; c < count; c += 1) {
      /* Rounded to single precision first: the device is handed float32, and so is the reference. */
      const [p, u, v, lod, t] = cases
        .slice(c * DECODE_CASE_FLOATS, (c + 1) * DECODE_CASE_FLOATS)
        .map(Math.fround);
      const program = programs[p];
      const resources = resourcesOf(program);
      decodeCpu(program.graph, resources, u, v, t, want, createDecodeRegisters(), lod);
      for (let i = 0; i < program.graph.count; i += 1) {
        const op = program.graph.nodes[i * 4];
        seen.add(op);
        /*
         * A frame index that is an exact multiple of the frame count is where a float modulo
         * failed on this machine — 144 / 12 came back 11.999999 — so the corpus has to hold some.
         */
        const frames = program.graph.nodes[i * 4 + 1];
        const raw = Math.floor(t * program.graph.nodes[i * 4 + 2]);
        if (op === DECODE_OP.FLIPBOOK_INDEX && frames > 1 && raw > 0 && raw % frames === 0) {
          multiples += 1;
        }
      }
      /*
       * **Relative above one and absolute below it**, at two parts in ten thousand. The latent is
       * eight bits, the device works in float32 and the reference in float64, and a network at the
       * hidden limit multiplies a last-bit difference by its gain. A wrong operation is wrong by
       * tenths. Measured on 2026-09-17, the worst of 768 cases was 3.6e-7, centre and lattice
       * alike, so the tolerance has three orders of magnitude of room and is not hiding anything.
       */
      for (let k = 0; k < 4; k += 1) {
        const got = out[7][c * 4 + k];
        const error = Math.abs(want[k] - got) / Math.max(1, Math.abs(want[k]));
        worst = Math.max(worst, error);
        if (!(error <= 2e-4)) {
          failures.push(
            `decode[${c}] program ${p} mode ${program.graph.addressMode} lane ${k}: reference ${want[k]}, device ${got}`,
          );
        }
      }

      /*
       * **The anchor outside the expression.** For a linear network, filtering the latent and then
       * decoding is decoding each texel and then filtering. So the device's answer — the
       * hardware's own filter, then the network — must equal a bilinear mix, done here by hand,
       * of the reference's decode **at the four surrounding texel centres**, where no
       * interpolation of the reference's is exercised at all. A sampler off by half a texel fails
       * this whether or not the reference shares the mistake.
       */
      if (program.linear && Number.isInteger(lod)) {
        const edge = SIZE >> lod;
        const wrap = program.graph.addressMode === 3;
        const index = (value) =>
          wrap ? ((value % edge) + edge) % edge : Math.min(edge - 1, Math.max(0, value));
        const sx = u * edge - 0.5;
        const sy = v * edge - 0.5;
        const bx = Math.floor(sx);
        const by = Math.floor(sy);
        const fx = sx - bx;
        const fy = sy - by;
        const decodeTexel = (x, y) => {
          decodeCpu(
            program.graph,
            resources,
            (index(x) + 0.5) / edge,
            (index(y) + 0.5) / edge,
            t,
            texel,
            createDecodeRegisters(),
            lod,
          );
          return Float32Array.from(texel);
        };
        const t00 = decodeTexel(bx, by);
        const t10 = decodeTexel(bx + 1, by);
        const t01 = decodeTexel(bx, by + 1);
        const t11 = decodeTexel(bx + 1, by + 1);
        for (let k = 0; k < 4; k += 1) {
          const mixed =
            (t00[k] * (1 - fx) + t10[k] * fx) * (1 - fy) + (t01[k] * (1 - fx) + t11[k] * fx) * fy;
          const got = out[7][c * 4 + k];
          if (!(Math.abs(mixed - got) / Math.max(1, Math.abs(mixed)) <= 2e-4)) {
            failures.push(
              `decode anchor[${c}] lane ${k}: filtered-then-decoded ${mixed}, device ${got}`,
            );
          }
        }
        anchored += 1;
      }
    }
    for (const op of Object.values(DECODE_OP)) {
      if (!seen.has(op)) failures.push(`decode: opcode ${op} never appeared in the corpus`);
    }
    if (anchored < 20) failures.push(`decode: only ${anchored} cases were anchored`);
    if (multiples === 0) failures.push('decode: no flipbook frame landed on a whole cycle');
    report(
      `decode        ${count} cases over ${PROGRAMS} programs and ${tables.layerCount} layers, ` +
        `${anchored} anchored, ${multiples} flipbook frames on a whole cycle, ` +
        `worst ${worst.toExponential(1)}`,
    );
  }

  /* ---------------------------------------------------------------- the network evaluator */
  {
    /*
     * **One evaluator, two precisions.** Single precision is held to `evalNetwork` almost exactly
     * — the order of operations is the reference's, and what is left is a device contracting a
     * multiply and an add. Half precision is held to `evalNetwork` within each network's own
     * `halfPrecisionErrorBound`, and **to `evalNetworkHalf` exactly, in one of its two forms**:
     * every operation rounded, or each multiply-add contracted into one rounding. WGSL lets a
     * driver contract, and this project's development machine does — every network there matched
     * the contracted form and none matched neither, which is the whole of its half-precision
     * arithmetic accounted for.
     *
     * **The anchors are outside both**: an identity, a hand-computed network that answers six, an
     * output that must stay negative and a hidden layer that must clamp — small integers, exact in
     * either precision, so any disagreement there is a defect rather than rounding.
     *
     * A network whose `activationBound` passes 30,000 is left out of the half-precision corpus, as a
     * consumer would leave it out of half precision; the count is printed.
     */
    const W = NETWORK_PARITY_WIDTH;
    const random = lcg(0x6e6e6574);
    const int = (n) => Math.floor(random() * n);

    const build = (half) => {
      const nets = [
        {
          inputs: 2,
          hidden: [],
          outputs: 2,
          weights: [1, 0, 0, 1, 0, 0],
          input: [0.25, -3],
          want: [0.25, -3],
        },
        {
          inputs: 1,
          hidden: [2],
          outputs: 1,
          weights: [2, -1, 0, 1, 1, 1, 0],
          input: [3],
          want: [6],
        },
        { inputs: 1, hidden: [1], outputs: 1, weights: [1, 0, -1, 0], input: [2], want: [-2] },
        { inputs: 1, hidden: [1], outputs: 1, weights: [1, 0, 1, 0], input: [-5], want: [0] },
      ];
      let overflowing = 0;
      while (nets.length < 256) {
        const layers = int(NETWORK_PARITY_HIDDEN + 1);
        const hidden = Array.from({ length: layers }, () => 1 + int(W));
        const inputs = 1 + int(W);
        const outputs = 1 + int(W);
        const shape = { inputs, hidden, outputs };
        const count = networkWeightCount(shape);
        const weights = Array.from({ length: count }, () => random() * 2 - 1);
        const input = Array.from({ length: inputs }, () => random());
        const box = Float32Array.from(input);
        if (half && activationBound(shape, Float32Array.from(weights), box, box) > 30000) {
          overflowing += 1;
          continue;
        }
        nets.push({ inputs, hidden, outputs, weights, input, want: null });
      }
      const cases = [];
      const weights = [];
      const inputs = new Float32Array(nets.length * W);
      for (const [c, net] of nets.entries()) {
        const widths = [...net.hidden, 0, 0, 0, 0].slice(0, NETWORK_PARITY_HIDDEN);
        cases.push(weights.length, net.inputs, net.hidden.length, net.outputs, ...widths);
        weights.push(...net.weights);
        inputs.set(net.input, c * W);
      }
      return { nets, cases, weights: Float32Array.from(weights), inputs, overflowing };
    };

    const run = async (half) => {
      const corpus = build(half);
      const out = await gpu.run({
        wgsl: networkParityWgsl(half ? 'f16' : 'f32'),
        features: half ? ['shader-f16'] : [],
        workgroups: [Math.ceil(corpus.nets.length / 64)],
        buffers: [
          { type: 'u32', values: corpus.cases, readOnly: true },
          half
            ? { type: 'f16', values: halfWeights(corpus.weights), readOnly: true }
            : { values: corpus.weights, readOnly: true },
          { values: corpus.inputs, readOnly: true },
          { length: corpus.nets.length * W, read: true },
        ],
      });
      return { corpus, got: out[3] };
    };

    for (const half of [false, true]) {
      const { corpus, got } = await run(half);
      const label = half ? 'network f16' : 'network f32';
      let worst = 0;
      let worstHalf = 0;
      let tightest = 0;
      /* Per network: which of the two half-precision forms the device matched, exactly. */
      const matched = { plain: 0, contracted: 0, both: 0, neither: 0 };
      let compared = 0;
      const single = new Float32Array(W);
      const plain = new Float32Array(W);
      const contracted = new Float32Array(W);
      for (const [c, net] of corpus.nets.entries()) {
        const shape = { inputs: net.inputs, hidden: net.hidden, outputs: net.outputs };
        const first = corpus.cases[c * NETWORK_CASE_WORDS];
        const weights = corpus.weights.subarray(first, first + networkWeightCount(shape));
        const input = Float32Array.from(net.input);
        evalNetwork(shape, weights, input, single, new Float32Array(2 * W));
        if (half) {
          const bits = halfWeights(weights);
          evalNetworkHalf(shape, bits, input, plain, new Float64Array(2 * W));
          evalNetworkHalf(shape, bits, input, contracted, new Float64Array(2 * W), true);
        }
        const allowed = half ? halfPrecisionErrorBound(shape, weights, input) : 0;
        let asPlain = true;
        let asContracted = true;
        for (let o = 0; o < net.outputs; o += 1) {
          const device = got[c * W + o];
          if (net.want !== null && device !== net.want[o]) {
            failures.push(
              `${label} anchor[${c}] output ${o}: want ${net.want[o]}, device ${device}`,
            );
          }
          const error = Math.abs(device - single[o]);
          worst = Math.max(worst, error / Math.max(1, Math.abs(single[o])));
          if (half) tightest = Math.max(tightest, error / allowed);
          const inside = half ? error <= allowed : error / Math.max(1, Math.abs(single[o])) <= 1e-5;
          if (!inside) {
            failures.push(`${label}[${c}] output ${o}: reference ${single[o]}, device ${device}`);
          }
          if (device !== plain[o]) asPlain = false;
          if (device !== contracted[o]) asContracted = false;
          compared += 1;
        }
        if (half) {
          if (asPlain && asContracted) matched.both += 1;
          else if (asPlain) matched.plain += 1;
          else if (asContracted) matched.contracted += 1;
          else {
            matched.neither += 1;
            failures.push(`${label}[${c}]: the device matched neither half-precision form`);
          }
        }
      }
      report(
        `${label.padEnd(13)} ${corpus.nets.length} networks, ${compared} outputs, 4 anchored, ` +
          `worst ${worst.toExponential(1)} against single precision` +
          (half
            ? `, at most ${(tightest * 100).toFixed(0)}% of its own bound; exactly the rounded ` +
              `reference ${matched.plain}, its contracted form ${matched.contracted}, both ` +
              `${matched.both}, neither ${matched.neither}; ${corpus.overflowing} left out as ` +
              'overflowing'
            : ''),
      );
    }
  }

  /* ------------------------------------------------------ the network evaluator, shape fixed */
  {
    /*
     * **The fixed form, held to the same references the same way.** It is the variable form's
     * arithmetic with every count a constant, which is what makes it an order of magnitude faster
     * and what a compiler is freest to reorder — so single precision is held to `evalNetwork`
     * within 1e-5, and half precision to `evalNetworkHalf` exactly, rounded or contracted, and to
     * `evalNetwork` within each network's own bound. The four anchors are the variable form's, and
     * the rest are the refinement tier's candidate shapes and random ones, each over many inputs.
     */
    const random = lcg(0x66697864);
    const shapes = [
      {
        inputs: 2,
        hidden: [],
        outputs: 2,
        weights: [1, 0, 0, 1, 0, 0],
        anchor: [
          [0.25, -3],
          [0.25, -3],
        ],
      },
      { inputs: 1, hidden: [2], outputs: 1, weights: [2, -1, 0, 1, 1, 1, 0], anchor: [[3], [6]] },
      { inputs: 1, hidden: [1], outputs: 1, weights: [1, 0, -1, 0], anchor: [[2], [-2]] },
      { inputs: 1, hidden: [1], outputs: 1, weights: [1, 0, 1, 0], anchor: [[-5], [0]] },
    ];
    const randomShapes = [
      [11, [8]],
      [11, [16]],
      [11, [8, 8]],
      [11, [16, 16]],
      [11, [32]],
      [27, [16]],
      [3, [4, 4, 4, 4]],
      [16, []],
    ];
    for (const [inputs, hidden] of randomShapes) {
      const shape = { inputs, hidden, outputs: 3 };
      const weights = Array.from({ length: networkWeightCount(shape) }, () => random() * 2 - 1);
      shapes.push({ ...shape, weights, anchor: null });
    }
    const PER_SHAPE = 128;
    for (const half of [false, true]) {
      const label = half ? 'fixed f16' : 'fixed f32';
      let worst = 0;
      let compared = 0;
      let leftOut = 0;
      const matched = { plain: 0, contracted: 0, both: 0, neither: 0 };
      for (const net of shapes) {
        const shape = { inputs: net.inputs, hidden: net.hidden, outputs: net.outputs };
        const weights = Float32Array.from(net.weights);
        const inputs = [];
        if (net.anchor !== null) inputs.push(net.anchor[0]);
        while (inputs.length < (net.anchor === null ? PER_SHAPE : 1)) {
          const input = Array.from({ length: net.inputs }, () => random());
          const box = Float32Array.from(input);
          if (half && activationBound(shape, weights, box, box) > 30000) {
            leftOut += 1;
            continue;
          }
          inputs.push(input);
        }
        const out = await gpu.run({
          wgsl: networkFixedParityWgsl(half ? 'f16' : 'f32', shape),
          features: half ? ['shader-f16'] : [],
          workgroups: [Math.ceil(inputs.length / 64)],
          buffers: [
            half
              ? { type: 'f16', values: halfWeights(weights), readOnly: true }
              : { values: weights, readOnly: true },
            { values: Float32Array.from(inputs.flat()), readOnly: true },
            { length: inputs.length * net.outputs, read: true },
          ],
        });
        const got = out[2];
        const widest = Math.max(net.inputs, net.outputs, ...net.hidden, 1);
        const single = new Float32Array(net.outputs);
        const plain = new Float32Array(net.outputs);
        const contracted = new Float32Array(net.outputs);
        for (const [k, values] of inputs.entries()) {
          const input = Float32Array.from(values);
          evalNetwork(shape, weights, input, single, new Float32Array(2 * widest));
          if (half) {
            const bits = halfWeights(weights);
            evalNetworkHalf(shape, bits, input, plain, new Float64Array(2 * widest));
            evalNetworkHalf(shape, bits, input, contracted, new Float64Array(2 * widest), true);
          }
          const allowed = half ? halfPrecisionErrorBound(shape, weights, input) : 0;
          let asPlain = true;
          let asContracted = true;
          for (let o = 0; o < net.outputs; o += 1) {
            const device = got[k * net.outputs + o];
            if (net.anchor !== null && device !== net.anchor[1][o]) {
              failures.push(
                `${label} anchor output ${o}: want ${net.anchor[1][o]}, device ${device}`,
              );
            }
            const error = Math.abs(device - single[o]);
            const relative = error / Math.max(1, Math.abs(single[o]));
            worst = Math.max(worst, relative);
            const inside = half ? error <= allowed : relative <= 1e-5;
            if (!inside) {
              failures.push(
                `${label} ${[net.inputs, ...net.hidden, net.outputs].join('-')} input ${k} output ` +
                  `${o}: reference ${single[o]}, device ${device}`,
              );
            }
            if (device !== plain[o]) asPlain = false;
            if (device !== contracted[o]) asContracted = false;
            compared += 1;
          }
          if (half) {
            if (asPlain && asContracted) matched.both += 1;
            else if (asPlain) matched.plain += 1;
            else if (asContracted) matched.contracted += 1;
            else {
              matched.neither += 1;
              failures.push(`${label} input ${k}: the device matched neither half-precision form`);
            }
          }
        }
      }
      report(
        `${label.padEnd(13)} ${shapes.length} shapes, ${compared} outputs, 4 anchored, worst ` +
          `${worst.toExponential(1)} against single precision` +
          (half
            ? `; exactly the rounded reference ${matched.plain}, its contracted form ` +
              `${matched.contracted}, both ${matched.both}, neither ${matched.neither}; ` +
              `${leftOut} inputs left out as overflowing`
            : ''),
      );
    }
  }

  /* ---------------------------------------------------------------- splats, tiled */
  {
    /*
     * **The fit's rasteriser, on the device.** A cloud is projected on the host — that arithmetic
     * is per splat rather than per pixel and stays where it can be differentiated by hand — and
     * everything per pixel is compared: the frame the device draws, the light it leaves behind, and
     * the gradients its backward pass reduces out of a tile.
     */
    const COUNT = 220;
    const WIDTH = 96;
    const HEIGHT = 64;
    const random = lcg(0x5a7c1f03);
    const set = {
      count: COUNT,
      positions: new Float64Array(COUNT * 3),
      scales: new Float64Array(COUNT * 3),
      rotations: new Float64Array(COUNT * 4),
      colors: new Float64Array(COUNT * 3),
      opacities: new Float64Array(COUNT),
    };
    for (let at = 0; at < COUNT; at += 1) {
      set.positions[at * 3] = (random() - 0.5) * 2.2;
      set.positions[at * 3 + 1] = (random() - 0.5) * 1.6;
      set.positions[at * 3 + 2] = 1.5 + random() * 2.4;
      for (let c = 0; c < 3; c += 1) set.scales[at * 3 + c] = 0.04 + random() * 0.1;
      for (let c = 0; c < 4; c += 1) set.rotations[at * 4 + c] = random() - 0.5;
      for (let c = 0; c < 3; c += 1) set.colors[at * 3 + c] = 0.25 + random() * 0.7;
      set.opacities[at] = 0.35 + random() * 0.6;
    }
    const camera = {
      width: WIDTH,
      height: HEIGHT,
      intrinsics: [90, 90, WIDTH / 2, HEIGHT / 2],
      /* Looking down positive z, which is the frame a capture's cameras are in. */
      worldToCamera: Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]),
    };

    /* The reference: the frame, a loss against a shifted copy of it, and the gradients. */
    const reference = new Float64Array(WIDTH * HEIGHT * 4);
    rasteriseGaussians(set, camera, reference);
    const target = new Float64Array(WIDTH * HEIGHT * 4);
    for (let at = 0; at < target.length; at += 1)
      target[at] = (reference[at] + random() * 0.4) * 0.8;
    const dPixels = new Float64Array(WIDTH * HEIGHT * 4);
    imageLoss(reference, target, dPixels);
    const gradients = createGradients(COUNT);
    accumulateGradients(set, camera, dPixels, gradients);

    /* The device's cloud: projected on the host, nearest first, which is the order tiles keep. */
    const { order, projected } = visibleGaussians(set, camera);
    const splats = new Float32Array(order.length * SPLAT_RASTER_FLOATS);
    const bins = new Float32Array(order.length * SPLAT_BIN_FLOATS);
    order.forEach((at, slot) => {
      const one = projected[at];
      const record = slot * SPLAT_RASTER_FLOATS;
      splats[record] = one.x;
      splats[record + 1] = one.y;
      splats[record + 2] = one.a;
      splats[record + 3] = one.b;
      splats[record + 4] = one.d;
      splats[record + 5] = set.opacities[at];
      for (let c = 0; c < 3; c += 1) splats[record + 6 + c] = set.colors[at * 3 + c];
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
      {
        offsets: pairOffsets,
        pairOf,
      },
    );

    const params = [WIDTH, HEIGHT, across, order.length];
    const forward = await gpu.run({
      wgsl: SPLAT_FORWARD_WGSL,
      workgroups: [across, down],
      buffers: [
        { kind: 'uniform', type: 'u32', values: params },
        { type: 'f32', values: splats, readOnly: true },
        { type: 'u32', values: offsets, readOnly: true },
        { type: 'u32', values: counts, readOnly: true },
        { type: 'u32', values: lists, readOnly: true },
        { type: 'f32', length: WIDTH * HEIGHT * 4, read: true },
        { type: 'f32', length: WIDTH * HEIGHT, read: true },
      ],
    });
    const frame = forward[5];
    const light = forward[6];
    let worstPixel = 0;
    let covered = 0;
    for (let at = 0; at < WIDTH * HEIGHT * 4; at += 1) {
      worstPixel = Math.max(worstPixel, Math.abs(frame[at] - reference[at]));
      if (at % 4 === 3 && reference[at] > 0.01) covered += 1;
    }
    /* Thresholds from the measurement: 5.6e-7, 3.4e-6 and 9.9e-8 on this machine. */
    if (!(worstPixel < 2e-6)) {
      failures.push(`splat forward: worst pixel ${worstPixel.toExponential(2)} apart`);
    }
    report(
      `splat forward  ${order.length} splats over ${across}x${down} tiles, ` +
        `${entries} tile entries, ${covered} covered pixels, worst ${worstPixel.toExponential(1)}`,
    );

    const backward = await gpu.run({
      wgsl: SPLAT_BACKWARD_WGSL,
      workgroups: [across, down],
      buffers: [
        { kind: 'uniform', type: 'u32', values: params },
        { type: 'f32', values: splats, readOnly: true },
        { type: 'u32', values: offsets, readOnly: true },
        { type: 'u32', values: counts, readOnly: true },
        { type: 'u32', values: lists, readOnly: true },
        { type: 'u32', values: pairOf, readOnly: true },
        { type: 'f32', values: Float32Array.from(dPixels), readOnly: true },
        { type: 'f32', values: light, readOnly: true },
        { type: 'f32', length: entries * SPLAT_GRADIENT_FLOATS, read: true },
      ],
    });
    const reduced = await gpu.run({
      wgsl: SPLAT_REDUCE_WGSL,
      workgroups: [Math.ceil(order.length / 64)],
      buffers: [
        { kind: 'uniform', type: 'u32', values: params },
        { type: 'u32', values: pairOffsets, readOnly: true },
        { type: 'u32', values: tilesPerSplat, readOnly: true },
        { type: 'f32', values: backward[8], readOnly: true },
        { type: 'f32', length: order.length * SPLAT_GRADIENT_FLOATS, read: true },
      ],
    });
    const deviceGradients = reduced[4];
    let worstGradient = 0;
    let largest = 0;
    order.forEach((at, slot) => {
      for (let k = 0; k < SCREEN_GRADIENTS; k += 1) {
        const want = gradients.screen[at * SCREEN_GRADIENTS + k];
        const got = deviceGradients[slot * SPLAT_GRADIENT_FLOATS + k];
        largest = Math.max(largest, Math.abs(want));
        worstGradient = Math.max(worstGradient, Math.abs(want - got) / Math.max(1, Math.abs(want)));
      }
    });
    if (!(worstGradient < 1e-5)) {
      failures.push(`splat backward: worst gradient ${worstGradient.toExponential(2)} off`);
    }
    report(
      `splat backward ${order.length} splats, ${entries} partial slots reduced, ` +
        `largest gradient ${largest.toFixed(2)}, worst ${worstGradient.toExponential(1)} relative`,
    );

    /* ------------------------------------------------------------------ the step itself */
    const NUMBERS = 512;
    const family = createFamily(1, 0.01, NUMBERS);
    for (let at = 0; at < NUMBERS; at += 1) {
      family.values[at] = (random() - 0.5) * 4;
      family.gradient[at] = (random() - 0.5) * 2;
      family.moment[at] = (random() - 0.5) * 0.1;
      family.second[at] = random() * 0.05;
    }
    const before = {
      values: Float32Array.from(family.values),
      gradient: Float32Array.from(family.gradient),
      moment: Float32Array.from(family.moment),
      second: Float32Array.from(family.second),
    };
    const state = createAdamState();
    adamStep([family], NUMBERS, state);
    const stepped = await gpu.run({
      wgsl: SPLAT_ADAM_WGSL,
      workgroups: [Math.ceil(NUMBERS / 64)],
      buffers: [
        /* A count and three rates: one word of each kind, laid out as the struct reads them. */
        { kind: 'uniform', type: 'u32', values: adamSettings(NUMBERS, 0.01, state) },
        { type: 'f32', values: before.values, read: true },
        { type: 'f32', values: before.gradient, readOnly: true },
        { type: 'f32', values: before.moment, read: true },
        { type: 'f32', values: before.second, read: true },
      ],
    });
    let worstStep = 0;
    for (let at = 0; at < NUMBERS; at += 1) {
      worstStep = Math.max(
        worstStep,
        Math.abs(stepped[1][at] - family.values[at]) / Math.max(1, Math.abs(family.values[at])),
      );
    }
    if (!(worstStep < 5e-7))
      failures.push(`splat adam: worst step ${worstStep.toExponential(2)} off`);
    report(
      `splat adam     ${NUMBERS} parameters stepped, worst ${worstStep.toExponential(1)} relative`,
    );
  }
} finally {
  await gpu.close();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} disagreement(s):`);
  for (const failure of failures.slice(0, 20)) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`\nthe reference and the device agree on ${reported} checks`);
process.exit(0);

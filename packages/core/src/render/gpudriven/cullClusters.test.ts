import { expect, test } from 'vitest';

import {
  CLUSTER_KEEP,
  clusterOccluded,
  coneBackfacing,
  cullClusters,
  cullCutoff,
  hzbLevelFor,
  sphereScreenBounds,
} from './cullClusters.ts';
import { FRUSTUM_FLOATS, frustumPlanes } from './frustum.ts';

/**
 * A **reversed-Z** perspective looking down -z, column-major: the near plane at 1 and the far at 0.
 *
 * `reference.test.ts` beside this builds a conventional one, and that difference is deliberate
 * rather than an oversight. Nothing it tests reads a depth *value* — the frustum planes bound the
 * same volume either way and `hzbReduce` is handed depths directly — while everything here does:
 * `sphereScreenBounds` reports the nearest depth a sphere reaches and `clusterOccluded` compares
 * it against the pyramid, and both of those are only right under the convention
 * `depthConvention.ts` actually ships. Written with a conventional matrix, the first of those
 * tests asserts that the nearer of two spheres reports the *larger* depth and it is the smaller,
 * which is what caught this.
 *
 * `m[10] = near / (far - near)` and `m[14] = far * near / (far - near)` are the reversal; the rest
 * is an ordinary perspective.
 */
function viewProj(): Float32Array {
  const near = 0.1;
  const far = 100;
  const f = 1 / Math.tan(Math.PI / 4 / 2);
  const m = new Float32Array(16);
  m[0] = f;
  m[5] = f;
  m[10] = near / (far - near);
  m[11] = -1;
  m[14] = (far * near) / (far - near);
  return m;
}

/*
 * The normal cone.
 *
 * `cutoff` is `sin(a)` for a cone whose normals all lie within `a` of the axis, so 0 is a flat
 * cluster and 1 is one whose normals span a hemisphere and can never be culled. See the module.
 */

test('A CONE POINTING AWAY FROM THE CAMERA IS CULLED, which is the whole point of carrying one', () => {
  /* Ten metres ahead, every normal pointing directly away from the eye. */
  expect(coneBackfacing(0, 0, -1, 0, 0, 0, -10, 0.5, 0, 0, 0)).toBe(true);
});

test('AND THE SAME CONE SEEN EDGE-ON IS NOT, because conservative is the only safe direction', () => {
  expect(coneBackfacing(1, 0, 0, 0, 0, 0, -10, 0.5, 0, 0, 0)).toBe(false);
});

test('a cone facing the camera is not culled', () => {
  expect(coneBackfacing(0, 0, 1, 0, 0, 0, -10, 0.5, 0, 0, 0)).toBe(false);
});

test('a cone whose normals span a hemisphere is never culled, however it is aimed', () => {
  for (const axis of [
    [0, 0, -1],
    [0, 0, 1],
    [1, 0, 0],
    [0, 1, 0],
  ] as const) {
    expect(coneBackfacing(axis[0], axis[1], axis[2], 1, 0, 0, -10, 0.5, 0, 0, 0)).toBe(false);
  }
});

test('THE SPHERE’S OWN ANGULAR SIZE IS IN THE TEST, so a wide one close up survives', () => {
  /* One metre away with a radius of 0.9: two thirds of the sphere is off to the side of the eye,
     and some of that faces the camera however the axis is aimed. Exactly at the threshold, where
     the approximation `sin(a + b) ~ sin a + radius / distance` is exact because `a` is zero. */
  expect(coneBackfacing(0, 0, -1, 0, 0, 0, -1, 0.9, 0, 0, 0)).toBe(true);
  expect(coneBackfacing(0, 0, -1, 0, 0, 0, -1, 1.1, 0, 0, 0)).toBe(false);
});

test('the eye is where the caller says it is, not the origin', () => {
  /* The same cluster, seen from behind it: its normals now face the eye. */
  expect(coneBackfacing(0, 0, -1, 0, 0, 0, -10, 0.5, 0, 0, -30)).toBe(false);
});

test('a sphere in front of the camera has screen bounds inside the unit square', () => {
  const out = new Float32Array(5);
  expect(sphereScreenBounds(viewProj(), 0, 0, -10, 1, out)).toBe(true);
  const [minX, minY, maxX, maxY] = out;
  expect(minX).toBeGreaterThan(0);
  expect(maxX).toBeLessThan(1);
  expect(minY).toBeGreaterThan(0);
  expect(maxY).toBeLessThan(1);
  expect(minX).toBeLessThan(maxX as number);
  expect(minY).toBeLessThan(maxY as number);
});

test('A SPHERE STRADDLING THE NEAR PLANE HAS NO BOUNDS AT ALL, which is what stops the flicker', () => {
  const out = new Float32Array(5);
  /* Centred a twentieth of a metre ahead with a radius of one: part of it is behind the eye, so
     its projection is not a rectangle and anything that treats it as one culls it every few
     frames and not the frames between. */
  expect(sphereScreenBounds(viewProj(), 0, 0, -0.05, 1, out)).toBe(false);
});

test('a sphere entirely behind the camera has no bounds either', () => {
  const out = new Float32Array(5);
  expect(sphereScreenBounds(viewProj(), 0, 0, 10, 1, out)).toBe(false);
});

test('the nearer of two spheres reports the larger clip depth, because near is one', () => {
  const near = new Float32Array(5);
  const far = new Float32Array(5);
  sphereScreenBounds(viewProj(), 0, 0, -5, 1, near);
  sphereScreenBounds(viewProj(), 0, 0, -50, 1, far);
  expect(near[4] as number).toBeGreaterThan(far[4] as number);
});

test('the level chosen covers the rectangle in at most two texels each way', () => {
  /* A rectangle four texels wide needs level two: at level one it is two texels, and two is what
     a four-texel gather reads. The bound is the width in texels of the *base* level. */
  expect(hzbLevelFor(4, 4, 256, 256)).toBe(1);
  expect(hzbLevelFor(1, 1, 256, 256)).toBe(0);
  expect(hzbLevelFor(256, 256, 256, 256)).toBe(7);
});

test('the level never runs past the top of the pyramid', () => {
  expect(hzbLevelFor(1e6, 1e6, 4, 4)).toBe(2);
});

/**
 * A pyramid over a 4x4 base, as the flat buffer a dispatch binds: level 0 first, then 2x2, then
 * 1x1. Every texel of the base is `depth` except the rectangle named, which is `occluder`.
 */
function pyramid(depth: number, occluder: number, x0: number, y0: number, x1: number, y1: number) {
  const base = new Float32Array(16).fill(depth);
  for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) base[y * 4 + x] = occluder;
  const mid = new Float32Array(4);
  for (let y = 0; y < 2; y += 1) {
    for (let x = 0; x < 2; x += 1) {
      /* Furthest of the four, which under reversed-Z is the smallest. */
      mid[y * 2 + x] = Math.min(
        base[y * 8 + x * 2] as number,
        base[y * 8 + x * 2 + 1] as number,
        base[y * 8 + 4 + x * 2] as number,
        base[y * 8 + 4 + x * 2 + 1] as number,
      );
    }
  }
  const top = new Float32Array([Math.min(...mid)]);
  const flat = new Float32Array(16 + 4 + 1);
  flat.set(base, 0);
  flat.set(mid, 16);
  flat.set(top, 20);
  return { flat, offsets: new Int32Array([0, 16, 20]), width: 4, height: 4 };
}

test('A CLUSTER BEHIND A CLOSER DEPTH IS CULLED', () => {
  /* The whole base is an occluder at 0.9 — very near, under reversed-Z — and the cluster's own
     nearest point is at 0.5. */
  const { flat, offsets, width, height } = pyramid(0.9, 0.9, 0, 0, 3, 3);
  expect(clusterOccluded(flat, offsets, width, height, 0.2, 0.2, 0.8, 0.8, 0.5)).toBe(true);
});

test('AND ONE IN FRONT OF IT IS NOT', () => {
  const { flat, offsets, width, height } = pyramid(0.5, 0.5, 0, 0, 3, 3);
  expect(clusterOccluded(flat, offsets, width, height, 0.2, 0.2, 0.8, 0.8, 0.9)).toBe(false);
});

test('one texel of open sky in the rectangle is enough to keep a cluster', () => {
  /* Three quarters of the base is a near occluder and the fourth is the far plane. A cluster
     covering all of it is visible through that quarter, and the pyramid must say so. */
  const { flat, offsets, width, height } = pyramid(0.0, 0.9, 0, 0, 3, 1);
  expect(clusterOccluded(flat, offsets, width, height, 0.05, 0.05, 0.95, 0.95, 0.5)).toBe(false);
});

/** Eight clusters in a row, each with its own sphere, cone and index. */
function clusters(): Float32Array {
  const out = new Float32Array(8 * 8);
  for (let i = 0; i < 8; i += 1) {
    const at = i * 8;
    out[at] = (i - 3.5) * 0.5;
    out[at + 1] = 0;
    out[at + 2] = -10;
    out[at + 3] = 0.2;
    /* Facing the camera, so nothing is cone-culled unless a case says so. */
    out[at + 4] = 0;
    out[at + 5] = 0;
    out[at + 6] = 1;
    out[at + 7] = 0;
  }
  return out;
}

test('THE COMPACTED OUTPUT PRESERVES INPUT ORDER', () => {
  const source = clusters();
  /* Three of the eight face away, and they are not the first three. */
  for (const i of [1, 4, 6]) source[i * 8 + 6] = -1;
  const planes = new Float32Array(FRUSTUM_FLOATS);
  frustumPlanes(viewProj(), planes);
  const keep = new Uint32Array(8);
  const list = new Uint32Array(8);
  const count = cullClusters(source, planes, 0, 0, 0, null, keep, list);
  expect(count).toBe(5);
  expect(Array.from(list.subarray(0, count))).toEqual([0, 2, 3, 5, 7]);
  expect(Array.from(keep)).toEqual([
    CLUSTER_KEEP,
    0,
    CLUSTER_KEEP,
    CLUSTER_KEEP,
    0,
    CLUSTER_KEEP,
    0,
    CLUSTER_KEEP,
  ]);
});

test('a cluster outside the frustum is culled by the same pass', () => {
  const source = clusters();
  source[2 * 8] = 500;
  const planes = new Float32Array(FRUSTUM_FLOATS);
  frustumPlanes(viewProj(), planes);
  const keep = new Uint32Array(8);
  const list = new Uint32Array(8);
  expect(cullClusters(source, planes, 0, 0, 0, null, keep, list)).toBe(7);
  expect(keep[2]).toBe(0);
});

test('with no pyramid bound nothing is occlusion-culled, which is what the first phase wants', () => {
  const source = clusters();
  const planes = new Float32Array(FRUSTUM_FLOATS);
  frustumPlanes(viewProj(), planes);
  const keep = new Uint32Array(8);
  const list = new Uint32Array(8);
  expect(cullClusters(source, planes, 0, 0, 0, null, keep, list)).toBe(8);
});

test('and with one bound in front of everything, nothing survives', () => {
  const source = clusters();
  const planes = new Float32Array(FRUSTUM_FLOATS);
  frustumPlanes(viewProj(), planes);
  const keep = new Uint32Array(8);
  const list = new Uint32Array(8);
  const { flat, offsets, width, height } = pyramid(0.999, 0.999, 0, 0, 3, 3);
  const hzb = { depths: flat, offsets, width, height, viewProj: viewProj() };
  expect(cullClusters(source, planes, 0, 0, 0, hzb, keep, list)).toBe(0);
});

test('THE PYRAMID IS ADDRESSED IN ITS OWN ROWS, which run the other way from clip space', () => {
  /*
   * **The rectangle arrives in clip-up coordinates and the pyramid is stored top-down.**
   * `sphereScreenBounds` maps clip `y` of +1 to `v` of 1, and the pyramid is seeded straight from
   * the depth texture, whose row 0 is where clip `y` is +1 — so a `v` used as a row index reads the
   * mirror of the region the cluster actually covers.
   *
   * What that draws is holes: geometry near the top of the frame tested against whatever stands
   * near the bottom, appearing and disappearing as the camera moves. It shipped, and
   * `gpu-parity.mjs` agreed about it the whole time, because both copies made the same mistake —
   * a parity check compares two implementations and neither of them is the truth.
   *
   * Here the near occluder is the **bottom** half of the base level and the cluster covers the
   * **top** half, where there is nothing but the far plane. It must survive.
   */
  const { flat, offsets, width, height } = pyramid(0, 0.9, 0, 2, 3, 3);
  expect(clusterOccluded(flat, offsets, width, height, 0.1, 0.55, 0.9, 0.95, 0.5)).toBe(false);

  /* And the same cluster over the *bottom* half is behind that occluder, which is the control. */
  expect(clusterOccluded(flat, offsets, width, height, 0.1, 0.05, 0.9, 0.45, 0.5)).toBe(true);
});

/**
 * **Two anchors added 2026-09-17: what the cone and the rectangle actually claim.**
 *
 * Everything above is a hand-picked case or a comparison against `gpu-parity.mjs`'s second copy of
 * the same expression, and §3 row 79 is what that was worth: the occlusion test read the pyramid at
 * the mirror of the region it covered, both copies agreed, and the picture had holes in it for a
 * fortnight. What was missing was never a second implementation. It was a sentence about what the
 * arithmetic means, checked by building the thing it describes.
 */

/** A deterministic generator, so a failure is reproducible from its seed alone. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** A unit vector at `angle` from `axis`, rotated `phi` about it. */
function withinCone(
  axis: readonly [number, number, number],
  angle: number,
  phi: number,
): [number, number, number] {
  /* Any vector not parallel to the axis gives a basis to swing around it. */
  const helper: [number, number, number] = Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const ux = (axis[1] as number) * helper[2] - (axis[2] as number) * helper[1];
  const uy = (axis[2] as number) * helper[0] - (axis[0] as number) * helper[2];
  const uz = (axis[0] as number) * helper[1] - (axis[1] as number) * helper[0];
  const ul = Math.hypot(ux, uy, uz) || 1;
  const vx = (axis[1] as number) * (uz / ul) - (axis[2] as number) * (uy / ul);
  const vy = (axis[2] as number) * (ux / ul) - (axis[0] as number) * (uz / ul);
  const vz = (axis[0] as number) * (uy / ul) - (axis[1] as number) * (ux / ul);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [
    (axis[0] as number) * c + ((ux / ul) * Math.cos(phi) + vx * Math.sin(phi)) * s,
    (axis[1] as number) * c + ((uy / ul) * Math.cos(phi) + vy * Math.sin(phi)) * s,
    (axis[2] as number) * c + ((uz / ul) * Math.cos(phi) + vz * Math.sin(phi)) * s,
  ];
}

test('A CULLED CONE HAS NO TRIANGLE FACING THE EYE, checked by building the triangles', () => {
  /*
   * **The cone test's whole claim, and it is not a comparison with anything.** A cluster carries an
   * axis and `sin` of the half-angle containing every one of its normals, and the module derives a
   * single inequality from `angle(axis, d) + a + b < 90 degrees` where `b` is the sphere's own
   * angular size. Every constant in that derivation — the sine rather than a cosine, the `radius`
   * added on the right, the multiply through by the distance — is a place a transcription lands
   * somewhere plausible.
   *
   * So the cone is populated: normals at the cone's own boundary and inside it, on surfaces
   * anywhere in the bounding sphere. If the test says *cull*, every one of those triangles has to
   * be facing away — `dot(normal, point - eye) > 0` — because a cluster dropped with one triangle
   * still facing the camera is a hole in the picture.
   */
  const random = lcg(0x6f1c2a3d);
  const eye: [number, number, number] = [0, 1.5, 4];
  let culled = 0;
  let kept = 0;

  for (let trial = 0; trial < 400; trial += 1) {
    const az = random() * 2 - 1;
    const aphi = random() * Math.PI * 2;
    const ar = Math.sqrt(Math.max(0, 1 - az * az));
    const axis: [number, number, number] = [ar * Math.cos(aphi), ar * Math.sin(aphi), az];
    const cutoff = random();
    const centre: [number, number, number] = [
      (random() - 0.5) * 20,
      (random() - 0.5) * 12,
      -random() * 30,
    ];
    const radius = 0.05 + random() * 2.5;

    const backfacing = coneBackfacing(
      axis[0],
      axis[1],
      axis[2],
      cutoff,
      centre[0],
      centre[1],
      centre[2],
      radius,
      eye[0],
      eye[1],
      eye[2],
    );
    if (backfacing) culled += 1;
    else kept += 1;
    if (!backfacing) continue;

    const half = Math.asin(Math.min(1, cutoff));
    for (let sample = 0; sample < 48; sample += 1) {
      /* The boundary of the cone every third sample: that is where the inequality is tight. */
      const angle = sample % 3 === 0 ? half : random() * half;
      const normal = withinCone(axis, angle, random() * Math.PI * 2);
      /*
       * **The helper is checked here rather than assumed**, because a `withinCone` that quietly
       * returned something outside the cone would make every assertion below vacuous — the anchor
       * would be testing normals the cluster never claimed to contain. Unit length and the angle
       * it was asked for, both from the vectors themselves.
       */
      expect(
        Math.hypot(normal[0], normal[1], normal[2]),
        'the sampled normal is not a unit',
      ).toBeCloseTo(1, 9);
      expect(
        normal[0] * axis[0] + normal[1] * axis[1] + normal[2] * axis[2],
        'the sampled normal is not at the angle it was asked for',
      ).toBeCloseTo(Math.cos(angle), 9);
      /* A point on the bounding sphere, which is as far from the centre as a triangle can sit. */
      const pz = random() * 2 - 1;
      const pphi = random() * Math.PI * 2;
      const pr = Math.sqrt(Math.max(0, 1 - pz * pz));
      const point = [
        (centre[0] as number) + pr * Math.cos(pphi) * radius,
        (centre[1] as number) + pr * Math.sin(pphi) * radius,
        (centre[2] as number) + pz * radius,
      ];
      const facing =
        (normal[0] as number) * ((point[0] as number) - eye[0]) +
        (normal[1] as number) * ((point[1] as number) - eye[1]) +
        (normal[2] as number) * ((point[2] as number) - eye[2]);
      expect(
        facing,
        `trial ${trial}: a culled cluster has a triangle facing the eye`,
      ).toBeGreaterThan(0);
    }
  }
  /* Both arms have to have run, or this is an assertion about an empty set. */
  expect(culled).toBeGreaterThan(20);
  expect(kept).toBeGreaterThan(20);
});

test('THE SCREEN RECTANGLE COVERS THE SPHERE, which is the claim the pyramid read is built on', () => {
  /*
   * **Row 79 lived here.** The rectangle was right and the rows it was read at were the mirror of
   * it, and nothing in the tree said what the rectangle was for — "screen bounds inside the unit
   * square" is true of a rectangle shifted anywhere inside the frame.
   *
   * The claim is coverage: every point of the sphere projects inside the rectangle, and the depth
   * reported as nearest is nearer than every one of them. A rectangle that does not cover reads
   * depth from somewhere the cluster is not, which is the same defect however the rows are
   * addressed.
   */
  const m = viewProj();
  const random = lcg(0x2ca6f503);
  const bounds = new Float32Array(5);
  let rectangles = 0;

  for (let trial = 0; trial < 400; trial += 1) {
    const centre: [number, number, number] = [
      (random() - 0.5) * 30,
      (random() - 0.5) * 20,
      -random() * 60 - 0.5,
    ];
    const radius = 0.05 + random() * 3;
    if (!sphereScreenBounds(m, centre[0], centre[1], centre[2], radius, bounds)) continue;
    rectangles += 1;

    for (let sample = 0; sample < 40; sample += 1) {
      const z = random() * 2 - 1;
      const phi = random() * Math.PI * 2;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      const x = (centre[0] as number) + r * Math.cos(phi) * radius;
      const y = (centre[1] as number) + r * Math.sin(phi) * radius;
      const w = (centre[2] as number) + z * radius;
      const cw =
        (m[3] as number) * x + (m[7] as number) * y + (m[11] as number) * w + (m[15] as number);
      const cx =
        (m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * w + (m[12] as number);
      const cy =
        (m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * w + (m[13] as number);
      const cz =
        (m[2] as number) * x + (m[6] as number) * y + (m[10] as number) * w + (m[14] as number);
      const u = (cx / cw) * 0.5 + 0.5;
      const v = (cy / cw) * 0.5 + 0.5;
      const label = `trial ${trial} sample ${sample}`;
      expect(u, `${label}: left of the rectangle`).toBeGreaterThanOrEqual(
        (bounds[0] as number) - 1e-5,
      );
      expect(u, `${label}: right of it`).toBeLessThanOrEqual((bounds[2] as number) + 1e-5);
      expect(v, `${label}: below it`).toBeGreaterThanOrEqual((bounds[1] as number) - 1e-5);
      expect(v, `${label}: above it`).toBeLessThanOrEqual((bounds[3] as number) + 1e-5);
      /* Reversed-Z: the nearest depth is the largest, so nothing on the sphere may exceed it. */
      expect(cz / cw, `${label}: nearer than the reported nearest depth`).toBeLessThanOrEqual(
        (bounds[4] as number) + 1e-5,
      );
    }
  }
  expect(rectangles).toBeGreaterThan(100);
});

/*
 * **The cutoff the cull reads is a sine and the one a cluster carries is a cosine.**
 * `buildClusters` writes "the minimum dot product of any face normal against the axis", the `MSHL`
 * container stores that and says so, and `ClusterSource` passed it straight through to a test
 * written in `sin(a)`. Every cluster before 2026-09-18 was a single quad or a near-flat patch,
 * whose cosine of about one reads as a sine of one — never culled, so the mismatch was silent. The
 * voxel sandbox's clusters are grown by position and span every direction a block faces: a cosine
 * of zero read as a sine of zero is a flat cluster, and a canopy seen from below lost every block
 * whose cluster pointed up.
 */
test('A CLUSTER’S CONE COSINE BECOMES THE SINE THE CULL IS WRITTEN IN', () => {
  expect(cullCutoff(1)).toBe(0);
  expect(cullCutoff(0)).toBe(1);
  expect(cullCutoff(Math.cos(Math.PI / 6))).toBeCloseTo(0.5, 12);
  /* Wider than a hemisphere: no aim of the eye sees every face from behind. */
  expect(cullCutoff(-0.5)).toBe(1);
  expect(cullCutoff(-1)).toBe(1);
});

test('AND A RUN THAT ASKS FOR NO CONES KEEPS A CLUSTER WHOSE EVERY FACE POINTS AWAY', () => {
  /* The blended half's run: its raster draws both sides, so facing away is no reason to cull. */
  const clusters = new Float32Array([0, 0, -10, 1, 0, 0, -1, 0]);
  const planes = new Float32Array(FRUSTUM_FLOATS);
  frustumPlanes(viewProj(), planes);
  const keep = new Uint32Array(1);
  const list = new Uint32Array(1);
  expect(cullClusters(clusters, planes, 0, 0, 0, null, keep, list, null)).toBe(0);
  expect(cullClusters(clusters, planes, 0, 0, 0, null, keep, list, null, false)).toBe(1);
});

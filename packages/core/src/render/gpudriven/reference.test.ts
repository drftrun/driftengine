import { expect, test } from 'vitest';
import { FRUSTUM_FLOATS, frustumPlanes, sphereOutsideFrustum } from './frustum.ts';
import { hzbMipCount, hzbMipSize, hzbOccluded, hzbReduce, shadowPyramidBase } from './hzb.ts';
import { clusterSelected, distanceTo, projectedError } from './lodCut.ts';
import {
  VIS_EMPTY,
  VIS_MAX_TRIANGLES,
  packVisibility,
  unpackVisibility,
  visibilityCovered,
} from './visbuffer.ts';

/** A perspective view-projection looking down -z, column-major, clip depth in [0, 1]. */
function viewProj(): Float32Array {
  const near = 0.1;
  const far = 100;
  const f = 1 / Math.tan(Math.PI / 4 / 2);
  const m = new Float32Array(16);
  m[0] = f;
  m[5] = f;
  m[10] = far / (near - far);
  m[11] = -1;
  m[14] = (far * near) / (near - far);
  return m;
}

test('a sphere in front of the camera is inside the frustum', () => {
  const planes = new Float32Array(FRUSTUM_FLOATS);
  frustumPlanes(viewProj(), planes);
  expect(sphereOutsideFrustum(planes, 0, 0, -10, 1)).toBe(false);
});

test('a sphere behind the camera is outside it', () => {
  const planes = new Float32Array(FRUSTUM_FLOATS);
  frustumPlanes(viewProj(), planes);
  expect(sphereOutsideFrustum(planes, 0, 0, 10, 1)).toBe(true);
});

test('a sphere far to the side is outside it', () => {
  const planes = new Float32Array(FRUSTUM_FLOATS);
  frustumPlanes(viewProj(), planes);
  expect(sphereOutsideFrustum(planes, 1000, 0, -10, 1)).toBe(true);
});

test('a sphere straddling a plane survives, because culling is conservative one way only', () => {
  const planes = new Float32Array(FRUSTUM_FLOATS);
  frustumPlanes(viewProj(), planes);
  /*
   * Centre outside the left plane at this depth by about 6.3 units, with a radius that reaches
   * back across it. A radius of 6 leaves it genuinely outside, which is what the first version of
   * this test asserted and got wrong.
   */
  expect(sphereOutsideFrustum(planes, -11, 0, -10, 7)).toBe(false);
  expect(sphereOutsideFrustum(planes, -11, 0, -10, 6)).toBe(true);
});

test('the planes are normalised, so a plane test is a true signed distance', () => {
  const planes = new Float32Array(FRUSTUM_FLOATS);
  frustumPlanes(viewProj(), planes);
  for (let p = 0; p < 6; p += 1) {
    const at = p * 4;
    const length = Math.hypot(
      planes[at] as number,
      planes[at + 1] as number,
      planes[at + 2] as number,
    );
    expect(length).toBeCloseTo(1, 5);
  }
});

test('the depth pyramid keeps the furthest sample, which under reversed-Z is the smallest', () => {
  const src = Float32Array.from([0.9, 0.8, 0.7, 0.2]);
  const out = new Float32Array(1);
  hzbReduce(src, 2, 2, out);
  expect(out[0]).toBe(Math.fround(0.2));
});

test('a uniform depth reduces to itself at every level', () => {
  const src = new Float32Array(16).fill(0.5);
  const out = new Float32Array(4);
  hzbReduce(src, 4, 4, out);
  expect(Array.from(out)).toEqual([0.5, 0.5, 0.5, 0.5]);
});

test('an odd level folds its extra row and column in rather than dropping them', () => {
  /* 3x1: the last group must see the third texel, which holds the furthest depth. */
  const src = Float32Array.from([0.9, 0.9, 0.1]);
  const out = new Float32Array(1);
  const size = hzbReduce(src, 3, 1, out);
  expect(size).toEqual({ width: 1, height: 1 });
  expect(out[0]).toBe(Math.fround(0.1));
});

test('the mip count reaches a single texel', () => {
  expect(hzbMipCount(8, 8)).toBe(4);
  expect(hzbMipCount(1, 1)).toBe(1);
  expect(hzbMipSize(1, 1)).toEqual({ width: 1, height: 1 });
});

test('a sphere further away than the occluder is hidden; one nearer is not', () => {
  /* Reversed-Z: nearer is a larger value. */
  expect(hzbOccluded(0.3, 0.5)).toBe(true);
  expect(hzbOccluded(0.7, 0.5)).toBe(false);
});

test('a nearby cluster has a larger projected error than a distant one', () => {
  const near = projectedError(0.1, 5, 1, 1080, Math.PI / 4);
  const far = projectedError(0.1, 500, 1, 1080, Math.PI / 4);
  expect(near).toBeGreaterThan(far);
});

test('a camera inside a cluster gets a large error rather than a division by nothing', () => {
  const value = projectedError(0.1, 0, 2, 1080, Math.PI / 4);
  expect(Number.isFinite(value)).toBe(true);
  expect(value).toBeGreaterThan(0);
});

test('exactly one level along a parent chain is selected', () => {
  const chain = [
    { own: 0, parent: 0.1 },
    { own: 0.1, parent: 0.4 },
    { own: 0.4, parent: Infinity },
  ];
  for (const threshold of [0.5, 2, 20, 200]) {
    const chosen = chain.filter((c) =>
      clusterSelected(c.own, c.parent, 50, 1, 1080, Math.PI / 4, threshold),
    );
    expect(chosen.length).toBe(1);
  }
});

test('a huge threshold picks the coarsest level, whose parent error is infinite', () => {
  expect(clusterSelected(0.4, Infinity, 50, 1, 1080, Math.PI / 4, 1e6)).toBe(true);
  expect(clusterSelected(0, 0.1, 50, 1, 1080, Math.PI / 4, 1e6)).toBe(false);
});

test('distance is the ordinary one', () => {
  expect(distanceTo(0, 0, 0, 3, 4, 0)).toBe(5);
});

test('visibility packs and unpacks over the full range of each field', () => {
  for (const triangle of [0, 1, 63, VIS_MAX_TRIANGLES - 1]) {
    for (const cluster of [0, 1, 1234567]) {
      expect(unpackVisibility(packVisibility(cluster, triangle))).toEqual({ cluster, triangle });
    }
  }
});

test('a triangle index past the cluster cap is refused rather than wrapping into the cluster', () => {
  expect(() => packVisibility(5, VIS_MAX_TRIANGLES)).toThrow(RangeError);
});

test('an uncovered pixel is distinguishable from triangle zero of cluster zero', () => {
  expect(visibilityCovered(VIS_EMPTY)).toBe(false);
  expect(visibilityCovered(packVisibility(0, 0))).toBe(true);
});

/**
 * **Three anchors added 2026-09-17, because everything above this line is a hand-picked case.**
 *
 * `scripts/gpu-parity.mjs` runs each of these against the WGSL that ships, and §3 row 79 is what
 * that is worth on its own: the occlusion cull read the mirror of the region it was testing and
 * both copies agreed about it for a fortnight. A parity check compares two implementations; what
 * says either of them is *right* is an assertion about what the arithmetic means, and the three
 * below are anchored on the projection matrix and on brute force rather than on a second reading
 * of the same expression.
 */

/** A deterministic generator, so a failure is reproducible from its seed alone. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * Whether a world point lands inside the volume the matrix clips to: `|x| ≤ w`, `|y| ≤ w` and
 * `0 ≤ z ≤ w`, with `w` positive.
 *
 * **This is the definition the planes are extracted to approximate**, so it is what they can be
 * checked against. Nothing here reads `frustum.ts`.
 */
function insideClip(m: Float32Array, x: number, y: number, z: number): boolean {
  const cx = (m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z + (m[12] as number);
  const cy = (m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number);
  const cz =
    (m[2] as number) * x + (m[6] as number) * y + (m[10] as number) * z + (m[14] as number);
  const cw =
    (m[3] as number) * x + (m[7] as number) * y + (m[11] as number) * z + (m[15] as number);
  if (!(cw > 0)) return false;
  return Math.abs(cx) <= cw && Math.abs(cy) <= cw && cz >= 0 && cz <= cw;
}

test('A CULLED SPHERE HAS NO POINT THE CAMERA COULD SEE, checked against the matrix itself', () => {
  /*
   * The claim the whole cull rests on, and the only one it is allowed to make: **a sphere this
   * refuses is a sphere no part of which projects into the clip volume.** Six plane tests are an
   * implementation of that sentence; this is the sentence.
   *
   * The converse is asserted too and is a different statement: a ball is convex, so if every point
   * of its surface is inside the volume then all of it is, and culling it would be a hole in the
   * picture. Between them they pin the sign of every plane — a flipped one passes "a sphere in
   * front of the camera is inside the frustum" and fails this on the first trial.
   */
  const m = viewProj();
  const planes = new Float32Array(FRUSTUM_FLOATS);
  frustumPlanes(m, planes);
  const random = lcg(0x1d872b41);

  let culled = 0;
  let wholly = 0;
  for (let trial = 0; trial < 500; trial += 1) {
    const cx = (random() - 0.5) * 60;
    const cy = (random() - 0.5) * 60;
    const cz = (random() - 0.5) * 120;
    const radius = 0.1 + random() * 8;
    const outside = sphereOutsideFrustum(planes, cx, cy, cz, radius);

    let anyInside = false;
    let allInside = true;
    for (let sample = 0; sample < 64; sample += 1) {
      const z = random() * 2 - 1;
      const phi = random() * Math.PI * 2;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      const at = insideClip(
        m,
        cx + Math.cos(phi) * r * radius,
        cy + Math.sin(phi) * r * radius,
        cz + z * radius,
      );
      anyInside = anyInside || at;
      allInside = allInside && at;
    }

    if (outside) {
      culled += 1;
      expect(anyInside, `trial ${trial}: culled a sphere with a visible point`).toBe(false);
    }
    if (allInside) {
      wholly += 1;
      expect(outside, `trial ${trial}: culled a sphere entirely inside the volume`).toBe(false);
    }
  }
  /* Both arms have to have run, or this is an assertion about an empty set. */
  expect(culled).toBeGreaterThan(50);
  expect(wholly).toBeGreaterThan(5);
});

test('A PROJECTED ERROR IS PIXELS, and a projection is what says how many', () => {
  /*
   * `projectedError` is `error * screenHeight / (2 * distance * tan(fovY / 2))`, which is four
   * constants a transcription can lose: the half on the field of view, the two under it, the
   * height, and the divide. Every one of those survives "a nearby cluster has a larger projected
   * error than a distant one", because every one of them is monotonic in distance.
   *
   * So the anchor is a **projection**: two points that far apart, at that distance, straight down
   * the view axis, put through a matrix with that field of view and mapped to a viewport that many
   * pixels tall. The separation is exact rather than approximate — the points share a depth, so
   * the perspective divide is the same for both — and it is the number this function claims to be.
   */
  const screenHeight = 1080;
  for (const fovY of [Math.PI / 6, Math.PI / 4, Math.PI / 3]) {
    for (const distance of [3, 17, 240]) {
      for (const error of [0.01, 0.4, 2]) {
        const f = 1 / Math.tan(fovY / 2);
        const topY = (f * (error / 2)) / distance;
        const bottomY = (f * (-error / 2)) / distance;
        const pixels = ((topY - bottomY) * screenHeight) / 2;
        expect(
          projectedError(error, distance, 0, screenHeight, fovY),
          `fov ${fovY} distance ${distance} error ${error}`,
        ).toBeCloseTo(pixels, 6);
      }
    }
  }
});

test('A REDUCED TEXEL IS ONE OF THE TEXELS UNDER IT, and never a nearer one', () => {
  /*
   * Three claims, and they need each other. **Each coarse value occurs in the level below it**,
   * which refuses an average, a scale and an offset — a reduction that blurs is a reduction whose
   * every value is plausible and whose occlusion test is a guess. **No coarse texel is nearer than
   * anything it covers**, which is the direction that matters: under reversed-Z the furthest sample
   * is the smallest, and a coarse texel claiming to be nearer than something under it culls
   * geometry standing in front of the occluder. And **the furthest sample in the whole image
   * survives to the top**, which is what says the odd row and column are folded in rather than
   * dropped.
   *
   * A random 37 by 21 rather than a hand-built 3 by 1, because a fold is exactly the case a
   * hand-built example is chosen to avoid — §3 row 14.
   */
  const width = 37;
  const height = 21;
  const random = lcg(0x44c0ffee);
  const base = new Float32Array(width * height);
  for (let i = 0; i < base.length; i += 1) base[i] = 0.05 + random() * 0.9;
  /* The furthest sample, planted in the corner an odd reduction would drop. */
  base[width * height - 1] = 0.001;

  const values = new Set<number>();
  for (const value of base) values.add(value);

  let level = base;
  let levelWidth = width;
  let levelHeight = height;
  let levels = 0;
  while (levelWidth > 1 || levelHeight > 1) {
    const size = hzbMipSize(levelWidth, levelHeight);
    const next = new Float32Array(size.width * size.height);
    hzbReduce(level, levelWidth, levelHeight, next);

    for (let y = 0; y < size.height; y += 1) {
      for (let x = 0; x < size.width; x += 1) {
        const value = next[y * size.width + x] as number;
        expect(values.has(value), `level ${levels + 1} texel ${x},${y} is not a sample`).toBe(true);
        /*
         * **The furthest of the four, not merely no nearer than the nearest of them.** The weaker
         * form was written first and a perturbation walked straight through it: a reduction reading
         * the texels one column and one row *over* still returns a value below the maximum of the
         * proper four, because the two footprints overlap. What the occlusion test needs is the
         * furthest depth in the region a coarse texel covers, so the claim is that region's own
         * minimum — a coarse texel nearer than anything it covers culls geometry standing in front
         * of the occluder, which is a hole that comes and goes with the camera.
         */
        let furthest = Number.POSITIVE_INFINITY;
        for (let dy = 0; dy < 2; dy += 1) {
          for (let dx = 0; dx < 2; dx += 1) {
            const sx = Math.min(levelWidth - 1, x * 2 + dx);
            const sy = Math.min(levelHeight - 1, y * 2 + dy);
            furthest = Math.min(furthest, level[sy * levelWidth + sx] as number);
          }
        }
        /* Under reversed-Z, "no nearer than" is "no greater than". The last row and column of an
           odd level cover more than four, so they may be further still. */
        expect(
          value,
          `level ${levels + 1} texel ${x},${y} is nearer than something it covers`,
        ).toBeLessThanOrEqual(furthest);
      }
    }

    level = next;
    levelWidth = size.width;
    levelHeight = size.height;
    levels += 1;
  }

  expect(levels).toBeGreaterThan(4);
  expect(level[0]).toBe(Math.fround(0.001));
});

test('AND EVERY FACE OF THE FRUSTUM IS WHERE THE MATRIX PUTS IT, which containment does not say', () => {
  /*
   * **The test above permits a plane that is too loose, and one of them was.** "A culled sphere has
   * no visible point" is satisfied by six planes pushed outward as far as you like — that cull is
   * conservative, it just never fires. Extracting the near plane the OpenGL way, `r3 + r2` instead
   * of `r2`, puts it at half the near distance on a matrix that clips depth to 0..1, and the
   * containment test passed it on 500 trials: everything it wrongly kept was a wasted draw rather
   * than a hole.
   *
   * So each face is pinned separately, and the boundary is **found rather than written down**: walk
   * out along a ray from inside the volume until `insideClip` stops being true, and that crossing
   * is the face. A small sphere placed two radii beyond it must be culled; the same sphere two
   * radii short of it must not. Rays through the middle of each face, so no case lands on a corner
   * where a sphere can be outside the frustum and outside no single plane.
   */
  const m = viewProj();
  const planes = new Float32Array(FRUSTUM_FLOATS);
  frustumPlanes(m, planes);

  /* An interior point, and the six directions out through the middle of each face. */
  const inside: [number, number, number] = [0, 0, -20];
  const faces: Array<{ name: string; dir: [number, number, number]; radius: number }> = [
    { name: 'near', dir: [0, 0, 1], radius: 0.01 },
    { name: 'far', dir: [0, 0, -1], radius: 1 },
    { name: 'left', dir: [-1, 0, 0], radius: 0.2 },
    { name: 'right', dir: [1, 0, 0], radius: 0.2 },
    { name: 'bottom', dir: [0, -1, 0], radius: 0.2 },
    { name: 'top', dir: [0, 1, 0], radius: 0.2 },
  ];

  for (const face of faces) {
    const at = (t: number): [number, number, number] => [
      (inside[0] as number) + (face.dir[0] as number) * t,
      (inside[1] as number) + (face.dir[1] as number) * t,
      (inside[2] as number) + (face.dir[2] as number) * t,
    ];
    expect(insideClip(m, ...at(0)), `${face.name}: the ray does not start inside`).toBe(true);

    /* Bracket the crossing, then bisect it to well under one radius. */
    let high = 1;
    while (insideClip(m, ...at(high)) && high < 1e4) high *= 2;
    expect(high, `${face.name}: the ray never leaves the volume`).toBeLessThan(1e4);
    let low = 0;
    for (let step = 0; step < 60; step += 1) {
      const mid = (low + high) / 2;
      if (insideClip(m, ...at(mid))) low = mid;
      else high = mid;
    }

    const beyond = at(low + face.radius * 2);
    const short = at(low - face.radius * 2);
    expect(
      sphereOutsideFrustum(planes, beyond[0], beyond[1], beyond[2], face.radius),
      `${face.name}: a sphere past the face was kept, so the plane is looser than the matrix`,
    ).toBe(true);
    expect(
      sphereOutsideFrustum(planes, short[0], short[1], short[2], face.radius),
      `${face.name}: a sphere short of the face was culled, so the plane is tighter than the matrix`,
    ).toBe(false);
  }
});

/*
 * **A light's pyramid, from a map whose depth runs the other way.** The camera's depth is reversed
 * — near is one — and the cull and the reduction are written for it; a shadow map is conventional,
 * near is zero, because the lookup both pipelines share reads it so. So the light's pyramid is the
 * map turned over, `1 - depth`, and from there it is the camera's pyramid: the same reduction, the
 * same cull, a matrix whose depth is turned over to match. It starts at half the map, the furthest
 * of each group, because a pyramid over a whole 2048 map would be 22 MB beside the map's 16.
 */
test('A LIGHT’S PYRAMID STARTS AT HALF ITS MAP, the furthest of each group turned over', () => {
  /* Four by two: two groups, the left one with a far texel in it. */
  const depth = new Float32Array([0.25, 0.5, 0.125, 0.25, 0.75, 0.5, 0.25, 0.375]);
  const out = new Float32Array(2);
  expect(shadowPyramidBase(depth, 4, 2, out)).toEqual({ width: 2, height: 1 });
  /* One minus the largest depth, which in the turned-over convention is the smallest value. */
  expect(Array.from(out)).toEqual([0.25, 0.625]);
});

test('IT IS THE CAMERA’S REDUCTION OF THE MAP TURNED OVER, at every size a map comes in', () => {
  let seed = 0x9e3779b9;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (const [width, height] of [
    [16, 16],
    [37, 21],
    [3, 1],
    [1, 1],
    [2048, 1],
  ] as const) {
    const depth = new Float32Array(width * height);
    for (let i = 0; i < depth.length; i += 1) depth[i] = random() < 0.2 ? 1 : random();
    const turned = new Float32Array(depth.length);
    for (let i = 0; i < depth.length; i += 1) turned[i] = 1 - (depth[i] as number);
    const size = hzbMipSize(width, height);
    const want = new Float32Array(size.width * size.height);
    hzbReduce(turned, width, height, want);
    const got = new Float32Array(size.width * size.height);
    expect(shadowPyramidBase(depth, width, height, got)).toEqual(size);
    expect(Array.from(got)).toEqual(Array.from(want));
  }
});

test('an empty map is far everywhere, so nothing is hidden behind it', () => {
  const depth = new Float32Array(16).fill(1);
  const out = new Float32Array(4);
  shadowPyramidBase(depth, 4, 4, out);
  expect(Array.from(out)).toEqual([0, 0, 0, 0]);
  expect(hzbOccluded(0, out[0] as number)).toBe(false);
});

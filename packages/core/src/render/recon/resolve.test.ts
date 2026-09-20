import { mat4 } from 'gl-matrix';
import { expect, test } from 'vitest';

import { DEFAULT_DISOCCLUSION } from './disocclusion.ts';
import { jitterOffset, reconJitterPhases } from './jitter.ts';
import {
  DEFAULT_RECON_QUALITY,
  accumulate,
  reconstructionWeight,
  resolveFrame,
  sharpen,
  type ResolveFrame,
} from './resolve.ts';

/**
 * DriftTR resolves a jittered history into an image larger than the one rendered.
 *
 * The frames here are rendered by hand: a camera looking at a flat wall whose colour is a function
 * of where on the wall a ray lands, each render texel sampling that function at its jittered
 * centre — point-sampled, so a single frame aliases exactly as a rasteriser does.
 */

test('a weight of zero is the current colour and a weight of one with no alpha is the history', () => {
  const out = new Float64Array(3);
  accumulate(out, [0.1, 0.2, 0.3], [0.9, 0.8, 0.7], 0, 0.1);
  expect(Array.from(out)).toEqual([0.1, 0.2, 0.3]);
  accumulate(out, [0.1, 0.2, 0.3], [0.9, 0.8, 0.7], 1, 0);
  expect(Array.from(out)).toEqual([0.9, 0.8, 0.7]);
  /* Out-of-range weights are held to the range, not extrapolated. */
  accumulate(out, [0.1, 0.2, 0.3], [0.9, 0.8, 0.7], 3, -1);
  expect(Array.from(out)).toEqual([0.9, 0.8, 0.7]);
  accumulate(out, [0.1, 0.2, 0.3], [0.9, 0.8, 0.7], -2, 0.5);
  expect(Array.from(out)).toEqual([0.1, 0.2, 0.3]);
});

test('accumulating one colour converges to it and never overshoots', () => {
  const out = new Float64Array(3);
  let history = [0, 0, 0];
  let previous = -1;
  for (let frame = 0; frame < 200; frame += 1) {
    accumulate(out, [1, 2, 0.5], history, 1, 0.1);
    history = Array.from(out);
    expect(history[0]).toBeLessThanOrEqual(1);
    expect(history[1]).toBeLessThanOrEqual(2);
    expect(history[0]).toBeGreaterThan(previous);
    previous = history[0] as number;
  }
  expect(history[0]).toBeCloseTo(1, 8);
  expect(history[2]).toBeCloseTo(0.5, 8);
});

test('sharpening a flat region changes nothing', () => {
  const out = new Float64Array(3);
  sharpen(out, [0.4, 0.4, 0.4], new Float64Array(12).fill(0.4), 1);
  expect(Array.from(out)).toEqual([0.4, 0.4, 0.4]);
});

test('SHARPENING AN EDGE RAISES ITS CONTRAST AND DRAWS NO HALO', () => {
  /*
   * An unsharp mask pushes the centre away from its neighbours' mean without limit, and beside an
   * edge that is a value brighter than anything around it — a halo. Held inside the five samples'
   * range, the push stops at the brightest neighbour.
   */
  const out = new Float64Array(3);
  const neighbours = Float64Array.of(0.2, 0.2, 0.2, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9);
  sharpen(out, [0.8, 0.8, 0.8], neighbours, 0.25);
  const mean = (0.2 + 0.9 * 3) / 4;
  expect(Math.abs((out[0] as number) - mean)).toBeGreaterThan(Math.abs(0.8 - mean));
  expect(out[0]).toBeCloseTo(0.8 + 0.25 * (0.8 - mean), 12);
  sharpen(out, [0.8, 0.8, 0.8], neighbours, 10);
  expect(out[0]).toBe(0.9);
  sharpen(out, [0.3, 0.3, 0.3], neighbours, 10);
  expect(out[0]).toBe(0.2);
});

/* ------------------------------------------------------------------------------------------------ */

const LENS = mat4.perspective(new Float64Array(16), Math.PI / 4, 1, 0.5, 40) as Float64Array;

interface Camera {
  viewProj: Float64Array;
  inverse: Float64Array;
  eye: [number, number, number];
}

function camera(eye: [number, number, number], target: [number, number, number]): Camera {
  const view = mat4.lookAt(new Float64Array(16), eye, target, [0, 1, 0]);
  const viewProj = mat4.multiply(new Float64Array(16), LENS, view) as Float64Array;
  return { viewProj, inverse: mat4.invert(new Float64Array(16), viewProj) as Float64Array, eye };
}

type Pattern = (x: number, y: number) => number;

/**
 * The wall at `z = wallZ + slope × (x − pivot)`: where the ray through clip-up `(u, v)` meets it, or
 * null. A slope of zero faces the camera.
 */
function hit(
  cam: Camera,
  u: number,
  v: number,
  wallZ: number,
  slope = 0,
  pivot = 0,
): [number, number, number] | null {
  const at = (z: number): number[] => {
    const m = cam.inverse;
    const x = u * 2 - 1;
    const y = v * 2 - 1;
    const h = [0, 1, 2, 3].map(
      (r) =>
        (m[r] as number) * x +
        (m[4 + r] as number) * y +
        (m[8 + r] as number) * z +
        (m[12 + r] as number),
    );
    return [
      (h[0] as number) / (h[3] as number),
      (h[1] as number) / (h[3] as number),
      (h[2] as number) / (h[3] as number),
    ];
  };
  const near = at(-1);
  const far = at(1);
  /* The plane is z − slope × x = wallZ − slope × pivot. */
  const side = (p: number[]): number => (p[2] as number) - slope * (p[0] as number);
  const dz = side(far) - side(near);
  if (Math.abs(dz) < 1e-12) return null;
  const t = (wallZ - slope * pivot - side(near)) / dz;
  if (t < 0 || t > 1) return null;
  return [0, 1, 2].map(
    (i) => (near[i] as number) + t * ((far[i] as number) - (near[i] as number)),
  ) as [number, number, number];
}

function clipDepth(cam: Camera, p: readonly number[]): number {
  const m = cam.viewProj;
  const row = (r: number): number =>
    (m[r] as number) * (p[0] as number) +
    (m[4 + r] as number) * (p[1] as number) +
    (m[8 + r] as number) * (p[2] as number) +
    (m[12 + r] as number);
  return row(2) / row(3);
}

/** One frame of the wall, point-sampled at each texel's jittered centre. */
function render(
  cam: Camera,
  width: number,
  height: number,
  jitter: ArrayLike<number>,
  pattern: Pattern,
  wallZ = 0,
  slope = 0,
  pivot = 0,
): { scene: Float32Array; depth: Float32Array } {
  const scene = new Float32Array(width * height * 3);
  const depth = new Float32Array(width * height).fill(1);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const u = (x + 0.5 - (jitter[0] as number)) / width;
      const v = (y + 0.5 - (jitter[1] as number)) / height;
      const p = hit(cam, u, v, wallZ, slope, pivot);
      if (p === null) continue;
      const value = pattern(p[0], p[1]);
      scene.fill(value, (y * width + x) * 3, (y * width + x + 1) * 3);
      depth[y * width + x] = clipDepth(cam, p);
    }
  }
  return { scene, depth };
}

/**
 * The wall as it should look at the output size, filtered by `weight` over offsets from each output
 * pixel's centre, eight samples to a pixel. A box is what a pixel's footprint averages to; the
 * reconstruction's own Gaussian is what the resolve converges on.
 */
function ideal(
  cam: Camera,
  width: number,
  height: number,
  pattern: Pattern,
  weight: (dx: number, dy: number) => number,
  reach: number,
): Float32Array {
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let total = 0;
      for (let j = -reach * 8; j < reach * 8; j += 1) {
        for (let i = -reach * 8; i < reach * 8; i += 1) {
          const dx = (i + 0.5) / 8;
          const dy = (j + 0.5) / 8;
          const w = weight(dx, dy);
          const p = hit(cam, (x + 0.5 + dx) / width, (y + 0.5 + dy) / height, 0);
          sum += w * (p === null ? 0 : pattern(p[0], p[1]));
          total += w;
        }
      }
      out[y * width + x] = sum / total;
    }
  }
  return out;
}

const BOX = (dx: number, dy: number): number => (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 ? 1 : 0);

function frameOf(
  cam: Camera,
  previous: Camera,
  current: { scene: Float32Array; depth: Float32Array },
  previousDepth: Float32Array,
  history: Float32Array,
  sizes: { rw: number; rh: number; ow: number; oh: number },
  jitter: ArrayLike<number>,
  previousJitter: ArrayLike<number>,
  hasHistory: boolean,
  motion = new Float32Array(sizes.rw * sizes.rh * 4),
): ResolveFrame {
  return {
    renderWidth: sizes.rw,
    renderHeight: sizes.rh,
    outputWidth: sizes.ow,
    outputHeight: sizes.oh,
    scene: current.scene,
    depth: current.depth,
    motion,
    previousDepth,
    history,
    hasHistory,
    inverseViewProj: cam.inverse,
    previousViewProj: previous.viewProj,
    previousInverseViewProj: previous.inverse,
    eye: cam.eye,
    previousEye: previous.eye,
    jitter,
    previousJitter,
    quality: DEFAULT_RECON_QUALITY,
    disocclusion: DEFAULT_DISOCCLUSION,
  };
}

const STRIPES: Pattern = (x, y) => (Math.floor(x * 7 + 0.3 * y) % 2 === 0 ? 0.9 : 0.1);
const FLAT =
  (value: number): Pattern =>
  () =>
    value;

/** The weight a pixel's history carries once it is full: `(1 − alpha) / alpha`. */
const CAP = (1 - DEFAULT_RECON_QUALITY.alpha) / DEFAULT_RECON_QUALITY.alpha;

/** A four-channel history of one colour a pixel, carrying `weight`. */
function historyOf(rgb: Float32Array, weight: number): Float32Array {
  const out = new Float32Array((rgb.length / 3) * 4);
  for (let i = 0; i < rgb.length / 3; i += 1) {
    out.set(rgb.subarray(i * 3, i * 3 + 3), i * 4);
    out[i * 4 + 3] = weight;
  }
  return out;
}

/** What the resolve makes of a frame with no history, for the cases that should come to the same. */
function fresh(
  cam: Camera,
  frame: { scene: Float32Array; depth: Float32Array },
  sizes: { rw: number; rh: number; ow: number; oh: number },
): Float32Array {
  const out = new Float32Array(sizes.ow * sizes.oh * 4);
  const shown = new Float32Array(sizes.ow * sizes.oh * 3);
  const empty = new Float32Array(sizes.ow * sizes.oh * 4);
  resolveFrame(
    frameOf(cam, cam, frame, frame.depth, empty, sizes, [0, 0], [0, 0], false),
    out,
    shown,
  );
  return out;
}

/** The weight nine render texels around an output pixel carry at a ratio of one, unjittered. */
const NATIVE_WEIGHT =
  reconstructionWeight(0, 0) + 4 * reconstructionWeight(1, 0) + 4 * reconstructionWeight(1, 1);

test('with no history each output pixel is its render texels weighted by distance', () => {
  /*
   * A flat frame comes back exactly, and a varied one inside its neighbourhood's range; the weight
   * it records is the nine texels' — at a ratio of one, one at the centre and eight a pixel or a
   * diagonal away.
   */
  const cam = camera([0, 0, 5], [0, 0, 0]);
  const sizes = { rw: 12, rh: 10, ow: 12, oh: 10 };
  const flat = fresh(cam, render(cam, 12, 10, [0, 0], FLAT(0.35)), sizes);
  for (let i = 0; i < 120; i += 1) {
    expect(flat[i * 4]).toBeCloseTo(0.35, 6);
    expect(flat[i * 4 + 3]).toBeGreaterThan(1);
  }
  expect(flat[(5 * 12 + 5) * 4 + 3]).toBeCloseTo(NATIVE_WEIGHT, 5);
  /* A history that is there but must not be read — the first frame after a cut — changes nothing. */
  const flatFrame = render(cam, 12, 10, [0, 0], FLAT(0.35));
  const ignored = new Float32Array(480);
  resolveFrame(
    frameOf(
      cam,
      cam,
      flatFrame,
      flatFrame.depth,
      historyOf(new Float32Array(360).fill(0.36), CAP),
      sizes,
      [0, 0],
      [0, 0],
      false,
    ),
    ignored,
    new Float32Array(360),
  );
  expect(Array.from(ignored)).toEqual(Array.from(flat));
  const striped = fresh(cam, render(cam, 12, 10, [0, 0], STRIPES), sizes);
  for (let i = 0; i < 120; i += 1) {
    expect(striped[i * 4]).toBeGreaterThanOrEqual(0.1 - 1e-6);
    expect(striped[i * 4]).toBeLessThanOrEqual(0.9 + 1e-6);
  }
});

test('a still camera over a history that already is the picture keeps the picture', () => {
  /*
   * A smooth wall, so every interior texel is its neighbourhood's mean — the weighted and the
   * variance box's alike — and its own history is inside the box. Over stripes a variance box can
   * clip even a correct history, which is what the box is for.
   */
  const cam = camera([0, 0, 5], [0, 0, 0]);
  const sizes = { rw: 12, rh: 10, ow: 12, oh: 10 };
  const frame = render(cam, 12, 10, [0, 0], (x, y) => 0.4 + 0.05 * x + 0.02 * y);
  const history = new Float32Array(480);
  const shown = new Float32Array(360);
  resolveFrame(
    frameOf(cam, cam, frame, frame.depth, historyOf(frame.scene, CAP), sizes, [0, 0], [0, 0], true),
    history,
    shown,
  );
  for (let y = 1; y < 9; y += 1) {
    for (let x = 1; x < 11; x += 1) {
      expect(history[(y * 12 + x) * 4]).toBeCloseTo(frame.scene[(y * 12 + x) * 3] as number, 5);
    }
  }
  /* And it has gathered the cap and this frame. */
  expect(history[(5 * 12 + 5) * 4 + 3]).toBeCloseTo(CAP + NATIVE_WEIGHT, 5);
});

test('A GHOST THE NEIGHBOURHOOD DOES NOT CONTAIN IS CLIPPED OUT', () => {
  /*
   * The history holds something bright that has gone: this frame is an even grey everywhere. The
   * box of an even neighbourhood is that grey, so the history collapses onto it however much of it
   * the accumulation would have kept.
   */
  const cam = camera([0, 0, 5], [0, 0, 0]);
  const sizes = { rw: 10, rh: 8, ow: 10, oh: 8 };
  const frame = render(cam, 10, 8, [0, 0], FLAT(0.3));
  const ghost = historyOf(new Float32Array(240).fill(5), CAP);
  const history = new Float32Array(320);
  const shown = new Float32Array(240);
  resolveFrame(
    frameOf(cam, cam, frame, frame.depth, ghost, sizes, [0, 0], [0, 0], true),
    history,
    shown,
  );
  for (let i = 0; i < 80; i += 1) expect(history[i * 4]).toBeCloseTo(0.3, 6);
});

test('A SURFACE THAT WAS HIDDEN LAST FRAME TAKES NOTHING FROM WHAT HID IT', () => {
  /*
   * Last frame something stood a unit in front of the wall. Its colour is inside this frame's box —
   * the wall is striped, and the occluder was one of the stripe colours — so only the depth can say
   * it was a different surface.
   */
  const cam = camera([0, 0, 5], [0, 0, 0]);
  const sizes = { rw: 12, rh: 10, ow: 12, oh: 10 };
  const frame = render(cam, 12, 10, [0, 0], STRIPES);
  const occluder = render(cam, 12, 10, [0, 0], FLAT(0.9), 1);
  const history = new Float32Array(480);
  const shown = new Float32Array(360);
  const stale = historyOf(occluder.scene, CAP);
  resolveFrame(
    frameOf(cam, cam, frame, occluder.depth, stale, sizes, [0, 0], [0, 0], true),
    history,
    shown,
  );
  expect(Array.from(history)).toEqual(Array.from(fresh(cam, frame, sizes)));
  /* The same history at the wall's own depth is kept, which is what makes that a test of depth. */
  resolveFrame(
    frameOf(cam, cam, frame, frame.depth, stale, sizes, [0, 0], [0, 0], true),
    history,
    shown,
  );
  expect(Array.from(history)).not.toEqual(Array.from(fresh(cam, frame, sizes)));
});

test('a surface that was behind last frame’s eye, or off its picture, has no history', () => {
  const cam = camera([0, 0, 5], [0, 0, 0]);
  const sizes = { rw: 8, rh: 8, ow: 8, oh: 8 };
  const frame = render(cam, 8, 8, [0, 0], STRIPES);
  const stale = historyOf(new Float32Array(192).fill(0.5), CAP);
  const history = new Float32Array(256);
  const shown = new Float32Array(192);
  const expected = Array.from(fresh(cam, frame, sizes));
  /* Last frame looked the other way, from behind the wall. */
  const away = camera([0, 0, -5], [0, 0, -10]);
  resolveFrame(
    frameOf(cam, away, frame, frame.depth, stale, sizes, [0, 0], [0, 0], true),
    history,
    shown,
  );
  expect(Array.from(history)).toEqual(expected);
  /* Last frame looked at a part of the wall far to one side. */
  const aside = camera([40, 0, 5], [40, 0, 0]);
  resolveFrame(
    frameOf(cam, aside, frame, frame.depth, stale, sizes, [0, 0], [0, 0], true),
    history,
    shown,
  );
  expect(Array.from(history)).toEqual(expected);
});

test('a drawn object’s motion is taken where the motion target flags it', () => {
  /*
   * The camera is still, so the camera's motion is zero. One texel carries an object's motion of a
   * whole output pixel to the right, with the object's previous view depth — the wall's, five units.
   * The history's columns differ by a known amount and all sit inside the box a checkered frame
   * makes, so the difference the flag makes is the history's share of that difference.
   */
  const cam = camera([0, 0, 5], [0, 0, 0]);
  const sizes = { rw: 8, rh: 8, ow: 8, oh: 8 };
  const wall = render(cam, 8, 8, [0, 0], FLAT(0.5));
  const scene = new Float32Array(192);
  for (let i = 0; i < 64; i += 1) {
    scene.fill(((i % 8) + (i >> 3)) % 2 === 0 ? 0.4 : 0.47, i * 3, i * 3 + 3);
  }
  const frame = { scene, depth: wall.depth };
  const columns = new Float32Array(192).fill(0.43);
  for (let y = 0; y < 8; y += 1) {
    columns.fill(0.42, (y * 8 + 4) * 3, (y * 8 + 5) * 3);
    columns.fill(0.45, (y * 8 + 5) * 3, (y * 8 + 6) * 3);
  }
  const motion = new Float32Array(8 * 8 * 4);
  motion.set([1 / 8, 0, 5, 1], (4 * 8 + 4) * 4);
  const at = (4 * 8 + 4) * 4;
  /*
   * With the history's own weight, and past the cap: a history that gathered three samples' worth
   * gets three, and one that gathered fifty gets the cap's nine.
   */
  for (const [gathered, kept] of [
    [3, 3],
    [50, CAP],
  ] as const) {
    const stale = historyOf(columns, gathered);
    const still = new Float32Array(256);
    const moved = new Float32Array(256);
    const shown = new Float32Array(192);
    resolveFrame(
      frameOf(cam, cam, frame, wall.depth, stale, sizes, [0, 0], [0, 0], true),
      still,
      shown,
    );
    resolveFrame(
      frameOf(cam, cam, frame, wall.depth, stale, sizes, [0, 0], [0, 0], true, motion),
      moved,
      shown,
    );
    const share = kept / (kept + NATIVE_WEIGHT);
    expect((moved[at] as number) - (still[at] as number), String(gathered)).toBeCloseTo(
      share * (0.45 - 0.42),
      5,
    );
    expect(moved[at + 3]).toBeCloseTo(kept + NATIVE_WEIGHT, 5);
    /* An unflagged texel beside it is untouched by the object's motion. */
    expect(moved[at - 4]).toBe(still[at - 4]);
  }
});

test('THE MOTION AT AN EDGE IS THE NEARER SURFACE’S, which is the dilation', () => {
  /*
   * The pixel is on the wall, and beside it is an object a unit nearer, moving: an edge's motion
   * belongs to the nearer of the two surfaces meeting there, so the pixel reads the history where
   * the object's motion sends it.
   */
  const cam = camera([0, 0, 5], [0, 0, 0]);
  const sizes = { rw: 8, rh: 8, ow: 8, oh: 8 };
  const wall = render(cam, 8, 8, [0, 0], FLAT(0.5));
  const nearer = render(cam, 8, 8, [0, 0], FLAT(0.5), 1);
  const depth = new Float32Array(wall.depth);
  depth[4 * 8 + 5] = nearer.depth[4 * 8 + 5] as number;
  const scene = new Float32Array(192);
  for (let i = 0; i < 64; i += 1) {
    scene.fill(((i % 8) + (i >> 3)) % 2 === 0 ? 0.4 : 0.47, i * 3, i * 3 + 3);
  }
  const columns = new Float32Array(192).fill(0.43);
  for (let y = 0; y < 8; y += 1) columns.fill(0.45, (y * 8 + 5) * 3, (y * 8 + 6) * 3);
  const stale = historyOf(columns, CAP);
  const motion = new Float32Array(8 * 8 * 4);
  motion.set([1 / 8, 0, 4, 1], (4 * 8 + 5) * 4);
  const still = new Float32Array(256);
  const moved = new Float32Array(256);
  const shown = new Float32Array(192);
  const frame = { scene, depth };
  resolveFrame(frameOf(cam, cam, frame, depth, stale, sizes, [0, 0], [0, 0], true), still, shown);
  resolveFrame(
    frameOf(cam, cam, frame, depth, stale, sizes, [0, 0], [0, 0], true, motion),
    moved,
    shown,
  );
  const at = (4 * 8 + 4) * 4;
  expect(Math.abs((moved[at] as number) - (still[at] as number))).toBeGreaterThan(0.01);
});

test('WHERE A PIXEL KNOWS TOO LITTLE, THE RENDER READ AT ITS JITTERED POSITION FILLS IT', () => {
  /*
   * Four output pixels a render texel: most output pixels are two pixels from any sample, and the
   * Gaussian gives them next to nothing. Their colour is the render read bicubically where this
   * frame observed them, which on a smooth wall is the wall's colour there — checked away from the
   * border, where the read clamps.
   */
  const cam = camera([0, 0, 5], [0, 0, 0]);
  const sizes = { rw: 12, rh: 12, ow: 48, oh: 48 };
  const gradient: Pattern = (x) => 0.2 + 0.1 * x;
  const jitter = [0.4, -0.3];
  const frame = render(cam, 12, 12, jitter, gradient);
  const out = new Float32Array(48 * 48 * 4);
  resolveFrame(
    frameOf(
      cam,
      cam,
      frame,
      frame.depth,
      new Float32Array(48 * 48 * 4),
      sizes,
      jitter,
      jitter,
      false,
    ),
    out,
    new Float32Array(48 * 48 * 3),
  );
  let sparse = 0;
  for (let y = 12; y < 36; y += 1) {
    for (let x = 12; x < 36; x += 1) {
      const at = (y * 48 + x) * 4;
      if ((out[at + 3] as number) > 1e-3) continue;
      sparse += 1;
      const p = hit(cam, (x + 0.5) / 48, (y + 0.5) / 48, 0) as number[];
      expect(out[at], `${String(x)},${String(y)}`).toBeCloseTo(gradient(p[0] as number, 0), 3);
    }
  }
  expect(sparse).toBeGreaterThan(50);
});

test('LAST FRAME’S DEPTH IS READ WHERE LAST FRAME’S JITTER PUT IT', () => {
  /*
   * The pixel's surface moved three tenths of a texel, so its history lands between two of last
   * frame's texel centres — and last frame was drawn two fifths of a texel to the right, which
   * decides which of the two was nearer. Last frame's depth has a step there: an object a unit
   * nearer on the left, the wall on the right. Read with last frame's jitter, the history lands at
   * 3.8 + 0.4, on the wall, the same surface; without it, at 3.8, on the object.
   */
  const cam = camera([0, 0, 5], [0, 0, 0]);
  const sizes = { rw: 8, rh: 8, ow: 8, oh: 8 };
  const previousJitter = [0.4, 0];
  const wall = render(cam, 8, 8, previousJitter, FLAT(0.5));
  const nearer = render(cam, 8, 8, previousJitter, FLAT(0.5), 1);
  const previousDepth = new Float32Array(64);
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      previousDepth[y * 8 + x] = (x <= 3 ? nearer : wall).depth[y * 8 + x] as number;
    }
  }
  const frame = render(cam, 8, 8, [0, 0], (x) => 0.4 + 0.01 * x);
  const stale = historyOf(new Float32Array(192).fill(0.41), CAP);
  const motion = new Float32Array(8 * 8 * 4);
  motion.set([0.3 / 8, 0, 5, 1], (4 * 8 + 3) * 4);
  const out = new Float32Array(256);
  resolveFrame(
    frameOf(cam, cam, frame, previousDepth, stale, sizes, [0, 0], previousJitter, true, motion),
    out,
    new Float32Array(192),
  );
  const at = (4 * 8 + 3) * 4;
  expect(out[at + 3]).toBeCloseTo(CAP + NATIVE_WEIGHT, 5);
});

test('A SURFACE AT THE SAME DEPTH TURNED ON ITS EDGE IS NOT THE SAME SURFACE', () => {
  /*
   * Last frame's depth at this texel is the wall's, exactly — but it belongs to a plane turned almost
   * edge-on through that point. Depth alone would keep the history; the normals do not.
   */
  const cam = camera([0, 0, 5], [0, 0, 0]);
  const sizes = { rw: 8, rh: 8, ow: 8, oh: 8 };
  const frame = render(cam, 8, 8, [0, 0], (x) => 0.4 + 0.01 * x);
  const pivot = (hit(cam, 4.5 / 8, 4.5 / 8, 0) as number[])[0] as number;
  const turned = render(cam, 8, 8, [0, 0], FLAT(0.5), 0, 10, pivot);
  const stale = historyOf(new Float32Array(192).fill(0.41), CAP);
  const facing = new Float32Array(256);
  const edgeOn = new Float32Array(256);
  resolveFrame(
    frameOf(cam, cam, frame, frame.depth, stale, sizes, [0, 0], [0, 0], true),
    facing,
    new Float32Array(192),
  );
  resolveFrame(
    frameOf(cam, cam, frame, turned.depth, stale, sizes, [0, 0], [0, 0], true),
    edgeOn,
    new Float32Array(192),
  );
  const at = (4 * 8 + 4) * 4;
  expect(turned.depth[4 * 8 + 4]).toBeCloseTo(frame.depth[4 * 8 + 4] as number, 6);
  expect(facing[at + 3]).toBeGreaterThan(CAP);
  expect(edgeOn[at + 3]).toBeLessThan(CAP * 0.2 + NATIVE_WEIGHT);
});

test('THE RESOLVE BUILDS A PICTURE LARGER THAN THE ONE RENDERED, and it converges on the ideal', () => {
  /*
   * **The whole point of the tier, as a number.** A wall of diagonal stripes, each about three
   * output pixels wide, rendered at two thirds of the output a side — two render pixels a stripe,
   * point-sampled, each frame at its own jitter. One frame is the render's staircase magnified;
   * forty accumulated frames approach the output-size picture.
   *
   * Measured 2026-09-17 against the footprint-averaged ideal: 0.107 to 0.045. Against the
   * reconstruction's own Gaussian, which isolates the accumulation from the choice of filter: 0.110
   * to 0.024. **What is left is the sampling density**, not the accumulation: eighteen phases put
   * about eleven samples under the Gaussian, and a hard edge wants more — a longer history, a looser
   * clip and more frames each changed nothing.
   */
  const stripes: Pattern = (x, y) => (Math.floor(x * 2.5 + 0.3 * y) % 2 === 0 ? 0.9 : 0.1);
  const cam = camera([0, 0, 5], [0, 0, 0]);
  const sizes = { rw: 20, rh: 20, ow: 30, oh: 30 };
  const box = ideal(cam, 30, 30, stripes, BOX, 1);
  const gaussian = ideal(cam, 30, 30, stripes, reconstructionWeight, 2);
  const phases = reconJitterPhases(20, 30);
  expect(phases).toBe(18);
  const jitter = new Float32Array(2);
  const previousJitter = new Float32Array(2);
  let history: Float32Array = new Float32Array(30 * 30 * 4);
  let previousDepth: Float32Array = new Float32Array(20 * 20);
  const errorOf = (picture: Float32Array, target: Float32Array): number => {
    let sum = 0;
    for (let i = 0; i < 900; i += 1) {
      sum += Math.abs((picture[i * 4] as number) - (target[i] as number));
    }
    return sum / 900;
  };
  const first = { box: 0, gaussian: 0 };
  const last = { box: 0, gaussian: 0 };
  for (let f = 0; f < 40; f += 1) {
    jitterOffset(f, phases, jitter);
    const frame = render(cam, 20, 20, jitter, stripes);
    const next = new Float32Array(3600);
    const shown = new Float32Array(2700);
    resolveFrame(
      frameOf(cam, cam, frame, previousDepth, history, sizes, jitter, previousJitter, f > 0),
      next,
      shown,
    );
    const at = f === 0 ? first : last;
    at.box = errorOf(next, box);
    at.gaussian = errorOf(next, gaussian);
    history = next;
    previousDepth = frame.depth;
    previousJitter.set(jitter);
  }
  expect(first.box).toBeGreaterThan(0.09);
  expect(last.box).toBeLessThan(first.box * 0.5);
  expect(last.gaussian).toBeLessThan(first.gaussian * 0.3);
});

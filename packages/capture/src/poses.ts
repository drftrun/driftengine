/**
 * The camera path of a clip: where each frame was taken from, and how sure the answer is.
 *
 * **Two starts, one refinement.** Where a depth model ran, its own cameras are the start — they are
 * roughly right and cost nothing — and where it did not, the start is two-view geometry between the
 * first frame and the first one far enough from it, with every later frame placed by its view of
 * the points already triangulated. Either way the finish is a bundle adjustment: every camera and
 * every point moved together until the pictures agree, solved through the Schur complement because
 * the points outnumber the cameras by orders of magnitude.
 *
 * **A clip that only turns is reported rather than fitted.** If no pair in the clip shows parallax,
 * there is no baseline to recover: the rotations are answered, every camera is left standing at the
 * first one's place, and `parallax` is false. **Fitting it anyway is the failure that matters** —
 * the translations would be noise, every triangulated point would take its scale from them, and a
 * scene built on that is wrong in a way nothing downstream can see.
 *
 * **Scale is relative unless something in the scene has a length.** Two views fix a path up to one
 * number; a known distance between two frames' places fixes that number, and only then is the
 * answer in metres.
 *
 * **Poses are the engine's**: 3 × 4 row-major world-to-camera, y up and right handed, with the
 * camera's own axes x right, y down and z forward, which is what an image has.
 *
 * **Which world, though, depends on what was given.** Started from a depth model's cameras, the
 * answer stays in the world those cameras are in. Started from the pictures alone, there is no such
 * world to stay in — two views fix a path up to a rigid motion and a scale — so the first frame is
 * the origin and everything is measured from it.
 */
import { exactCos, exactSin } from '@driftengine/core';

import {
  createFeatureSet,
  describeFeatures,
  detectFeatures,
  matchFeatures,
  type Descriptors,
  type FeatureSet,
} from './features.ts';
import { levenbergMarquardt } from './math/dense.ts';
import { schurSolve } from './math/schur.ts';
import { relativePose, triangulate } from './twoView.ts';

export interface CaptureFrame {
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface PoseOptions {
  /** `fx`, `fy`, `cx`, `cy` of the frames as they are given. */
  readonly intrinsics: readonly [number, number, number, number];
  /** The seeded generator RANSAC draws from; a capture answers the same twice. */
  readonly random?: () => number;
  /** Corners a frame. */
  readonly budget?: number;
  /** A depth model's own cameras, 3 × 4 world-to-camera each, where it ran. */
  readonly modelPoses?: readonly ArrayLike<number>[] | null;
  /** A distance in metres between two frames' places, which makes the scale metric. */
  readonly knownLength?: {
    readonly metres: number;
    readonly from: number;
    readonly to: number;
  } | null;
}

export interface PoseResult {
  readonly count: number;
  /** Per frame, between zero and one: how much of it the answer rests on. */
  readonly confidence: Float32Array;
  /** False where the clip never moved: the rotations are answered and no baseline is claimed. */
  readonly parallax: boolean;
  readonly scale: 'metric' | 'relative';
}

/** A pair with less parallax than this, in degrees, carries no baseline. */
const TURNED = 1;
/** How many corners a frame, and how far a reprojection may sit from its observation. */
const BUDGET = 400;
const OUTLIER = 4;
/** A link that starts further than this from where it was seen is a wrong match, not a bad pose. */
const STRAY = 8;
const ITERATIONS = 12;

/** One observation of a track: which frame, and where in it. */
interface Observation {
  readonly frame: number;
  readonly x: number;
  readonly y: number;
}

/** A rotation from a rotation vector, by Rodrigues, into `out` (3 × 3 row-major). */
function rotationOf(vector: ArrayLike<number>, out: Float64Array): void {
  const x = vector[0] as number;
  const y = vector[1] as number;
  const z = vector[2] as number;
  const angle = Math.sqrt(x * x + y * y + z * z);
  if (angle < 1e-12) {
    out.set([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    return;
  }
  const c = exactCos(angle);
  const s = exactSin(angle);
  const ax = x / angle;
  const ay = y / angle;
  const az = z / angle;
  const rest = 1 - c;
  out[0] = c + ax * ax * rest;
  out[1] = ax * ay * rest - az * s;
  out[2] = ax * az * rest + ay * s;
  out[3] = ay * ax * rest + az * s;
  out[4] = c + ay * ay * rest;
  out[5] = ay * az * rest - ax * s;
  out[6] = az * ax * rest - ay * s;
  out[7] = az * ay * rest + ax * s;
  out[8] = c + az * az * rest;
}

/** `a · b` for 3 × 3 row-major matrices, into `out`. */
function compose(a: Float64Array, b: Float64Array, out: Float64Array): void {
  const held = new Float64Array(9);
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      let sum = 0;
      for (let k = 0; k < 3; k += 1) sum += (a[r * 3 + k] as number) * (b[k * 3 + c] as number);
      held[r * 3 + c] = sum;
    }
  }
  out.set(held);
}

/** A pose as the engine wants it, from a rotation and a translation. */
function writePose(
  rotation: Float64Array,
  translation: Float64Array,
  out: Float32Array,
  at: number,
): void {
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) out[at * 12 + r * 4 + c] = rotation[r * 3 + c] as number;
    out[at * 12 + r * 4 + 3] = translation[r] as number;
  }
}

/** Every frame's corners and their descriptions. */
function look(
  frames: readonly CaptureFrame[],
  budget: number,
): { features: FeatureSet[]; descriptors: Descriptors[] } {
  const features: FeatureSet[] = [];
  const descriptors: Descriptors[] = [];
  for (const frame of frames) {
    const set = createFeatureSet(budget);
    detectFeatures(frame.pixels, frame.width, frame.height, set, budget);
    features.push(set);
    descriptors.push(describeFeatures(frame.pixels, frame.width, frame.height, set));
  }
  return { features, descriptors };
}

/**
 * Tracks across the clip: a feature followed from frame to frame, at most one observation a frame.
 *
 * **Every pair within a reach of each other is matched, not only the neighbours.** A track built from
 * neighbours alone survives only as long as every step in the chain matches, and the pair that
 * carries the parallax is rarely a neighbour — measured on the test orbit, the neighbours give
 * matches in the eighties while the pair four apart, the one with seven degrees of parallax, is
 * what the reconstruction has to start from. A feature seen in two frames of the window joins their
 * tracks, which is what carries an observation across a step that failed.
 */
function follow(
  features: readonly FeatureSet[],
  descriptors: readonly Descriptors[],
  reach: number,
): Observation[][] {
  const counts = features.map((set) => set.count);
  const firstOf: number[] = [];
  let total = 0;
  for (const count of counts) {
    firstOf.push(total);
    total += count;
  }
  /* Union-find over every (frame, feature) in the clip. */
  const parent = new Int32Array(total);
  for (let i = 0; i < total; i += 1) parent[i] = i;
  const rootOf = (at: number): number => {
    let root = at;
    while ((parent[root] as number) !== root) root = parent[root] as number;
    let walk = at;
    while ((parent[walk] as number) !== walk) {
      const next = parent[walk] as number;
      parent[walk] = root;
      walk = next;
    }
    return root;
  };
  const pairs = new Int32Array(2 * BUDGET);
  for (let a = 0; a < features.length; a += 1) {
    for (let b = a + 1; b < features.length && b <= a + reach; b += 1) {
      const count = matchFeatures(
        descriptors[a] as Descriptors,
        descriptors[b] as Descriptors,
        pairs,
        {},
      );
      for (let m = 0; m < count; m += 1) {
        const left = rootOf((firstOf[a] as number) + (pairs[m * 2] as number));
        const right = rootOf((firstOf[b] as number) + (pairs[m * 2 + 1] as number));
        if (left !== right) parent[left] = right;
      }
    }
  }

  const byRoot = new Map<number, Observation[]>();
  const seenFrames = new Map<number, Set<number>>();
  const dropped = new Set<number>();
  for (let frame = 0; frame < features.length; frame += 1) {
    const set = features[frame] as FeatureSet;
    for (let i = 0; i < set.count; i += 1) {
      const root = rootOf((firstOf[frame] as number) + i);
      const frames = seenFrames.get(root) ?? new Set<number>();
      /* A track that claims two features in one frame is a wrong merge: it is dropped whole. */
      if (frames.has(frame)) {
        dropped.add(root);
        continue;
      }
      frames.add(frame);
      seenFrames.set(root, frames);
      const track = byRoot.get(root) ?? [];
      track.push({ frame, x: set.x[i] as number, y: set.y[i] as number });
      byRoot.set(root, track);
    }
  }
  const tracks: Observation[][] = [];
  for (const [root, track] of byRoot) {
    if (dropped.has(root) || track.length < 2) continue;
    tracks.push(track);
  }
  return tracks;
}

/** Where a track is seen in a frame, or null. */
function seenIn(track: readonly Observation[], frame: number): Observation | null {
  for (const one of track) if (one.frame === frame) return one;
  return null;
}

/** A camera's pose as six numbers — a rotation vector and a translation — and back. */
interface Camera {
  readonly rotation: Float64Array;
  readonly translation: Float64Array;
}

/** The projection of a point and its derivatives, in the camera's own increments. */
function project(
  camera: Camera,
  point: ArrayLike<number>,
  intrinsics: readonly [number, number, number, number],
  out: Float64Array,
  dCamera: Float64Array | null,
  dPoint: Float64Array | null,
): boolean {
  const [fx, fy, cx, cy] = intrinsics;
  const r = camera.rotation;
  const turned = [0, 0, 0];
  for (let i = 0; i < 3; i += 1) {
    turned[i] =
      (r[i * 3] as number) * (point[0] as number) +
      (r[i * 3 + 1] as number) * (point[1] as number) +
      (r[i * 3 + 2] as number) * (point[2] as number) +
      (camera.translation[i] as number);
  }
  const z = turned[2] as number;
  if (!(z > 1e-6)) return false;
  out[0] = (fx * (turned[0] as number)) / z + cx;
  out[1] = (fy * (turned[1] as number)) / z + cy;
  if (dCamera !== null) {
    /* The update is a small rotation applied on the left, so its derivative is a cross product. */
    const [X, Y, Z] = turned as [number, number, number];
    const du = [fx / z, 0, (-fx * X) / (z * z)];
    const dv = [0, fy / z, (-fy * Y) / (z * z)];
    const skew = [
      [0, Z, -Y],
      [-Z, 0, X],
      [Y, -X, 0],
    ];
    for (let p = 0; p < 3; p += 1) {
      let u = 0;
      let v = 0;
      for (let k = 0; k < 3; k += 1) {
        u += (du[k] as number) * ((skew[k] as number[])[p] as number);
        v += (dv[k] as number) * ((skew[k] as number[])[p] as number);
      }
      dCamera[p] = u;
      dCamera[6 + p] = v;
      dCamera[3 + p] = du[p] as number;
      dCamera[9 + p] = dv[p] as number;
    }
  }
  if (dPoint !== null) {
    const du = [fx / z, 0, (-fx * (turned[0] as number)) / (z * z)];
    const dv = [0, fy / z, (-fy * (turned[1] as number)) / (z * z)];
    for (let p = 0; p < 3; p += 1) {
      let u = 0;
      let v = 0;
      for (let k = 0; k < 3; k += 1) {
        u += (du[k] as number) * (r[k * 3 + p] as number);
        v += (dv[k] as number) * (r[k * 3 + p] as number);
      }
      dPoint[p] = u;
      dPoint[3 + p] = v;
    }
  }
  return true;
}

/** A frame's pose from points it can see, by Levenberg–Marquardt over six numbers. */
function poseFromPoints(
  observations: readonly { readonly point: Float64Array; readonly x: number; readonly y: number }[],
  intrinsics: readonly [number, number, number, number],
  camera: Camera,
): number {
  const start = new Float64Array(6);
  const rotation = new Float64Array(9);
  const working: Camera = { rotation: new Float64Array(9), translation: new Float64Array(3) };
  const pixel = new Float64Array(2);
  const apply = (x: Float64Array): void => {
    rotationOf(x, rotation);
    compose(rotation, camera.rotation, working.rotation);
    for (let i = 0; i < 3; i += 1) {
      working.translation[i] = (camera.translation[i] as number) + (x[3 + i] as number);
    }
  };
  const problem = {
    residuals: observations.length * 2,
    parameters: 6,
    evaluate(x: Float64Array, residuals: Float64Array, jacobian: Float64Array | null): void {
      apply(x);
      const dCamera = new Float64Array(12);
      observations.forEach((one, at) => {
        const ahead = project(
          working,
          one.point,
          intrinsics,
          pixel,
          jacobian === null ? null : dCamera,
          null,
        );
        residuals[at * 2] = ahead ? (pixel[0] as number) - one.x : 0;
        residuals[at * 2 + 1] = ahead ? (pixel[1] as number) - one.y : 0;
        if (jacobian === null) return;
        for (let p = 0; p < 6; p += 1) {
          jacobian[at * 2 * 6 + p] = ahead ? (dCamera[p] as number) : 0;
          jacobian[(at * 2 + 1) * 6 + p] = ahead ? (dCamera[6 + p] as number) : 0;
        }
      });
    },
  };
  const { cost } = levenbergMarquardt(problem, start, { maxIterations: 30 });
  apply(start);
  camera.rotation.set(working.rotation);
  camera.translation.set(working.translation);
  return cost;
}

/** Everything the adjustment moves: the cameras, the points, and which sees which. */
interface Problem {
  readonly cameras: Camera[];
  readonly points: Float64Array[];
  readonly links: {
    readonly camera: number;
    readonly point: number;
    readonly x: number;
    readonly y: number;
  }[];
}

/** The whole reconstruction scaled so the furthest camera stands `gauge` from the first. */
function rescale(problem: Problem, gauge: number): void {
  if (!(gauge > 0)) return;
  const first = centreOf(problem.cameras[0] as Camera);
  let furthest = 0;
  let span = 0;
  problem.cameras.forEach((camera, at) => {
    const centre = centreOf(camera);
    const away = Math.sqrt(
      (centre[0] - first[0]) * (centre[0] - first[0]) +
        (centre[1] - first[1]) * (centre[1] - first[1]) +
        (centre[2] - first[2]) * (centre[2] - first[2]),
    );
    if (away > span) {
      span = away;
      furthest = at;
    }
  });
  void furthest;
  if (!(span > 1e-12)) return;
  const factor = gauge / span;
  if (Math.abs(factor - 1) < 1e-12) return;
  for (const camera of problem.cameras) {
    for (let i = 0; i < 3; i += 1)
      camera.translation[i] = (camera.translation[i] as number) * factor;
  }
  for (const point of problem.points) {
    for (let i = 0; i < 3; i += 1) point[i] = (point[i] as number) * factor;
  }
}

/** The reprojection cost of a problem as it stands. */
function costOf(problem: Problem, intrinsics: readonly [number, number, number, number]): number {
  const pixel = new Float64Array(2);
  let sum = 0;
  for (const link of problem.links) {
    const camera = problem.cameras[link.camera] as Camera;
    const point = problem.points[link.point] as Float64Array;
    if (!project(camera, point, intrinsics, pixel, null, null)) continue;
    const dx = (pixel[0] as number) - link.x;
    const dy = (pixel[1] as number) - link.y;
    sum += dx * dx + dy * dy;
  }
  return sum;
}

/**
 * The bundle adjustment: cameras and points together, the points eliminated by the Schur
 * complement. The first camera is held still, since a path has no absolute place of its own.
 *
 * **And its scale is held too, which the first camera alone does not fix.** Shrinking every camera
 * and every point together reprojects to the very same pixels, so the cost cannot see it and the
 * reconstruction drifts — measured, a path that started a tenth of a metre from the truth ended
 * three quarters of one away. So after each accepted step the whole thing is scaled back to the
 * distance `gauge` between the first camera and the furthest one.
 */
function adjust(
  problem: Problem,
  intrinsics: readonly [number, number, number, number],
  iterations: number,
  gauge: number,
): void {
  const cameraCount = problem.cameras.length;
  const pointCount = problem.points.length;
  if (cameraCount < 2 || pointCount === 0) return;
  const size = 6;
  let damping = 1e-4;
  let cost = costOf(problem, intrinsics);

  const cameraBlocks = new Float64Array(cameraCount * size * size);
  const pointBlocks = new Float64Array(pointCount * 9);
  const links = new Float64Array(problem.links.length * size * 3);
  const linkCamera = Int32Array.from(problem.links.map((link) => link.camera));
  const linkPoint = Int32Array.from(problem.links.map((link) => link.point));
  const cameraGradient = new Float64Array(cameraCount * size);
  const pointGradient = new Float64Array(pointCount * 3);
  const cameraStep = new Float64Array(cameraCount * size);
  const pointStep = new Float64Array(pointCount * 3);
  const pixel = new Float64Array(2);
  const dCamera = new Float64Array(12);
  const dPoint = new Float64Array(6);
  const rotation = new Float64Array(9);

  for (let round = 0; round < iterations; round += 1) {
    cameraBlocks.fill(0);
    pointBlocks.fill(0);
    links.fill(0);
    cameraGradient.fill(0);
    pointGradient.fill(0);

    problem.links.forEach((link, at) => {
      const camera = problem.cameras[link.camera] as Camera;
      const point = problem.points[link.point] as Float64Array;
      if (!project(camera, point, intrinsics, pixel, dCamera, dPoint)) return;
      const residual = [(pixel[0] as number) - link.x, (pixel[1] as number) - link.y];
      /* The first camera is the frame everything else is measured in: its rows are zero, so its
         own block is the identity added below and its step comes back as nothing. */
      const fixed = link.camera === 0;
      for (let row = 0; row < 2; row += 1) {
        for (let p = 0; p < size; p += 1) {
          const value = fixed ? 0 : (dCamera[row * 6 + p] as number);
          cameraGradient[link.camera * size + p] =
            (cameraGradient[link.camera * size + p] as number) - value * (residual[row] as number);
          for (let q = 0; q < size; q += 1) {
            const other = fixed ? 0 : (dCamera[row * 6 + q] as number);
            cameraBlocks[(link.camera * size + p) * size + q] =
              (cameraBlocks[(link.camera * size + p) * size + q] as number) + value * other;
          }
          for (let q = 0; q < 3; q += 1) {
            links[(at * size + p) * 3 + q] =
              (links[(at * size + p) * 3 + q] as number) + value * (dPoint[row * 3 + q] as number);
          }
        }
        for (let p = 0; p < 3; p += 1) {
          const value = dPoint[row * 3 + p] as number;
          pointGradient[link.point * 3 + p] =
            (pointGradient[link.point * 3 + p] as number) - value * (residual[row] as number);
          for (let q = 0; q < 3; q += 1) {
            pointBlocks[(link.point * 3 + p) * 3 + q] =
              (pointBlocks[(link.point * 3 + p) * 3 + q] as number) +
              value * (dPoint[row * 3 + q] as number);
          }
        }
      }
    });
    /* The held camera's block would be singular; one on its diagonal leaves it where it is. */
    for (let p = 0; p < size; p += 1)
      cameraBlocks[p * size + p] = (cameraBlocks[p * size + p] as number) + 1;

    let taken = false;
    for (let attempt = 0; attempt < 8 && !taken; attempt += 1) {
      const solved = schurSolve(
        {
          cameras: cameraCount,
          cameraSize: size,
          points: pointCount,
          cameraBlocks,
          pointBlocks,
          links,
          linkCamera,
          linkPoint,
          cameraGradient,
          pointGradient,
        },
        damping,
        cameraStep,
        pointStep,
      );
      if (!solved) {
        damping *= 10;
        continue;
      }
      const heldCameras = problem.cameras.map((camera) => ({
        rotation: Float64Array.from(camera.rotation),
        translation: Float64Array.from(camera.translation),
      }));
      const heldPoints = problem.points.map((point) => Float64Array.from(point));
      for (let c = 0; c < cameraCount; c += 1) {
        const camera = problem.cameras[c] as Camera;
        rotationOf(cameraStep.subarray(c * size, c * size + 3), rotation);
        compose(rotation, camera.rotation, camera.rotation);
        for (let i = 0; i < 3; i += 1) {
          camera.translation[i] =
            (camera.translation[i] as number) + (cameraStep[c * size + 3 + i] as number);
        }
      }
      for (let p = 0; p < pointCount; p += 1) {
        const point = problem.points[p] as Float64Array;
        for (let i = 0; i < 3; i += 1)
          point[i] = (point[i] as number) + (pointStep[p * 3 + i] as number);
      }
      rescale(problem, gauge);
      const next = costOf(problem, intrinsics);
      if (next < cost) {
        cost = next;
        damping = Math.max(damping / 10, 1e-10);
        taken = true;
      } else {
        problem.cameras.forEach((camera, c) => {
          camera.rotation.set((heldCameras[c] as Camera).rotation);
          camera.translation.set((heldCameras[c] as Camera).translation);
        });
        problem.points.forEach((point, p) => point.set(heldPoints[p] as Float64Array));
        damping *= 10;
        if (damping > 1e8) return;
      }
    }
    if (!taken) return;
  }
}

/** The clip's camera path, into `out`: 3 × 4 world-to-camera a frame. */
export function estimatePoses(
  frames: readonly CaptureFrame[],
  options: PoseOptions,
  out: Float32Array,
): PoseResult {
  const count = frames.length;
  const confidence = new Float32Array(count);
  if (count === 0) return { count: 0, confidence, parallax: false, scale: 'relative' };
  const intrinsics = options.intrinsics;
  const random = options.random ?? mulberryish();
  const budget = options.budget ?? BUDGET;

  const identity = (): Camera => ({
    rotation: Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    translation: new Float64Array(3),
  });
  const cameras: Camera[] = Array.from({ length: count }, () => identity());
  writePose(cameras[0]!.rotation, cameras[0]!.translation, out, 0);
  if (count === 1) {
    confidence[0] = 1;
    return { count: 1, confidence, parallax: false, scale: 'relative' };
  }

  const { features, descriptors } = look(frames, budget);
  const tracks = follow(features, descriptors, Math.min(4, count - 1));

  /* Does the clip move at all? Every consecutive pair is asked, and one moving pair is enough. */
  let parallax = false;
  let bestPair = { at: 1, parallax: 0 };
  const scratchRotation = new Float64Array(9);
  const scratchTranslation = new Float64Array(3);
  for (let at = 1; at < count; at += 1) {
    const shared = tracks.filter(
      (track) => seenIn(track, 0) !== null && seenIn(track, at) !== null,
    );
    if (shared.length < 20) continue;
    const a = new Float64Array(shared.length * 2);
    const b = new Float64Array(shared.length * 2);
    shared.forEach((track, i) => {
      const first = seenIn(track, 0) as Observation;
      const second = seenIn(track, at) as Observation;
      a[i * 2] = first.x;
      a[i * 2 + 1] = first.y;
      b[i * 2] = second.x;
      b[i * 2 + 1] = second.y;
    });
    const answer = relativePose(a, b, shared.length, intrinsics, random, {
      rotation: scratchRotation,
      translation: scratchTranslation,
    });
    if (answer.parallax > bestPair.parallax) {
      bestPair = { at, parallax: answer.parallax };
      if (answer.model === 'essential') {
        cameras[at]!.rotation.set(scratchRotation);
        cameras[at]!.translation.set(scratchTranslation);
      }
    }
    if (answer.model === 'essential' && answer.parallax >= TURNED) parallax = true;
  }

  const given = options.modelPoses ?? null;
  if (given !== null) {
    /* The model's own cameras, taken as they are and refined below. */
    for (let at = 0; at < count; at += 1) {
      const pose = given[at];
      if (pose === undefined) continue;
      for (let r = 0; r < 3; r += 1) {
        for (let c = 0; c < 3; c += 1) cameras[at]!.rotation[r * 3 + c] = pose[r * 4 + c] as number;
        cameras[at]!.translation[r] = pose[r * 4 + 3] as number;
      }
    }
  }

  if (!parallax) {
    /* A turn: answer the rotations and claim no baseline at all. */
    for (let at = 0; at < count; at += 1) {
      if (at > 0 && given === null) turnOnly(tracks, features, intrinsics, random, at, cameras);
      cameras[at]!.translation.fill(0);
      writePose(cameras[at]!.rotation, cameras[at]!.translation, out, at);
      confidence[at] = at === 0 ? 1 : 0.5;
    }
    return { count, confidence, parallax: false, scale: 'relative' };
  }

  /* The points, from the pair that moved most, and then every frame that can see them. */
  const points = new Map<number, Float64Array>();
  triangulateTracks(tracks, cameras, intrinsics, 0, bestPair.at, points);
  const placed = new Set<number>([0, bestPair.at]);
  for (let at = 1; at < count; at += 1) {
    if (placed.has(at)) continue;
    const seen: { point: Float64Array; x: number; y: number }[] = [];
    tracks.forEach((track, id) => {
      const point = points.get(id);
      const here = seenIn(track, at);
      if (point !== undefined && here !== null) seen.push({ point, x: here.x, y: here.y });
    });
    if (seen.length >= 6 && given === null) {
      /* A frame with nothing placed yet starts from the nearest placed camera. */
      const nearest = [...placed].reduce((best, one) =>
        Math.abs(one - at) < Math.abs(best - at) ? one : best,
      );
      cameras[at]!.rotation.set(cameras[nearest]!.rotation);
      cameras[at]!.translation.set(cameras[nearest]!.translation);
      poseFromPoints(seen, intrinsics, cameras[at] as Camera);
    }
    placed.add(at);
    triangulateTracks(tracks, cameras, intrinsics, 0, at, points);
  }

  /* And everything moves together until the pictures agree. */
  const ids = [...points.keys()];
  const problem: Problem = {
    cameras,
    points: ids.map((id) => points.get(id) as Float64Array),
    links: [],
  };
  ids.forEach((id, index) => {
    for (const one of tracks[id] as Observation[]) {
      problem.links.push({ camera: one.frame, point: index, x: one.x, y: one.y });
    }
  });
  /*
   * **A track merged in error is a point that pulls every camera that sees it.** The window's
   * matching joins tracks across a missed step, which is what makes a clip's tracks long enough to
   * start from, and it joins a few that are not the same point at all. Those land far from where
   * they were seen the moment the first poses exist, so they are dropped before anything is moved —
   * measured on the orbit, keeping them left the answer further from the truth than the start was.
   */
  {
    const pixel = new Float64Array(2);
    const kept = problem.links.filter((link) => {
      const camera = problem.cameras[link.camera] as Camera;
      const point = problem.points[link.point] as Float64Array;
      if (!project(camera, point, intrinsics, pixel, null, null)) return false;
      const dx = (pixel[0] as number) - link.x;
      const dy = (pixel[1] as number) - link.y;
      return Math.sqrt(dx * dx + dy * dy) < STRAY;
    });
    const seen = new Int32Array(problem.points.length);
    for (const link of kept) seen[link.point] = (seen[link.point] as number) + 1;
    problem.links.length = 0;
    for (const link of kept) if ((seen[link.point] as number) >= 2) problem.links.push(link);
  }
  /* The distance the adjustment holds: the path's own span, which fixes the one free scale. */
  const firstCentre = centreOf(cameras[0] as Camera);
  let gauge = 0;
  for (const camera of cameras) {
    const centre = centreOf(camera);
    gauge = Math.max(
      gauge,
      Math.sqrt(
        (centre[0] - firstCentre[0]) * (centre[0] - firstCentre[0]) +
          (centre[1] - firstCentre[1]) * (centre[1] - firstCentre[1]) +
          (centre[2] - firstCentre[2]) * (centre[2] - firstCentre[2]),
      ),
    );
  }
  adjust(problem, intrinsics, ITERATIONS, gauge);

  /* What is left over per frame is how sure it is: how many of its points still land where seen. */
  const pixel = new Float64Array(2);
  const seenPer = new Int32Array(count);
  const keptPer = new Int32Array(count);
  for (const link of problem.links) {
    seenPer[link.camera] = (seenPer[link.camera] as number) + 1;
    const camera = problem.cameras[link.camera] as Camera;
    if (!project(camera, problem.points[link.point] as Float64Array, intrinsics, pixel, null, null))
      continue;
    const dx = (pixel[0] as number) - link.x;
    const dy = (pixel[1] as number) - link.y;
    if (Math.sqrt(dx * dx + dy * dy) < OUTLIER)
      keptPer[link.camera] = (keptPer[link.camera] as number) + 1;
  }

  let scale: 'metric' | 'relative' = 'relative';
  const known = options.knownLength ?? null;
  if (known !== null) {
    const from = centreOf(cameras[known.from] as Camera);
    const to = centreOf(cameras[known.to] as Camera);
    const measured = Math.sqrt(
      (to[0] - from[0]) * (to[0] - from[0]) +
        (to[1] - from[1]) * (to[1] - from[1]) +
        (to[2] - from[2]) * (to[2] - from[2]),
    );
    if (measured > 1e-9) {
      const factor = known.metres / measured;
      for (const camera of cameras) {
        for (let i = 0; i < 3; i += 1)
          camera.translation[i] = (camera.translation[i] as number) * factor;
      }
      scale = 'metric';
    }
  }

  for (let at = 0; at < count; at += 1) {
    writePose(cameras[at]!.rotation, cameras[at]!.translation, out, at);
    const seen = seenPer[at] as number;
    const kept = keptPer[at] as number;
    /* Sure where many points were seen and they still land where they were seen. */
    const share = seen === 0 ? 0 : kept / seen;
    const enough = Math.min(1, seen / 40);
    confidence[at] = at === 0 ? 1 : share * enough;
  }
  return { count, confidence, parallax: true, scale };
}

/** Where a camera stands: −Rᵀ · t. */
function centreOf(camera: Camera): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      out[c] -= (camera.rotation[r * 3 + c] as number) * (camera.translation[r] as number);
    }
  }
  return out;
}

/** The rotation of a frame that only turned, from its matches with the first. */
function turnOnly(
  tracks: readonly Observation[][],
  _features: readonly FeatureSet[],
  intrinsics: readonly [number, number, number, number],
  random: () => number,
  at: number,
  cameras: readonly Camera[],
): void {
  const shared = tracks.filter((track) => seenIn(track, 0) !== null && seenIn(track, at) !== null);
  if (shared.length < 8) return;
  const a = new Float64Array(shared.length * 2);
  const b = new Float64Array(shared.length * 2);
  shared.forEach((track, i) => {
    const first = seenIn(track, 0) as Observation;
    const second = seenIn(track, at) as Observation;
    a[i * 2] = first.x;
    a[i * 2 + 1] = first.y;
    b[i * 2] = second.x;
    b[i * 2 + 1] = second.y;
  });
  relativePose(a, b, shared.length, intrinsics, random, {
    rotation: cameras[at]!.rotation,
    translation: new Float64Array(3),
  });
}

/** Points for the tracks two placed frames both see, kept where they land in front of both. */
function triangulateTracks(
  tracks: readonly Observation[][],
  cameras: readonly Camera[],
  intrinsics: readonly [number, number, number, number],
  first: number,
  second: number,
  points: Map<number, Float64Array>,
): void {
  const ids: number[] = [];
  const a: number[] = [];
  const b: number[] = [];
  tracks.forEach((track, id) => {
    if (points.has(id)) return;
    const one = seenIn(track, first);
    const other = seenIn(track, second);
    if (one === null || other === null) return;
    ids.push(id);
    a.push(one.x, one.y);
    b.push(other.x, other.y);
  });
  if (ids.length === 0) return;
  /* The second camera, measured from the first, which is what the linear method takes. */
  const rotation = new Float64Array(9);
  const translation = new Float64Array(3);
  const firstCamera = cameras[first] as Camera;
  const secondCamera = cameras[second] as Camera;
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      let sum = 0;
      for (let k = 0; k < 3; k += 1) {
        sum +=
          (secondCamera.rotation[r * 3 + k] as number) *
          (firstCamera.rotation[c * 3 + k] as number);
      }
      rotation[r * 3 + c] = sum;
    }
  }
  for (let r = 0; r < 3; r += 1) {
    let sum = secondCamera.translation[r] as number;
    for (let k = 0; k < 3; k += 1)
      sum -= (rotation[r * 3 + k] as number) * (firstCamera.translation[k] as number);
    translation[r] = sum;
  }
  const found = new Float64Array(ids.length * 3);
  triangulate(
    Float64Array.from(a),
    Float64Array.from(b),
    ids.length,
    intrinsics,
    rotation,
    translation,
    found,
  );
  ids.forEach((id, at) => {
    const z = found[at * 3 + 2] as number;
    if (!(z > 0)) return;
    /* Back into the world the first camera is measured in. */
    const world = new Float64Array(3);
    for (let c = 0; c < 3; c += 1) {
      let sum = 0;
      for (let r = 0; r < 3; r += 1) {
        sum +=
          (firstCamera.rotation[r * 3 + c] as number) *
          ((found[at * 3 + r] as number) - (firstCamera.translation[r] as number));
      }
      world[c] = sum;
    }
    points.set(id, world);
  });
}

/** A generator for a caller that gave none: seeded, so the answer is still the same twice. */
function mulberryish(): () => number {
  let state = 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

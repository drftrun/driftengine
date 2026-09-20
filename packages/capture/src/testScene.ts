/**
 * Analytic scenes rendered on the CPU, so a capture's stages can be held to geometry that is known
 * before anything runs.
 *
 * **It ships rather than sitting in a test**, as `@driftengine/nav`'s test field does: a consumer
 * porting this, or checking a device against the reference, needs the same scenes the engine's own
 * tests use, and a fixture that exists only under `*.test.ts` cannot be imported.
 *
 * **A ray cast rather than a rasteriser.** Every pixel's answer is the distance along its own ray,
 * so the depth written beside the colour is the truth rather than an interpolation — which is what
 * makes it a fixture for depth, for triangulation and for the pose that comes out of them. The
 * shapes are boxes and planes, which intersect in closed form, and the surfaces are a procedural
 * checker with a seeded value noise on top: **a corner detector needs something to find**, and a
 * flat colour would make every later test pass for the wrong reason.
 *
 * **What it gives up**: no shadows, no reflections, one directional light. Nothing in a capture
 * cares — what is measured is where things are, not how they look.
 */

export interface TestCamera {
  readonly width: number;
  readonly height: number;
  /** `fx`, `fy`, `cx`, `cy`. */
  readonly intrinsics: readonly [number, number, number, number];
  /** 3 × 4 row-major, world to camera. */
  readonly worldToCamera: Float64Array;
}

export interface TestBox {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  readonly seed: number;
}

export interface TestPlane {
  readonly normal: readonly [number, number, number];
  /** The plane is `normal · x = offset`. */
  readonly offset: number;
  readonly seed: number;
}

export interface TestScene {
  readonly boxes: readonly TestBox[];
  readonly planes: readonly TestPlane[];
}

/** Where the light comes from, normalised, and how much of the surface is lit without it. */
const LIGHT = [0.4, 0.8, -0.45] as const;
const AMBIENT = 0.35;

/**
 * A world-to-camera for an eye looking at a target, with the world's up.
 *
 * **The camera's axes are the ones an image has**: x to the right, **y downward** and z forward, so
 * row zero of a frame is the top of it. Taking y upward instead renders every scene upside down,
 * which a test of a corner's position finds and a test of a colour does not.
 */
export function lookAt(
  eye: readonly [number, number, number],
  target: readonly [number, number, number],
  up: readonly [number, number, number] = [0, 1, 0],
): Float64Array {
  const forward = normalise([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]);
  const sideways = cross(up, forward);
  /*
   * **A camera looking straight along its own up vector is refused rather than answered.** The
   * cross product is zero there and `normalise` would hand back a zero row, so the pose comes out
   * rank-deficient: every point in the world projects to the middle of the frame and the depth map
   * behind it is nonsense that looks like a picture. Found by a fusion whose two vertical views
   * quietly agreed the sphere was somewhere else.
   */
  const span = Math.sqrt(
    sideways[0] * sideways[0] + sideways[1] * sideways[1] + sideways[2] * sideways[2],
  );
  if (!(span > 1e-9)) {
    throw new RangeError(
      'capture: a camera cannot look along its own up vector — pass an up it is not parallel to',
    );
  }
  const right = normalise(sideways);
  const down = cross(right, forward);
  const out = new Float64Array(12);
  const rows = [right, down, forward];
  for (let r = 0; r < 3; r += 1) {
    const row = rows[r] as readonly [number, number, number];
    out[r * 4] = row[0];
    out[r * 4 + 1] = row[1];
    out[r * 4 + 2] = row[2];
    out[r * 4 + 3] = -(row[0] * eye[0] + row[1] * eye[1] + row[2] * eye[2]);
  }
  return out;
}

function cross(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalise(v: readonly [number, number, number]): [number, number, number] {
  /* `Math.hypot` is one of the twenty-two the determinism gate refuses; a root of a sum is not. */
  const length = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

/*
 * A value noise over the surface, from an integer hash rather than a sine: `Math.sin` is one of the
 * twenty-two functions no two engines are obliged to agree on, and this package is inside the
 * determinism gate — a fixture that renders differently elsewhere is not a fixture.
 */
function noise(x: number, y: number, z: number, seed: number): number {
  let h =
    (Math.imul(x | 0, 0x27d4eb2d) ^
      Math.imul(y | 0, 0x165667b1) ^
      Math.imul(z | 0, 0x9e3779b1) ^
      seed) >>>
    0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** The colour of a point on a surface: a checker, a seeded speckle, and the light on it. */
function shade(
  point: readonly [number, number, number],
  normal: readonly [number, number, number],
  seed: number,
  out: Uint8Array,
  at: number,
): void {
  const checker =
    (Math.floor(point[0] * 2) + Math.floor(point[1] * 2) + Math.floor(point[2] * 2)) % 2 === 0
      ? 0.75
      : 0.35;
  const speckle = noise(
    Math.floor(point[0] * 8),
    Math.floor(point[1] * 8),
    Math.floor(point[2] * 8),
    seed,
  );
  const lambert = Math.max(0, normal[0] * LIGHT[0] + normal[1] * LIGHT[1] + normal[2] * LIGHT[2]);
  const light = AMBIENT + (1 - AMBIENT) * lambert;
  const tone = (checker * 0.7 + speckle * 0.3) * light;
  const tint = [1, 0.92, 0.86];
  for (let c = 0; c < 3; c += 1) {
    out[at + c] = Math.max(0, Math.min(255, Math.round(tone * 255 * (tint[c] as number))));
  }
  out[at + 3] = 255;
}

/** The nearest hit along a ray, or null: `[distance, normal]`. */
function hitBox(
  origin: readonly [number, number, number],
  direction: readonly [number, number, number],
  box: TestBox,
): { distance: number; normal: [number, number, number] } | null {
  let near = -Infinity;
  let far = Infinity;
  let axis = 0;
  let sign = 1;
  for (let a = 0; a < 3; a += 1) {
    const d = direction[a] as number;
    const o = origin[a] as number;
    const low = box.min[a] as number;
    const high = box.max[a] as number;
    if (Math.abs(d) < 1e-12) {
      if (o < low || o > high) return null;
      continue;
    }
    let first = (low - o) / d;
    let second = (high - o) / d;
    let towards = -1;
    if (first > second) {
      [first, second] = [second, first];
      towards = 1;
    }
    if (first > near) {
      near = first;
      axis = a;
      sign = towards;
    }
    far = Math.min(far, second);
    if (near > far) return null;
  }
  if (near <= 1e-6 || near === -Infinity) return null;
  const normal: [number, number, number] = [0, 0, 0];
  normal[axis] = sign;
  return { distance: near, normal };
}

/**
 * `scene` through `camera` into `out`, RGBA, and the distance along the camera's own axis into
 * `depth` where one
 * is given — zero where the ray met nothing.
 */
export function renderTestScene(
  scene: TestScene,
  camera: TestCamera,
  out: Uint8Array,
  depth?: Float32Array,
): void {
  const { width, height } = camera;
  const [fx, fy, cx, cy] = camera.intrinsics;
  const m = camera.worldToCamera;
  /* The eye and the camera's axes in the world: the rotation is orthonormal, so its inverse is its transpose. */
  const eye: [number, number, number] = [0, 0, 0];
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      eye[c] -= (m[r * 4 + c] as number) * (m[r * 4 + 3] as number);
    }
  }
  const point: [number, number, number] = [0, 0, 0];
  const direction: [number, number, number] = [0, 0, 0];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const a = (x + 0.5 - cx) / fx;
      const b = (y + 0.5 - cy) / fy;
      for (let c = 0; c < 3; c += 1) {
        direction[c] = a * (m[c] as number) + b * (m[4 + c] as number) + (m[8 + c] as number);
      }
      const length = Math.sqrt(
        direction[0] * direction[0] + direction[1] * direction[1] + direction[2] * direction[2],
      );
      for (let c = 0; c < 3; c += 1) direction[c] = (direction[c] as number) / length;

      let nearest = Infinity;
      let normal: [number, number, number] | null = null;
      let seed = 0;
      for (const box of scene.boxes) {
        const hit = hitBox(eye, direction, box);
        if (hit !== null && hit.distance < nearest) {
          nearest = hit.distance;
          normal = hit.normal;
          seed = box.seed;
        }
      }
      for (const plane of scene.planes) {
        const denominator =
          (plane.normal[0] as number) * direction[0] +
          (plane.normal[1] as number) * direction[1] +
          (plane.normal[2] as number) * direction[2];
        if (Math.abs(denominator) < 1e-12) continue;
        const distance =
          (plane.offset -
            ((plane.normal[0] as number) * eye[0] +
              (plane.normal[1] as number) * eye[1] +
              (plane.normal[2] as number) * eye[2])) /
          denominator;
        if (distance > 1e-6 && distance < nearest) {
          nearest = distance;
          normal = [
            denominator > 0 ? -(plane.normal[0] as number) : (plane.normal[0] as number),
            denominator > 0 ? -(plane.normal[1] as number) : (plane.normal[1] as number),
            denominator > 0 ? -(plane.normal[2] as number) : (plane.normal[2] as number),
          ];
          seed = plane.seed;
        }
      }

      const at = (y * width + x) * 4;
      if (normal === null) {
        out[at] = 0;
        out[at + 1] = 0;
        out[at + 2] = 0;
        out[at + 3] = 0;
        if (depth !== undefined) depth[y * width + x] = 0;
        continue;
      }
      for (let c = 0; c < 3; c += 1)
        point[c] = (eye[c] as number) + nearest * (direction[c] as number);
      shade(point, normal, seed, out, at);
      /* The depth a camera means is along its axis, not along the ray. */
      if (depth !== undefined) {
        const along =
          (point[0] - eye[0]) * (m[8] as number) +
          (point[1] - eye[1]) * (m[9] as number) +
          (point[2] - eye[2]) * (m[10] as number);
        depth[y * width + x] = along;
      }
    }
  }
}

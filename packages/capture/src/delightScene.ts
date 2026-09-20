/**
 * A lit scene with the answer known: what a delighting test needs and nothing else.
 *
 * **A fixture, not a renderer.** `testScene.ts` ray casts analytic boxes and planes for the
 * geometry stages; this renders a *triangle mesh* with a light in it, because delighting is asked
 * about a mesh and about shading — a cast shadow, a highlight, and an albedo that the caller knows
 * because it put it there. It is deliberately the simplest thing that can pose the question: one
 * directional light, Lambert plus a Blinn–Phong lobe, and a shadow by testing the ray to the light
 * against the same triangles.
 *
 * **It lives beside the code rather than in the test file** because three tests need it and because
 * the *relighting* gate needs to render the same scene under a second light — which is the one
 * measurement that says whether a recovered material is a material or a picture of one.
 */
import { exactExp, exactLog } from '@driftengine/core';
import type { MeshData } from '@driftengine/drft';

import type { RasterCamera } from './gaussians/project.ts';

export interface LitScene {
  readonly mesh: MeshData;
  /** Three per vertex, linear: what the recovery is measured against. */
  readonly albedo: Float32Array;
  /** One per vertex: the same. */
  readonly roughness: Float32Array;
}

export interface Light {
  /** Towards the light, unit length. */
  readonly direction: readonly [number, number, number];
  readonly colour: readonly [number, number, number];
  /** What arrives from everywhere else, so a shadowed point is dark rather than black. */
  readonly ambient: number;
}

/**
 * `scene` seen from `camera`, into `out` as linear premultiplied RGBA.
 *
 * Each pixel is one ray: the nearest triangle, its interpolated normal and albedo, Lambert against
 * the light, a shadow ray back to it, and a Blinn–Phong lobe whose width is the roughness. What a
 * real capture would have instead of the shadow ray is a shadow in the photograph; what matters for
 * the test is that the shadow is *there* and that the caller knows where.
 */
export function renderLit(
  scene: LitScene,
  camera: RasterCamera,
  light: Light,
  out: Float32Array,
): void {
  const { width, height, intrinsics } = camera;
  const [fx, fy, cx, cy] = intrinsics;
  const m = camera.worldToCamera;
  const eye = cameraCentre(m);
  out.fill(0);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const ahead = toWorld(m, [(x + 0.5 - cx) / fx, (y + 0.5 - cy) / fy, 1]);
      const direction = normalise([
        (ahead[0] as number) - (eye[0] as number),
        (ahead[1] as number) - (eye[1] as number),
        (ahead[2] as number) - (eye[2] as number),
      ]);
      const hit = nearestHit(scene.mesh, eye, direction, 1e-4, Infinity);
      const pixel = (y * width + x) * 4;
      if (hit === null) {
        out[pixel + 3] = 1;
        continue;
      }
      const point = [0, 1, 2].map(
        (k) => (eye[k] as number) + hit.distance * (direction[k] as number),
      ) as [number, number, number];
      const normal = interpolate(scene.mesh, scene.mesh.normals, hit, 3);
      const albedo = interpolate(scene.mesh, scene.albedo, hit, 3);
      const rough = interpolate(scene.mesh, scene.roughness, hit, 1)[0] as number;

      const facing = dot(normal, light.direction);
      /* A ray back to the light, against the same triangles: a hard shadow with a hard edge. */
      const lit =
        facing > 0 &&
        nearestHit(scene.mesh, point, light.direction as [number, number, number], 1e-3, 40) ===
          null;
      const toEye = normalise([
        (eye[0] as number) - point[0],
        (eye[1] as number) - point[1],
        (eye[2] as number) - point[2],
      ]);
      const half = normalise([
        toEye[0] + (light.direction[0] as number),
        toEye[1] + (light.direction[1] as number),
        toEye[2] + (light.direction[2] as number),
      ]);
      /*
       * **A Blinn–Phong lobe that widens *and weakens* as the surface roughens.** The exponent
       * alone is not enough: with a strength that does not fall, a rough surface comes out with an
       * enormous broad highlight over the whole of it, which is not a surface anybody has seen. It
       * also made this fixture's floor 1.77 times too bright through a delighting that was working
       * correctly — the light really was mostly specular, so the recovery was right about a scene
       * nobody would build.
       */
      const square = rough * rough;
      const shininess = 2 / Math.max(1e-4, square * square) - 2;
      /*
       * **Normalised, which is the difference between a rough surface and a bright one.** A lobe
       * that widens without losing energy puts a broad sheen over the whole of a rough surface,
       * and it is not a small effect: measured here, the dark channels of a matte blue floor came
       * back nearly twice as bright through a delighting that was working correctly. The peak of a
       * Blinn–Phong lobe scales as (n + 2) / 8π, and 0.04 is a dielectric's reflectance head-on.
       */
      const strength = (0.04 * (shininess + 2)) / (8 * Math.PI);
      /*
       * The power by the engine's own reproducible pair rather than `Math.pow`, which the
       * determinism gate refuses — two engines may differ by a unit in the last place, and a
       * fixture that renders differently on two machines is a test nobody can compare.
       */
      const facingHalf = Math.max(0, dot(normal, half));
      const lobe = facingHalf > 0 ? exactExp(shininess * exactLog(facingHalf)) : 0;
      const specular = lit ? lobe * strength : 0;

      for (let c = 0; c < 3; c += 1) {
        const irradiance = (lit ? facing : 0) * (light.colour[c] as number) + light.ambient;
        out[pixel + c] =
          (albedo[c] as number) * irradiance + specular * (light.colour[c] as number);
      }
      out[pixel + 3] = 1;
    }
  }
}

/** Where a camera stands, from its 3 × 4 world-to-camera. */
export function cameraCentre(worldToCamera: Float64Array): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      out[c] -= (worldToCamera[r * 4 + c] as number) * (worldToCamera[r * 4 + 3] as number);
    }
  }
  return out;
}

/** A camera-space point in the world: the projection run backwards. */
function toWorld(
  m: Float64Array,
  view: readonly [number, number, number],
): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      out[c] += (m[r * 4 + c] as number) * ((view[r] as number) - (m[r * 4 + 3] as number));
    }
  }
  return out;
}

export interface MeshHit {
  readonly triangle: number;
  readonly distance: number;
  /** Barycentric weights of the three corners, in order. */
  readonly weights: readonly [number, number, number];
}

/** The nearest triangle a ray meets, by Möller–Trumbore over every one of them. */
export function nearestHit(
  mesh: MeshData,
  origin: readonly [number, number, number],
  direction: readonly [number, number, number],
  near: number,
  far: number,
): MeshHit | null {
  let best: MeshHit | null = null;
  const triangles = mesh.indices.length / 3;
  for (let face = 0; face < triangles; face += 1) {
    const a = mesh.indices[face * 3] as number;
    const b = mesh.indices[face * 3 + 1] as number;
    const c = mesh.indices[face * 3 + 2] as number;
    const e1 = corner(mesh, b, a);
    const e2 = corner(mesh, c, a);
    const p = cross(direction, e2);
    const determinant = dot(e1, p);
    if (Math.abs(determinant) < 1e-12) continue;
    const inverse = 1 / determinant;
    const t = [0, 1, 2].map(
      (k) => (origin[k] as number) - (mesh.positions[a * 3 + k] as number),
    ) as [number, number, number];
    const u = dot(t, p) * inverse;
    if (u < 0 || u > 1) continue;
    const q = cross(t, e1);
    const v = dot(direction, q) * inverse;
    if (v < 0 || u + v > 1) continue;
    const distance = dot(e2, q) * inverse;
    if (distance < near || distance > far) continue;
    if (best !== null && distance >= best.distance) continue;
    best = { triangle: face, distance, weights: [1 - u - v, u, v] };
  }
  return best;
}

/** A per-vertex attribute at a hit, by its barycentric weights. */
export function interpolate(
  mesh: MeshData,
  values: ArrayLike<number>,
  hit: MeshHit,
  stride: number,
): number[] {
  const out = new Array<number>(stride).fill(0);
  for (let corner = 0; corner < 3; corner += 1) {
    const vertex = mesh.indices[hit.triangle * 3 + corner] as number;
    const weight = hit.weights[corner] as number;
    for (let k = 0; k < stride; k += 1) {
      out[k] = (out[k] as number) + weight * (values[vertex * stride + k] as number);
    }
  }
  return out;
}

function corner(mesh: MeshData, to: number, from: number): [number, number, number] {
  return [0, 1, 2].map(
    (k) => (mesh.positions[to * 3 + k] as number) - (mesh.positions[from * 3 + k] as number),
  ) as [number, number, number];
}

function cross(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): [number, number, number] {
  return [
    (a[1] as number) * (b[2] as number) - (a[2] as number) * (b[1] as number),
    (a[2] as number) * (b[0] as number) - (a[0] as number) * (b[2] as number),
    (a[0] as number) * (b[1] as number) - (a[1] as number) * (b[0] as number),
  ];
}

function dot(a: readonly number[], b: readonly number[]): number {
  return (
    (a[0] as number) * (b[0] as number) +
    (a[1] as number) * (b[1] as number) +
    (a[2] as number) * (b[2] as number)
  );
}

function normalise(v: readonly number[]): [number, number, number] {
  const length = Math.sqrt(
    (v[0] as number) * (v[0] as number) +
      (v[1] as number) * (v[1] as number) +
      (v[2] as number) * (v[2] as number),
  );
  const scale = length > 0 ? 1 / length : 0;
  return [(v[0] as number) * scale, (v[1] as number) * scale, (v[2] as number) * scale];
}

import { raySphere as coreRaySphere } from '@driftengine/core';

/**
 * Turning a click into an entity.
 *
 * **A ray against bounding volumes, not an identifier buffer read back from the device.** The ray
 * is exact enough for selection, works on both backends, needs no readback, and — the reason it is
 * this and not the other — can be tested with no renderer at all. An identifier buffer is
 * pixel-exact for complex geometry and costs a readback; it is worth adding only if a real scene
 * shows the ray picking the wrong thing, which is a measurement rather than a guess.
 *
 * **Nothing picked is -1 rather than 0**, because 0 is an entity.
 */

/** A ray through a screen position, from a view-projection inverse. */
export function screenRay(
  x: number,
  y: number,
  width: number,
  height: number,
  invViewProj: Float32Array,
  outOrigin: Float32Array,
  outDirection: Float32Array,
): void {
  const ndcX = (x / width) * 2 - 1;
  const ndcY = 1 - (y / height) * 2;

  const unproject = (z: number, out: Float32Array): void => {
    const m = invViewProj;
    const px =
      (m[0] as number) * ndcX + (m[4] as number) * ndcY + (m[8] as number) * z + (m[12] as number);
    const py =
      (m[1] as number) * ndcX + (m[5] as number) * ndcY + (m[9] as number) * z + (m[13] as number);
    const pz =
      (m[2] as number) * ndcX + (m[6] as number) * ndcY + (m[10] as number) * z + (m[14] as number);
    const pw =
      (m[3] as number) * ndcX + (m[7] as number) * ndcY + (m[11] as number) * z + (m[15] as number);
    const k = pw === 0 ? 0 : 1 / pw;
    out[0] = px * k;
    out[1] = py * k;
    out[2] = pz * k;
  };

  const far = new Float32Array(3);
  /* Reversed-Z: the near plane is 1 and the far plane 0. See core's depthConvention. */
  unproject(1, outOrigin);
  unproject(0, far);

  const dx = (far[0] as number) - (outOrigin[0] as number);
  const dy = (far[1] as number) - (outOrigin[1] as number);
  const dz = (far[2] as number) - (outOrigin[2] as number);
  const length = Math.hypot(dx, dy, dz);
  const k = length > 0 ? 1 / length : 0;
  outDirection[0] = dx * k;
  outDirection[1] = dy * k;
  outDirection[2] = dz * k;
}

export interface PickCandidate {
  entity: number;
  /** Centre and radius of the bounding sphere, in world space. */
  cx: number;
  cy: number;
  cz: number;
  radius: number;
}

const CENTRE = new Float32Array(3);

/**
 * Distance along the ray to the sphere, or -1 when it misses or is behind.
 *
 * **Core's arithmetic, in this file's shape.** This held its own copy until 2026-09-16, which is
 * the thing this repository keeps paying for: a rule stated twice is a rule until somebody edits
 * one copy. Core exports `raySphere` now — it had to, for the gizmo — so what is left here is the
 * `PickCandidate` unpacking, which is genuinely this module's.
 */
export function raySphere(
  origin: Float32Array,
  direction: Float32Array,
  candidate: PickCandidate,
): number {
  CENTRE[0] = candidate.cx;
  CENTRE[1] = candidate.cy;
  CENTRE[2] = candidate.cz;
  return coreRaySphere(origin, direction, CENTRE, candidate.radius);
}

/** The nearest candidate the ray hits, or -1. */
export function pickNearest(
  origin: Float32Array,
  direction: Float32Array,
  candidates: readonly PickCandidate[],
): number {
  let best = -1;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = raySphere(origin, direction, candidate);
    if (distance < 0 || distance >= bestDistance) continue;
    bestDistance = distance;
    best = candidate.entity;
  }
  return best;
}

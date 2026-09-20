import { mat4 } from 'gl-matrix';
import { expect, test } from 'vitest';

import { newScreenSpaceHit, traceScreenSpaceRay } from '../screenSpaceReflection.ts';
import { GI_SOURCE_FIELD, GI_SOURCE_SCREEN, newIndirectResult } from './chain.ts';
import { composeGlobalField, createGlobalField } from './globalField.ts';
import { createProbeVisibility } from './probeVolume.ts';
import { reflectDirection, reflectionCone, traceReflection } from './reflection.ts';
import { GI_SCREEN_MARCH } from './traceScreen.ts';

import type { GiResources } from './chain.ts';
import type { FieldSource } from './globalField.ts';
import { ProbeGrid } from '../probeGrid.ts';

/**
 * **What this file is for: a reflection that leaves the frame keeps reflecting, and the six
 * published scenes do not move.**
 *
 * The second of those is this wave's first global constraint and it is the one that can be broken
 * by accident. A fallback that is on by default changes every reflective surface in every scene
 * ever shipped, and it changes them for the better, which is exactly why nobody would notice until
 * a pixel gate failed.
 */

const WALL_Z = -5;

function project(x: number, y: number, z: number, uv: Float32Array): boolean {
  if (z >= -1e-4) return false;
  const u = 0.5 + x / (-z * 2);
  const v = 0.5 + y / (-z * 2);
  if (u < 0 || u > 1 || v < 0 || v > 1) return false;
  uv[0] = u;
  uv[1] = v;
  return true;
}

function sceneDistance(u: number, v: number): number {
  return Math.hypot((u - 0.5) * -WALL_Z * 2, (v - 0.5) * -WALL_Z * 2, -WALL_Z);
}

function sphereField(radius: number, half: number, resolution: number): FieldSource {
  const field = new Float32Array(resolution ** 3);
  const step = (2 * half) / (resolution - 1);
  for (let iz = 0; iz < resolution; iz++) {
    for (let iy = 0; iy < resolution; iy++) {
      for (let ix = 0; ix < resolution; ix++) {
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

function resources(
  centre: readonly [number, number, number] = [0, 0, -3],
  radius = 1,
): GiResources {
  const field = createGlobalField(49, 2);
  const at = mat4.fromTranslation(new Float32Array(16), centre as never) as Float32Array;
  composeGlobalField(
    [{ source: sphereField(radius, radius * 2, 25), transform: at }],
    [0, 0, 0],
    4,
    field,
  );
  const grid = new ProbeGrid({ origin: [-8, -8, -8], spacing: [16, 16, 16], counts: [2, 2, 2] });
  const probeValues = new Float32Array(grid.layers * 3);
  for (let layer = 0; layer < grid.layers; layer++) probeValues[layer * 3 + 2] = 1;
  return {
    eye: [0, 0, 0],
    project,
    sceneDistance,
    screenRadiance: (_u, _v, out) => {
      out[0] = 1;
      out[1] = 0;
      out[2] = 0;
    },
    field,
    fieldRadiance: (_x, _y, _z, out) => {
      out[0] = 0;
      out[1] = 1;
      out[2] = 0;
    },
    grid,
    visibility: createProbeVisibility(8, grid.layers),
    probeValues,
    probeChannels: 3,
  };
}

test('a direction is mirrored about a normal, and a grazing one stays grazing', () => {
  const out = new Float32Array(3);
  reflectDirection([0, 0, -1], [0, 0, 1], out);
  expect(Array.from(out)).toEqual([0, 0, 1]);

  reflectDirection([1, -1, 0], [0, 1, 0], out);
  expect(out[0]).toBeCloseTo(1, 6);
  expect(out[1]).toBeCloseTo(1, 6);

  /* A direction already leaving the surface is mirrored back into it, which is what a mirror
     does and is the caller's business to not ask for. It is not special-cased into a lie. */
  reflectDirection([0, 1, 0], [0, 1, 0], out);
  expect(out[1]).toBeCloseTo(-1, 6);

  /*
   * **A normal that is not unit length is normalised first**, because an interpolated one rarely
   * is. Without that the mirror term is scaled by the square of the length: a normal of length two
   * turns a reflection into a direction seven times too long, which a march then takes as a step
   * length and walks through everything in front of it.
   */
  reflectDirection([0, 0, -1], [0, 0, 2], out);
  expect(Array.from(out)).toEqual([0, 0, 1]);
});

test('ROUGHNESS WIDENS THE CONE, monotonically and from a mirror at zero', () => {
  expect(reflectionCone(0)).toBe(0);
  let previous = 0;
  for (const roughness of [0.1, 0.25, 0.5, 0.75, 1]) {
    const angle = reflectionCone(roughness);
    expect(angle).toBeGreaterThan(previous);
    previous = angle;
  }
  /* A fully rough surface gathers over a hemisphere's worth of lobe, not over the whole sphere. */
  expect(reflectionCone(1)).toBeLessThan(Math.PI / 2);
});

test('A REFLECTION THAT LEAVES THE FRAME KEEPS REFLECTING, instead of fading to nothing', () => {
  /*
   * **The failure this closes is the one screen-space reflection is always criticised for**: a
   * mirror near the edge of the picture reflects less and less of the world as the camera turns,
   * until it reflects nothing and reads as a matte surface that was polished a moment ago. The
   * world field has the answer and the chain already knows how to ask it.
   */
  const shared = { ...resources([0, 0, -3], 1), sceneDistance: () => Infinity };
  const out = newIndirectResult();
  traceReflection(
    /* A mirror facing the eye at seven metres out; the view reflects straight back at the
       sphere three metres in front of the camera, which only the world field knows about. */
    { point: [0, 0, -7], normal: [0, 0, 1], view: [0, 0, -1], roughness: 0 },
    shared,
    { fallback: true },
    out,
  );
  expect(out.source).toBe(GI_SOURCE_FIELD);
  expect(out.radiance[1]).toBeGreaterThan(0);
});

test('THE EXISTING BEHAVIOUR IS UNCHANGED WHEN THE FALLBACK IS OFF, so the scenes do not move', () => {
  /*
   * **This wave's first global constraint, asserted rather than assumed.** A fallback on by default
   * changes every reflective surface in every scene ever shipped — for the better, which is exactly
   * why nobody would notice until a pixel gate failed. With it off, the answer has to be the frame's
   * own march and nothing else, which this checks against `traceScreenSpaceRay` directly rather
   * than against a remembered number.
   */
  const shared = resources();
  const out = newIndirectResult();
  /* A floor: the view grazes it, so the reflection carries on toward the wall the frame drew. */
  const surface = {
    point: [0, 0, -2] as const,
    normal: [0, 1, 0] as const,
    view: [0, 0, -1] as const,
    roughness: 0,
  };

  traceReflection(surface, shared, { fallback: false }, out);
  expect(out.source).toBe(GI_SOURCE_SCREEN);
  expect(out.radiance[0]).toBeGreaterThan(0.9);
  /* Nothing from the world or the probes reached the answer. */
  expect(out.blend[1]).toBe(0);
  expect(out.blend[2]).toBe(0);

  /* And a ray the frame cannot answer stays unanswered rather than falling through. */
  const away = { ...surface, view: [1, 0, -0.05] as const };
  traceReflection(away, shared, { fallback: false }, out);
  expect(out.hit).toBe(false);
  expect(out.blend[0]).toBe(0);
  expect(out.blend[1]).toBe(0);
  expect(out.blend[2]).toBe(0);

  /*
   * **And a hit near the edge of the frame comes back unfaded**, which is what "unchanged" has to
   * mean. The chain scales the screen's contribution by how close its path came to the border,
   * because it has two levels behind it to give the rest to; with the fallback off there is
   * nothing behind it, and a caller that has applied its own fade since this effect shipped would
   * otherwise get it applied twice — a mirror half as bright near the edge of every picture.
   */
  const grazing = { ...surface, point: [1.8, 0, -2] as const };
  traceReflection(grazing, shared, { fallback: false }, out);
  expect(out.hit).toBe(true);
  expect(out.blend[0]).toBe(1);
  expect(out.radiance[0]).toBeCloseTo(1, 5);

  /* The same ray the old way, to pin that "unchanged" means this and not something adjacent. */
  const direct = newScreenSpaceHit();
  const mirrored = new Float32Array(3);
  reflectDirection(away.view, away.normal, mirrored);
  const found = traceScreenSpaceRay(
    away.point,
    mirrored,
    shared.eye,
    GI_SCREEN_MARCH,
    project,
    sceneDistance,
    direct,
  );
  expect(found).toBe(false);
});

test('a rough surface reaches the world through a wider cone than a mirror does', () => {
  const shared = { ...resources([0, 0, -3], 1), sceneDistance: () => Infinity };
  const mirror = newIndirectResult();
  const satin = newIndirectResult();
  /* Aimed to graze the sphere by 30 cm, which only a cone reaches across. */
  const surface = {
    point: [0, 1.3, -7] as const,
    normal: [0, 0, 1] as const,
    view: [0, 0, -1] as const,
  };

  traceReflection({ ...surface, roughness: 0 }, shared, { fallback: true }, mirror);
  traceReflection({ ...surface, roughness: 0.6 }, shared, { fallback: true }, satin);

  expect(mirror.blend[1]).toBe(0);
  expect(satin.blend[1]).toBeGreaterThan(0);
});

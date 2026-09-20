import { mat4 } from 'gl-matrix';
import { expect, test } from 'vitest';

import { ProbeGrid } from '../probeGrid.ts';
import { composeGlobalField, createGlobalField } from './globalField.ts';
import {
  GI_SOURCE_FIELD,
  GI_SOURCE_PROBES,
  GI_SOURCE_SCREEN,
  newIndirectResult,
  traceIndirect,
} from './chain.ts';
import { createProbeVisibility } from './probeVolume.ts';

import type { FieldSource } from './globalField.ts';
import type { GiResources, IndirectRay } from './chain.ts';

/**
 * **What this file is for: there is no fourth case, and there is no seam.**
 *
 * The chain's whole claim is that indirect light always has an answer whose error is bounded, and
 * two things have to be true for that. The last level must always succeed, or there is a fourth
 * case nobody wrote and it renders as whatever the buffer held. And the levels must *blend*, or
 * every boundary between them is a line across the picture — and every one of these boundaries
 * moves with the camera, because the frame does and the cascades are centred on it.
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

/** A sphere's exact field, the same oracle the other two trace tests use. */
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

/** Screen red, field green, probes blue — so the source of an answer is readable in its colour. */
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

function ray(
  point: readonly [number, number, number],
  direction: readonly [number, number, number],
): IndirectRay {
  return { point, normal: [0, 0, 1], direction, coneAngle: 0 };
}

test('a ray the screen can answer reports the screen', () => {
  const out = newIndirectResult();
  traceIndirect(ray([0, 0, -2], [0, 0, -1]), resources(), out);
  expect(out.hit).toBe(true);
  expect(out.source).toBe(GI_SOURCE_SCREEN);
  expect(out.radiance[0]).toBeGreaterThan(0.9);
});

test('a ray the screen cannot answer but the field can reports the field', () => {
  const out = newIndirectResult();
  /* Behind the eye's frame entirely: the screen refuses on the first sample, and the sphere at
     three metres down -z is in the field, so the world answers. */
  traceIndirect(ray([0, 0, -8], [0, 0, 1]), resources(), out);
  expect(out.hit).toBe(true);
  expect(out.source).toBe(GI_SOURCE_FIELD);
  expect(out.radiance[1]).toBeGreaterThan(0.9);
});

test('a ray neither can answer reports the probes', () => {
  const out = newIndirectResult();
  /* Straight up and out of everything: off the frame, and out of the outermost cascade. */
  traceIndirect(ray([0, 0, -8], [0, 1, 0]), resources(), out);
  expect(out.hit).toBe(true);
  expect(out.source).toBe(GI_SOURCE_PROBES);
  expect(out.radiance[2]).toBeGreaterThan(0.9);
});

test('SOURCE 2 ALWAYS SUCCEEDS, so there is no fourth case and no undefined result', () => {
  /*
   * **The whole architecture rests on this one line.** If the last level could fail there would be
   * a ray with no answer, and a shader has nothing to put in that pixel but whatever the buffer
   * held — which is the previous frame, and reads as a flicker rather than as a gap. A probe
   * volume cannot fail: it is an interpolation between measurements, with no ray to escape and no
   * frame to leave, and `visibleProbes` falls back to the nearest probe even when every visibility
   * weight has crushed to zero.
   *
   * Six hundred rays over a deterministic fan, including ones aimed at nothing at all.
   */
  const shared = resources();
  const out = newIndirectResult();
  let weights = 0;
  for (let i = 0; i < 600; i++) {
    const a = (i * 2.399963) % (Math.PI * 2);
    const b = ((i * 0.7548) % 1) * Math.PI - Math.PI / 2;
    const from = [Math.cos(a) * 6, Math.sin(b) * 6, Math.sin(a) * 6 - 3] as const;
    traceIndirect(
      ray(from, [Math.cos(b) * Math.cos(a), Math.sin(b), Math.cos(b) * Math.sin(a)]),
      shared,
      out,
    );

    expect(out.hit).toBe(true);
    for (let c = 0; c < 3; c++) expect(Number.isFinite(out.radiance[c] as number)).toBe(true);
    /* **No level contributes a negative share.** The sum is one by construction — the probes take
       the remainder — so the sum alone would pass a field that took more than the screen left it,
       with the probes made to balance the books by going negative. */
    for (let c = 0; c < 3; c++) expect(out.blend[c] as number).toBeGreaterThanOrEqual(0);
    const total = (out.blend[0] as number) + (out.blend[1] as number) + (out.blend[2] as number);
    expect(total).toBeCloseTo(1, 6);
    weights += total;
  }
  expect(weights).toBeCloseTo(600, 3);
});

test('THE SOURCES BLEND AT THE FRAME EDGE rather than switching across it', () => {
  /*
   * **The frame edge is a line that moves with the camera**, so a hard switch there is not a static
   * artefact a viewer learns to ignore — it is a seam that sweeps across the picture whenever the
   * camera turns. `screenEdgeFade` already exists for exactly this, in the reflection that first
   * met it; the chain weights the screen's answer by it and gives the remainder to the level below.
   *
   * Walked along the frame's edge, asserting the answer changes smoothly rather than in one step.
   */
  const shared = resources();
  const out = newIndirectResult();
  let previous: number | null = null;
  let worst = 0;
  /* A fan of rays from the eye's axis out past the edge of the frame. */
  for (let x = 0; x < 2.6; x += 0.01) {
    traceIndirect(ray([x, 0, -2], [0, 0, -1]), shared, out);
    const screen = out.blend[0] as number;
    if (previous !== null) worst = Math.max(worst, Math.abs(screen - previous));
    previous = screen;
  }
  /* A hard switch would step the full way in one hundredth of a metre. */
  expect(worst).toBeLessThan(0.2);
  /* And the walk really did cross the edge, rather than staying inside it. */
  traceIndirect(ray([0, 0, -2], [0, 0, -1]), shared, out);
  expect(out.blend[0]).toBeGreaterThan(0.9);
  traceIndirect(ray([2.5, 0, -2], [0, 0, -1]), shared, out);
  expect(out.blend[0]).toBeLessThan(0.1);
});

test('THE LEVELS SHARE ONE UNIT OF LIGHT, and the screen is served before the field', () => {
  /*
   * **The three levels are shares of one answer, not three answers added up.** A ray near the edge
   * of the frame is half answered by the screen, and what the world field is then asked for is the
   * *other half* — not a whole one. Adding them would put more light into a pixel than arrived at
   * it, brightest exactly along the band where the screen is fading, which reads as a halo around
   * the edge of the picture.
   *
   * The sphere stands where this ray will graze it, so both levels genuinely answer at once —
   * which none of the tests above arranged, and which is why this one exists.
   */
  const shared = resources([1.8, 0, -3.5], 0.8);
  const out = newIndirectResult();
  traceIndirect(ray([1.8, 0, -2], [0, 0, -1]), shared, out);

  expect(out.blend[0]).toBeGreaterThan(0.05);
  expect(out.blend[0]).toBeLessThan(0.95);
  expect(out.blend[1]).toBeGreaterThan(0);
  expect((out.blend[0] as number) + (out.blend[1] as number)).toBeLessThanOrEqual(1 + 1e-6);
  for (let c = 0; c < 3; c++) expect(out.blend[c] as number).toBeGreaterThanOrEqual(0);
});

test('A FIELD HIT NEAR THE OUTERMOST CASCADE IS ONLY PART OF THE ANSWER', () => {
  /*
   * **The cascade's outer face is centred on the camera, so it moves with it.** A hit right on it
   * is a hit the field barely had the information for — one step further and the march would have
   * escaped and answered nothing at all. Trusting it fully makes that boundary a switch, and a
   * switch on a surface that follows the camera is a seam sweeping through the scene as it moves.
   *
   * A half-metre sphere at 7.6 m against an outermost cascade reaching 8 m: the hit lands 0.9 m
   * inside a 1.6 m band, so the field is worth a little over half and the probes carry the rest.
   */
  const shared = resources([7.6, 0, 0], 0.5);
  const out = newIndirectResult();
  /* From the sky side, so the screen has nothing to say and the field is the first to answer. */
  traceIndirect(ray([2, 0, 0], [1, 0, 0]), { ...shared, sceneDistance: () => Infinity }, out);

  expect(out.blend[0]).toBe(0);
  expect(out.blend[1]).toBeGreaterThan(0);
  expect(out.blend[1]).toBeLessThan(1);
  expect(out.blend[2]).toBeGreaterThan(0);
  expect(out.radiance[1]).toBeGreaterThan(0);
  expect(out.radiance[2]).toBeGreaterThan(0);
});

test("A ROUGH SURFACE'S CONE REACHES THE WORLD MARCH, or roughness does nothing at all", () => {
  /*
   * The ray grazes a unit sphere by 30 cm. A mirror finds nothing there and the probes answer; a
   * rough surface's cone reaches across the gap and the field does. If the ray's cone angle never
   * reached the march, both would report the probes and roughness would be a parameter with no
   * effect anywhere in the chain.
   */
  const shared = { ...resources([0, 0, -3], 1), sceneDistance: () => Infinity };
  const mirror = newIndirectResult();
  const rough = newIndirectResult();
  const from = [0, 1.3, -7] as const;

  traceIndirect({ ...ray(from, [0, 0, 1]), coneAngle: 0 }, shared, mirror);
  traceIndirect({ ...ray(from, [0, 0, 1]), coneAngle: 0.3 }, shared, rough);

  expect(mirror.source).toBe(GI_SOURCE_PROBES);
  expect(rough.source).toBe(GI_SOURCE_FIELD);
});

test('a chain with no visibility volume still answers, and answers from the probes', () => {
  const shared = { ...resources(), visibility: null };
  const out = newIndirectResult();
  traceIndirect(ray([0, 0, -8], [0, 1, 0]), shared, out);
  expect(out.hit).toBe(true);
  expect(out.source).toBe(GI_SOURCE_PROBES);
});

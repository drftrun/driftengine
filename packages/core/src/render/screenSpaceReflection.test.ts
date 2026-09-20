import { describe, expect, test } from 'vitest';
import { mat4 } from 'gl-matrix';

import {
  CLIP_Y_FLIP,
  ReflectiveSurface,
  newScreenSpaceHit,
  projectToUv,
  screenEdgeFade,
  towardCameraFade,
  traceScreenSpaceRay,
} from './screenSpaceReflection.ts';

/**
 * The whole scene these tests march through: an eye at the origin looking down `-z`, and a wall.
 *
 * **Orthographic on purpose.** What is under test is the march — where it samples, when it calls a
 * crossing a hit, and how close the refinement gets — and none of that depends on the projection.
 * A perspective one would make every expected number an arctangent and hide an arithmetic error
 * behind a plausible one. The renderer hands the shader a real projection; this hands it the
 * simplest one that can be read at a glance.
 *
 * `u` and `v` run 0 to 1 across four metres each way, so a point at `x = 0` sits at `u = 0.5`.
 */
const SPAN = 4;

function orthographic(
  wallZ: number,
  options: { ledgeFrom?: number; ledgeZ?: number; gap?: [number, number] } = {},
) {
  const project = (x: number, y: number, _z: number, uv: Float32Array): boolean => {
    const u = 0.5 + x / SPAN;
    const v = 0.5 + y / SPAN;
    if (u < 0 || u > 1 || v < 0 || v > 1) return false;
    uv[0] = u;
    uv[1] = v;
    return true;
  };
  /* The eye is at the origin looking down -z, so the distance to the wall along any of these
     parallel rays is just how far away the wall is. `Infinity` is sky: nothing was drawn. */
  const sceneDistance = (u: number): number => {
    const gap = options.gap;
    if (gap !== undefined && u >= gap[0] && u <= gap[1]) return Infinity;
    if (options.ledgeFrom !== undefined && u > options.ledgeFrom) {
      return Math.abs(options.ledgeZ ?? 0);
    }
    return Math.abs(wallZ);
  };
  return { project, sceneDistance };
}

const MARCH = { steps: 8, reachM: 16, thicknessM: 0.5 };

describe('the march', () => {
  test('finds a wall the ray runs into', () => {
    const { project, sceneDistance } = orthographic(-10);
    const hit = newScreenSpaceHit();

    const found = traceScreenSpaceRay(
      [0, 0, -2],
      [0, 0, -1],
      [0, 0, 0],
      MARCH,
      project,
      sceneDistance,
      hit,
    );

    expect(found).toBe(true);
    /* The ray starts two metres out and the wall is ten, so it travels eight. Within a tenth of a
       metre, which is what six halvings of the bracket the quadratic spacing lands it in buys. */
    expect(found).toBe(true);
    expect(Math.abs(hit.distanceM - 8)).toBeLessThan(0.1);
    expect(hit.u).toBeCloseTo(0.5, 3);
    expect(hit.v).toBeCloseTo(0.5, 3);
  });

  test('refines the crossing to better than the step it was found in', () => {
    /* A wall at 9.3 puts the true crossing at 7.3, inside a bracket that is nearly three metres
       wide out there — the samples are spaced by the square of their index, so the far ones are
       coarse. A march that reported the sample rather than refining would answer 9. */
    const { project, sceneDistance } = orthographic(-9.3);
    const hit = newScreenSpaceHit();

    traceScreenSpaceRay([0, 0, -2], [0, 0, -1], [0, 0, 0], MARCH, project, sceneDistance, hit);

    expect(hit.distanceM).toBeGreaterThan(7.2);
    expect(hit.distanceM).toBeLessThan(7.4);
  });

  test('misses where the frame drew nothing at all', () => {
    /* Sky. A march that treated an untouched depth as a surface would reflect the whole world in
       the horizon, which is the failure that looks like a working effect from one angle. */
    const project = (x: number, y: number, _z: number, uv: Float32Array): boolean => {
      uv[0] = 0.5 + x / SPAN;
      uv[1] = 0.5 + y / SPAN;
      return true;
    };
    const hit = newScreenSpaceHit();

    const found = traceScreenSpaceRay(
      [0, 0, -2],
      [0, 0, -1],
      [0, 0, 0],
      MARCH,
      project,
      () => Infinity,
      hit,
    );

    expect(found).toBe(false);
  });

  test('stops where the ray leaves the frame rather than sampling the border', () => {
    /*
     * **The failure this prevents is the one that looks most like the effect working.** A sample
     * off the edge of the frame clamps to the border texel, so a reflection acquires a smear of
     * whatever is at the edge of the screen and it drags as the camera turns. The temporal row
     * records the same trap in its own reprojection.
     *
     * The wall is there and the ray would reach it; it exits the frame first.
     *
     * **Counted rather than inferred from the outcome, since 2026-09-16.** Asserting only that
     * there is no hit passed a march that clamped every out-of-frame sample to the border and went
     * on reading it: the crossing it then found was rejected by the *thickness* check instead,
     * because the refinement bails out on the same failed projection and leaves the coarse gap in
     * place. Two guards, one assertion, and the one the test is named for was the one not being
     * checked. The count is the claim: after the ray leaves the frame, the frame is not sampled.
     */
    const { project, sceneDistance } = orthographic(-10);
    const hit = newScreenSpaceHit();
    let samples = 0;
    const counted = (u: number, v: number): number => {
      samples++;
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      return sceneDistance(u);
    };

    const found = traceScreenSpaceRay(
      [1.9, 0, -2],
      /* Mostly sideways: two more metres of x leaves the four-metre span. */
      [0.9, 0, -0.436],
      [0, 0, 0],
      MARCH,
      project,
      counted,
      hit,
    );

    expect(found).toBe(false);
    /* The first sample is already past the edge, so the frame is never read at all. */
    expect(samples).toBe(0);
  });

  test('does not hit a surface it only ever passes behind', () => {
    /*
     * **The classic false positive, and the reason `thicknessM` exists.** A depth buffer holds one
     * distance per pixel and says nothing about how thick the thing at that distance is. A march
     * that treats it as an infinitely deep wall reports a hit for every ray that ends up behind
     * *anything*, so a reflection acquires a copy of whatever is between it and the far plane.
     *
     * This ray starts already behind the wall and stays there: there is no crossing to find.
     */
    const { project, sceneDistance } = orthographic(-4);
    const hit = newScreenSpaceHit();

    const found = traceScreenSpaceRay(
      [0, 0, -6],
      [0, 0, -1],
      [0, 0, 0],
      MARCH,
      project,
      sceneDistance,
      hit,
    );

    expect(found).toBe(false);
  });

  test('rejects a crossing it only made by sliding onto something in the foreground', () => {
    /*
     * **The other half of what `thicknessM` is for, and the one that shows.** The ray is running
     * ten metres out along a far wall when its screen position slides onto a ledge three metres
     * from the eye. It is suddenly seven metres behind what that pixel holds, so a march that
     * called any positive gap a hit would paste the ledge into the reflection — a copy of the
     * foreground smeared along wherever a ray happened to graze past it.
     *
     * The refinement narrows the bracket and cannot narrow the gap, because the ledge is genuinely
     * that far in front. Rejected on the thickness, which is what this asserts.
     */
    const { project, sceneDistance } = orthographic(-10, { ledgeFrom: 0.6, ledgeZ: -3 });
    const hit = newScreenSpaceHit();

    const found = traceScreenSpaceRay(
      [0, 0, -2],
      [0.1, 0, -0.995],
      [0, 0, 0],
      MARCH,
      project,
      sceneDistance,
      hit,
    );

    expect(found).toBe(false);
  });

  test('never samples its own origin, which is what makes a grazing ray clean', () => {
    /*
     * The first sample is a whole step along the ray. At zero the ray is exactly on the surface it
     * left, so the comparison is a coin toss on rounding — and every pixel of a reflective floor
     * takes it at once, which is the speckle a screen-space effect is remembered for.
     */
    const { project, sceneDistance } = orthographic(-10);
    const hit = newScreenSpaceHit();

    const found = traceScreenSpaceRay(
      /* Starting exactly on the wall, running along it. */
      [0, 0, -10],
      [1, 0, 0],
      [0, 0, 0],
      MARCH,
      project,
      sceneDistance,
      hit,
    );

    expect(found).toBe(false);
  });

  test('crosses a gap in the geometry and lands on what is beyond it', () => {
    /*
     * A doorway, a skyline, anything the frame drew nothing behind. A march that treated an
     * untouched depth as a wall would stop at the near edge of every gap; one that treated it as a
     * miss would give up there. It is neither: nothing to be behind, so the ray carries on.
     */
    const { project, sceneDistance } = orthographic(-10, { gap: [0.54, 0.66] });
    const hit = newScreenSpaceHit();

    const found = traceScreenSpaceRay(
      [0, 0, -2],
      [0.1, 0, -0.995],
      [0, 0, 0],
      MARCH,
      project,
      sceneDistance,
      hit,
    );

    expect(found).toBe(true);
    /* Past the gap, which ends at 0.66. */
    expect(hit.u).toBeGreaterThan(0.66);
  });
});

describe('the fades, which are most of what stops it looking wrong', () => {
  test('a hit in the middle of the frame is not faded and one at the edge is gone', () => {
    expect(screenEdgeFade(0.5, 0.5, 0.1)).toBeCloseTo(1, 6);
    expect(screenEdgeFade(0, 0.5, 0.1)).toBeCloseTo(0, 6);
    expect(screenEdgeFade(1, 0.5, 0.1)).toBeCloseTo(0, 6);
    expect(screenEdgeFade(0.5, 0, 0.1)).toBeCloseTo(0, 6);
    expect(screenEdgeFade(0.5, 1, 0.1)).toBeCloseTo(0, 6);
  });

  test('the fade is monotone across the band, so an edge does not appear inside it', () => {
    let last = 0;
    for (let u = 0; u <= 0.1; u += 0.01) {
      const fade = screenEdgeFade(u, 0.5, 0.1);
      expect(fade).toBeGreaterThanOrEqual(last - 1e-6);
      last = fade;
    }
    expect(last).toBeCloseTo(1, 6);
  });

  test('a ray pointing back at the eye fades out, because nothing can be behind the camera', () => {
    /*
     * A reflection whose ray comes back toward the viewer can only ever find what is between the
     * surface and the eye, which is usually nothing and occasionally the viewer's own geometry. It
     * is the artefact that reads as a smear of the foreground pasted onto a floor.
     */
    const view: [number, number, number] = [0, 0, -1];
    expect(towardCameraFade([0, 0, -1], view)).toBeCloseTo(1, 6);
    expect(towardCameraFade([0, 0, 1], view)).toBeCloseTo(0, 6);
    expect(towardCameraFade([1, 0, 0], view)).toBeGreaterThan(0);
    expect(towardCameraFade([1, 0, 0], view)).toBeLessThan(1);
  });
});

describe('the surface a consumer declares', () => {
  test('follows a pose set every frame without allocating a matrix per frame', () => {
    const surface = new ReflectiveSurface({
      center: [0, 0, 0],
      halfExtents: [4, 4, 0.5],
      forward: [0, -1, 0],
      up: [0, 0, 1],
    });
    const before = surface.worldToSurface;

    surface.setPose([5, 0, 0], [0, -1, 0], [0, 0, 1]);

    expect(surface.worldToSurface).toBe(before);
    expect(surface.surfaceToWorld[12]).toBeCloseTo(5, 6);
  });

  test('defaults to a mirror that reaches a few metres and is not a perfect one', () => {
    const surface = new ReflectiveSurface({
      center: [0, 0, 0],
      halfExtents: [4, 4, 0.5],
      forward: [0, -1, 0],
      up: [0, 0, 1],
    });

    expect(surface.strength).toBeGreaterThan(0);
    expect(surface.strength).toBeLessThanOrEqual(1);
    expect(surface.reachM).toBeGreaterThan(0);
    expect(surface.thicknessM).toBeGreaterThan(0);
    expect(surface.steps).toBeGreaterThan(1);
  });

  test('carries the projection axis, which decides which surfaces inside the box reflect', () => {
    const surface = new ReflectiveSurface({
      center: [0, 0, 0],
      halfExtents: [4, 4, 0.5],
      forward: [0, -3, 0],
      up: [0, 0, 1],
    });

    expect([...surface.axis]).toEqual([0, -1, 0]);
  });
});

describe('projecting a ray sample back onto the screen', () => {
  function camera(): Float32Array {
    const view = mat4.create();
    mat4.lookAt(view, [0, 0, 8], [0, 0, 0], [0, 1, 0]);
    const projection = mat4.create();
    mat4.perspective(projection, Math.PI / 3, 16 / 9, 0.1, 100);
    const out = mat4.create();
    mat4.multiply(out, projection, view);
    return out as Float32Array;
  }

  test('puts a point in front of the camera inside the frame', () => {
    const uv = new Float32Array(2);

    expect(projectToUv(camera(), 0, 0, 0, uv)).toBe(true);
    expect(uv[0]).toBeCloseTo(0.5, 6);
    expect(uv[1]).toBeCloseTo(0.5, 6);
  });

  test('refuses a point behind the eye rather than mirroring it through the origin', () => {
    /*
     * **Dividing clip space by a negative `w` mirrors the point.** A march that projected a sample
     * behind the camera would get a perfectly ordinary screen position somewhere else in the frame
     * and read a depth that has nothing to do with the ray — a reflection of a place the ray never
     * went. `decalScissor` records the same trap for the bound it computes.
     */
    const uv = new Float32Array(2);

    expect(projectToUv(camera(), 0, 0, 20, uv)).toBe(false);
  });

  test('refuses a point outside the frame rather than clamping to its border', () => {
    const uv = new Float32Array(2);

    expect(projectToUv(camera(), 40, 0, 0, uv)).toBe(false);
  });

  test('the Y flip is a matrix, and it is the whole difference between the two backends', () => {
    /*
     * One shader on both backends, with the framebuffer's own Y sense premultiplied into the
     * matrix it is handed. A convention held in a branch inside the shader is a convention held in
     * two places, which is what `DEPTH_01_TO_CLIP_Y_DOWN` exists to say.
     */
    const raw = camera();
    const flipped = mat4.create();
    mat4.multiply(flipped, CLIP_Y_FLIP, raw);

    const up = new Float32Array(2);
    const down = new Float32Array(2);
    /* Off the axis, since a point at the middle of the frame is its own mirror image. */
    expect(projectToUv(raw, 0, 2, 0, up)).toBe(true);
    expect(projectToUv(flipped as Float32Array, 0, 2, 0, down)).toBe(true);

    expect(down[0]).toBeCloseTo(up[0] ?? 0, 6);
    expect(down[1]).toBeCloseTo(1 - (up[1] ?? 0), 6);
    expect(up[1]).toBeGreaterThan(0.5);
  });
});

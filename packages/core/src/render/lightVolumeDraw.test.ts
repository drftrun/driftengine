import { REVERSED_DEPTH } from './depthConvention.ts';
import { describe, expect, it } from 'vitest';
import { mat4, vec4 } from 'gl-matrix';

import type { Atmosphere } from './atmosphere.ts';
import {
  DEPTH_01_TO_CLIP,
  DEPTH_01_TO_CLIP_Y_DOWN,
  createResolvedLightVolume,
  resolveLightVolume,
  volumeMediumGain,
} from './lightVolumeDraw.ts';

/**
 * The inside test is the whole reason this arithmetic is on the CPU, and it is what decides
 * which half of the hull a draw keeps. Getting it wrong does not fail: it draws a beam that
 * disappears when somebody walks into it, or one that is marched twice and arrives at double
 * brightness. Both look like a shader problem.
 *
 * Every expectation here is hand-derived from the geometry rather than from the function.
 */
describe('resolveLightVolume', () => {
  it('puts the camera in the volume’s own space', () => {
    /*
     * The placement `demo/gildedChamber` uses, reduced to its rotation: local +Z becomes world
     * -Y, which is the direction daylight falls, and the apex sits ten metres up. A camera at
     * the origin is therefore ten metres down the axis and nothing off it.
     */
    const model = new Float32Array([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 10, 0, 1]);
    const out = resolveLightVolume(model, [0, 0, 0], 20, 0.5, createResolvedLightVolume());

    expect(out.cameraLocal[0]).toBeCloseTo(0);
    expect(out.cameraLocal[1]).toBeCloseTo(0);
    expect(out.cameraLocal[2]).toBeCloseTo(10);
  });

  it('calls a camera inside the cone inside it', () => {
    /* Five along the axis, one off it: the cone is 0.5 * 5 = 2.5 wide there. */
    const out = resolveLightVolume(mat4.create(), [1, 0, 5], 20, 0.5, createResolvedLightVolume());
    expect(out.inside).toBe(true);
  });

  it('calls a camera past the aperture outside it', () => {
    /* Three off the axis at five along, where the cone is 2.5. Just outside, not far outside. */
    const out = resolveLightVolume(mat4.create(), [3, 0, 5], 20, 0.5, createResolvedLightVolume());
    expect(out.inside).toBe(false);
  });

  it('calls a camera behind the apex outside it, however near the axis', () => {
    /*
     * A cone opening along +Z has a mirror nappe behind its apex, and a test written against
     * `|z|` would call this inside — which turns a viewer standing *behind* a beam into one
     * standing in it, and the hull is then culled the wrong way round. The bound here goes
     * negative instead, so the radial comparison rejects it on its own and the explicit
     * `axial >= 0` says so rather than leaving it to be noticed.
     */
    const out = resolveLightVolume(mat4.create(), [0, 0, -5], 20, 0.5, createResolvedLightVolume());
    expect(out.inside).toBe(false);
  });

  it('calls a camera beyond the reach outside it', () => {
    const out = resolveLightVolume(mat4.create(), [0, 0, 25], 20, 0.5, createResolvedLightVolume());
    expect(out.inside).toBe(false);
  });
});

/**
 * The clamp's reconstruction, which had no test and was therefore re-derived wrong twice.
 *
 * **The rule is that both backends must land on the same point in the volume's own space, each
 * from its own screen coordinates.** The shader is one piece of GLSL and reads
 * `vec4(uv * 2 - 1, stored, 1)` without knowing which backend it is on, so everything that
 * differs has to be in the matrix the CPU hands it — and what differs is which way the
 * framebuffer's Y runs, not which clip space the scene was drawn in.
 *
 * **Why the WebGPU screen position below is `(1 - ndc.y) / 2` and not `(1 + ndc.y) / 2`.** The
 * scene is drawn through `CLIP_CORRECTION`, which negates Y, and then through the generated
 * vertex stage, which negates it again — naga runs without `--keep-coordinate-space`, so every
 * WGSL entry point this engine ships ends with `gl_Position.y = -gl_Position.y`. The two cancel,
 * the rasteriser uses the raw matrix's own Y, and the only thing left is that WebGPU's
 * framebuffer origin is the top-left. That last fact is the whole content of
 * `DEPTH_01_TO_CLIP_Y_DOWN`.
 *
 * Every number here is derived from the projection rather than from the constants under test.
 */
describe('the scene-depth clamp reconstructs one point from either backend', () => {
  const projection = mat4.perspective(mat4.create(), (48 * Math.PI) / 180, 16 / 9, 0.3, 300);
  const view = mat4.lookAt(mat4.create(), [9.5, 3.4, 11], [0, 5.4, 0], [0, 1, 0]);
  const viewProjection = mat4.multiply(mat4.create(), projection, view);
  /* `demo/gildedChamber`'s placement: local +Z becomes world -Y, apex ten metres up. */
  const model = new Float32Array([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 10, 0, 1]);

  /* Deliberately well off the frame's horizontal centre line, which is the one place a mirrored
     reconstruction is still right. */
  const world = vec4.fromValues(1.2, 7.8, -2.4, 1);
  const clip = vec4.transformMat4(vec4.create(), world, viewProjection);
  const ndc = [clip[0] / clip[3], clip[1] / clip[3], clip[2] / clip[3]] as const;
  /*
   * Stored depth is [0,1] on both: WebGL2 by its depth range, WebGPU by `CLIP_CORRECTION`. Which
   * *end* is near depends on the convention, and it is read rather than copied — a test holding
   * its own idea of that agrees with itself and disagrees with the buffer, which is the one
   * failure the pair of matrices below exists to prevent.
   */
  const stored = REVERSED_DEPTH ? (1 - (ndc[2] as number)) / 2 : ((ndc[2] as number) + 1) / 2;

  /** `inverse(viewProjection * model) * remap`, built exactly as both renderers build it. */
  const depthToLocal = (remap: Float32Array | Iterable<number>): mat4 => {
    const out = mat4.create();
    mat4.multiply(out, viewProjection, model);
    mat4.invert(out, out);
    return mat4.multiply(out, out, remap as never);
  };

  /** What the shader computes: the matrix applied to its screen position, then divided through. */
  const reconstruct = (matrix: mat4, u: number, v: number): readonly number[] => {
    const hit = vec4.transformMat4(
      vec4.create(),
      vec4.fromValues(u * 2 - 1, v * 2 - 1, stored, 1),
      matrix,
    );
    return [hit[0] / hit[3], hit[1] / hit[3], hit[2] / hit[3]];
  };

  /* The answer, from the volume's own transform and never from the reconstruction. */
  const expected = ((): readonly number[] => {
    const inverseModel = mat4.create();
    mat4.invert(inverseModel, model as never);
    const local = vec4.transformMat4(vec4.create(), world, inverseModel);
    return [local[0] / local[3], local[1] / local[3], local[2] / local[3]];
  })();

  it('lands on the point from a framebuffer whose Y runs up', () => {
    const got = reconstruct(depthToLocal(DEPTH_01_TO_CLIP), (ndc[0] + 1) / 2, (ndc[1] + 1) / 2);
    for (const axis of [0, 1, 2]) expect(got[axis]).toBeCloseTo(expected[axis] ?? 0, 3);
  });

  it('lands on the same point from a framebuffer whose Y runs down', () => {
    const got = reconstruct(
      depthToLocal(DEPTH_01_TO_CLIP_Y_DOWN),
      (ndc[0] + 1) / 2,
      (1 - ndc[1]) / 2,
    );
    for (const axis of [0, 1, 2]) expect(got[axis]).toBeCloseTo(expected[axis] ?? 0, 3);
  });

  it('lands somewhere else when a top-down framebuffer is given the bottom-up matrix', () => {
    /*
     * The regression itself, stated as a fact rather than as an absence. Sharing one matrix
     * mirrors the reconstruction about the middle of the frame, and the beam that comes out is
     * plausible — shorter by `cos(2t)` along its own ray, which reads as a shaft that stops
     * before the ceiling it fell through rather than as anything obviously broken.
     */
    const got = reconstruct(depthToLocal(DEPTH_01_TO_CLIP), (ndc[0] + 1) / 2, (1 - ndc[1]) / 2);
    expect(got[1]).not.toBeCloseTo(expected[1] ?? 0, 1);
  });
});

describe('how much of a beam the air is thick enough to show', () => {
  const air: Atmosphere = {
    fogColor: [0.5, 0.6, 0.7],
    fogDensity: 0.02,
    fogHeightFalloff: 0,
    fogBaseY: 0,
    underwater: null,
  };
  /** A volume standing at height `y`, which is all this reads from a model matrix. */
  const at = (y: number): Float32Array => {
    const m = mat4.create();
    mat4.translate(m, m, [12, y, -30]);
    return m as Float32Array;
  };

  it('draws the beam as authored once the air is as thick as it was written for', () => {
    expect(volumeMediumGain(air, at(0), 0.02)).toBe(1);
    expect(volumeMediumGain(air, at(0), 0.005), 'and no further past it').toBe(1);
  });

  it('dims it in proportion as the air clears', () => {
    /* A quarter of the density it was written for is a quarter of the beam. */
    expect(volumeMediumGain(air, at(0), 0.08)).toBeCloseTo(0.25, 12);
  });

  it('draws nothing at all in clear air', () => {
    /* Not a faint beam: zero, so the caller's own `strength <= 0` guard skips the draw. A beam
       with no medium to light is not a dim beam, it is no beam. */
    expect(volumeMediumGain({ ...air, fogDensity: 0 }, at(0), 0.02)).toBe(0);
  });

  it('is disabled by a density of zero rather than dividing by it', () => {
    expect(volumeMediumGain(air, at(0), 0)).toBe(1);
  });

  /**
   * The valley case, which is why the height comes from the volume and not from the camera.
   *
   * With a reciprocal scale height of 0.1 per metre and a base at zero, the haze at 20 m is
   * `0.02 · e⁻²`, and `e⁻²` is 0.1353352832. A car down in it is lit and the same headlights on
   * the ridge above are not, which a camera-height reading would get exactly backwards for
   * whichever of the two the camera is standing beside.
   */
  it('reads the air where the volume is, not where the camera is', () => {
    const layered: Atmosphere = { ...air, fogHeightFalloff: 0.1 };
    expect(volumeMediumGain(layered, at(0), 0.02)).toBe(1);
    expect(volumeMediumGain(layered, at(20), 0.02)).toBeCloseTo(0.1353352832, 9);
  });
});

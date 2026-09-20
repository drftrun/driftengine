import { mat4 } from 'gl-matrix';
import { describe, expect, test } from 'vitest';

import {
  GLOBAL_FIELD_BLEND,
  composeGlobalField,
  createGlobalField,
  sampleGlobalField,
} from './globalField.ts';

import type {
  FieldSource,
  GlobalField,
  GlobalFieldCascade,
  GlobalFieldInstance,
} from './globalField.ts';

/**
 * **What this file is for: the four ways a composed field is wrong, and the one that crawls.**
 *
 * A field that puts an object somewhere other than where its transform says; a union that takes
 * the wrong one of two overlapping solids; a field that changes under the camera when nothing in
 * the world changed; and a sample that jumps as it crosses from one cascade into the next. The
 * third is the one nobody catches by looking, because it looks like noise rather than like a bug.
 */

/**
 * A sphere's exact distance field, sampled onto a grid. The oracle, not a bake.
 *
 * Analytic rather than `bakeObjectSdf`, for two reasons and the second is the binding one: this
 * package cannot import `@driftengine/assets`, and a composition tested against a baked field
 * would be testing two things at once. Every number below is a closed form.
 */
function sphereField(radius: number, half: number, resolution: number): FieldSource {
  const dims: [number, number, number] = [resolution, resolution, resolution];
  const field = new Float32Array(resolution ** 3);
  const step = (2 * half) / (resolution - 1);
  for (let iz = 0; iz < resolution; iz++) {
    for (let iy = 0; iy < resolution; iy++) {
      for (let ix = 0; ix < resolution; ix++) {
        const distance =
          Math.hypot(-half + ix * step, -half + iy * step, -half + iz * step) - radius;
        field[ix + resolution * (iy + resolution * iz)] = distance;
      }
    }
  }
  return { field, dims, bounds: new Float32Array([-half, -half, -half, half, half, half]) };
}

/**
 * A field of a slab filling `x < 0` inside its box, which is the one shape a rotation can see.
 *
 * A sphere is invariant under every rotation, so an instance sampled through the wrong inverse
 * reads exactly the same as one sampled through the right inverse. `probeGrid.ts` records the
 * same class of blindness about a room that is symmetric on the axis it is being tested on.
 */
function slabField(half: number, resolution: number): FieldSource {
  const dims: [number, number, number] = [resolution, resolution, resolution];
  const field = new Float32Array(resolution ** 3);
  const step = (2 * half) / (resolution - 1);
  for (let iz = 0; iz < resolution; iz++) {
    for (let iy = 0; iy < resolution; iy++) {
      for (let ix = 0; ix < resolution; ix++) {
        field[ix + resolution * (iy + resolution * iz)] = -half + ix * step;
      }
    }
  }
  return { field, dims, bounds: new Float32Array([-half, -half, -half, half, half, half]) };
}

function at(x: number, y: number, z: number): Float32Array {
  return mat4.fromTranslation(new Float32Array(16), [x, y, z]) as Float32Array;
}

function instance(source: FieldSource, transform: Float32Array): GlobalFieldInstance {
  return { source, transform };
}

describe('an instance lands where its transform says', () => {
  test('a sphere five metres along x reports its own radius from five metres along x', () => {
    const field = createGlobalField(33, 1);
    composeGlobalField([instance(sphereField(1, 2, 17), at(5, 0, 0))], [0, 0, 0], 8, field);

    expect(sampleGlobalField(field, 5, 0, 0)).toBeCloseTo(-1, 1);
    expect(sampleGlobalField(field, 6, 0, 0)).toBeCloseTo(0, 1);
    expect(sampleGlobalField(field, 6.5, 0, 0)).toBeCloseTo(0.5, 1);
  });

  test('AND A ROTATED INSTANCE SAMPLES THROUGH THE INVERSE, not through the transform', () => {
    /*
     * **The transform every implementation gets wrong first**, and a sphere cannot see it: a world
     * point has to be carried *into* the object's space to index the object's field, which is the
     * inverse of the matrix that places the object. Using the transform itself puts the object at
     * the mirror of where it was asked to stand, and for a rotation by a quarter turn that is a
     * different quarter turn — visible only on geometry that is not symmetric about the axis.
     *
     * The slab is solid where its own `x` is negative. Turned a quarter turn about `y`, object `x`
     * points along world `-z`, so the solid half is the one at world `+z`.
     */
    const turn = mat4.fromYRotation(new Float32Array(16), Math.PI / 2) as Float32Array;
    const field = createGlobalField(33, 1);
    composeGlobalField([instance(slabField(2, 17), turn)], [0, 0, 0], 8, field);

    expect(sampleGlobalField(field, 0, 0, 1)).toBeLessThan(0);
    expect(sampleGlobalField(field, 0, 0, -1)).toBeGreaterThan(0);
    /* And the magnitude is the distance to the plane, which the quarter turn does not change. */
    expect(sampleGlobalField(field, 0, 0, 1)).toBeCloseTo(-1, 1);
    expect(sampleGlobalField(field, 0, 0, -1)).toBeCloseTo(1, 1);
  });

  test('a uniformly scaled instance reports distances in world metres, not in object ones', () => {
    const scaled = mat4.fromScaling(new Float32Array(16), [2, 2, 2]) as Float32Array;
    const field = createGlobalField(33, 1);
    composeGlobalField([instance(sphereField(1, 2, 17), scaled)], [0, 0, 0], 8, field);
    /* A unit sphere at twice the size has radius two, so three metres out is one metre clear. */
    expect(sampleGlobalField(field, 3, 0, 0)).toBeCloseTo(1, 1);
  });

  test('a non-uniformly scaled instance is refused rather than silently wrong', () => {
    /*
     * A distance is not preserved by a non-uniform scale — there is no factor to multiply by,
     * because the factor depends on the direction to the nearest surface, which is what the field
     * does not record. Refusing says so; a scale applied anyway produces a field that is a
     * distance nowhere and looks like one everywhere.
     */
    const squashed = mat4.fromScaling(new Float32Array(16), [2, 1, 1]) as Float32Array;
    const field = createGlobalField(17, 1);
    expect(() =>
      composeGlobalField([instance(sphereField(1, 2, 9), squashed)], [0, 0, 0], 8, field),
    ).toThrow(/uniform/i);
  });
});

describe('the union of two solids is the nearer surface', () => {
  test('TWO OVERLAPPING INSTANCES TAKE THE MINIMUM, which is what makes the union a union', () => {
    /*
     * **The maximum is the intersection and the sum is neither**, and both read as a plausible
     * field: every value has the right sign in the middle of a solid and out in the open, so the
     * only place the choice shows is between two objects that overlap — where a maximum carves a
     * groove along the seam of every wall that meets another wall.
     */
    const field = createGlobalField(33, 1);
    const source = sphereField(1, 2, 17);
    composeGlobalField(
      [instance(source, at(-0.7, 0, 0)), instance(source, at(0.7, 0, 0))],
      [0, 0, 0],
      8,
      field,
    );

    /* Midway between two spheres of radius one whose centres are 1.4 apart: inside both. */
    expect(sampleGlobalField(field, 0, 0, 0)).toBeLessThan(0);
    /* At the far side of the right-hand sphere, the right-hand one is the nearer surface. */
    expect(sampleGlobalField(field, 2.2, 0, 0)).toBeCloseTo(0.5, 1);
    /* And at the far side of the left-hand one, so is it — a maximum would answer for the other. */
    expect(sampleGlobalField(field, -2.2, 0, 0)).toBeCloseTo(0.5, 1);
  });

  test('THE FIELD NEVER OVERESTIMATES, which is the whole of what makes a step safe', () => {
    /*
     * **A distance field is only useful because its value is a distance nothing can be nearer
     * than.** A sphere trace steps by it; an overestimate anywhere steps through the surface it
     * was meant to stop at, and there is no later stage that can notice. Underestimating is free
     * by comparison: the march takes a shorter step and converges anyway.
     *
     * The value a sample far from every instance takes is the cascade's own **reach**, and that is
     * where this bites — the reach has to be small enough to be a bound on the true distance for
     * every point in the cascade, which the half-extent is and anything larger is not. A corner of
     * a cascade of half-extent four is 5.93 m from a unit sphere at its centre; the field says
     * four, and four is a step that lands.
     */
    /*
     * **Two scenes, because only one of them can see the reach.** Where an instance is near, every
     * sample takes that instance's own value and the reach never wins the minimum — so a reach set
     * far too large passes. The binding case is an instance **just past the cull threshold**: the
     * cascade then holds nothing but its reach, and the nearest surface is barely further away
     * than the reach claims. A half-metre sphere at 9.5 m against a cascade reaching 4 m: the
     * nearest point of the cascade is 5.0 m from its surface, so 4 is a bound and 16 is not.
     */
    for (const [centre, radius] of [
      [0, 1],
      [9.5, 0.5],
    ] as const) {
      const field = createGlobalField(33, 1);
      composeGlobalField(
        [instance(sphereField(radius, radius * 2, 17), at(centre, 0, 0))],
        [0, 0, 0],
        4,
        field,
      );
      expectNoOverestimate(field, centre, radius);
    }
  });

  function expectNoOverestimate(
    field: { readonly cascades: readonly unknown[] },
    centre: number,
    radius: number,
  ): void {
    const cascade = field.cascades[0] as {
      readonly field: Float32Array;
      readonly dims: readonly [number, number, number];
      readonly bounds: Float32Array;
      readonly step: number;
    };
    const [nx, ny, nz] = cascade.dims;
    const offenders: string[] = [];
    for (let iz = 0; iz < nz; iz++) {
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
          const px = (cascade.bounds[0] as number) + ix * cascade.step;
          const py = (cascade.bounds[1] as number) + iy * cascade.step;
          const pz = (cascade.bounds[2] as number) + iz * cascade.step;
          const truth = Math.hypot(px - centre, py, pz) - radius;
          const value = cascade.field[ix + nx * (iy + ny * iz)] as number;
          /* A tenth of a voxel of slack for the trilinear read of the source's own grid. */
          if (value > truth + cascade.step / 10 && offenders.length < 8) {
            offenders.push(
              `(${px}, ${py}, ${pz}) says ${value.toFixed(3)} against ${truth.toFixed(3)}`,
            );
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  }

  test('THERE IS NO PHANTOM SURFACE AT A SOURCE BOX, which is what a marcher would stop on', () => {
    /*
     * **"Never overestimates" passed this, because zero is an underestimate of everything.** Just
     * outside a source's own bounding box the distance *to that box* is nearly nothing, while the
     * distance to the object inside it is most of a metre — so a field that reported the first put
     * a shell of near-zero around every instance, and a sphere trace stops where the field falls
     * under its epsilon. It drew as dark fins radiating from every object in `demo/giFieldRig.ts`,
     * which is how it was found: by looking, after every number here said it was fine.
     *
     * The sphere has radius 1 in a box of half-extent 2, so a point at 2.05 along x is 1.05 from
     * the surface and 0.05 from the box.
     */
    const field = createGlobalField(33, 1);
    composeGlobalField([instance(sphereField(1, 2, 17), at(0, 0, 0))], [0, 0, 0], 8, field);

    /*
     * **The bound is tight against the box and loosens away from it**, which is the right shape:
     * `d(c) - |q - c|` is exact where `q` is on the box and decays as `q` leaves, while `|q - c|`
     * takes over further out. At 2.05 it gives 0.95 against a true 1.05; at 2.8, 0.80 against 1.80.
     * Both are underestimates and both are far above any epsilon a march would use, which is the
     * whole requirement — a loose bound costs shorter steps and a zero costs a phantom surface.
     */
    for (const x of [2.05, 2.3, 2.8]) {
      const truth = x - 1;
      const value = sampleGlobalField(field, x, 0, 0);
      expect(value, `at ${x}, where the truth is ${truth.toFixed(2)}`).toBeGreaterThan(0.4);
      /* Still an underestimate, which is what keeps a step safe. */
      expect(value).toBeLessThanOrEqual(truth + 0.05);
    }

    /* And hard against the box, where the old answer was 0.05, it is within a tenth of the truth. */
    expect(sampleGlobalField(field, 2.05, 0, 0)).toBeGreaterThan(0.9);
  });

  test('an instance outside the radius contributes nothing at all', () => {
    const near = createGlobalField(33, 1);
    composeGlobalField([instance(sphereField(1, 2, 17), at(200, 0, 0))], [0, 0, 0], 8, near);

    const empty = createGlobalField(33, 1);
    composeGlobalField([], [0, 0, 0], 8, empty);

    expect(Array.from(near.cascades[0]!.field)).toEqual(Array.from(empty.cascades[0]!.field));
  });
});

describe('the field does not move when only the camera does', () => {
  test('A WORLD POINT READS THE SAME AFTER THE CAMERA MOVES, because the grid is snapped', () => {
    /*
     * **This is the one that reads as noise rather than as a bug.** A grid centred on the exact
     * camera position resamples the whole world at a new sub-voxel offset every frame, so every
     * value in it changes slightly every frame and the indirect light shimmers — worst on a still
     * camera drifting slowly, which is exactly when a viewer is looking. Snapping the centre to a
     * multiple of the cascade's own step makes a camera move either nothing at all or a whole
     * voxel, and a whole voxel leaves every shared sample identical.
     */
    const source = sphereField(1, 2, 17);
    const before = createGlobalField(33, 1);
    composeGlobalField([instance(source, at(3, 0, 0))], [0, 0, 0], 8, before);

    const cascade = before.cascades[0] as { readonly step: number };
    for (const move of [cascade.step * 0.4, cascade.step, cascade.step * 3]) {
      const after = createGlobalField(33, 1);
      composeGlobalField([instance(source, at(3, 0, 0))], [move, 0, 0], 8, after);
      for (const [px, py, pz] of [
        [3, 0, 0],
        [4.2, 0.3, -0.5],
        [2, 1, 1],
      ] as const) {
        expect(sampleGlobalField(after, px, py, pz)).toBeCloseTo(
          sampleGlobalField(before, px, py, pz),
          5,
        );
      }
    }
  });

  test('composition is deterministic', () => {
    const source = sphereField(1, 2, 17);
    const build = (): Float32Array => {
      const field = createGlobalField(25, 2);
      composeGlobalField(
        [instance(source, at(1, 2, 3)), instance(source, at(-2, 0, 1))],
        [0.31, -0.62, 0.17],
        6,
        field,
      );
      return field.cascades[1]!.field;
    };
    expect(new Uint8Array(build().buffer)).toEqual(new Uint8Array(build().buffer));
  });
});

describe('cascades, fine near the viewer and coarse further out', () => {
  test('each cascade is twice the reach of the one inside it', () => {
    const field = createGlobalField(17, 3);
    composeGlobalField([], [0, 0, 0], 4, field);
    const reach = field.cascades.map((c) => (c.bounds[3] as number) - (c.bounds[0] as number));
    expect(reach[1]! / reach[0]!).toBeCloseTo(2, 6);
    expect(reach[2]! / reach[1]!).toBeCloseTo(2, 6);
    /* Same sample count each, so the step doubles with the reach. */
    expect(field.cascades[1]!.step / field.cascades[0]!.step).toBeCloseTo(2, 6);
  });

  test('A SAMPLE DOES NOT JUMP AS IT CROSSES OUT OF ONE CASCADE INTO THE NEXT', () => {
    /*
     * **A hard switch between cascades is visible as a seam that moves with the camera**, which is
     * worse than either cascade's own error: an error that is wrong everywhere reads as a coarse
     * solution, and an error that changes abruptly along a surface reads as a crack.
     *
     * **The scene is a ring of small spheres straddling the boundary, and it has to be.** A single
     * large sphere is resolved just as well by the coarse cascade as by the fine one, so the two
     * agree at the boundary to within a hundredth of a metre and a hard switch passes — which is
     * what the first version of this test did. Measured on the face of cascade 0 with this scene,
     * the seam between the two cascades is **0.47 m at worst and 0.11 m on average**, against an
     * inner step of 0.25.
     *
     * Walked across the boundary in eighth-of-a-voxel steps: **0.114 m worst step with the fade,
     * 0.422 m without**, and without it the worst step lands exactly on the boundary rather than
     * on the geometry.
     */
    const source = sphereField(0.4, 1, 21);
    const ring: GlobalFieldInstance[] = [];
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2;
      ring.push(
        instance(
          source,
          at(4 + Math.cos(angle) * 0.9, Math.sin(angle) * 2, Math.cos(angle * 3) * 2),
        ),
      );
    }
    const field = createGlobalField(33, 2);
    composeGlobalField(ring, [0, 0, 0], 4, field);

    const inner = field.cascades[0] as { readonly bounds: Float32Array; readonly step: number };
    const edge = inner.bounds[3] as number;
    const band = GLOBAL_FIELD_BLEND * (edge - (inner.bounds[0] as number));

    let worst = 0;
    for (let y = -2.5; y <= 2.5; y += 0.25) {
      for (let z = -2.5; z <= 2.5; z += 0.25) {
        let previous = sampleGlobalField(field, edge - 2 * band, y, z);
        for (let x = edge - 2 * band; x < edge + 2 * band; x += inner.step / 8) {
          const value = sampleGlobalField(field, x, y, z);
          worst = Math.max(worst, Math.abs(value - previous));
          previous = value;
        }
      }
    }
    expect(worst).toBeLessThan(inner.step);
  });

  test('a point past the last cascade reports that cascade rather than nothing', () => {
    const field = createGlobalField(17, 2);
    composeGlobalField([instance(sphereField(1, 2, 9), at(0, 0, 0))], [0, 0, 0], 4, field);
    expect(Number.isFinite(sampleGlobalField(field, 1000, 1000, 1000))).toBe(true);
    expect(sampleGlobalField(field, 1000, 1000, 1000)).toBeGreaterThan(0);
  });
});

describe('what the composer refuses', () => {
  /**
   * A slab whose box is not a cube, sampled onto a grid with the same count on every axis.
   *
   * **Which makes its voxels oblong, and that is the mistake this describes.** `sourceAt` derives
   * one step from the x axis and uses it on all three, because `bakeObjectSdf` picks its step from
   * the longest axis and varies `dims` instead — so a source built this way is read along the
   * wrong axes and collapses to a corner of itself.
   */
  function oblongVoxels(resolution: number): FieldSource {
    return {
      field: new Float32Array(resolution ** 3),
      dims: [resolution, resolution, resolution],
      bounds: new Float32Array([-1, -3, -3, 1, 3, 3]),
    };
  }

  test('A SOURCE WHOSE VOXELS ARE NOT CUBIC, which is read along the wrong axes if it is not', () => {
    /*
     * **Measured rather than reasoned about, on `demo/dev/bounce.html`.** The page declared its
     * room as five slabs sampled 17 cubed over boxes that are not cubes, so every one of them was
     * read at its own corner and the composed field held almost no room at all. A census of the
     * bake counted 98.9% of every probe's rays leaving a *closed* room, which is the number that
     * said the field was empty rather than the trace being dim.
     *
     * The composer cannot correct it — a distance field carries no record of which axis it was
     * sampled along — so it refuses, exactly as it refuses a non-uniform scale.
     */
    const field = createGlobalField(9, 1);
    expect(() =>
      composeGlobalField([instance(oblongVoxels(9), at(0, 0, 0))], [0, 0, 0], 8, field),
    ).toThrow(/cubic/i);
  });

  test('an axis of one sample, which `read` has no pair to interpolate between', () => {
    /* Not a cubic-voxel failure but the same class: a shape neither reader can address. */
    const field = createGlobalField(9, 1);
    expect(() =>
      composeGlobalField(
        [
          instance(
            {
              field: new Float32Array(7 * 7),
              dims: [1, 7, 7],
              bounds: new Float32Array([0, -3, -3, 0, 3, 3]),
            },
            at(0, 0, 0),
          ),
        ],
        [0, 0, 0],
        8,
        field,
      ),
    ).toThrow(/at least two/i);
  });

  test('and accepts one whose dims differ per axis so that its voxels are cubic', () => {
    /* What `bakeObjectSdf` produces: one step from the longest axis, a count an axis needs. */
    const field = createGlobalField(9, 1);
    expect(() =>
      composeGlobalField(
        [
          instance(
            {
              field: new Float32Array(3 * 7 * 7),
              dims: [3, 7, 7],
              bounds: new Float32Array([-1, -3, -3, 1, 3, 3]),
            },
            at(0, 0, 0),
          ),
        ],
        [0, 0, 0],
        8,
        field,
      ),
    ).not.toThrow();
  });

  test('a resolution below two, and a cascade count below one', () => {
    expect(() => createGlobalField(1, 1)).toThrow(/resolution/i);
    expect(() => createGlobalField(17, 0)).toThrow(/cascade/i);
  });

  test('a radius that is not positive', () => {
    const field = createGlobalField(9, 1);
    expect(() => composeGlobalField([], [0, 0, 0], 0, field)).toThrow(/radius/i);
  });
});

/**
 * The albedo of whatever surface won the union, composed beside the distance.
 *
 * **A composed distance field is a union and loses which instance won**, which is why this exists:
 * a ray that marches the field and lands on a wall needs to know what colour that wall is, and the
 * distance alone cannot say. `demo/dev/bounce.html` is what made it necessary — a trace that read
 * a rasterised capture for the colour could not follow a wall that changed colour, and one that
 * read irradiance returned the same answer for a red wall and a white one.
 */
describe('the albedo beside the distance', () => {
  function unitBox(resolution: number): FieldSource {
    const field = new Float32Array(resolution ** 3);
    for (let iz = 0; iz < resolution; iz += 1) {
      for (let iy = 0; iy < resolution; iy += 1) {
        for (let ix = 0; ix < resolution; ix += 1) {
          const p = [ix, iy, iz].map((i) => -2 + (4 * i) / (resolution - 1));
          const gap = p.map((v) => Math.abs(v) - 1);
          const outside = Math.hypot(...gap.map((v) => Math.max(v, 0)));
          field[ix + resolution * (iy + resolution * iz)] = outside + Math.min(Math.max(...gap), 0);
        }
      }
    }
    return {
      field,
      dims: [resolution, resolution, resolution],
      bounds: new Float32Array([-2, -2, -2, 2, 2, 2]),
    };
  }

  function at(x: number): Float32Array {
    return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]);
  }

  test('A SAMPLE TAKES THE COLOUR OF THE INSTANCE THAT WON THE MINIMUM', () => {
    const source = unitBox(9);
    const field = createGlobalField(17, 1);
    composeGlobalField(
      [
        { source, transform: at(-3), albedo: [1, 0, 0] },
        { source, transform: at(3), albedo: [0, 0, 1] },
      ],
      [0, 0, 0],
      8,
      field,
    );

    /* Deep inside the left box, which only the red instance can have won. */
    expect(Array.from(albedoAt(field, -3, 0, 0))).toEqual([1, 0, 0]);
    /* And inside the right one, which only the blue instance can have won. */
    expect(Array.from(albedoAt(field, 3, 0, 0))).toEqual([0, 0, 1]);
  });

  test('an instance that never wins colours nothing, however many samples it reaches', () => {
    /*
     * The control. A second instance placed exactly where the first is cannot change a colour if
     * it never has the smaller distance — and a composer that wrote its albedo unconditionally
     * would paint the whole field with whatever came last.
     */
    const source = unitBox(9);
    const field = createGlobalField(17, 1);
    composeGlobalField(
      [
        { source, transform: at(0), albedo: [1, 0, 0] },
        /* Further away everywhere, so it loses at every sample it reaches. */
        { source, transform: at(6), albedo: [0, 1, 0] },
      ],
      [0, 0, 0],
      8,
      field,
    );
    expect(Array.from(albedoAt(field, 0, 0, 0))).toEqual([1, 0, 0]);
  });

  test('a sample no instance reached is white rather than black', () => {
    /*
     * White, because an unreached sample's colour is never read — a ray reads albedo where it hit
     * something — and black would turn any read that did happen into a light that vanishes rather
     * than one that is obviously wrong.
     */
    const field = createGlobalField(9, 1);
    composeGlobalField([], [0, 0, 0], 4, field);
    expect(Array.from(albedoAt(field, 0, 0, 0))).toEqual([1, 1, 1]);
  });

  test('an instance that declared no albedo is white, so every existing caller is unchanged', () => {
    const source = unitBox(9);
    const field = createGlobalField(17, 1);
    composeGlobalField([{ source, transform: at(0) }], [0, 0, 0], 8, field);
    expect(Array.from(albedoAt(field, 0, 0, 0))).toEqual([1, 1, 1]);
  });
});

/** The albedo at a world point of the innermost cascade, by nearest sample. */
function albedoAt(field: GlobalField, x: number, y: number, z: number): Float32Array {
  const cascade = field.cascades[0] as GlobalFieldCascade;
  const step = cascade.step;
  const index = [x, y, z].map((v, axis) =>
    Math.min(
      (cascade.dims[axis] as number) - 1,
      Math.max(0, Math.round((v - (cascade.bounds[axis] as number)) / step)),
    ),
  );
  const at =
    ((index[0] as number) +
      (cascade.dims[0] as number) *
        ((index[1] as number) + (cascade.dims[1] as number) * (index[2] as number))) *
    3;
  return cascade.albedo.slice(at, at + 3);
}

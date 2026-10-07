import { describe, expect, it } from 'vitest';

import {
  createAreaLightBuffer,
  MAX_AREA_LIGHTS,
  packAreaSizesAndDoors,
  selectAreaLights,
} from './areaLights.ts';
import type { AreaLightSource } from './areaLights.ts';

const PANEL: AreaLightSource = {
  x: 0,
  y: 3,
  z: 0,
  r: 1,
  g: 1,
  b: 1,
  rightX: 1,
  rightY: 0,
  rightZ: 0,
  upX: 0,
  upY: 0,
  upZ: 1,
  halfWidth: 1,
  halfHeight: 0.5,
};

/** Length of the three floats starting at `at`. */
function length3(values: Float32Array, at: number): number {
  const x = values[at] ?? 0;
  const y = values[at + 1] ?? 0;
  const z = values[at + 2] ?? 0;
  return Math.sqrt(x * x + y * y + z * z);
}

function dot3(a: Float32Array, b: Float32Array, at: number): number {
  return (
    (a[at] ?? 0) * (b[at] ?? 0) +
    (a[at + 1] ?? 0) * (b[at + 1] ?? 0) +
    (a[at + 2] ?? 0) * (b[at + 2] ?? 0)
  );
}

describe('selecting area lights', () => {
  it('carries what a caller declared', () => {
    const buffer = createAreaLightBuffer();
    selectAreaLights([PANEL], buffer);
    expect(buffer.count).toBe(1);
    expect(buffer.positions[1]).toBe(3);
    expect(buffer.sizes[0]).toBe(1);
    expect(buffer.sizes[1]).toBe(0.5);
    expect(buffer.twoSided[0]).toBe(0);
  });

  /*
   * **The axes are normalised here rather than trusted**, because the form factor treats them as
   * unit vectors: an axis of length two describes a rectangle twice the size the half extents say,
   * which reads as the extents having been set wrong rather than the axis.
   */
  it('normalises the in-plane axes', () => {
    const buffer = createAreaLightBuffer();
    selectAreaLights([{ ...PANEL, rightX: 3, upZ: 5 }], buffer);
    expect(length3(buffer.right, 0)).toBeCloseTo(1, 6);
    expect(length3(buffer.up, 0)).toBeCloseTo(1, 6);
  });

  /*
   * **And made perpendicular**, because two axes that are not describe a parallelogram — and the
   * form factor is the irradiance of the polygon its corners make, so a caller would get the light
   * of a shape they cannot see the outline of and did not ask for.
   */
  it('orthogonalises an up that leans into right', () => {
    const buffer = createAreaLightBuffer();
    selectAreaLights([{ ...PANEL, upX: 0.6, upY: 0, upZ: 0.8 }], buffer);
    expect(dot3(buffer.right, buffer.up, 0)).toBeCloseTo(0, 6);
    expect(length3(buffer.up, 0)).toBeCloseTo(1, 6);
  });

  /*
   * Parallel axes describe no rectangle at all, and the naive result is a zero vector — every
   * corner the same point, every form factor a NaN, and a light that blanks whatever it touches
   * from two numbers a caller got wrong. Any perpendicular is better than that.
   */
  it('recovers a usable axis when a caller supplies two parallel ones', () => {
    const buffer = createAreaLightBuffer();
    selectAreaLights([{ ...PANEL, upX: 1, upY: 0, upZ: 0 }], buffer);
    expect(length3(buffer.up, 0)).toBeCloseTo(1, 6);
    expect(dot3(buffer.right, buffer.up, 0)).toBeCloseTo(0, 6);
    expect(Number.isNaN(buffer.up[0] ?? NaN)).toBe(false);
  });

  /* A rectangle with no extent has no solid angle, and dividing by it is where a NaN starts. */
  it('never carries a zero extent', () => {
    const buffer = createAreaLightBuffer();
    selectAreaLights([{ ...PANEL, halfWidth: 0, halfHeight: -1 }], buffer);
    expect(buffer.sizes[0]).toBeGreaterThan(0);
    expect(buffer.sizes[1]).toBeGreaterThan(0);
  });

  it('takes at most the budget, and reports how many it took', () => {
    const buffer = createAreaLightBuffer();
    selectAreaLights(new Array<AreaLightSource>(MAX_AREA_LIGHTS + 3).fill(PANEL), buffer);
    expect(buffer.count).toBe(MAX_AREA_LIGHTS);
  });

  it('reports none for an empty list, which is what makes the shader loop free', () => {
    const buffer = createAreaLightBuffer();
    selectAreaLights([], buffer);
    expect(buffer.count).toBe(0);
  });
});

/*
 * **Barn doors cross as a cosine and a length**, because the shader wants where a door's tip stands
 * and the cosine gives it without a trigonometric call a fragment. A door at 90° hides nothing, so
 * it is written as no doors at all: the shader's early out, and the frame bit for bit a rectangle's
 * with none.
 */
describe('barn doors', () => {
  const lights: AreaLightSource[] = [
    { ...PANEL, barnDoorAngle: 60, barnDoorLength: 0.3 },
    { ...PANEL, barnDoorAngle: 60 },
    { ...PANEL, barnDoorAngle: 90 },
    PANEL,
    { ...PANEL, barnDoorAngle: 30, barnDoorLength: 0 },
    { ...PANEL, barnDoorAngle: Number.NaN },
  ];

  it("A RECTANGLE'S DOORS REACH THE SHADER AS THEIR COSINE AND LENGTH, AND NONE AS ZERO", () => {
    const buffer = createAreaLightBuffer(lights.length);
    selectAreaLights(lights, buffer);
    const doors = Array.from(buffer.barnDoors ?? []);
    expect(doors[0], 'cos 60°').toBeCloseTo(0.5, 6);
    expect(doors[1]).toBeCloseTo(0.3, 6);
    expect(doors[2], 'the default length').toBeCloseTo(0.5, 6);
    expect(doors[3], 'the 20 cm default').toBeCloseTo(0.2, 6);
    expect(doors.slice(4), 'flat, absent, zero-length and NaN doors').toEqual([
      0, 0, 0, 0, 0, 0, 0, 0,
    ]);
  });

  it('packs four a rectangle for the fixed arm: its two half extents, then its doors', () => {
    const buffer = createAreaLightBuffer(lights.length);
    selectAreaLights(lights, buffer);
    const packed = new Float32Array(MAX_AREA_LIGHTS * 4);
    packAreaSizesAndDoors(buffer, packed);
    expect(Array.from(packed.subarray(0, 4))).toEqual([1, 0.5, 0.5, Math.fround(0.3)]);
    expect(Array.from(packed.subarray(4, 8))).toEqual([1, 0.5, 0.5, Math.fround(0.2)]);
    expect(Array.from(packed.subarray(8, 12))).toEqual([1, 0.5, 0, 0]);
  });
});

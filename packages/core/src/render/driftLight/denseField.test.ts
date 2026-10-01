import { expect, test } from 'vitest';

import { bakeBrick, BRICK_TEXELS } from './bake.ts';
import { bakeDenseField } from './denseField.ts';
import { BRICK_SAMPLES, layoutLightField } from './layout.ts';

/**
 * A world's dense volume, baked offline, against the courtyard's bricks baked in the page: laid on
 * the same lattice, every sample the two share must hold the same light and the same direction, bit
 * for bit, occluded and not. They share one sampling kernel, so anything short of exact means one of
 * them summed a different set of lights — the bucketing missing one, or a sample off the lattice.
 */
const source = (
  x: number,
  y: number,
  z: number,
  radius: number,
  r: number,
  g: number,
  b: number,
) => ({
  x,
  y,
  z,
  radius,
  r,
  g,
  b,
  sourceRadius: 0.1,
});

/* Seven lights of four reaches and colours over twelve metres, some overlapping, one far off. */
const LIGHTS = [
  source(1.2, 1.5, 2.1, 3.0, 1, 0.8, 0.5),
  source(4.4, 0.8, 3.3, 2.5, 0.3, 0.6, 1),
  source(6.1, 2.2, 1.0, 4.0, 1, 1, 1),
  source(2.7, 0.4, 6.8, 1.5, 0.9, 0.2, 0.2),
  source(9.3, 1.1, 8.2, 3.5, 0.5, 1, 0.5),
  source(7.7, 3.0, 5.5, 2.0, 1, 0.5, 0),
  source(11.0, 0.5, 11.0, 1.0, 0.2, 0.2, 1),
  /* Four close together, so many samples sum three lights and more. */
  source(3.1, 1.0, 3.9, 2.6, 0.7, 0.3, 0.9),
  source(3.4, 1.3, 4.2, 2.2, 0.1, 0.9, 0.4),
  source(2.9, 0.7, 4.4, 2.9, 0.6, 0.6, 0.2),
  source(3.6, 1.1, 3.6, 2.4, 0.3, 0.1, 0.8),
];

/* A wall across x = 5, 20 cm thick and 3 m tall, which the lights on either side cannot see past. */
const WALL = (x: number, y: number): number => Math.max(Math.abs(x - 5) - 0.1, y - 3);

function compare(distance: ((x: number, y: number, z: number) => number) | null): number {
  const spacing = 1 / 3;
  const layout = layoutLightField(LIGHTS, spacing);
  const span = layout.span;
  const [ox, oy, oz] = layout.origin;
  const bounds = [
    ox,
    oy,
    oz,
    ox + layout.dims[0] * span,
    oy + layout.dims[1] * span,
    oz + layout.dims[2] * span,
  ];
  const dense = bakeDenseField(LIGHTS, 'smooth', distance, bounds, spacing);
  const light = new Float32Array(BRICK_TEXELS * 4);
  const direction = new Float32Array(BRICK_TEXELS * 4);
  let compared = 0;
  let differ = 0;
  for (let brick = 0; brick < layout.count; brick++) {
    bakeBrick(layout, brick, LIGHTS, 'smooth', distance, light, direction);
    const cx = layout.brickCoords[brick * 3] as number;
    const cy = layout.brickCoords[brick * 3 + 1] as number;
    const cz = layout.brickCoords[brick * 3 + 2] as number;
    for (let k = 0; k < BRICK_SAMPLES; k++) {
      for (let j = 0; j < BRICK_SAMPLES; j++) {
        for (let i = 0; i < BRICK_SAMPLES; i++) {
          const texel = (i + BRICK_SAMPLES * (j + BRICK_SAMPLES * k)) * 4;
          const at = (cx * 3 + i + dense.dims[0] * (cy * 3 + j + dense.dims[1] * (cz * 3 + k))) * 4;
          for (let c = 0; c < 4; c++) {
            if (dense.light[at + c] !== light[texel + c]) differ++;
            if (dense.direction[at + c] !== direction[texel + c]) differ++;
          }
          compared++;
        }
      }
    }
  }
  expect(differ, `values differing between the dense and the brick bake`).toBe(0);
  return compared;
}

test('AN OFFLINE DENSE BAKE MATCHES THE BRICK BAKE at every sample they share, occluded and not', () => {
  const open = compare(null);
  const walled = compare(WALL);
  expect(open, 'the comparison covered the bricks').toBeGreaterThan(1000);
  expect(walled).toBe(open);
});

test('a volume past what one texture holds is refused, and says how to fit it', () => {
  expect(() => bakeDenseField(LIGHTS, 'smooth', null, [0, 0, 0, 2100, 100, 100], 8)).toThrow(
    /coarser spacing/,
  );
});

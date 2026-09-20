import { expect, test } from 'vitest';

import { MATERIAL, MATERIAL_COUNT, STYLE_WINDOWS, TEXTURED } from './manhattan';
import { cityPalette } from './palette';

/**
 * **A unit of facade UV is one window, and each style's image is `STYLE_WINDOWS` of them a side.**
 * So every textured material scales its UV down by that many before its program reads it, or every
 * bay shows the whole tile — which is what the first captures of the city showed.
 */
const palette = cityPalette(20260918);

test('ONE MATERIAL FOR EVERY INDEX THE GENERATOR WRITES', () => {
  expect(palette).toHaveLength(MATERIAL_COUNT);
  for (const material of palette) expect(material).toBeDefined();
});

test('EVERY FACADE READS ONE WINDOW OF ITS IMAGE PER UNIT OF UV', () => {
  for (const index of TEXTURED) {
    expect(palette[index]?.textures?.uScale, `material ${index}`).toBe(1 / STYLE_WINDOWS);
    expect(palette[index]?.textures?.vScale, `material ${index}`).toBe(1 / STYLE_WINDOWS);
  }
});

test('THE FACADES GLOW BY THEIR MASKS, AND ONLY THE CURTAIN WALL IS BLENDED', () => {
  for (const index of [MATERIAL.brick, MATERIAL.limestone, MATERIAL.deco, MATERIAL.office]) {
    expect(palette[index]?.textures?.emissive, `material ${index}`).toBeDefined();
    expect(palette[index]?.emissive, `material ${index}`).toBeGreaterThan(0);
  }
  expect(palette.map((material) => material.blend === true)).toEqual(
    palette.map((_, index) => index === MATERIAL.glass),
  );
});

test('A SIGN’S COLOUR IS ITS OWN: the neon material is white and glows', () => {
  expect(palette[MATERIAL.neon]?.tint).toEqual([1, 1, 1]);
  expect(palette[MATERIAL.neon]?.emissive).toBeGreaterThan(1);
  expect(palette[MATERIAL.lamp]?.emissive).toBeGreaterThan(1);
});

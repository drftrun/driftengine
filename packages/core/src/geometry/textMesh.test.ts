import { expect, test } from 'vitest';
import { buildTextMesh, textMeshHeightM, textMeshWidthM } from './textMesh.ts';
import { MeshBuilder } from './meshBuilder.ts';
import { countCells, forEachCell, forEachRun } from './pixelFont.ts';
import type { Vec3 } from '../math/color.ts';

const WHITE: Vec3 = [1, 1, 1];

function bounds(positions: Float32Array): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
} {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i] ?? 0);
    maxX = Math.max(maxX, positions[i] ?? 0);
    minY = Math.min(minY, positions[i + 1] ?? 0);
    maxY = Math.max(maxY, positions[i + 1] ?? 0);
    minZ = Math.min(minZ, positions[i + 2] ?? 0);
    maxZ = Math.max(maxZ, positions[i + 2] ?? 0);
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

test('a line stands on its baseline, centred on its origin', () => {
  /*
   * The contract a caller places geometry against. `3` is five cells wide and seven
   * tall, so at a 0.4 m cell it occupies 2.0 x 2.8 m — centred, that is x from -1.0 to
   * 1.0, and y from 0 (the baseline) to 2.8. Hand-derived, so the assertion can
   * disagree with the layout code.
   */
  const mesh = buildTextMesh('3', { cellSizeM: 0.4, color: WHITE });
  const box = bounds(mesh.positions);

  expect(box.minX).toBeCloseTo(-1.0, 6);
  expect(box.maxX).toBeCloseTo(1.0, 6);
  expect(box.minY).toBeCloseTo(0, 6);
  expect(box.maxY).toBeCloseTo(2.8, 6);
  // Depth defaults to the cell size and is centred on the plane, so the text has a
  // front and a back at equal distance rather than growing out of one face.
  expect(box.minZ).toBeCloseTo(-0.2, 6);
  expect(box.maxZ).toBeCloseTo(0.2, 6);

  expect(textMeshWidthM('3', 0.4)).toBeCloseTo(2.0, 6);
  expect(textMeshHeightM(0.4)).toBeCloseTo(2.8, 6);
});

test('one box per horizontal run, and no box for a blank cell', () => {
  /*
   * 24 vertices a box, so the vertex count is the number of *runs* times 24 — it was the number
   * of lit cells until 2026-08-30, when a run of adjacent cells became one box. This is still what
   * catches a layout that quietly draws the unlit cells too, which looks like a solid plate and
   * reads as a missing glyph: an unlit cell ends a run rather than joining one.
   */
  let runs = 0;
  forEachRun('DRFT', () => {
    runs++;
  });
  const mesh = buildTextMesh('DRFT', { cellSizeM: 0.2, color: WHITE });
  expect(mesh.positions.length / 3).toBe(runs * 24);
  expect(runs).toBeLessThan(countCells('DRFT'));
});

/**
 * **The claim that makes the merge invisible: the same outer surface.**
 *
 * A run of three cells and the box that spans them have identical outsides; what goes is the
 * interior faces between them, which nothing can ever see. So the geometry must occupy exactly the
 * same extent as one box per cell would, and hold strictly fewer vertices. A merge that got the
 * centre or the half-extent wrong shifts letters by half a cell, which reads as a font bug.
 */
test('a merged run covers exactly what its cells covered', () => {
  const cellSizeM = 0.2;
  for (const text of ['DRFT', 'VIA ROMA', '42', 'W']) {
    const mesh = buildTextMesh(text, { cellSizeM, color: WHITE });

    /* What one box per lit cell would have spanned, from the font alone. */
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let cells = 0;
    forEachCell(text, (x, y) => {
      cells++;
      minX = Math.min(minX, x * cellSizeM);
      maxX = Math.max(maxX, (x + 1) * cellSizeM);
      minY = Math.min(minY, y * cellSizeM);
      maxY = Math.max(maxY, (y + 1) * cellSizeM);
    });

    let gotMinX = Infinity;
    let gotMaxX = -Infinity;
    let gotMinY = Infinity;
    let gotMaxY = -Infinity;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      gotMinX = Math.min(gotMinX, mesh.positions[i] as number);
      gotMaxX = Math.max(gotMaxX, mesh.positions[i] as number);
      gotMinY = Math.min(gotMinY, mesh.positions[i + 1] as number);
      gotMaxY = Math.max(gotMaxY, mesh.positions[i + 1] as number);
    }

    /* Centred by default, so the cell extent is offset by half the string's width. */
    const shift = -textMeshWidthM(text, cellSizeM) * 0.5;
    expect(gotMinX, `${text} left edge`).toBeCloseTo(minX + shift, 6);
    expect(gotMaxX, `${text} right edge`).toBeCloseTo(maxX + shift, 6);
    expect(gotMinY, `${text} bottom edge`).toBeCloseTo(minY, 6);
    expect(gotMaxY, `${text} top edge`).toBeCloseTo(maxY, 6);
    expect(mesh.positions.length / 3, `${text} is fewer boxes`).toBeLessThan(cells * 24);
  }
});

test('a spelled-out space adds width without geometry', () => {
  const spaced = buildTextMesh('A A', { cellSizeM: 0.2, color: WHITE });
  const tight = buildTextMesh('AA', { cellSizeM: 0.2, color: WHITE });
  expect(spaced.positions.length).toBe(tight.positions.length);
  expect(textMeshWidthM('A A', 0.2)).toBeGreaterThan(textMeshWidthM('AA', 0.2));
});

test('a basis rotates the geometry and its normals together', () => {
  /*
   * The reason `addOrientedMesh` exists, and the failure it is checked against: a
   * mesh placed under a basis whose normals were left alone is lit as though it were
   * still facing the way it was authored, which looks like a shading bug and is not.
   *
   * A quarter turn about Y sends local +x to world -z and local +z to world +x, so a
   * cell's outward face and the corner it belongs to must both land there.
   */
  const mesh = buildTextMesh('1', { cellSizeM: 1, color: WHITE });
  const turned = new MeshBuilder()
    .addOrientedMesh(mesh, [10, 0, 0], [0, 0, -1], [0, 1, 0], [1, 0, 0])
    .build();

  const flat = bounds(mesh.positions);
  const box = bounds(turned.positions);
  // The width that ran along x now runs along z, negated, and the origin moved.
  expect(box.minZ).toBeCloseTo(-flat.maxX, 6);
  expect(box.maxZ).toBeCloseTo(-flat.minX, 6);
  expect(box.minX).toBeCloseTo(10 + flat.minZ, 6);
  expect(box.maxX).toBeCloseTo(10 + flat.maxZ, 6);
  // Height is untouched by a turn about the up axis.
  expect(box.maxY).toBeCloseTo(flat.maxY, 6);

  let facingWorldX = 0;
  for (let i = 0; i < turned.normals.length; i += 3) {
    if ((turned.normals[i] ?? 0) > 0.99) facingWorldX++;
  }
  // Every cell's +z face — the one that faced the reader — now faces world +x.
  expect(facingWorldX).toBe(turned.positions.length / 3 / 6);
});

test('a skewed basis is refused rather than silently mis-lit', () => {
  const mesh = buildTextMesh('1', { cellSizeM: 1, color: WHITE });
  expect(() =>
    new MeshBuilder().addOrientedMesh(mesh, [0, 0, 0], [1, 0, 0], [1, 0, 0], [0, 0, 1]),
  ).toThrow(/orthonormal/);
});

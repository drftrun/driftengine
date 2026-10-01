import { expect, test } from 'vitest';
import { solidIntersect, solidSubtract, solidUnion } from './csg.ts';
import type { Solid } from './solid.ts';
import { emptySolid, solidVolume, transformSolid } from './solid.ts';
import { solidBox } from './solidFlat.ts';
import { solidCylinder } from './solidRound.ts';
import { normalsFaceOutward, rotationX, rotationY, translation } from './solidHarness.ts';

/**
 * Booleans are held to volume, which the divergence theorem measures exactly on any closed
 * surface — T-junctions included, which a BSP boolean leaves and an edge-pairing check would
 * reject — and to outward normals. Every expected volume is the overlap worked out by hand.
 */

test('SUBTRACTING A CORNER CUBE REMOVES EXACTLY ITS OVERLAP', () => {
  /* 2×2×2 at the origin minus a 1×1×1 centred on the +x+y+z corner: the overlap is 0.5³. */
  const cut = solidSubtract(
    solidBox(2, 2, 2),
    transformSolid(solidBox(1, 1, 1), translation(1, 1, 1)),
  );
  expect(solidVolume(cut)).toBeCloseTo(8 - 0.125, 6);
  expect(normalsFaceOutward(cut)).toBe(true);
});

test('UNION AND INTERSECTION OF OVERLAPPING BOXES', () => {
  /* Two 2×2×2 boxes one unit apart along x overlap in a 1×2×2 slab of volume 4. */
  const a = solidBox(2, 2, 2);
  const b = transformSolid(solidBox(2, 2, 2), translation(1, 0, 0));
  expect(solidVolume(solidUnion(a, b))).toBeCloseTo(8 + 8 - 4, 6);
  expect(solidVolume(solidIntersect(a, b))).toBeCloseTo(4, 6);
  expect(normalsFaceOutward(solidUnion(a, b))).toBe(true);
  expect(normalsFaceOutward(solidIntersect(a, b))).toBe(true);
});

test('COPLANAR FACES LEAVE NEITHER A SLIVER NOR A HOLE', () => {
  /* Two boxes sharing the face x = 1: the union is one 4×2×2 box, with the shared face gone. */
  const a = solidBox(2, 2, 2);
  const b = transformSolid(solidBox(2, 2, 2), translation(2, 0, 0));
  const u = solidUnion(a, b);
  expect(solidVolume(u)).toBeCloseTo(16, 6);
  let insideFace = 0;
  for (let v = 0; v < u.positions.length / 3; v++) {
    if (Math.abs((u.positions[v * 3] ?? 0) - 1) < 1e-6 && Math.abs(u.normals[v * 3] ?? 0) > 0.5)
      insideFace++;
  }
  expect(insideFace, 'no vertex of the shared face survives facing along x').toBe(0);
});

test('AN EMPTY OPERAND IS THE IDENTITY FOR UNION AND SUBTRACTION, AND EMPTIES AN INTERSECTION', () => {
  const a = solidBox(1, 1, 1);
  expect(solidVolume(solidUnion(a, emptySolid()))).toBeCloseTo(1, 10);
  expect(solidVolume(solidUnion(emptySolid(), a))).toBeCloseTo(1, 10);
  expect(solidVolume(solidSubtract(a, emptySolid()))).toBeCloseTo(1, 10);
  expect(solidSubtract(emptySolid(), a).indices.length).toBe(0);
  expect(solidIntersect(a, emptySolid()).indices.length).toBe(0);
  expect(solidIntersect(emptySolid(), a).indices.length).toBe(0);
});

test('A CYLINDER BORED THROUGH A BOX REMOVES ITS POLYGONAL SECTION TIMES THE DEPTH (the arch case)', () => {
  const n = 32;
  const r = 0.5;
  const bore = transformSolid(solidCylinder(r, 4, n), rotationX(Math.PI / 2));
  const cut = solidSubtract(solidBox(2, 2, 2), bore);
  const section = (n / 2) * r * r * Math.sin((2 * Math.PI) / n);
  expect(solidVolume(cut)).toBeCloseTo(8 - 2 * section, 5);
  expect(normalsFaceOutward(cut)).toBe(true);
});

test('A CUT SPLITS ONLY THE FACES IT REACHES: A WALL CUT FIVE TIMES KEEPS ITS END FACES WHOLE', () => {
  /* A 10 m wall with five cubes turned 45° about y cut into its top one after another, the way a
     parapet is cut. Every cut's planes are infinite and the wall stops being convex after the
     first, so a tree built from the cut wall splits its faces along planes of cuts nowhere near
     them. The end faces at x = ±5 are 1 m from the nearest cube and must stay two triangles. */
  const cube = (x: number) =>
    transformSolid(transformSolid(solidBox(1, 1, 1), rotationY(Math.PI / 4)), translation(x, 1, 0));
  const endFace = (s: Solid, x: number): number => {
    let n = 0;
    for (let t = 0; t < s.indices.length; t += 3) {
      let onEnd = true;
      for (let k = 0; k < 3; k++) {
        const v = s.indices[t + k] ?? 0;
        if (Math.abs((s.positions[v * 3] ?? 0) - x) > 1e-6) onEnd = false;
      }
      if (onEnd) n++;
    }
    return n;
  };
  let wall = solidBox(10, 2, 2);
  for (const x of [-4, -2, 0, 2, 4]) wall = solidSubtract(wall, cube(x));
  expect([endFace(wall, -5), endFace(wall, 5)]).toEqual([2, 2]);
  /* Each cube's centre is on the top face, so half of each is inside: 40 − 5 · 0.5. */
  expect(solidVolume(wall)).toBeCloseTo(40 - 2.5, 6);
  expect(normalsFaceOutward(wall)).toBe(true);
  /* A union keeps the faces clear of the other operand whole, and an intersection drops them. */
  let joined = solidBox(10, 2, 2);
  for (const x of [-4, -2, 0, 2, 4]) joined = solidUnion(joined, cube(x));
  expect([endFace(joined, -5), endFace(joined, 5)]).toEqual([2, 2]);
  expect(solidVolume(joined)).toBeCloseTo(40 + 2.5, 6);
  expect(solidVolume(solidIntersect(solidBox(10, 2, 2), cube(4)))).toBeCloseTo(0.5, 6);
});

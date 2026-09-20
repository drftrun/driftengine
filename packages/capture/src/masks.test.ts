import { mulberry32 } from '@driftengine/core';
import type { MeshData } from '@driftengine/drft';
import { expect, test } from 'vitest';

import { labelMasks, liftMasks, promptGrid, type MaskView } from './masks.ts';
import { lookAt } from './testScene.ts';

/**
 * **A model's masks reach the mesh, and a detector's names reach the masks.**
 *
 * Nothing in this file runs a model. Masks and detections arrive as data, which is what lets the
 * lifting be tested at all: a vote is a rule about disagreement, and to test a rule about
 * disagreement you have to be able to write the disagreement down.
 */

/** Two panels: a floor across the origin and a wall behind it. Four triangles, and no more. */
function panels(): MeshData {
  const positions: number[] = [];
  const indices: number[] = [];
  const quad = (corners: readonly (readonly [number, number, number])[]): void => {
    const base = positions.length / 3;
    for (const [x, y, z] of corners) positions.push(x, y, z);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  quad([
    [-2, 0, -2],
    [-2, 0, 2],
    [2, 0, 2],
    [2, 0, -2],
  ]);
  quad([
    [-2, 0, -2],
    [2, 0, -2],
    [2, 4, -2],
    [-2, 4, -2],
  ]);
  return {
    positions: Float32Array.from(positions),
    normals: new Float32Array(positions.length),
    colors: new Float32Array(positions.length).fill(1),
    emissive: new Float32Array(3),
    indices: Uint32Array.from(indices),
  };
}

/** A view of `panels` from `angle`, with every pixel claimed by `claim`. */
function view(angle: number, claim: number): MaskView {
  const width = 32;
  const height = 32;
  return {
    mask: new Int32Array(width * height).fill(claim),
    width,
    height,
    worldToCamera: lookAt([Math.sin(angle) * 5, 3, Math.cos(angle) * 5], [0, 0, 0]),
    intrinsics: [26, 26, width / 2, height / 2],
  };
}

test('MASKS FROM SEVERAL VIEWS ARE VOTED ONTO THE MESH', () => {
  const mesh = panels();
  /*
   * Three views, two of them calling the surface mask 1 and one calling it mask 0. **The majority
   * wins against the lower index**, which is the whole of the rule and is why the disagreement here
   * runs that way round: had the two agreed on mask 0, a tie-break alone would have produced the
   * same answer and this test would have proved nothing.
   */
  const regions = liftMasks([view(-0.4, 1), view(0.4, 1), view(1.2, 0)], mesh, ['ground', 'thing']);
  expect(regions.length).toBe(1);
  expect(regions[0]?.label).toBe('thing');

  /* And no triangle is in two regions: the vote gives each one answer. */
  const claimed = new Set<number>();
  let total = 0;
  for (const region of regions)
    for (const face of region.triangles) {
      claimed.add(face);
      total += 1;
    }
  expect(claimed.size).toBe(total);
  expect(total).toBeGreaterThan(1);
});

test('two views that disagree one against one give the same answer every run', () => {
  const mesh = panels();
  /*
   * **A tie, and a tie is the ordinary case at a mask boundary** — two views, one vote each, from
   * the same place so nothing else can separate them. Whatever is decided has to be decided the
   * same way on every machine and every run, because a region's number ends up in a file that a
   * consumer's scene refers to. The lower mask index wins, which is a rule rather than a judgement.
   */
  const regions = liftMasks([view(0.6, 1), view(0.6, 0)], mesh, ['ground', 'thing']);
  expect(regions.length).toBe(1);
  expect(regions[0]?.label).toBe('ground');
});

test('a triangle votes with the pixel its centre lands on, not with a corner', () => {
  const width = 8;
  const height = 8;
  /*
   * **A corner of a triangle is on the boundary of whatever region it belongs to**, which is
   * exactly where a mask is least certain and where two views least agree. Voting from a corner
   * reads the neighbour's label about as often as its own, and the vote that was supposed to settle
   * the boundary is taken at the boundary.
   *
   * One pixel of this mask says 0 and the rest say 1. The triangle's centre lands on that pixel and
   * none of its corners do: straight down +z from the origin at a focal length of 10, a corner at
   * x = 6 and depth 10 lands at 6, and the centre at x = 2 lands at 10 × 2 / 10 = 2.
   */
  const mask = new Int32Array(width * height).fill(1);
  mask[2 * width + 2] = 0;
  const view: MaskView = {
    mask,
    width,
    height,
    worldToCamera: Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]),
    intrinsics: [10, 10, 0, 0],
  };
  const triangle: MeshData = {
    positions: Float32Array.from([0, 0, 10, 6, 0, 10, 0, 6, 10]),
    normals: new Float32Array(9),
    colors: new Float32Array(9).fill(1),
    emissive: new Float32Array(3),
    indices: Uint32Array.from([0, 1, 2]),
  };

  const regions = liftMasks([view], triangle, ['centre', 'corner']);
  expect(regions.length).toBe(1);
  expect(regions[0]?.label).toBe('centre');
});

test('a triangle behind the camera is not claimed by the pixel it would land on', () => {
  const mesh = panels();
  const width = 32;
  const height = 32;
  /* Low over the floor looking at the wall, so half the floor is behind the camera. */
  const view: MaskView = {
    mask: new Int32Array(width * height).fill(0),
    width,
    height,
    worldToCamera: lookAt([0, 0.3, 0], [0, 0.35, -4]),
    intrinsics: [14, 14, width / 2, height / 2],
  };
  const camera = (face: number): [number, number, number] => {
    const m = view.worldToCamera;
    const middle = [0, 0, 0];
    for (let slot = 0; slot < 3; slot += 1) {
      const vertex = mesh.indices[face * 3 + slot] as number;
      for (let k = 0; k < 3; k += 1) {
        middle[k] = (middle[k] as number) + (mesh.positions[vertex * 3 + k] as number) / 3;
      }
    }
    const out: [number, number, number] = [0, 0, 0];
    for (let r = 0; r < 3; r += 1) {
      let value = m[r * 4 + 3] as number;
      for (let k = 0; k < 3; k += 1) value += (m[r * 4 + k] as number) * (middle[k] as number);
      out[r] = value;
    }
    return out;
  };

  /*
   * **The control**: dividing by a negative depth mirrors a point through the principal point, so
   * a triangle behind the camera lands on a pixel that exists and is claimed by whatever is drawn
   * there. This fixture only poses the question while some triangle actually does that, so count
   * them — a fixture that stopped posing it would otherwise pass in silence.
   */
  const [fx, fy, cx, cy] = view.intrinsics;
  let mirrored = 0;
  for (let face = 0; face < mesh.indices.length / 3; face += 1) {
    const [x, y, z] = camera(face);
    if (z > 0) continue;
    const px = Math.floor((fx * x) / z + cx);
    const py = Math.floor((fy * y) / z + cy);
    if (px >= 0 && px < width && py >= 0 && py < height) mirrored += 1;
  }
  expect(mirrored).toBeGreaterThan(0);

  const regions = liftMasks([view], mesh, ['ground']);
  expect(regions.length).toBe(1);
  for (const face of regions[0]?.triangles ?? []) expect(camera(face)[2]).toBeGreaterThan(0);
});

test('a triangle no view claimed is left unassigned rather than given to a neighbour', () => {
  const mesh = panels();
  const width = 16;
  const height = 16;
  /* One view that claims nothing at all. */
  const views: MaskView[] = [
    {
      mask: new Int32Array(width * height).fill(-1),
      width,
      height,
      worldToCamera: lookAt([0, 4, 4], [0, 0, 0]),
      intrinsics: [13, 13, width / 2, height / 2],
    },
  ];
  expect(liftMasks(views, mesh, []).length).toBe(0);
});

test('the prompt grid is a lattice, is inside the frame, and is the same twice', () => {
  const first = promptGrid(64, 48, 4, 3, mulberry32(7));
  const second = promptGrid(64, 48, 4, 3, mulberry32(7));
  expect(Array.from(second)).toEqual(Array.from(first));
  expect(first.length).toBe(4 * 3 * 2);
  for (let at = 0; at < first.length / 2; at += 1) {
    expect(first[at * 2]).toBeGreaterThanOrEqual(0);
    expect(first[at * 2]).toBeLessThan(64);
    expect(first[at * 2 + 1]).toBeGreaterThanOrEqual(0);
    expect(first[at * 2 + 1]).toBeLessThan(48);
  }
  /*
   * **A lattice, and jittered inside its own cell.** The lattice is what stops a small object
   * falling between prompts; the jitter is what stops a repeated object being missed the same way
   * in every instance. Each point stays in its own cell, which is what makes it still a lattice.
   */
  for (let j = 0; j < 3; j += 1) {
    for (let i = 0; i < 4; i += 1) {
      const at = (j * 4 + i) * 2;
      expect(Math.floor(((first[at] as number) / 64) * 4)).toBe(i);
      expect(Math.floor(((first[at + 1] as number) / 48) * 3)).toBe(j);
    }
  }
  /* And it is not a plain grid: the jitter really moved them. */
  const plain = promptGrid(64, 48, 4, 3, () => 0.5);
  expect(Array.from(first)).not.toEqual(Array.from(plain));
});

test('A NAME IS ATTACHED WHERE A BOX AGREES WITH A MASK, AND NOWHERE ELSE', () => {
  /*
   * An 8 by 8 frame: mask 0 is the left half, 32 pixels; mask 1 is the right half less a corner,
   * 28; mask 2 is that corner, 4. The agreements are hand-measured. A box over the left half holds
   * all 32 of mask 0 and covers 32, so union is 32 and agreement is one. A box over the whole frame
   * holds all 28 of mask 1 but covers 64: union 64, agreement 0.4375. **The same box holds all 4 of
   * mask 2 and agrees with it 0.0625**, which is what stops a box drawn around a room from naming
   * every cushion in it — and is the difference between agreement and *the mask is inside the box*,
   * which that corner satisfies perfectly.
   */
  const width = 8;
  const height = 8;
  const mask = new Int32Array(width * height);
  for (let y = 0; y < height; y += 1) for (let x = 4; x < width; x += 1) mask[y * width + x] = 1;
  for (let y = 6; y < height; y += 1) for (let x = 6; x < width; x += 1) mask[y * width + x] = 2;
  const frame: MaskView = {
    mask,
    width,
    height,
    worldToCamera: lookAt([0, 0, 4], [0, 0, 0]),
    intrinsics: [8, 8, 4, 4],
  };
  const half = { label: 0, score: 0.9, box: [0, 0, 4, 8] } as const;
  const whole = { label: 1, score: 0.8, box: [0, 0, 8, 8] } as const;

  expect(labelMasks(frame, [half, whole], ['door', 'room'])).toEqual(['door', 'room', null]);

  /* A corner nobody's mask agrees with leaves them all unnamed, and unnamed reaches a scene as scenery. */
  expect(labelMasks(frame, [{ label: 0, score: 0.9, box: [0, 0, 2, 2] }], ['door'])).toEqual([
    null,
    null,
    null,
  ]);

  /* Two detections agreeing exactly: the first keeps the mask, so a model that answers twice about
   * one thing does not hand the label to whichever copy came last. */
  expect(labelMasks(frame, [half, { ...half, label: 1 }], ['door', 'room'])[0]).toBe('door');
});

import {
  countSplatTiles,
  fillSplatTiles,
  mulberry32,
  splatTileGrid,
  splatTileOffsets,
  SPLAT_BIN_FLOATS,
  SPLAT_TILE,
} from '@driftengine/core';
import { expect, test } from 'vitest';

import { lookAt } from '../testScene.ts';
import { visibleGaussians, type GaussianSet, type RasterCamera } from './project.ts';
import { rasteriseGaussians } from './rasterise.ts';

/**
 * **The tiles a device walks hold every splat the reference actually draws.**
 *
 * `@driftengine/core` builds the lists and `@driftengine/capture` owns the rasteriser they stand
 * in for, so this is the one place the two can be compared — and it is the claim that matters,
 * because a splat missing from a tile it covers is a hole in the picture that moves with the
 * camera and reads as a culling fault. The comparison is made pixel by pixel rather than box by
 * box: every pixel the reference put light on is asked which tile it is in, and that tile is asked
 * whether it knows about the splat that lit it.
 */

const WIDTH = 96;
const HEIGHT = 64;
const CAMERA: RasterCamera = {
  width: WIDTH,
  height: HEIGHT,
  intrinsics: [90, 90, WIDTH / 2, HEIGHT / 2],
  worldToCamera: lookAt([0, 0, 0], [0, 0, 1]),
};

/** A cloud spread across the frame, including splats that hang off its edges. */
function cloud(count: number): GaussianSet {
  const random = mulberry32(12);
  const set: GaussianSet = {
    count,
    positions: new Float64Array(count * 3),
    scales: new Float64Array(count * 3),
    rotations: new Float64Array(count * 4),
    colors: new Float64Array(count * 3),
    opacities: new Float64Array(count),
  };
  for (let at = 0; at < count; at += 1) {
    set.positions[at * 3] = (random() - 0.5) * 2.4;
    set.positions[at * 3 + 1] = (random() - 0.5) * 1.8;
    set.positions[at * 3 + 2] = 1.4 + random() * 2.2;
    for (let c = 0; c < 3; c += 1) set.scales[at * 3 + c] = 0.03 + random() * 0.09;
    for (let c = 0; c < 4; c += 1) set.rotations[at * 4 + c] = random() - 0.5;
    for (let c = 0; c < 3; c += 1) set.colors[at * 3 + c] = 0.3 + random() * 0.6;
    set.opacities[at] = 0.4 + random() * 0.5;
  }
  return set;
}

/** The visible splats as the binning takes them — nearest first, which is the order it keeps. */
function binsOf(set: GaussianSet): { bins: Float32Array; order: number[] } {
  const { order, projected } = visibleGaussians(set, CAMERA);
  const bins = new Float32Array(order.length * SPLAT_BIN_FLOATS);
  order.forEach((at, slot) => {
    const one = projected[at];
    if (one === null || one === undefined) return;
    bins[slot * SPLAT_BIN_FLOATS] = one.x;
    bins[slot * SPLAT_BIN_FLOATS + 1] = one.y;
    bins[slot * SPLAT_BIN_FLOATS + 2] = one.radius;
    bins[slot * SPLAT_BIN_FLOATS + 3] = one.depth;
  });
  return { bins, order };
}

test('EVERY PIXEL THE REFERENCE LIT IS IN A TILE THAT KNOWS THE SPLAT THAT LIT IT', () => {
  const set = cloud(40);
  const { bins, order } = binsOf(set);
  const { across, down } = splatTileGrid(WIDTH, HEIGHT);
  const counts = new Uint32Array(across * down);
  const total = countSplatTiles(bins, order.length, WIDTH, HEIGHT, counts);
  const offsets = new Uint32Array(across * down);
  splatTileOffsets(counts, offsets);
  const lists = new Uint32Array(total);
  fillSplatTiles(bins, order.length, WIDTH, HEIGHT, offsets, new Uint32Array(across * down), lists);

  /* What each tile knows, as a set per tile, so the question below is asked once a pixel. */
  const known: Set<number>[] = [];
  for (let tile = 0; tile < across * down; tile += 1) {
    const from = offsets[tile] as number;
    known.push(new Set(Array.from(lists.subarray(from, from + (counts[tile] as number)))));
  }

  /*
   * One splat at a time, drawn alone: every pixel it put light on names the tile it is in, and that
   * tile has to know the splat. Drawn alone because a cloud composited together cannot say which
   * splat lit which pixel, which is the whole question.
   */
  const frame = new Float64Array(WIDTH * HEIGHT * 4);
  let lit = 0;
  for (let slot = 0; slot < order.length; slot += 1) {
    const at = order[slot] as number;
    const alone: GaussianSet = {
      count: 1,
      positions: set.positions.subarray(at * 3, at * 3 + 3),
      scales: set.scales.subarray(at * 3, at * 3 + 3),
      rotations: set.rotations.subarray(at * 4, at * 4 + 4),
      colors: set.colors.subarray(at * 3, at * 3 + 3),
      opacities: set.opacities.subarray(at, at + 1),
    };
    rasteriseGaussians(alone, CAMERA, frame);
    for (let y = 0; y < HEIGHT; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) {
        if (!((frame[(y * WIDTH + x) * 4 + 3] as number) > 0)) continue;
        lit += 1;
        const tile = Math.floor(y / SPLAT_TILE) * across + Math.floor(x / SPLAT_TILE);
        expect(
          (known[tile] as Set<number>).has(slot),
          `splat ${slot} lit pixel ${x},${y} and tile ${tile} does not hold it`,
        ).toBe(true);
      }
    }
  }
  /* And the cloud really covered something: a comparison over an empty frame proves nothing. */
  expect(lit).toBeGreaterThan(5000);
  expect(order.length).toBeGreaterThan(20);
});

test('the lists are nearest first, because that is the order the splats arrive in', () => {
  const set = cloud(24);
  const { bins, order } = binsOf(set);
  const { across, down } = splatTileGrid(WIDTH, HEIGHT);
  const counts = new Uint32Array(across * down);
  const total = countSplatTiles(bins, order.length, WIDTH, HEIGHT, counts);
  const offsets = new Uint32Array(across * down);
  splatTileOffsets(counts, offsets);
  const lists = new Uint32Array(total);
  fillSplatTiles(bins, order.length, WIDTH, HEIGHT, offsets, new Uint32Array(across * down), lists);

  let deepest = 0;
  for (let tile = 0; tile < across * down; tile += 1) {
    const from = offsets[tile] as number;
    const held = lists.subarray(from, from + (counts[tile] as number));
    deepest = Math.max(deepest, held.length);
    for (let slot = 1; slot < held.length; slot += 1) {
      const before = bins[(held[slot - 1] as number) * SPLAT_BIN_FLOATS + 3] as number;
      const after = bins[(held[slot] as number) * SPLAT_BIN_FLOATS + 3] as number;
      expect(before).toBeLessThanOrEqual(after);
    }
  }
  /* Tiles with several splats over each other are where the order could have gone wrong. */
  expect(deepest).toBeGreaterThan(3);
});

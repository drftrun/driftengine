import { expect, test } from 'vitest';

import { ADDRESS_MODE } from '@driftengine/texture';

import { STYLE_WINDOWS } from './manhattan';
import {
  BRICK,
  CELL,
  DECO,
  LIMESTONE,
  OFFICE,
  PANE_COVERAGE,
  STYLE_EDGE,
  curtainGlass,
  paintStyle,
} from './styles';

import type { GpuDrivenProgram } from '../../packages/core/src/index';

/**
 * **What this file is for: walls that never glow, and windows that are rooms.**
 *
 * The second pipeline glows as the albedo times the emissive mask times the material's emissive,
 * so a wall texel that is not black in the mask lights the whole city from within. And a lit
 * window is a room — its own brightness, a blind, a ceiling light — not a flat square, which is
 * what the first city's windows were.
 */

const SEED = 20260918;
const PAINTERS = [
  ['brick', BRICK],
  ['limestone', LIMESTONE],
  ['deco', DECO],
  ['office', OFFICE],
] as const;

function level0(program: GpuDrivenProgram): Uint8Array {
  return program.blocks?.[0]?.levels[0] as Uint8Array;
}

test('EVERY STYLE IS A POWER-OF-TWO TILE OF WINDOWS THAT REPEATS', () => {
  expect(STYLE_EDGE).toBe(STYLE_WINDOWS * CELL);
  expect(STYLE_EDGE & (STYLE_EDGE - 1)).toBe(0);
  for (const [, painter] of PAINTERS) {
    const style = paintStyle(painter, SEED, 1);
    for (const program of [style.baseColour, style.emissive]) {
      expect(program.graph.addressMode).toBe(ADDRESS_MODE.CENTRE_WRAP);
      expect(program.blocks?.[0]?.width).toBe(STYLE_EDGE);
    }
  }
  expect(curtainGlass().graph.addressMode).toBe(ADDRESS_MODE.CENTRE_WRAP);
});

test('A WALL GLOWS NOWHERE, in any style, and some of every style’s windows do', () => {
  for (const [name, painter] of PAINTERS) {
    const glow = level0(paintStyle(painter, SEED, 1).emissive);
    let walls = 0;
    let lit = 0;
    for (let y = 0; y < STYLE_EDGE; y += 1) {
      for (let x = 0; x < STYLE_EDGE; x += 1) {
        const on = (glow[(y * STYLE_EDGE + x) * 4] as number) > 0;
        if (painter.part(x % CELL, y % CELL) !== 'glass') {
          if (on) walls += 1;
        } else if (on) lit += 1;
      }
    }
    expect(walls, name).toBe(0);
    expect(lit, name).toBeGreaterThan(0);
  }
});

test('A LIT WINDOW IS A ROOM: brighter under its head, and not every one alike', () => {
  const colour = level0(paintStyle(BRICK, SEED, 1).baseColour);
  const glow = level0(paintStyle(BRICK, SEED, 1).emissive);
  const levels = new Set<number>();
  let brighterAbove = 0;
  let windows = 0;
  for (let row = 0; row < STYLE_WINDOWS; row += 1) {
    for (let col = 0; col < STYLE_WINDOWS; col += 1) {
      const at = (x: number, y: number) => ((row * CELL + y) * STYLE_EDGE + col * CELL + x) * 4;
      if ((glow[at(8, 6)] as number) === 0) continue;
      windows += 1;
      levels.add(colour[at(8, 6)] as number);
      if ((colour[at(8, 4)] as number) <= (colour[at(8, 10)] as number)) brighterAbove += 1;
    }
  }
  expect(windows).toBeGreaterThan(50);
  expect(levels.size).toBeGreaterThan(20);
  /* Row 4 is lower in the window than row 10, since a cell's rows run up the building. */
  expect(brighterAbove / windows).toBeGreaterThan(0.6);
});

test('THE CURTAIN WALL: MULLIONS AND FLOOR BANDS SOLID, PANES THREE QUARTERS CLEAR', () => {
  const glass = level0(curtainGlass());
  const alpha = (x: number, y: number) => glass[(y * STYLE_EDGE + x) * 4 + 3] as number;
  expect(alpha(0, 8)).toBe(255);
  expect(alpha(8, 1)).toBeGreaterThan(200);
  expect(alpha(8, 8)).toBe(Math.round(PANE_COVERAGE * 255));
});

test('THE SAME SEED PAINTS THE SAME CITY, and another seed another', () => {
  const a = level0(paintStyle(DECO, SEED, 3).emissive);
  expect([...level0(paintStyle(DECO, SEED, 3).emissive)]).toEqual([...a]);
  expect([...level0(paintStyle(DECO, SEED + 1, 3).emissive)]).not.toEqual([...a]);
});

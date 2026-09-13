import { describe, expect, it } from 'vitest';

import {
  createSpriteFrame,
  frameOf,
  gridSheet,
  namedSheet,
  sheetFrame,
  sheetFrameHeight,
  sheetFrameWidth,
} from './spriteSheet.ts';

describe('gridSheet', () => {
  it('cuts a sheet into cells, row-major, left to right and top to bottom', () => {
    const sheet = gridSheet(0, 64, 32, 16, 16);
    expect(sheet.count).toBe(8);
    const frame = createSpriteFrame();
    sheetFrame(sheet, 0, frame);
    expect([frame.u0, frame.v0, frame.u1, frame.v1]).toEqual([0, 0, 0.25, 0.5]);
    sheetFrame(sheet, 4, frame);
    // The fifth cell is the first of the second row: back to the left edge, half way down.
    expect([frame.u0, frame.v0, frame.u1, frame.v1]).toEqual([0, 0.5, 0.25, 1]);
  });

  /*
   * A non-square sheet cut into non-square cells, because a square one passes with u and v swapped
   * — the same blindness a separable field gives a triangulation.
   */
  it('measures each axis against its own extent', () => {
    const sheet = gridSheet(0, 200, 50, 50, 25);
    expect(sheet.count).toBe(8);
    const frame = createSpriteFrame();
    sheetFrame(sheet, 5, frame);
    expect(frame.u0).toBeCloseTo(0.25, 6);
    expect(frame.v0).toBeCloseTo(0.5, 6);
    expect(frame.u1).toBeCloseTo(0.5, 6);
    expect(frame.v1).toBeCloseTo(1, 6);
  });

  it("answers each frame's size in texels, for drawing at its own scale", () => {
    const sheet = gridSheet(0, 200, 50, 50, 25);
    expect(sheetFrameWidth(sheet, 3)).toBe(50);
    expect(sheetFrameHeight(sheet, 3)).toBe(25);
  });

  it('ignores a partial cell rather than emitting one that runs off the sheet', () => {
    const sheet = gridSheet(0, 70, 16, 16, 16);
    expect(sheet.count).toBe(4);
  });
});

describe('namedSheet', () => {
  const sheet = namedSheet(2, 128, 64, [
    { name: 'idle', x: 0, y: 0, w: 32, h: 32 },
    { name: 'run', x: 32, y: 16, w: 64, h: 48 },
  ]);

  it('keeps the texture slot it was built for', () => {
    expect(sheet.texture).toBe(2);
  });

  it('turns a pixel rectangle into the texture coordinates that address it', () => {
    const frame = createSpriteFrame();
    sheetFrame(sheet, frameOf(sheet, 'run'), frame);
    expect([frame.u0, frame.v0, frame.u1, frame.v1]).toEqual([0.25, 0.25, 0.75, 1]);
  });

  it('answers a name it does not have with a frame that draws nothing visible', () => {
    expect(frameOf(sheet, 'jump')).toBe(-1);
  });

  it('reads a missing frame as the whole sheet rather than throwing in a frame loop', () => {
    const frame = createSpriteFrame();
    sheetFrame(sheet, -1, frame);
    expect([frame.u0, frame.v0, frame.u1, frame.v1]).toEqual([0, 0, 1, 1]);
  });
});

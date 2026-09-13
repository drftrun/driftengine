import { describe, expect, test } from 'vitest';
import { BoxSurface } from './boxSurface.ts';
import { CompositeSurface } from './compositeSurface.ts';
import { RibbonSurface, createSurfaceHit } from './ribbonSurface.ts';
import { Spline } from '../geometry/spline.ts';
import type { SurfaceBox } from './boxSurface.ts';

function pad(over: Partial<SurfaceBox> = {}): SurfaceBox {
  return {
    minX: -2,
    maxX: 2,
    minZ: -2,
    maxZ: 2,
    topY: 10,
    distanceM: 0,
    tangentX: 1,
    tangentZ: 0,
    ...over,
  };
}

describe('BoxSurface', () => {
  test('a pad is ground where it is, and nowhere else', () => {
    const surface = new BoxSurface([pad()]);
    const hit = createSurfaceHit();
    expect(surface.sample(0, 0, hit)).toBe(true);
    expect(hit.y).toBe(10);
    expect(surface.sample(5, 0, hit)).toBe(false);
    expect(surface.sample(0, 5, hit)).toBe(false);
  });

  test('the gap between two pads is a gap', () => {
    // The whole point of a run of pads: not jumping means going down.
    const surface = new BoxSurface([
      pad({ minX: 0, maxX: 4 }),
      pad({ minX: 10, maxX: 14, topY: 8 }),
    ]);
    const hit = createSurfaceHit();
    expect(surface.sample(2, 0, hit)).toBe(true);
    expect(surface.sample(7, 0, hit)).toBe(false);
    expect(surface.sample(12, 0, hit)).toBe(true);
  });

  test('overlapping pads report the one on top', () => {
    // A flight of steps whose treads touch at the riser: standing on the seam
    // has to put you on the upper tread, or every step down is a stumble.
    const surface = new BoxSurface([
      pad({ minX: 0, maxX: 5, topY: 10 }),
      pad({ minX: 4, maxX: 9, topY: 8 }),
    ]);
    const hit = createSurfaceHit();
    expect(surface.sample(4.5, 0, hit)).toBe(true);
    expect(hit.y).toBe(10);
  });

  test('it reports where along the route it is', () => {
    // Pads are part of the route, so they have to answer the question the
    // ribbon answers — top speed, the HUD and the director all read it.
    const surface = new BoxSurface([pad({ distanceM: 143.5 })]);
    const hit = createSurfaceHit();
    surface.sample(0, 0, hit);
    expect(hit.distanceM).toBe(143.5);
    expect(hit.normalY).toBe(1);
    expect(hit.bankRad).toBe(0);
  });

  test('an empty set is ground nowhere', () => {
    const hit = createSurfaceHit();
    expect(new BoxSurface([]).sample(0, 0, hit)).toBe(false);
  });

  test('a ribbon and its pads answer as one route', () => {
    /*
     * The composite is what makes a hybrid route possible: the ribbon covers
     * most of it, pads cover the stretches where the ribbon stops, and a caller
     * — the controller — asks one question and never learns there are two kinds
     * of ground.
     */
    const spline = new Spline([
      { x: 0, y: 10, z: 0, bankRad: 0, widthM: 8 },
      { x: 20, y: 10, z: 0, bankRad: 0, widthM: 8 },
      { x: 40, y: 10, z: 0, bankRad: 0, widthM: 8 },
    ]);
    const holes = [{ fromM: 15, toM: 28 }];
    const route = new CompositeSurface([
      new RibbonSurface(spline, { holes }),
      new BoxSurface([pad({ minX: 17, maxX: 21, topY: 9 }), pad({ minX: 24, maxX: 27, topY: 8 })]),
    ]);
    const hit = createSurfaceHit();

    expect(route.sample(5, 0, hit), 'on the ribbon').toBe(true);
    expect(hit.y).toBeCloseTo(10, 3);
    expect(route.sample(19, 0, hit), 'on the first pad').toBe(true);
    expect(hit.y).toBe(9);
    expect(route.sample(22.5, 0, hit), 'in the gap between pads').toBe(false);
    expect(route.sample(35, 0, hit), 'back on the ribbon').toBe(true);
    expect(hit.y).toBeCloseTo(10, 3);
  });
});

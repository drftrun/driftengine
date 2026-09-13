import { describe, expect, test } from 'vitest';
import { Spline, createSplineSample } from '../geometry/spline.ts';
import { RibbonSurface, createSurfaceHit } from './ribbonSurface.ts';
import type { SplinePoint } from '../geometry/spline.ts';

function pt(x: number, y: number, z: number, bankRad = 0, widthM = 8): SplinePoint {
  return { x, y, z, bankRad, widthM };
}

/** Climbs, banks and turns — nothing here is separable into easy axes. */
function twistedTrack(): Spline {
  return new Spline([
    pt(0, 4, 0, 0, 8),
    pt(20, 5, 2, 0.2, 8),
    pt(40, 8, 12, 0.45, 9),
    pt(55, 9, 28, 0.45, 9),
    pt(60, 8, 46, 0.1, 7),
    pt(58, 6, 62, 0, 7),
  ]);
}

describe('RibbonSurface', () => {
  test('it inverts the surface it was built from', () => {
    /*
     * The strongest statement available: take a point that is *on* the surface
     * by construction — the centreline at arc length s, pushed u metres along
     * the banked right vector — drop its height, and ask the surface where the
     * ground is in that column. It must give the height back, and it must say
     * how far off the line you are.
     *
     * This is what the controller will stand on. A surface query that is right
     * on a flat straight and 20 cm out on a banked corner produces a character who
     * hovers through every corner of the game.
     */
    const spline = twistedTrack();
    const surface = new RibbonSurface(spline);
    const sample = createSplineSample();
    const hit = createSurfaceHit();

    for (let d = 2; d < spline.lengthM - 2; d += 1.7) {
      spline.sampleAt(d, sample);
      for (const u of [-2.5, -1, 0, 1, 2.5]) {
        const x = sample.x + sample.rightX * u;
        const y = sample.y + sample.rightY * u;
        const z = sample.z + sample.rightZ * u;
        expect(surface.sample(x, z, hit), `no surface at d=${d} u=${u}`).toBe(true);
        // Sub-millimetre. Loose enough was 5 mm, and 5 mm was passing while the
        // solver was decoupling arc length from lateral offset — the tolerance
        // was hiding the defect rather than allowing for float error.
        expect(hit.y, `height at d=${d} u=${u}`).toBeCloseTo(y, 3);
        expect(hit.lateralM, `lateral at d=${d} u=${u}`).toBeCloseTo(u, 3);
        expect(hit.distanceM, `arc length at d=${d} u=${u}`).toBeCloseTo(d, 0);
      }
    }
  });

  test('the normal it reports is the banked normal, not up', () => {
    // The entire reason this exists. A surface that reports world up on a bank
    // makes banking decorative: friction, gravity and the camera all keep
    // behaving as though the track were flat.
    const bank = 0.5;
    const spline = new Spline([pt(0, 3, 0, bank), pt(20, 3, 0, bank), pt(40, 3, 0, bank)]);
    const surface = new RibbonSurface(spline);
    const hit = createSurfaceHit();
    expect(surface.sample(20, 0, hit)).toBe(true);
    expect(hit.normalY).toBeCloseTo(Math.cos(bank), 3);
    expect(Math.hypot(hit.normalX, hit.normalY, hit.normalZ)).toBeCloseTo(1, 5);
    expect(hit.bankRad).toBeCloseTo(bank, 3);
  });

  test('past the edge there is no surface', () => {
    const spline = new Spline([pt(0, 3, 0, 0, 8), pt(20, 3, 0, 0, 8), pt(40, 3, 0, 0, 8)]);
    const surface = new RibbonSurface(spline);
    const hit = createSurfaceHit();
    expect(surface.sample(20, 3.5, hit)).toBe(true);
    expect(surface.sample(20, 4.5, hit)).toBe(false);
    expect(surface.sample(20, -4.5, hit)).toBe(false);
  });

  test('past the ends there is no surface', () => {
    // Otherwise the track has invisible floor before its first metre and past
    // the summit, which is exactly where a fall is supposed to be possible.
    const spline = new Spline([pt(0, 3, 0), pt(20, 3, 0), pt(40, 3, 0)]);
    const surface = new RibbonSurface(spline);
    const hit = createSurfaceHit();
    expect(surface.sample(-3, 0, hit)).toBe(false);
    expect(surface.sample(43, 0, hit)).toBe(false);
  });

  test('over a hole there is no surface, because that is the jump', () => {
    /*
     * An interrupted track: if you do not jump, you go down. The surface
     * query is the thing that decides that, so a hole it does not know about is
     * a jump the player cannot fail — which is the same as no jump at all.
     */
    const spline = new Spline([pt(0, 3, 0), pt(20, 3, 0), pt(40, 3, 0)]);
    const surface = new RibbonSurface(spline, { holes: [{ fromM: 15, toM: 25 }] });
    const hit = createSurfaceHit();
    expect(surface.sample(10, 0, hit)).toBe(true);
    expect(surface.sample(20, 0, hit)).toBe(false);
    expect(surface.sample(30, 0, hit)).toBe(true);
  });

  test('the query allocates nothing, because it runs every tick', () => {
    const surface = new RibbonSurface(twistedTrack());
    const hit = createSurfaceHit();
    const before = hit;
    surface.sample(20, 2, hit);
    expect(hit).toBe(before);
  });

  test('a degenerate track has no surface anywhere', () => {
    const surface = new RibbonSurface(new Spline([]));
    const hit = createSurfaceHit();
    expect(surface.sample(0, 0, hit)).toBe(false);
    expect(surface.sample(10, -4, hit)).toBe(false);
  });

  test('a track that doubles back over itself picks the nearer pass', () => {
    /*
     * A hairpin puts two stretches of the same track in the same column, less
     * than a track-width apart. Seeding the search from the wrong one snaps the
     * character onto the other carriageway — and it happens in exactly the corner
     * where a player is least able to recover.
     */
    const spline = new Spline([
      pt(0, 3, 0, 0, 6),
      pt(20, 3, 0, 0, 6),
      pt(28, 3, 4, 0, 6),
      pt(28, 3, 12, 0, 6),
      pt(20, 3, 16, 0, 6),
      pt(0, 3, 16, 0, 6),
    ]);
    const surface = new RibbonSurface(spline);
    const hit = createSurfaceHit();
    expect(surface.sample(10, 0, hit)).toBe(true);
    expect(hit.distanceM).toBeLessThan(15);
    expect(surface.sample(10, 16, hit)).toBe(true);
    expect(hit.distanceM).toBeGreaterThan(spline.lengthM - 15);
  });
});

test('a kerb is floor: the raised trim down each edge can be stood on', () => {
  /*
   * Reported on a route's edges: the trim read as non-solid, and the body's feet sank
   * under it. A small detail, and the kind that makes a world stop feeling consistent.
   *
   * A kerb is drawn as its own ribbon over the outermost band of the deck, lifted a few
   * centimetres. Nothing about that reached the *surface*, so it reported the deck's own
   * height under trim the player can see they are standing on — and their skates sank
   * into it. The two figures come from the same constants the trim is built with, which
   * is what stops the drawn kerb and the walkable floor from drifting apart.
   *
   * A flat straight ribbon, so the only thing that can move `y` is the band.
   */
  const points: SplinePoint[] = [];
  for (let x = 0; x <= 120; x += 10) {
    points.push({ x, y: 50, z: 0, bankRad: 0, widthM: 10 });
  }
  const spline = new Spline(points);
  const plain = new RibbonSurface(spline);
  const kerbed = new RibbonSurface(spline, { edgeBandM: 0.7, edgeLiftM: 0.06 });
  const hit = createSurfaceHit();

  // Down the middle both agree: a kerb is at the edge, and nowhere else.
  expect(plain.sample(60, 0, hit)).toBe(true);
  expect(hit.y).toBeCloseTo(50, 6);
  expect(kerbed.sample(60, 0, hit)).toBe(true);
  expect(hit.y, 'the centreline is not a kerb').toBeCloseTo(50, 6);

  // And inside the band, on both edges, the floor is the trim's own top.
  for (const z of [4.8, -4.8]) {
    expect(plain.sample(60, z, hit)).toBe(true);
    expect(hit.y, `without trim, ${z} is deck`).toBeCloseTo(50, 6);
    expect(kerbed.sample(60, z, hit)).toBe(true);
    expect(hit.y, `with trim, ${z} stands on the kerb`).toBeCloseTo(50.06, 6);
  }

  // Just inside the band's inner edge is still deck, so the step is where it is drawn.
  expect(kerbed.sample(60, 4.2, hit)).toBe(true);
  expect(hit.y, 'a hair inside the band is still deck').toBeCloseTo(50, 6);

  // The kerb does not change which way is up: its top is parallel to what it edges.
  expect(kerbed.sample(60, 4.8, hit)).toBe(true);
  expect(hit.normalY, 'a kerb top is level with its deck').toBeCloseTo(1, 6);
});

import { describe, expect, it } from 'vitest';
import {
  CLEAR_TEXEL,
  FROST_RADIUS_CAP,
  FROST_SPREAD,
  combinePanes,
  frostRadius,
  paneTexel,
  spreadTint,
  tapTint,
  unmixTint,
  type GlassTexel,
} from './glassShadow.ts';

const texel = (): GlassTexel => ({ r: 0, g: 0, b: 0, clarity: 0 });

describe('glass shadow arithmetic', () => {
  it('A PANE PASSES ITS TRANSMISSION, LESS WHAT IT REFLECTS, IN ITS COLOUR', () => {
    /* Face-on the reflected share is 0.04, so 0.9 × 0.96 × tint. Clarity is 1 − frost. */
    const out = paneTexel({ transmission: 0.9, frost: 0.25, tint: [1, 0.5, 0.25] }, 1, texel());
    expect(out.r).toBeCloseTo(0.864, 6);
    expect(out.g).toBeCloseTo(0.432, 6);
    expect(out.b).toBeCloseTo(0.216, 6);
    expect(out.clarity).toBeCloseTo(0.75, 6);
    /* Grazing, at the 0.05 floor: 0.04 + 0.96 × 0.95⁵ of it is reflected rather than passed. */
    const grazing = paneTexel({ transmission: 1, frost: 0, tint: [1, 1, 1] }, 0, texel());
    expect(grazing.r).toBeCloseTo(1 - (0.04 + 0.96 * 0.95 ** 5), 6);
  });

  it('TWO PANES MULTIPLY, IN EITHER ORDER', () => {
    const a = { r: 0.8, g: 0.6, b: 0.4, clarity: 0.5 };
    const b = { r: 0.5, g: 1, b: 0.25, clarity: 0.9 };
    const ab = combinePanes(a, b, texel());
    const ba = combinePanes(b, a, texel());
    expect(ab.r).toBeCloseTo(0.4, 9);
    expect(ab.g).toBeCloseTo(0.6, 9);
    expect(ab.b).toBeCloseTo(0.1, 9);
    expect(ab.clarity).toBeCloseTo(0.45, 9);
    expect(ba).toEqual(ab);
    expect(combinePanes(CLEAR_TEXEL, a, texel()), 'no glass is the identity').toEqual(a);
  });

  it('ONLY A RECEIVER BEHIND THE PANE IS TINTED, and the pane itself is not', () => {
    const glass = { r: 0.5, g: 0.5, b: 0.5, clarity: 1 };
    expect(tapTint(0.8, 0.5, 0.01, glass, texel()).r, 'behind: tinted').toBe(0.5);
    expect(tapTint(0.3, 0.5, 0.01, glass, texel()).r, 'on the light side: clear').toBe(1);
    expect(tapTint(0.505, 0.5, 0.01, glass, texel()).r, 'the pane itself: clear').toBe(1);
  });

  it('FROST SPREADS WITH DISTANCE FROM THE PANE, AND IS CAPPED', () => {
    /* Sixty-four base radii: a frosted pane two metres above a floor spreads its colour most of a
       metre, and on a 14 m sun map eight radii was seven centimetres — frost that nobody saw. */
    expect(FROST_RADIUS_CAP).toBe(64);
    expect(frostRadius(1, 2, 0.01), 'clear glass: the base filter').toBe(0.01);
    /* Below the cap (8 × 0.1): half frosted, two metres behind the pane, a 30° cone. */
    expect(frostRadius(0.5, 2, 0.1)).toBeCloseTo(0.5 * FROST_SPREAD * 2, 9);
    expect(frostRadius(0, 1000, 0.01), 'never past the cap').toBe(0.01 * FROST_RADIUS_CAP);
    expect(FROST_SPREAD).toBeCloseTo(0.57735, 5);
  });
});

describe('spreading a frosted pane', () => {
  it('KEEPS THE PATCH S OUTLINE AND MIXES ONLY GLASS INTO ITS COLOUR, so no light is gained', () => {
    const out = { r: 0, g: 0, b: 0, clarity: 0 };
    /* Inside a uniform pane: every outline tap covered, every spread tap on the same glass. */
    spreadTint(1, { r: 4 * 0.5, g: 4 * 0.25, b: 4, clarity: 0 }, 4, out);
    expect([out.r, out.g, out.b]).toEqual([0.5, 0.25, 1]);
    /* Half the outline covered, the colour of the glass the spread found: half tinted. */
    spreadTint(0.5, { r: 0.5, g: 0.5, b: 0.5, clarity: 0 }, 1, out);
    expect([out.r, out.g, out.b]).toEqual([0.75, 0.75, 0.75]);
    /* No outline tap covered: untinted, whatever glass the wide spread reached beyond it. */
    spreadTint(0, { r: 0.1, g: 0.1, b: 0.1, clarity: 0 }, 1, out);
    expect([out.r, out.g, out.b]).toEqual([1, 1, 1]);
    /* Covered, and the spread found only ground: the outline's own glass is unknown, so clear. */
    spreadTint(1, { r: 0, g: 0, b: 0, clarity: 0 }, 0, out);
    expect([out.r, out.g, out.b]).toEqual([1, 1, 1]);
  });
});

describe('reading a frosted pane at a coarse level', () => {
  it('UNMIXES THE GROUND S WHITE FROM A COARSE TEXEL, by how milky the pane is', () => {
    const out = { r: 0, g: 0, b: 0, clarity: 0 };
    /*
     * Half a coarse texel is a pane letting 0.5 through at clarity 0.2, half is open ground:
     * the level averages to 0.75 and clarity 0.6. The pane's share is (1 − 0.6) / (1 − 0.2) = 0.5,
     * and its colour (0.75 − 0.5) / 0.5 = 0.5 — exactly the pane, with no white leaked in.
     */
    expect(unmixTint({ r: 0.75, g: 0.75, b: 0.75, clarity: 0.6 }, 0.2, out)).toBeCloseTo(0.5, 9);
    expect(out.r).toBeCloseTo(0.5, 9);
    /* All pane: nothing to unmix. */
    expect(unmixTint({ r: 0.4, g: 0.3, b: 0.2, clarity: 0.2 }, 0.2, out)).toBeCloseTo(1, 9);
    expect([out.r, out.g, out.b].map((v) => Number(v.toFixed(9)))).toEqual([0.4, 0.3, 0.2]);
    /* All ground: no pane in it, and nothing claimed. */
    expect(unmixTint({ r: 1, g: 1, b: 1, clarity: 1 }, 0.2, out)).toBe(0);
    /* A clear pane cannot be told from ground by clarity; it is read as it stands. */
    expect(unmixTint({ r: 0.6, g: 0.6, b: 0.6, clarity: 1 }, 1, out)).toBe(1);
    expect(out.r).toBeCloseTo(0.6, 9);
  });
});

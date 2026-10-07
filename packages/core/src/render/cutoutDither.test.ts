import { expect, test } from 'vitest';

import { cutoutShare, ditherThreshold, resolveCutout } from './cutoutDither.ts';

/*
 * What a dithered cutout does is decided per frame from what the frame can resolve, and the three
 * answers are the maintainer's ruling: dither under a temporal resolve, coverage when the frame is
 * multisampled, the hard test otherwise. A hard cutout is hard whatever the frame has.
 */
test('A DITHERED CUTOUT TAKES THE SMOOTHEST EDGE THE FRAME CAN RESOLVE', () => {
  expect(resolveCutout('dithered', true, 1)).toBe('dither');
  expect(resolveCutout('dithered', true, 4), 'a temporal resolve wins over multisampling').toBe(
    'dither',
  );
  expect(resolveCutout('dithered', false, 4)).toBe('coverage');
  expect(resolveCutout('dithered', false, 1)).toBe('hard');
  expect(resolveCutout('hard', true, 4)).toBe('hard');
  expect(resolveCutout('hard', false, 1)).toBe('hard');
});

/*
 * The share of a pixel a cutout keeps, which the dither and the coverage both draw: alpha mapped so
 * the cutoff is half covered. At the common cutoff of a half that is alpha itself, which is what
 * coverage means for a strand of hair; a lower cutoff reaches full cover sooner.
 */
test('the kept share is half at the cutoff, and alpha itself at a cutoff of a half', () => {
  expect(cutoutShare(0.5, 0.5)).toBeCloseTo(0.5, 6);
  expect(cutoutShare(0.2, 0.5)).toBeCloseTo(0.2, 6);
  expect(cutoutShare(0.9, 0.5)).toBeCloseTo(0.9, 6);
  expect(cutoutShare(0.25, 0.25)).toBeCloseTo(0.5, 6);
  /* 2 * min(0.25, 0.75) = 0.5 wide around 0.25: nothing at 0, everything from 0.5 up. */
  expect(cutoutShare(0, 0.25)).toBeCloseTo(0, 6);
  expect(cutoutShare(0.5, 0.25)).toBeCloseTo(1, 6);
  expect(cutoutShare(0.8, 0.25)).toBeCloseTo(1, 6);
});

/*
 * The threshold a pixel is compared against: interleaved gradient noise, which a temporal resolve
 * integrates because it is evenly spread over every small tile. Its mean over a tile is a half, so
 * a pixel of share s is kept on a share s of the pixels around it.
 */
test('the threshold is evenly spread over a tile, on every frame', () => {
  for (let frame = 0; frame < 8; frame++) {
    let sum = 0;
    let below = 0;
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const t = ditherThreshold(x + 0.5, y + 0.5, frame);
        expect(t).toBeGreaterThanOrEqual(0);
        expect(t).toBeLessThan(1);
        sum += t;
        if (t < 0.3) below += 1;
      }
    }
    expect(sum / 4096, `frame ${frame}`).toBeCloseTo(0.5, 2);
    expect(below / 4096, `frame ${frame}: a share of 0.3 keeps 0.3 of the tile`).toBeCloseTo(
      0.3,
      1,
    );
  }
});

/* And it moves from frame to frame, or a temporal resolve has nothing to average. */
test('A PIXEL SEES A DIFFERENT THRESHOLD ON THE NEXT FRAME', () => {
  let moved = 0;
  for (let x = 0; x < 64; x++) {
    if (Math.abs(ditherThreshold(x + 0.5, 7.5, 0) - ditherThreshold(x + 0.5, 7.5, 1)) > 0.05)
      moved++;
  }
  expect(moved).toBeGreaterThan(48);
});

/*
 * The lit pass and every caster keep a dithered pixel by the same two functions, so a shadow is
 * cut from the share the surface draws. The lit pass alone takes the frame's pattern; a caster's
 * does not move, because a shadow map has no temporal resolve and a static layer keeps it.
 */
test('THE SURFACE AND ITS CASTERS KEEP A DITHERED PIXEL BY THE SAME TEST', async () => {
  const { flatFrag } = await import('./shaders/flat/index.ts');
  const { DEPTH_CUTOUT_FRAG, GLASS_TINT_CUTOUT_FRAG } = await import('./shaders/depth.ts');
  const lit = flatFrag({
    pointShadows: true,
    directionalShadows: true,
    environmentProbe: true,
    nightEmissive: true,
  }).replace(/\s+/g, ' ');
  expect(lit).toContain('if (!cutoutKeeps(share, gl_FragCoord.xy, uHighlightMin.w)) discard;');
  expect(lit, 'a coverage frame hands the share on as alpha').toContain('kept = share;');
  for (const caster of [DEPTH_CUTOUT_FRAG, GLASS_TINT_CUTOUT_FRAG]) {
    const source = caster.replace(/\s+/g, ' ');
    expect(source).toContain(
      'if (!cutoutKeeps(cutoutShare(alpha, vAlphaCutout.x), gl_FragCoord.xy, 0.0)) discard;',
    );
  }
});

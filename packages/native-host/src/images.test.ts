import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import { encodePng } from '@driftengine/core/scripts/png.mjs';
import { hostCreateImageBitmap, isHostBitmap } from './images.ts';

/**
 * **What this file is for: the images a scene decodes, under a host with no browser to decode them.**
 * A model's textures arrive as PNG and JPEG bytes and go through `createImageBitmap`, which Node does
 * not have. PNG through this repository's own decoder, JPEG through `@jsquash/jpeg` — MozJPEG, which
 * is libjpeg-turbo, and which decodes the showroom car's five JPEGs to Chrome's bytes exactly
 * (measured 2026-09-19: 0 of 6.07 million pixels).
 */

const RED_THEN_CLEAR = new Uint8Array([255, 0, 0, 255, 10, 20, 30, 0]);

describe('the images a host decodes', () => {
  test('A PNG DECODES TO ITS OWN BYTES, straight alpha and all', async () => {
    const png = encodePng(2, 1, RED_THEN_CLEAR);
    const bitmap = await hostCreateImageBitmap(
      new Blob([new Uint8Array(png)], { type: 'image/png' }),
    );
    expect(isHostBitmap(bitmap)).toBe(true);
    expect([bitmap.width, bitmap.height]).toEqual([2, 1]);
    /* The transparent pixel keeps its colour: nothing premultiplied it. */
    expect(Array.from(bitmap.data)).toEqual(Array.from(RED_THEN_CLEAR));
  });

  test('A PNG WITHOUT ALPHA GAINS AN OPAQUE ONE, four bytes a pixel like every other', async () => {
    const png = readFileSync(new URL('./fixtures/rgb.png', import.meta.url));
    const bitmap = await hostCreateImageBitmap(
      new Blob([new Uint8Array(png)], { type: 'image/png' }),
    );
    expect(Array.from(bitmap.data)).toEqual([10, 20, 30, 255, 200, 100, 50, 255]);
  });

  test('A JPEG DECODES THROUGH MOZJPEG, to four bytes a pixel', async () => {
    const jpeg = readFileSync(new URL('./fixtures/grey.jpg', import.meta.url));
    const bitmap = await hostCreateImageBitmap(
      new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' }),
    );
    expect([bitmap.width, bitmap.height]).toEqual([8, 8]);
    expect(bitmap.data.length).toBe(8 * 8 * 4);
    /* A flat mid grey, which a baseline JPEG holds exactly. */
    expect(Array.from(bitmap.data.subarray(0, 4))).toEqual([128, 128, 128, 255]);
  });

  test('IMAGEDATA IS TAKEN AS IT IS, which is how a raw texture arrives', async () => {
    const data = new Uint8ClampedArray(RED_THEN_CLEAR);
    const bitmap = await hostCreateImageBitmap({ data, width: 2, height: 1 } as ImageData);
    expect(Array.from(bitmap.data)).toEqual(Array.from(RED_THEN_CLEAR));
  });

  test('WHAT THE ENGINE ASKS FOR IS WHAT IT GETS: no premultiply, no colour conversion', async () => {
    const png = encodePng(2, 1, RED_THEN_CLEAR);
    const bitmap = await hostCreateImageBitmap(
      new Blob([new Uint8Array(png)], { type: 'image/png' }),
      {
        premultiplyAlpha: 'none',
        colorSpaceConversion: 'none',
      },
    );
    expect(Array.from(bitmap.data)).toEqual(Array.from(RED_THEN_CLEAR));
  });

  test('A RESIZED DECODE IS DECLINED BY NAME, since Chrome’s resampling is its own', async () => {
    /*
     * **Declined rather than approximated.** The model loader asks for a small preview first and
     * drops it if it fails; the sharp image follows either way. A preview resampled by some other
     * filter would put a picture on the screen for a few frames that no browser ever drew.
     */
    const png = encodePng(2, 1, RED_THEN_CLEAR);
    await expect(
      hostCreateImageBitmap(new Blob([new Uint8Array(png)], { type: 'image/png' }), {
        resizeWidth: 1,
      }),
    ).rejects.toThrow(/does not resample/);
  });

  test('A FORMAT IT CANNOT DECODE IS REFUSED BY NAME', async () => {
    await expect(
      hostCreateImageBitmap(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' })),
    ).rejects.toThrow(/image\/webp/);
  });
});

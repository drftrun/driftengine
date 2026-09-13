import { describe, expect, it } from 'vitest';

import { equirectToCubeFaces } from './equirectToCube.ts';

const FACE_POS_X = 0;
const FACE_NEG_X = 1;
const FACE_POS_Y = 2;
const FACE_NEG_Y = 3;
const FACE_POS_Z = 4;
const FACE_NEG_Z = 5;

/** An equirectangular image of one colour, so a marked region is the only thing that can show. */
function blank(
  width: number,
  height: number,
): { width: number; height: number; data: Float32Array } {
  return { width, height, data: new Float32Array(width * height * 3) };
}

/** Light one horizontal band of rows. */
function markRows(
  image: { width: number; height: number; data: Float32Array },
  from: number,
  to: number,
): void {
  for (let y = from; y < to; y++) {
    for (let x = 0; x < image.width; x++) image.data[(y * image.width + x) * 3] = 1;
  }
}

/** Light one vertical band of columns. */
function markColumns(
  image: { width: number; height: number; data: Float32Array },
  from: number,
  to: number,
): void {
  for (let y = 0; y < image.height; y++) {
    for (let x = from; x < to; x++) image.data[(y * image.width + x) * 3] = 1;
  }
}

/** Mean red of a face, which is all these fixtures write. */
function meanRed(face: Float32Array): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < face.length; i += 4) {
    sum += face[i] ?? 0;
    count++;
  }
  return count === 0 ? 0 : sum / count;
}

describe('equirectangular to cube faces', () => {
  it('produces six faces of the asked-for size, in RGBA', () => {
    const faces = equirectToCubeFaces(blank(16, 8), 4);
    expect(faces.length).toBe(6);
    for (const face of faces) expect(face.length).toBe(4 * 4 * 4);
  });

  /*
   * **The latitude test, and it is the one that matters most.** Row 0 of an equirectangular image
   * is the zenith, so a bright band at the top must land on `+Y` and nowhere else. Getting this
   * inverted puts the sky underfoot, which is the single most confusing way an environment can be
   * wrong: every surface is lit from below and nothing about the picture says why.
   */
  it('puts the top of the image on +Y and the bottom on -Y', () => {
    const top = blank(32, 16);
    markRows(top, 0, 2);
    /*
     * **Asserted as "this face and no other" rather than against a level.** A band two rows deep
     * out of sixteen is a cap around the pole, and the +Y face reaches 45 degrees away from it, so
     * the face mean is a fraction — 0.1364 here — that depends on the band's depth and the face
     * size and means nothing on its own. What does mean something is that five faces are exactly
     * zero: any mis-indexed fetch, any transposed axis, any mirrored face breaks that and nothing
     * else about the picture would say so.
     */
    const fromTop = equirectToCubeFaces(top, 8);
    const topFaces = fromTop.map(meanRed);
    expect(topFaces[FACE_POS_Y]).toBeGreaterThan(0);
    for (const face of [FACE_POS_X, FACE_NEG_X, FACE_NEG_Y, FACE_POS_Z, FACE_NEG_Z]) {
      expect(topFaces[face]).toBe(0);
    }

    const bottom = blank(32, 16);
    markRows(bottom, 14, 16);
    const bottomFaces = equirectToCubeFaces(bottom, 8).map(meanRed);
    expect(bottomFaces[FACE_NEG_Y]).toBeGreaterThan(0);
    for (const face of [FACE_POS_X, FACE_NEG_X, FACE_POS_Y, FACE_POS_Z, FACE_NEG_Z]) {
      expect(bottomFaces[face]).toBe(0);
    }
  });

  /*
   * **The longitude test, which pins the handedness.** The convention this module documents is that
   * the centre column of the image is `-Z`, matching the engine's own camera convention where yaw 0
   * looks toward `-Z` and positive yaw turns toward `+X`. So a bright band down the middle lands on
   * `-Z`, and one at three quarters across lands on `+X`.
   *
   * A mirrored longitude passes every "is the sky up" check and every "is it bright enough" check,
   * and shows only as a reflection that turns the wrong way — which is the failure that took a
   * shared spherical-harmonic basis to find between the two backends once already.
   */
  it('puts the centre column on -Z and three quarters across on +X', () => {
    const centre = blank(32, 16);
    markColumns(centre, 15, 17);
    const centreFaces = equirectToCubeFaces(centre, 8).map(meanRed);
    expect(centreFaces[FACE_NEG_Z]).toBeGreaterThan(0);
    expect(centreFaces[FACE_POS_Z]).toBe(0);
    expect(centreFaces[FACE_POS_X]).toBe(0);
    expect(centreFaces[FACE_NEG_X]).toBe(0);

    const quarter = blank(32, 16);
    markColumns(quarter, 23, 25);
    const quarterFaces = equirectToCubeFaces(quarter, 8).map(meanRed);
    expect(quarterFaces[FACE_POS_X]).toBeGreaterThan(0);
    expect(quarterFaces[FACE_NEG_X]).toBe(0);
    expect(quarterFaces[FACE_POS_Z]).toBe(0);
    expect(quarterFaces[FACE_NEG_Z]).toBe(0);
  });

  /*
   * A uniform environment comes back uniform on every face. This is the check that a sampling bug
   * cannot hide behind: any mis-indexed fetch shows as one face differing from five identical ones.
   */
  it('carries a uniform environment through unchanged', () => {
    const flat = blank(32, 16);
    for (let i = 0; i < flat.data.length; i += 3) flat.data[i] = 0.375;
    const faces = equirectToCubeFaces(flat, 8);
    for (const face of faces) expect(meanRed(face)).toBeCloseTo(0.375, 5);
  });

  /* Alpha is written as one, because a cube sampler reads four channels whatever we meant. */
  it('writes an opaque alpha', () => {
    const faces = equirectToCubeFaces(blank(16, 8), 2);
    const face = faces[0] ?? new Float32Array();
    for (let i = 3; i < face.length; i += 4) expect(face[i]).toBe(1);
  });
});

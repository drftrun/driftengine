import { describe, expect, it } from 'vitest';
import {
  ADDRESS_CLAMP,
  ADDRESS_WRAP,
  OVERLAY_CHANNELS,
  compositeOverlay,
  createOverlay,
  overlayTileCount,
  overlayTiles,
  sampleOverlay,
  writeOverlay,
  writtenMaskAt,
  type Overlay,
} from './sparse.ts';

/** Four tiles of eight texels each way: thirty-two texels across the unit square. */
function overlay(options: { addressMode?: number } = {}): Overlay {
  return createOverlay(8, { tilesAcross: 4, addressMode: options.addressMode });
}

const out = new Float32Array(OVERLAY_CHANNELS);

/**
 * The UV of a texel's centre, and of the boundary before it.
 *
 * Spelled out because the first version of these tests used round numbers like 0.5, which at
 * thirty-two texels across is a texel *boundary* — so a disc of any radius straddles four texels
 * and four tiles, and five tests asserted the wrong thing for a reason that had nothing to do with
 * the code. A mark is aimed at a texel or at a seam, and saying which is the whole of it.
 */
const centre = (texel: number): number => (texel + 0.5) / 32;
const edge = (texel: number): number => texel / 32;
/** One texel's worth of UV, so a radius can be stated in texels. */
const TEXEL = 1 / 32;

describe('nothing exists until it is written', () => {
  it('holds no tiles at all to begin with', () => {
    const o = overlay();
    expect(overlayTileCount(o)).toBe(0);
    expect(sampleOverlay(o, 0.5, 0.5, out)).toBe(false);
  });

  it('allocates only the tiles a mark touched', () => {
    /* The whole point: a scorch on one wall must not allocate a layer for the building. Sixteen
       tiles exist in principle and one is made. */
    const o = overlay();
    expect(o.resolution).toBe(32);
    writeOverlay(o, centre(2), centre(2), TEXEL * 0.4, 0, 1);
    expect(overlayTileCount(o)).toBe(1);
    expect(sampleOverlay(o, centre(29), centre(29), out)).toBe(false);
  });

  it('reports an untouched texel inside a written tile as unwritten', () => {
    const o = overlay();
    writeOverlay(o, centre(2), centre(2), TEXEL * 0.4, 0, 1);
    expect(sampleOverlay(o, centre(2), centre(2), out)).toBe(true);
    /* The same tile — tiles are eight texels — and a texel the disc did not reach. */
    expect(sampleOverlay(o, centre(6), centre(6), out)).toBe(false);
    expect(overlayTileCount(o)).toBe(1);
  });
});

describe('a write then a read', () => {
  it('returns the value on the channel it was written to', () => {
    const o = overlay();
    expect(writeOverlay(o, centre(12), centre(12), TEXEL * 0.4, 2, 0.75)).toBe(1);
    expect(sampleOverlay(o, centre(12), centre(12), out)).toBe(true);
    expect(out[2]).toBeCloseTo(0.75, 6);
    /* And the others are untouched zeros rather than the value bleeding across. */
    expect([out[0], out[1], out[3]]).toEqual([0, 0, 0]);
    expect(writtenMaskAt(o, centre(12), centre(12))).toBe(1 << 2);
  });

  it('remembers two channels written separately', () => {
    const o = overlay();
    writeOverlay(o, centre(12), centre(12), TEXEL * 0.4, 0, 0.25);
    writeOverlay(o, centre(12), centre(12), TEXEL * 0.4, 3, 0.5);
    sampleOverlay(o, centre(12), centre(12), out);
    expect([out[0], out[3]]).toEqual([0.25, 0.5]);
    expect(writtenMaskAt(o, centre(12), centre(12))).toBe(0b1001);
  });

  it('marks a disc rather than a square', () => {
    /*
     * A square decal is a square nobody asked for. The radius has to sit between one texel and
     * √2 of them for the neighbour along the axis to be in and the one on the diagonal to be out —
     * at a radius of two, the diagonal neighbour is 1.41 away and inside, which is what the first
     * version of this test got wrong.
     */
    const o = overlay();
    writeOverlay(o, centre(16), centre(16), TEXEL * 1.2, 0, 1);
    expect(sampleOverlay(o, centre(17), centre(16), out)).toBe(true);
    expect(sampleOverlay(o, centre(16), centre(17), out)).toBe(true);
    expect(sampleOverlay(o, centre(17), centre(17), out)).toBe(false);
  });

  it('refuses a channel that does not exist rather than writing past the texel', () => {
    const o = overlay();
    expect(writeOverlay(o, centre(12), centre(12), TEXEL, OVERLAY_CHANNELS, 1)).toBe(0);
    expect(writeOverlay(o, centre(12), centre(12), TEXEL, -1, 1)).toBe(0);
    expect(overlayTileCount(o)).toBe(0);
  });
});

describe('a mark across a tile boundary', () => {
  it('writes into both tiles', () => {
    /*
     * The seam defect. A version that found one tile and wrote into it leaves a hard edge at every
     * boundary — which looks like the decal was clipped and gets blamed on the mesh.
     */
    const o = overlay();
    /*
     * Texel 8 is the first of tile 1, so `edge(8)` is the seam. The row is centred on texel 20,
     * which is in the middle of tile row 2 — a row centred on texel 16 would straddle *that* seam
     * too and make four tiles, which is a different test and was this one's first mistake.
     */
    writeOverlay(o, edge(8), centre(20), TEXEL * 2, 0, 1);
    expect(overlayTileCount(o)).toBe(2);
    expect(sampleOverlay(o, centre(7), centre(20), out)).toBe(true);
    expect(sampleOverlay(o, centre(8), centre(20), out)).toBe(true);
  });

  it('writes into four tiles at a corner', () => {
    const o = overlay();
    writeOverlay(o, edge(8), edge(8), TEXEL * 2, 0, 1);
    expect(overlayTileCount(o)).toBe(4);
  });
});

describe('outside the unit square, the base texture decides', () => {
  it('wraps where the base wraps', () => {
    const o = overlay({ addressMode: ADDRESS_WRAP });
    const radius = 2 / o.resolution;
    writeOverlay(o, 0.0, 0.5, radius, 0, 1);
    const texel = 1 / o.resolution;
    /* Just past the left edge is just inside the right one. */
    expect(sampleOverlay(o, 1 - texel * 0.5, 0.5, out)).toBe(true);
    expect(sampleOverlay(o, texel * 0.5, 0.5, out)).toBe(true);
  });

  it('drops what falls outside where the base clamps', () => {
    /*
     * Dropped rather than clamped onto the edge texel: clamping a *write* smears the whole edge of
     * the texture with whatever somebody aimed past it, which is a visible band rather than the
     * nothing they expected.
     */
    const o = overlay({ addressMode: ADDRESS_CLAMP });
    writeOverlay(o, edge(0), centre(20), TEXEL * 2, 0, 1);
    expect(sampleOverlay(o, centre(0), centre(20), out)).toBe(true);
    expect(sampleOverlay(o, centre(31), centre(20), out)).toBe(false);
  });

  it('writes nothing at all for a mark entirely outside a clamped surface', () => {
    /*
     * The case that tells dropping from clamping apart. Clamped onto the edge, every texel of this
     * disc lands on column zero and paints a band down the side of the texture; dropped, it does
     * what somebody aiming past the edge expected, which is nothing. And a version that neither
     * dropped nor clamped would make a tile at a negative index, so the count catches that too.
     */
    const o = overlay({ addressMode: ADDRESS_CLAMP });
    expect(writeOverlay(o, -0.1, centre(20), TEXEL * 2, 0, 1)).toBe(0);
    expect(overlayTileCount(o)).toBe(0);
    expect(sampleOverlay(o, centre(0), centre(20), out)).toBe(false);
  });

  it('clamps a read, which is what a sampler outside the surface wants', () => {
    const o = overlay({ addressMode: ADDRESS_CLAMP });
    writeOverlay(o, 0.99, 0.5, 4 / o.resolution, 0, 1);
    expect(sampleOverlay(o, 1.4, 0.5, out)).toBe(true);
  });

  it('defaults to clamping, as `createDecodeGraph` does', () => {
    expect(createOverlay(8).addressMode).toBe(ADDRESS_CLAMP);
    expect(ADDRESS_CLAMP).toBe(0);
    expect(ADDRESS_WRAP).toBe(1);
  });
});

describe('tiles are content-addressed, as base tiles are', () => {
  it('stores an identical mark in two places once', () => {
    const o = overlay();
    /* The same mark at the same place within two different tiles, so the tiles are identical. */
    writeOverlay(o, centre(2), centre(2), TEXEL * 0.4, 0, 1);
    writeOverlay(o, centre(18), centre(2), TEXEL * 0.4, 0, 1);
    expect(overlayTileCount(o)).toBe(2);

    const hashes: string[] = [];
    expect(overlayTiles(o, hashes)).toBe(1);
  });

  it('gives different contents different hashes', () => {
    const o = overlay();
    writeOverlay(o, centre(2), centre(2), TEXEL * 0.4, 0, 1);
    writeOverlay(o, centre(18), centre(2), TEXEL * 0.4, 0, 0.5);
    const hashes: string[] = [];
    expect(overlayTiles(o, hashes)).toBe(2);
  });

  it('tells a written zero from an unwritten one', () => {
    /* A tile that wrote a zero exists; an overlay that wrote nothing has no tile at all. */
    const first = overlay();
    writeOverlay(first, centre(2), centre(2), TEXEL * 0.4, 0, 0);
    const second = overlay();

    const a: string[] = [];
    const b: string[] = [];
    overlayTiles(first, a);
    overlayTiles(second, b);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
  });

  it('tells two tiles apart when only the channels written differ', () => {
    /*
     * Both hold nothing but zeros, and one wrote channel 0 while the other wrote channel 1. The
     * values are identical; the tiles are not, and compositing proves it — which is why the written
     * mask is hashed alongside them. Hashing the values alone makes these one page.
     */
    const first = overlay();
    const second = overlay();
    writeOverlay(first, centre(2), centre(2), TEXEL * 0.4, 0, 0);
    writeOverlay(second, centre(2), centre(2), TEXEL * 0.4, 1, 0);

    const a: string[] = [];
    const b: string[] = [];
    overlayTiles(first, a);
    overlayTiles(second, b);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]).not.toBe(b[0]);
  });

  it('rehashes after a write rather than serving the old hash', () => {
    const o = overlay();
    const hashes: string[] = [];
    writeOverlay(o, centre(2), centre(2), TEXEL * 0.4, 0, 1);
    overlayTiles(o, hashes);
    const before = hashes[0];

    writeOverlay(o, centre(2), centre(2), TEXEL * 0.4, 1, 1);
    overlayTiles(o, hashes);
    expect(hashes[0]).not.toBe(before);
  });
});

describe('compositing leaves untouched channels alone', () => {
  it('takes the overlay only where a channel was written', () => {
    const texels = 3;
    const base = new Float32Array(texels * OVERLAY_CHANNELS).fill(0.25);
    const over = new Float32Array(texels * OVERLAY_CHANNELS).fill(0.75);
    const written = new Uint8Array([0, 0b0001, 0b1010]);
    const result = new Float32Array(texels * OVERLAY_CHANNELS);

    compositeOverlay(result, base, over, written);
    /* Nothing written: the base, whole. */
    expect([...result.slice(0, 4)]).toEqual([0.25, 0.25, 0.25, 0.25]);
    /* Channel 0 only. */
    expect([...result.slice(4, 8)]).toEqual([0.75, 0.25, 0.25, 0.25]);
    /* Channels 1 and 3. */
    expect([...result.slice(8, 12)]).toEqual([0.25, 0.75, 0.25, 0.75]);
  });

  it('takes a written zero from the overlay rather than falling back to the base', () => {
    /* The case a sentinel value would get wrong, and the reason the mask exists. */
    const base = new Float32Array([1, 1, 1, 1]);
    const over = new Float32Array([0, 0, 0, 0]);
    const result = new Float32Array(4);
    compositeOverlay(result, base, over, new Uint8Array([0b0001]));
    expect([...result]).toEqual([0, 1, 1, 1]);
  });
});

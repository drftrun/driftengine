import { describe, expect, it } from 'vitest';

import {
  DETAIL_FLOATS,
  MAX_DETAIL_REGIONS,
  detailOf,
  detailRefusal,
  packSurfaceDetail,
  type SurfaceDetail,
} from './surfaceDetail.ts';

const maps = { name: 'detail array' };

describe("a material's tiled detail", () => {
  it('PACKS EACH REGION INTO TWO VECTORS BEHIND A HEADER, AS THE SHADER READS THEM', () => {
    const detail: SurfaceDetail<unknown> = {
      maps,
      regionLayer: 7,
      regions: [
        { normalLayer: 2, repeat: 40 },
        {
          normalLayer: 3,
          occlusionLayer: 4,
          repeat: [10, 20],
          offset: [0.5, 0.25],
          normalStrength: 2,
          occlusionStrength: 0.5,
        },
      ],
    };
    const out = new Float32Array(DETAIL_FLOATS);
    packSurfaceDetail(detail, true, out);
    expect(Array.from(out.subarray(0, 20))).toEqual([
      /* Two regions, the region map at the ORM array's layer 7. */
      2, 7, 0, 0,
      /* Region 0: normal layer 2, no occlusion, full strength; forty repeats both ways. */
      2, -1, 1, 1, 40, 40, 0, 0,
      /* Region 1: normal 3, occlusion 4, twice as steep, half laid on; 10 by 20, offset. */
      3, 4, 2, 0.5, 10, 20, 0.5, 0.25,
    ]);
    expect(out.subarray(20).every((value) => value === 0)).toBe(true);
  });

  it('reads every texel as region 0 where the material has no ORM array for a region map', () => {
    const out = new Float32Array(DETAIL_FLOATS);
    packSurfaceDetail(
      { maps, regionLayer: 7, regions: [{ normalLayer: 0, repeat: 8 }] },
      false,
      out,
    );
    expect(out[1]).toBe(-1);
    packSurfaceDetail({ maps, regions: [{ normalLayer: 0, repeat: 8 }] }, true, out);
    expect(out[1], 'and where it names none').toBe(-1);
  });

  it('holds what cannot be drawn to what can: sixteen regions, a repeat above zero, strengths in range', () => {
    const out = new Float32Array(DETAIL_FLOATS);
    const regions = Array.from({ length: 20 }, () => ({
      normalLayer: 1,
      repeat: -3,
      normalStrength: -1,
      occlusionStrength: 4,
    }));
    packSurfaceDetail({ maps, regions }, true, out);
    expect(out[0]).toBe(MAX_DETAIL_REGIONS);
    expect(Array.from(out.subarray(4, 10))).toEqual([1, -1, 0, 1, 1, 1]);
    packSurfaceDetail(null, true, out);
    expect(
      out.every((value) => value === 0),
      'none is zeros, which the shader reads as none',
    ).toBe(true);
  });

  it('is refused beside another array in its slot, or placed by the world, and not beside its own', () => {
    const detail = { maps, regions: [{ normalLayer: 0, repeat: 8 }] };
    expect(detailRefusal(detail, null, false)).toBeNull();
    expect(detailRefusal(detail, maps, false), 'a modelMap that is its array').toBeNull();
    expect(detailRefusal(detail, { name: 'a model map' }, false)).toBe('slot');
    expect(detailRefusal(detail, null, true)).toBe('projection');
    expect(detailOf({ detail: { maps, regions: [] } }), 'no region is no detail').toBeNull();
    expect(detailOf({ detail })).toBe(detail);
  });
});

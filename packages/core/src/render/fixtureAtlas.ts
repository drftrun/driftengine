/**
 * What a light fixture throws, in one texture: its spot cookies in the top band, its photometric
 * profiles in the rows below.
 *
 * **One binding for two tables, because the lit stage had one sampler left.** The cookie atlas and
 * the photometric atlas were two small float textures read with `textureLod`, and the widest lit
 * shader bound fifteen of the sixteen fragment samplers WebGL2 guarantees — so the next sampler had
 * to be found by folding two into one, which is what this is. Both describe a fixture's emission
 * pattern, and both are 128 texels across, which is what lets them share a texture exactly.
 *
 * **Cookies on top, profiles at the bottom, and the order is load-bearing.** A profile's row blend
 * only ever reaches forward — to the next plane, and from the last to the repeat of the first — so
 * past its last row it meets the texture's edge and the clamp, never a cookie. A cookie's own
 * half-texel inset keeps it inside its band on both axes. The shader finds the bands from
 * `textureSize` and `uFixtureShape.x`, so the fold cost no uniform.
 *
 * **What it gives up**: every texel is four half floats where a profile needed one, a few kilobytes
 * a scene; and setting either table rebuilds the whole texture, which a consumer does once per set.
 */
import { IES_ATLAS_WIDTH } from './iesProfile.ts';
import { COOKIE_TILE } from './lightBudget.ts';

export interface FixtureAtlasLayout {
  readonly width: number;
  readonly height: number;
  /** Rows of cookie tiles at the top: `COOKIE_TILE`, or 0 with none loaded. */
  readonly cookieRows: number;
  /** The first row of the profiles, below the cookies. */
  readonly iesTop: number;
}

/** The atlas for `iesRows` rows of profile and `cookieTiles` cookies. */
export function fixtureAtlasLayout(iesRows: number, cookieTiles: number): FixtureAtlasLayout {
  const cookieRows = cookieTiles > 0 ? COOKIE_TILE : 0;
  return {
    width: Math.max(IES_ATLAS_WIDTH, COOKIE_TILE * cookieTiles),
    height: cookieRows + iesRows,
    cookieRows,
    iesTop: cookieRows,
  };
}

/**
 * The profiles' rows as the atlas holds them: `data` one float a texel, `width` across and `rows`
 * down, spread into the red channel of a four-channel image the atlas's size, the rest ones. The
 * cookie band is left zero for the backend to fill from its images.
 */
export function fixtureAtlasTexels(
  layout: FixtureAtlasLayout,
  ies: { readonly data: Float32Array; readonly width: number; readonly height: number },
): Float32Array {
  const out = new Float32Array(layout.width * layout.height * 4);
  for (let row = 0; row < ies.height; row++) {
    for (let x = 0; x < ies.width; x++) {
      const at = ((layout.iesTop + row) * layout.width + x) * 4;
      out[at] = ies.data[row * ies.width + x] as number;
      out[at + 1] = 1;
      out[at + 2] = 1;
      out[at + 3] = 1;
    }
  }
  return out;
}

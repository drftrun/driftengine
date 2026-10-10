/**
 * Named colours and sizes, so an interface stops repeating its own constants.
 *
 * **Flattened at derivation rather than chained at lookup.** A token is read per node per frame, so
 * a chain of parent themes would be a walk on every one of those reads. Spreading once when a
 * theme is derived costs a record and makes every lookup a single property access.
 */
import { srgbToLinear } from '@driftengine/core';

/** Named colours, packed as `0xRRGGBBAA`, and sizes, flattened when the theme is derived. */
export interface Theme {
  readonly values: Readonly<Record<string, number>>;
}

export function createTheme(values: Record<string, number>): Theme {
  return { values: { ...values } };
}

/** A new theme with `overrides` applied over `base`. `base` is not modified. */
export function deriveTheme(base: Theme, overrides: Record<string, number>): Theme {
  return { values: { ...base.values, ...overrides } };
}

export function themeColour(theme: Theme, name: string, fallback: number): number {
  return theme.values[name] ?? fallback;
}

export function themeSize(theme: Theme, name: string, fallback: number): number {
  return theme.values[name] ?? fallback;
}

/**
 * A packed `0xRRGGBBAA` token as the four floats a node's `background` and `tint` are: the colour
 * decoded from sRGB to the linear light the renderer draws in, the coverage as it is.
 *
 * **Decoded, because a hex colour is a display colour** wherever one is written, CSS included, and
 * the renderer grades everything it draws: read as linear, `0x336699` came out as `0x7caacb` under
 * the default `outputTransform`, every panel a washed-out version of the one picked. What it gives
 * up is a token meant as an amount rather than a look, which a colour token is not. A renderer
 * asked for `outputTransform: 'none'` draws these darker than picked, as it does every colour.
 *
 * **Two of this package's own APIs did not meet**: a theme token is one number and a `UiNode`
 * colour is a `Float32Array`, so every consumer wrote the same four shifts. The editor found it by
 * being the first thing to build widgets on both, which is what a consumer outside `packages/` is
 * for.
 *
 * `>>>` rather than `>>`, because a token with red at or above `0x80` has the sign bit set and an
 * arithmetic shift returns it negative — a red that turns the whole colour into a large negative
 * number, which is exactly the shape of bug that survives review.
 */
export function unpackRgba(packed: number, out: Float32Array): Float32Array {
  out[0] = srgbToLinear(((packed >>> 24) & 0xff) / 255);
  out[1] = srgbToLinear(((packed >>> 16) & 0xff) / 255);
  out[2] = srgbToLinear(((packed >>> 8) & 0xff) / 255);
  out[3] = (packed & 0xff) / 255;
  return out;
}

/** `themeColour` and `unpackRgba` in one call, which is how a widget uses both. */
export function themeRgba(
  theme: Theme,
  name: string,
  fallback: number,
  out: Float32Array,
): Float32Array {
  return unpackRgba(themeColour(theme, name, fallback), out);
}

/**
 * Coloured light through glass: how one pane filters light, how panes combine, which receivers a
 * pane tints, and how far frost spreads the colour — the reference the shaders state term for term.
 *
 * **Frost spreads light, it does not remove it.** Etched glass passes 88–91% of visible light
 * against clear float glass's ~90%, so a frosted pane passes `transmission × (1 − F) × tint` like a
 * clear one and only the filter widens. What it gives up: the spread stays inside the opaque frame's
 * shadow, so light from a frosted pane does not reach past the outline of the frame around it. What
 * would make it wrong is glass that genuinely absorbs as it diffuses — opal glass, milk glass — for
 * which a lower `transmission` is the honest statement.
 *
 * **What else it does not reach**: light that bounces. DriftRay's probe bake and DriftLight's summed
 * far field see a pane as absent, so the light a tinted window sends round a room by bouncing is its
 * sun's own colour; only the direct light through the pane takes the tint.
 */
import { schlickFresnel, type ResolvedGlass } from './glass.ts';

/** One tint texel: the light a stack of panes lets through, and how clear the stack is. */
export interface GlassTexel {
  r: number;
  g: number;
  b: number;
  clarity: number;
}

/** No glass: everything passes, perfectly clear. What a tint map is cleared to. */
export const CLEAR_TEXEL: Readonly<GlassTexel> = { r: 1, g: 1, b: 1, clarity: 1 };

/** How widely a fully frosted pane spreads its colour: a 30° half-angle cone behind it. */
export const FROST_SPREAD = Math.tan(Math.PI / 6);

/**
 * The spread never exceeds this many base filter radii, and the tap count never changes.
 *
 * **Sixty-four, because the tint is read from the mip level the spread asks for**: each tap is then
 * already an average over its own share of the spread, so taps far apart do not alias into grain.
 * It was eight before the tint had mips, and on a sun map a few centimetres a texel that capped a
 * frosted pane's spread at seven centimetres — frost that nobody saw. What the cap still bounds is
 * a pane so frosted and so far above a floor that its colour would wash over a room.
 */
export const FROST_RADIUS_CAP = 64;

/** One pane as a tint texel, lit at `cosLight` to its normal. Fresnel as `glass.ts` states it. */
export function paneTexel(glass: ResolvedGlass, cosLight: number, out: GlassTexel): GlassTexel {
  const passes = glass.transmission * (1 - schlickFresnel(cosLight));
  out.r = passes * glass.tint[0];
  out.g = passes * glass.tint[1];
  out.b = passes * glass.tint[2];
  out.clarity = 1 - glass.frost;
  return out;
}

/** Two stacks of glass on one ray: a product, so the order they are drawn in cannot matter. */
export function combinePanes(a: GlassTexel, b: GlassTexel, out: GlassTexel): GlassTexel {
  out.r = a.r * b.r;
  out.g = a.g * b.g;
  out.b = a.b * b.b;
  out.clarity = a.clarity * b.clarity;
  return out;
}

/**
 * What one filter tap contributes: the glass's texel where the receiver is behind the pane, and
 * nothing where it is on the light's side of it — or is the pane, which the bias keeps untinted.
 */
export function tapTint(
  receiverDepth: number,
  glassDepth: number,
  bias: number,
  glass: GlassTexel,
  out: GlassTexel,
): GlassTexel {
  const behind = receiverDepth > glassDepth + bias;
  out.r = behind ? glass.r : 1;
  out.g = behind ? glass.g : 1;
  out.b = behind ? glass.b : 1;
  out.clarity = behind ? glass.clarity : 1;
  return out;
}

/**
 * A frosted pane's tint at a receiver: the outline from the taps at the base radius, the colour
 * from the spread taps that found glass — nothing else.
 *
 * **Split because a tint cannot carry light out past a pane.** Blurring the tint map whole pulls in
 * the white of the unobstructed ground around a pane, which brightens the patch — measured at 10%
 * more light over a frosted window than a clear one — while the pane's own light, which should
 * spread onto that ground, has no way to exceed full sun there. So the outline stays where the
 * clear pane's is (`coverage`, the share of outline taps behind glass) and only the colour spreads,
 * averaged over glass alone (`colourSum` over `colourCount`, the summed pane shares `unmixTint`
 * reports — continuous, so a colour crossing between panes blends rather than stepping): neighbouring
 * panes mix, a pattern blurs, and the light through the patch is what it was. What it gives up is
 * spread past the outline, which the spec states; with no glass found by the spread the colour is
 * clear.
 */
export function spreadTint(
  coverage: number,
  colourSum: GlassTexel,
  colourCount: number,
  out: GlassTexel,
): GlassTexel {
  const r = colourCount > 0 ? colourSum.r / colourCount : 1;
  const g = colourCount > 0 ? colourSum.g / colourCount : 1;
  const b = colourCount > 0 ? colourSum.b / colourCount : 1;
  out.r = 1 + (r - 1) * coverage;
  out.g = 1 + (g - 1) * coverage;
  out.b = 1 + (b - 1) * coverage;
  out.clarity = 1;
  return out;
}

/**
 * A coarse level of the tint, with the open ground's white taken back out: returns the pane's share
 * of the texel and writes the pane's own colour to `out`.
 *
 * **Why a level needs this**: it averages a pane with whatever lies beside it, and beside a pane is
 * usually open ground, which the tint holds as white — so a frosted patch read coarse is paler than
 * the pane, and measured 6% more light than the clear pane over the same floor. The clarity channel
 * says how much of the texel was pane: open ground holds 1, the pane its own `centreClarity`, so
 * the pane's share is `(1 − a) / (1 − centreClarity)` and its colour follows by subtraction. What it
 * assumes is that the frost around a receiver is the frost at its centre, which is true within a
 * pane and blends where two panes of different frost meet; a clear pane (`centreClarity` 1) is
 * never read coarse, so it is returned as it stands.
 */
export function unmixTint(mip: GlassTexel, centreClarity: number, out: GlassTexel): number {
  if (centreClarity >= 1) {
    out.r = mip.r;
    out.g = mip.g;
    out.b = mip.b;
    out.clarity = mip.clarity;
    return 1;
  }
  const share = Math.min(1, Math.max(0, (1 - mip.clarity) / (1 - centreClarity)));
  if (share <= 0) {
    out.r = 1;
    out.g = 1;
    out.b = 1;
    out.clarity = 1;
    return 0;
  }
  const ground = 1 - share;
  out.r = Math.min(1, Math.max(0, (mip.r - ground) / share));
  out.g = Math.min(1, Math.max(0, (mip.g - ground) / share));
  out.b = Math.min(1, Math.max(0, (mip.b - ground) / share));
  out.clarity = centreClarity;
  return share;
}

/** The filter radius for a receiver `paneToReceiver` behind a pane of this clarity. */
export function frostRadius(clarity: number, paneToReceiver: number, baseRadius: number): number {
  const spread = (1 - clarity) * FROST_SPREAD * Math.max(paneToReceiver, 0);
  return Math.min(Math.max(baseRadius, spread), baseRadius * FROST_RADIUS_CAP);
}

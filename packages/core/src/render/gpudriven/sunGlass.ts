/**
 * The second pipeline's sunlight through glass, as a reference: `glassTintAt` over the glass depth
 * and tint maps the GPU-driven pass draws from the sun, for `shade.wgsl.ts`'s lookup to be read
 * against.
 *
 * **The forward path's rule, not a second one** (`glassShadow.ts`, and `sunGlassLookup` in
 * `flat/directionalShadow.ts`): the outline from taps at the base filter radius that count a pane
 * only where the receiver is behind it, and the colour from spread taps read coarse, unmixed from
 * the ground around the pane by its clarity and weighed by its share. Frost widens only the
 * colour's taps, so the light a frosted pane passes is the light a clear one does.
 *
 * **What differs is where two numbers come from.** A compute invocation has no derivatives, so the
 * map's scale in metres is the caller's (`uvPerMetre`, which an orthographic light matrix states
 * outright); and a coarse level here is a box average over the spread's footprint, which is what a
 * mip level approximates on the device. `scripts/gpu-parity.mjs` holds the device's per-tap
 * arithmetic to `glassShadow.ts`; the sampling is what the glass page measures.
 */
import { frostRadius, spreadTint, unmixTint, type GlassTexel } from '../glassShadow.ts';
import { SHADOW_DEPTH_BIAS, SHADOW_PCF_OFFSETS, SHADOW_TEXEL_SCALE } from './shadow.ts';

/** The two maps the sun's glass pass draws, square, row-major from v = 0. */
export interface SunGlassMaps {
  readonly size: number;
  /** The nearest pane's depth a texel, 1 where no pane was drawn. */
  readonly glassDepth: Float32Array;
  /** What the panes on a texel's ray let through, and their clarity: four floats a texel. */
  readonly tint: Float32Array;
}

export interface SunGlassSettings {
  /** Metres the light's depth range spans, which turns a depth difference into a distance. */
  readonly depthSpan: number;
  /** Map units a metre across the light, which turns a spread in metres into one on the map. */
  readonly uvPerMetre: number;
  readonly taps: number;
}

const centre: GlassTexel = { r: 1, g: 1, b: 1, clarity: 1 };
const coarse: GlassTexel = { r: 1, g: 1, b: 1, clarity: 1 };
const pane: GlassTexel = { r: 1, g: 1, b: 1, clarity: 1 };
const found: GlassTexel = { r: 0, g: 0, b: 0, clarity: 0 };

function index(maps: SunGlassMaps, u: number, v: number): number {
  const x = Math.min(maps.size - 1, Math.max(0, Math.floor(u * maps.size)));
  const y = Math.min(maps.size - 1, Math.max(0, Math.floor(v * maps.size)));
  return y * maps.size + x;
}

/** The average of every texel within `radius` of (u, v): a mip level's footprint, in the large. */
function coarseAt(maps: SunGlassMaps, u: number, v: number, radius: number, out: GlassTexel): void {
  const reach = radius * maps.size;
  const x0 = Math.max(0, Math.floor(u * maps.size - reach));
  const x1 = Math.min(maps.size - 1, Math.floor(u * maps.size + reach));
  const y0 = Math.max(0, Math.floor(v * maps.size - reach));
  const y1 = Math.min(maps.size - 1, Math.floor(v * maps.size + reach));
  out.r = 0;
  out.g = 0;
  out.b = 0;
  out.clarity = 0;
  let n = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const at = (y * maps.size + x) * 4;
      out.r += maps.tint[at] as number;
      out.g += maps.tint[at + 1] as number;
      out.b += maps.tint[at + 2] as number;
      out.clarity += maps.tint[at + 3] as number;
      n++;
    }
  }
  out.r /= n;
  out.g /= n;
  out.b /= n;
  out.clarity /= n;
}

/** What the sun keeps through glass at a receiver at map position (u, v) and light depth `depth`. */
export function glassTintAt(
  u: number,
  v: number,
  depth: number,
  maps: SunGlassMaps,
  settings: SunGlassSettings,
  out: GlassTexel,
): GlassTexel {
  out.r = 1;
  out.g = 1;
  out.b = 1;
  out.clarity = 1;
  if (u < 0 || u > 1 || v < 0 || v > 1) return out;
  const texel = SHADOW_TEXEL_SCALE / maps.size;
  const bias = SHADOW_DEPTH_BIAS / settings.depthSpan;
  const taps = Math.min(settings.taps, SHADOW_PCF_OFFSETS.length);

  const at = index(maps, u, v);
  centre.clarity = maps.tint[at * 4 + 3] as number;
  const behind = Math.max(depth - (maps.glassDepth[at] as number), 0) * settings.depthSpan;
  const radius = frostRadius(centre.clarity, behind * settings.uvPerMetre, texel);

  let cover = 0;
  found.r = 0;
  found.g = 0;
  found.b = 0;
  let shares = 0;
  for (let i = 0; i < taps; i++) {
    const offset = SHADOW_PCF_OFFSETS[i] as readonly [number, number];
    const nearest = maps.glassDepth[index(maps, u + offset[0] * texel, v + offset[1] * texel)];
    if (depth > (nearest as number) + bias) cover++;
    coarseAt(maps, u + offset[0] * radius, v + offset[1] * radius, radius, coarse);
    const share = unmixTint(coarse, centre.clarity, pane);
    found.r += pane.r * share;
    found.g += pane.g * share;
    found.b += pane.b * share;
    shares += share;
  }
  return spreadTint(cover / Math.max(taps, 1), found, shares, out);
}

/**
 * The slice of depth a view model is drawn into: the nearest share of the range.
 *
 * **A first-person view model — arms and a held weapon — must never go into the wall it is pushed
 * against**, and clearing depth to draw it on top costs every pass that reads depth afterwards:
 * ambient occlusion, depth of field and the fog all see a hole where the world was. Squeezing the
 * view model's depth into the nearest sliver of the range does neither. Anything past the near
 * plane in the world lands behind it, the world's depth is kept, and the view model still sorts
 * against itself, at a fraction of the precision.
 *
 * **The near end is where the convention says it is**: 1 under reversed depth and 0 under the
 * conventional sense, which a WebGL2 context without `EXT_clip_control` runs. Taken from the
 * renderer's own `reversedDepth`, never from the constant, for the reason `depthConvention.ts`
 * gives at length.
 *
 * **What it gives up**: a view model is in front of everything, so it cannot be drawn reaching
 * behind a world object in its own frame — which is what a view model is for. And under temporal
 * reconstruction its pixels take no motion of their own, because the motion pass matches the frame's
 * depth exactly and a squeezed draw matches nothing; draw a view model with multisampling.
 */

/** The share of depth a view model is drawn into when the caller names none: the nearest 1%. */
export const VIEW_MODEL_DEPTH_SHARE = 0.01;

/**
 * Fill `out` with the `[min, max]` window depth a view model's draws are squeezed into.
 *
 * `share` is clamped to `[1e-4, 1]`: zero would collapse every view-model fragment onto one depth
 * and lose its own sorting, and more than the whole range is no squeeze.
 */
export function viewModelDepthRange(
  reversed: boolean,
  share: number,
  out: [number, number] | Float32Array,
): void {
  const width = Number.isFinite(share)
    ? Math.min(1, Math.max(1e-4, share))
    : VIEW_MODEL_DEPTH_SHARE;
  out[0] = reversed ? 1 - width : 0;
  out[1] = reversed ? 1 : width;
}

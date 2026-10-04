/**
 * What a blended draw into the scene does to its alpha, which holds how much of each pixel is still
 * the opaque surface — the share ambient occlusion is allowed to darken.
 *
 * **Occlusion is applied in the composite, from the depth the opaque world left**, after every
 * translucent draw has landed, and a particle or a pane writes no depth: so a puff of smoke in front
 * of a wall was darkened by the corner behind it. Reported from a game as walls and two figures
 * standing behind a cloud showing through it as outlines, and nothing at all with occlusion off.
 *
 * So the scene's alpha is a running share. The frame clears it to 1 and an opaque draw writes 1,
 * which is the whole of the surface; then each draw blended in front of it says which of three
 * things it is, and the composite darkens `share` of the pixel and leaves the rest:
 *
 * - **It covers**: glass, smoke, water, a line, text in the world, a panel. The share falls by what
 *   the draw lets through, `share * (1 - a)`.
 * - **It transmits**: the medium, the order-independent composite. Its alpha already *is* what gets
 *   through, `share * a`.
 * - **It keeps**: light added to the surface or a layer of the surface itself — caustics, a light
 *   volume, a bolt, a wet film, a decal, a reflection. The share is unchanged.
 *
 * **What it gives up** is added light in front of an occluded corner: a glow or a spark adds to the
 * pixel and keeps the share, so the composite darkens what it added along with the surface — which
 * is how every blended draw behaved before this, and one multiply cannot tell the two apart. **What
 * would make it wrong** is an opaque pass writing an alpha below 1: its surface would then take less
 * occlusion than it should, which is the safe direction, and is the lit shader's own case at a
 * cutout's edge or under a per-vertex alpha lane.
 *
 * **It survives the temporal passes.** A temporal resolve passes the frame's alpha through, since
 * it is a fact about this frame and takes no history; a reconstruction reads it from the scene it
 * rebuilt into the picture it shows, and the blended draws that land after it cover that picture.
 *
 * **One pipeline does not take part**: the GPU-driven pass blends its own surfaces into a target
 * whose alpha is the mask its blit reads to tell a drawn pixel from an undrawn one, and that blit
 * writes the share back to 1. Its panes still take the occlusion of what they cover. What would
 * close it is a channel for that mask other than alpha.
 *
 * A contributed pass drawing something blended into the scene states the same thing for its own
 * pipeline with `SCENE_ALPHA_COVERS`, `SCENE_ALPHA_TRANSMITS` or `SCENE_ALPHA_KEEPS`.
 */

/** A blended draw that covers the surface by its alpha: `share * (1 - a)`. */
export const SCENE_ALPHA_COVERS: GPUBlendComponent = {
  srcFactor: 'zero',
  dstFactor: 'one-minus-src-alpha',
  operation: 'add',
};

/** A draw whose alpha is what gets through it, a transmittance or a revealage: `share * a`. */
export const SCENE_ALPHA_TRANSMITS: GPUBlendComponent = {
  srcFactor: 'zero',
  dstFactor: 'src-alpha',
  operation: 'add',
};

/** Light added to the surface, or a layer of it: the share unchanged. */
export const SCENE_ALPHA_KEEPS: GPUBlendComponent = {
  srcFactor: 'zero',
  dstFactor: 'one',
  operation: 'add',
};

/**
 * The same three on WebGL2, as the alpha half of `blendFuncSeparate` beside the colour half a
 * caller already had. `src` and `dst` are the colour factors.
 */
export function blendCovering(gl: WebGL2RenderingContext, src: number, dst: number): void {
  gl.blendFuncSeparate(src, dst, gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
}

/** `SCENE_ALPHA_TRANSMITS` on WebGL2, beside the colour factors `src` and `dst`. */
export function blendTransmitting(gl: WebGL2RenderingContext, src: number, dst: number): void {
  gl.blendFuncSeparate(src, dst, gl.ZERO, gl.SRC_ALPHA);
}

/** `SCENE_ALPHA_KEEPS` on WebGL2, beside the colour factors `src` and `dst`. */
export function blendKeeping(gl: WebGL2RenderingContext, src: number, dst: number): void {
  gl.blendFuncSeparate(src, dst, gl.ZERO, gl.ONE);
}

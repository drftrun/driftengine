/**
 * The sun's shadow: one depth array whose layers are the static world, its movers, and the static
 * world's second occluder (the peel), drawn one at a time and sampled together.
 *
 * **One array rather than three maps since 4.5.0**, for the reason the lamps' twelve cubemaps
 * became one: a texture unit. The lit pass binds all three through one `sampler2DArray`, which is
 * what paid for the two tints glass casts with. The layers share one size and one format, so
 * nothing about how each is drawn or read moved — only where it lives.
 *
 * Filtering belongs to the receiving material shader, so the depth target can stay a
 * single-sample texture shared by every mesh pass. This is a depth *render target*, not an art
 * texture: AGENTS.md's "zero textures" rule is about the payload, and nothing here adds to it.
 */
import { SHADOW_DEPTH_CLEAR } from './depthConvention.ts';
import { DEFAULT_RENDER_QUALITY } from './renderQuality.ts';

/** Where each of the sun's maps lives in the array. The shaders read these same numbers. */
export const SUN_STATIC_LAYER = 0;
export const SUN_DYNAMIC_LAYER = 1;
/** Present only when more than one static depth layer is asked for. */
export const SUN_PEELED_LAYER = 2;
/**
 * Where the nearest pane's depth lives once glass has cast: after the three maps, at fixed places,
 * because a shader cannot ask an array how many layers it has here — naga refuses the third
 * component of an arrayed size query. A profile with no peel grows past an unused third layer to
 * reach them, which is one map's memory in a profile that already declined one.
 */
export const SUN_GLASS_STATIC_LAYER = 3;
export const SUN_GLASS_MOVING_LAYER = 4;

/** The three passes a scene opens, by the names `beginShadowPass` takes. */
export type SunShadowLayer = 'static' | 'static-peel' | 'dynamic';

/** The array layer a pass draws into. */
export function sunLayerIndex(layer: SunShadowLayer): number {
  return layer === 'static'
    ? SUN_STATIC_LAYER
    : layer === 'dynamic'
      ? SUN_DYNAMIC_LAYER
      : SUN_PEELED_LAYER;
}

export class SunShadowArray {
  readonly size: number;
  /** Replaced once, when glass first casts: see `growForGlass`. */
  private current: WebGLTexture;
  private layerCount: number;
  private glass = false;

  private readonly framebuffer: WebGLFramebuffer;
  /**
   * **The peel is drawn here and copied into its layer when the pass ends.** It reads the static
   * layer while it is drawn, and WebGL2 calls a texture both sampled and attached a feedback loop
   * whatever layer each names — so drawing the peel into the array would draw nothing at all.
   * What it costs is one more map's memory where a peel is asked for, and one blit per peel.
   */
  private readonly peelTexture: WebGLTexture | null;
  private readonly peelFramebuffer: WebGLFramebuffer | null;
  private peeling = false;

  constructor(
    gl: WebGL2RenderingContext,
    size = DEFAULT_RENDER_QUALITY.directionalShadowMapSize,
    peeled = false,
  ) {
    this.size = size;
    this.layerCount = peeled ? 3 : 2;

    const texture = createSunTexture(gl, size, this.layerCount);
    this.current = texture;

    const framebuffer = gl.createFramebuffer();
    if (framebuffer === null) throw new Error('SunShadowArray: createFramebuffer failed');
    this.framebuffer = framebuffer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, texture, 0, SUN_STATIC_LAYER);
    // Depth-only: without this WebGL expects a colour attachment.
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);

    if (peeled) {
      const peelTexture = gl.createTexture();
      const peelFramebuffer = gl.createFramebuffer();
      if (peelTexture === null || peelFramebuffer === null) {
        throw new Error('SunShadowArray: the peel target could not be created');
      }
      gl.bindTexture(gl.TEXTURE_2D, peelTexture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, size, size);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, peelFramebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, peelTexture, 0);
      gl.drawBuffers([gl.NONE]);
      gl.readBuffer(gl.NONE);
      gl.bindTexture(gl.TEXTURE_2D, null);
      this.peelTexture = peelTexture;
      this.peelFramebuffer = peelFramebuffer;
    } else {
      this.peelTexture = null;
      this.peelFramebuffer = null;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      /*
       * A lost context reports every attachment unusable, and that is not a
       * misconfiguration the caller can fix — see planarReflection.ts. Init still throws,
       * because the context cannot be lost before it exists.
       */
      if (gl.isContextLost()) return;
      throw new Error(`SunShadowArray: framebuffer incomplete (0x${status.toString(16)})`);
    }

    /*
     * **Every layer cleared once, here, to the far plane, because nothing else says what it
     * holds.** WebGL zeroes the texture, and a zero compared with `LEQUAL` is an occluder at the
     * light itself, so a layer no pass has drawn put the whole world in shade. ANGLE on Vulkan
     * hands the same texture back reading 1, which is lit, and that is what every capture here
     * ran on: a scene with a second depth layer it never peeled lost its sun only under ANGLE's
     * GL backend, the one Chrome on Linux runs by default. The frame's clear value is put back.
     */
    const frameClear = gl.getParameter(gl.DEPTH_CLEAR_VALUE) as number;
    gl.clearDepth(SHADOW_DEPTH_CLEAR);
    gl.viewport(0, 0, size, size);
    for (let layer = 0; layer < this.layers; layer++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, texture, 0, layer);
      gl.clear(gl.DEPTH_BUFFER_BIT);
    }
    gl.clearDepth(frameClear);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  }

  get texture(): WebGLTexture {
    return this.current;
  }

  get layers(): number {
    return this.layerCount;
  }

  /** Whether the two glass layers exist: from the first glass a sun pass is offered, for good. */
  get hasGlass(): boolean {
    return this.glass;
  }

  /** The glass depth layer beside a map: fixed places after the three maps. */
  glassLayer(which: 'static' | 'dynamic'): number {
    return which === 'static' ? SUN_GLASS_STATIC_LAYER : SUN_GLASS_MOVING_LAYER;
  }

  /**
   * Add the two glass layers, once, carrying every layer already held across.
   *
   * **Carried rather than re-baked**, because the sun's static map is the consumer's to bake and
   * it may bake it once: the glass that grows the array arrives in the very pass that drew that
   * map, so a copy is what keeps it. A depth blit per layer, same size and format, and the glass
   * layers cleared to the far plane — nothing nearer than the sun until a pane is drawn there.
   * Returns whether it grew, so the caller knows every bind of the old texture is stale.
   */
  growForGlass(gl: WebGL2RenderingContext): boolean {
    if (this.glass) return false;
    const old = this.current;
    const oldLayers = this.layerCount;
    const layers = SUN_GLASS_MOVING_LAYER + 1;
    const texture = createSunTexture(gl, this.size, layers);
    const read = gl.createFramebuffer();
    if (read === null) throw new Error('SunShadowArray: createFramebuffer failed');
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.framebuffer);
    for (let layer = 0; layer < oldLayers; layer++) {
      gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.DEPTH_ATTACHMENT, old, 0, layer);
      gl.framebufferTextureLayer(gl.DRAW_FRAMEBUFFER, gl.DEPTH_ATTACHMENT, texture, 0, layer);
      gl.blitFramebuffer(
        0,
        0,
        this.size,
        this.size,
        0,
        0,
        this.size,
        this.size,
        gl.DEPTH_BUFFER_BIT,
        gl.NEAREST,
      );
    }
    for (let layer = oldLayers; layer < layers; layer++) {
      gl.framebufferTextureLayer(gl.DRAW_FRAMEBUFFER, gl.DEPTH_ATTACHMENT, texture, 0, layer);
      gl.clearBufferfv(gl.DEPTH, 0, FAR_PLANE);
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(read);
    gl.deleteTexture(old);
    this.current = texture;
    this.layerCount = layers;
    this.glass = true;
    return true;
  }

  /** Bind `layer` as the render target and clear it. Caller then draws the casters. */
  begin(gl: WebGL2RenderingContext, layer: SunShadowLayer): void {
    this.peeling = layer === 'static-peel' && this.peelFramebuffer !== null;
    if (this.peeling) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.peelFramebuffer);
    } else {
      this.attach(gl, sunLayerIndex(layer));
    }
    this.clearAndRaster(gl);
  }

  /** Bind a glass depth layer as the render target and clear it: where the nearest pane is. */
  beginGlass(gl: WebGL2RenderingContext, which: 'static' | 'dynamic'): void {
    this.peeling = false;
    this.attach(gl, this.glassLayer(which));
    this.clearAndRaster(gl);
  }

  private attach(gl: WebGL2RenderingContext, layer: number): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, this.current, 0, layer);
  }

  private clearAndRaster(gl: WebGL2RenderingContext): void {
    gl.viewport(0, 0, this.size, this.size);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    /*
     * Store the face nearest the sun. Culling front faces stores the far side
     * and moves a box or limb through its own thickness, which is exactly the
     * detached-shadow failure. A small slope-aware raster offset separates the
     * stored caster from its receiver without moving the receiver differently
     * on each face; receiver-plane compensation handles the PCF taps.
     */
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.1, 4);
  }

  end(gl: WebGL2RenderingContext): void {
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.cullFace(gl.BACK);
    if (this.peeling) {
      /* The peel into its layer: same size, same format, so a nearest depth blit is a copy. */
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.peelFramebuffer);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.framebuffer);
      gl.framebufferTextureLayer(
        gl.DRAW_FRAMEBUFFER,
        gl.DEPTH_ATTACHMENT,
        this.current,
        0,
        SUN_PEELED_LAYER,
      );
      gl.blitFramebuffer(
        0,
        0,
        this.size,
        this.size,
        0,
        0,
        this.size,
        this.size,
        gl.DEPTH_BUFFER_BIT,
        gl.NEAREST,
      );
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      this.peeling = false;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  dispose(gl: WebGL2RenderingContext): void {
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteTexture(this.current);
    if (this.peelFramebuffer !== null) gl.deleteFramebuffer(this.peelFramebuffer);
    if (this.peelTexture !== null) gl.deleteTexture(this.peelTexture);
  }
}

/** The far plane, as `clearBufferfv` takes it: a layer no pane has reached is clear of glass. */
const FAR_PLANE = new Float32Array([SHADOW_DEPTH_CLEAR]);

function createSunTexture(gl: WebGL2RenderingContext, size: number, layers: number): WebGLTexture {
  const texture = gl.createTexture();
  if (texture === null) throw new Error('SunShadowArray: createTexture failed');
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.DEPTH_COMPONENT24, size, size, layers);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  // Clamp so anything outside the light frustum samples the border and is
  // treated as lit, rather than wrapping into a spurious shadow.
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

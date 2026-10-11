/** The 2D layer as a pass a consumer registers: one batch of quads, drawn where the caller says. */

import { interfaceGrade } from '@driftengine/core';
import type { PassContext, PassDefinition, PassDevice } from '@driftengine/core';

import { SPRITE_BINDINGS } from './shaders/generated/sprite.wgsl.ts';
import { createAffine2D } from './camera2d.ts';
import type { Affine2D } from './camera2d.ts';
import { createSpriteBatch, resetSpriteBatch } from './spriteBatch.ts';
import type { SpriteBatch } from './spriteBatch.ts';
import {
  createWebgl2Sprites,
  disposeWebgl2Sprites,
  drawWebgl2Sprites,
  setWebgl2SpriteTexture,
  updateWebgl2SpriteTexture,
  setWebgl2WhiteTexture,
  uploadWebgl2Instances,
} from './spriteGl.ts';
import type { Webgl2Sprites } from './spriteGl.ts';
import {
  createGpuSprites,
  disposeGpuSprites,
  drawGpuSprites,
  spritePipelineFor,
  setGpuSpriteTexture,
  updateGpuSpriteTexture,
  setGpuWhiteTexture,
  uploadGpuInstances,
} from './spriteGpu.ts';
import type { GpuSprites } from './spriteGpu.ts';
import { DEFAULT_SPRITE_TEXTURE_OPTIONS } from './spriteTexture.ts';
import type { SpriteImage, SpriteRegion, SpriteTextureOptions } from './spriteTexture.ts';

const VERT = SPRITE_BINDINGS.SPRITE_VERT;
const FRAG = SPRITE_BINDINGS.SPRITE_FRAG;

/** Identity, so a pass that is drawn before it is transformed puts its sprites in clip space. */
const IDENTITY_CLIP = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Sprites a frame, if the caller does not say. Four thousand quads is 224 KB of instance data. */
export const DEFAULT_SPRITE_CAPACITY = 4096;

/**
 * Texture slots, if the caller does not say.
 *
 * Eight is a sheet for the world, one for the interface, and room to spare. It is not a GPU limit
 * — each slot is its own bind group on WebGPU and its own object on WebGL2 — it is the number
 * above which a caller should be asking why its 2D layer has that many atlases.
 */
export const DEFAULT_SPRITE_SLOTS = 8;

export interface SpritePassOptions {
  readonly capacity?: number;
  readonly slots?: number;
  readonly label?: string;
}

export interface SpritePass extends PassDefinition {
  /**
   * The quads for this frame. Reset it, fill it with `drawSprite`, then call `drawPass`.
   *
   * Held by the pass rather than handed in per frame, because its size is the pass's GPU buffer
   * and the two must agree.
   */
  readonly batch: SpriteBatch;
  /**
   * A slot holding one opaque white texel, filled by the pass and not settable.
   *
   * White is the identity of the multiply the shader does, so a quad on this slot draws exactly its
   * tint — which is what a solid rectangle is, and what `fillPanel` in core does with a whole
   * program of its own. A caller drawing a filled box needs no sheet for it.
   *
   * **A background on this slot and an image from a sheet are two runs**, because a slot change is
   * a run and the order may not be regrouped. A caller with many filled boxes and many images
   * interleaved should pack a white texel into its *own* sheet and tint a frame of that instead:
   * then the whole tree is one run. This slot is the convenience, and the sheet is the fast path.
   */
  readonly white: number;
  /** Clear the batch. Call once at the top of a frame. */
  reset(): void;
  /**
   * Where the batch's coordinates are, from `screenToNdc` or `worldToNdc`.
   *
   * Copied, so the caller may reuse its array; and read at draw time, so this can be called before
   * the pass has a device.
   */
  setTransform(affine: Affine2D): void;
  /** Fill a texture slot. Safe before the pass is registered; applied when it gets a device. */
  setTexture(slot: number, source: SpriteImage, options?: SpriteTextureOptions): void;
  /**
   * Copy `region` of `source` into the slot's texture at the same place, keeping the rest: what an
   * atlas painted one picture at a time sends, instead of all of itself.
   *
   * The slot must hold a texture made from an image of `source`'s size, through `setTexture`; it
   * keeps the options it was made with. Otherwise, or before the pass has a device, this does what
   * `setTexture` does with the slot's options (the default ones for an empty slot), so a caller
   * never has to ask which. The region is clipped to the image, and an empty one copies nothing. A
   * slot with a mip chain has the chain rebuilt.
   *
   * **The saving, measured by a consumer painting a 2D layer into atlases**: `setTexture` sends the
   * whole image and, on WebGPU, makes the texture again, about 100 ms for a 5120-texel side, while
   * the pictures new on that frame covered about 6 of its 26 million texels and a typical later
   * frame changes a timer's digits. Call it before `drawPass` in a frame, as `setTexture` is.
   *
   * **Paint such an atlas into a 2D context made with `willReadFrequently: true`.** On WebGPU a
   * canvas drawn on the GPU is transferred whole before any part of it is copied, measured at 66 ms
   * for one 256 by 64 rectangle of a 5120-texel atlas against 0.4 ms from a canvas kept in memory;
   * WebGL2 copies a rectangle quickly from either. What the option gives up is painting on the GPU,
   * which matters for a canvas redrawn whole every frame and not for an atlas painted in pieces.
   */
  updateTexture(slot: number, source: SpriteImage, region: SpriteRegion): void;
}

interface HeldTexture {
  width: number;
  height: number;
  options: SpriteTextureOptions;
}

interface PendingTexture {
  readonly slot: number;
  readonly source: SpriteImage;
  readonly options: SpriteTextureOptions;
}

export function createSpritePass(options: SpritePassOptions = {}): SpritePass {
  const capacity = options.capacity ?? DEFAULT_SPRITE_CAPACITY;
  const slots = options.slots ?? DEFAULT_SPRITE_SLOTS;
  const label = options.label ?? 'ui2d.sprites';
  /* One past the caller's slots, so `setTexture` cannot reach it and it cannot be lost. */
  const white = slots;
  const batch = createSpriteBatch(capacity);
  const toNdc = createAffine2D();
  /* Identity as an affine: ndc = (x, y). A caller that never sets one draws in clip space. */
  toNdc[0] = 1;
  toNdc[3] = 1;

  let gl: Webgl2Sprites | null = null;
  let context: WebGL2RenderingContext | null = null;
  let gpu: GpuSprites | null = null;
  let device: GPUDevice | null = null;
  let clipCorrection: Float32Array = IDENTITY_CLIP;
  const pending: PendingTexture[] = [];
  /* What each slot was made from, so an update knows whether a partial copy fits it. */
  const held: (HeldTexture | null)[] = Array.from({ length: slots }, () => null);

  function setTexture(
    slot: number,
    source: SpriteImage,
    textureOptions?: SpriteTextureOptions,
  ): void {
    if (slot < 0 || slot >= slots) {
      throw new RangeError(`${label}: slot ${slot} is outside the ${slots} this pass has`);
    }
    const options = textureOptions ?? DEFAULT_SPRITE_TEXTURE_OPTIONS;
    held[slot] = { width: source.width, height: source.height, options };
    const entry: PendingTexture = { slot, source, options };
    if (gl === null && gpu === null) {
      pending.push(entry);
      return;
    }
    applyTexture(entry);
  }

  const applyTexture = (entry: PendingTexture): void => {
    if (gl !== null && context !== null) {
      setWebgl2SpriteTexture(context, gl, entry.slot, entry.source, entry.options);
      return;
    }
    if (gpu !== null && device !== null) {
      setGpuSpriteTexture(device, gpu, entry.slot, entry.source, entry.options);
    }
  };

  return {
    label,
    batch,
    white,

    reset(): void {
      resetSpriteBatch(batch);
    },

    setTransform(affine: Affine2D): void {
      toNdc.set(affine);
    },

    setTexture,

    updateTexture(slot: number, source: SpriteImage, region: SpriteRegion): void {
      const was = slot >= 0 && slot < slots ? held[slot] : null;
      if (
        was === null ||
        was === undefined ||
        was.width !== source.width ||
        was.height !== source.height ||
        (gl === null && gpu === null)
      ) {
        setTexture(slot, source, was?.options);
        return;
      }
      /* Whole texels inside the image: a rectangle reaching past an edge copies what is inside it. */
      const x0 = Math.max(0, Math.floor(region.x));
      const y0 = Math.max(0, Math.floor(region.y));
      const x1 = Math.min(source.width, Math.ceil(region.x + region.width));
      const y1 = Math.min(source.height, Math.ceil(region.y + region.height));
      if (x1 <= x0 || y1 <= y0) return;
      if (gl !== null && context !== null) {
        const mipmap = was.options.mipmap === true;
        updateWebgl2SpriteTexture(context, gl, slot, source, x0, y0, x1 - x0, y1 - y0, mipmap);
        return;
      }
      if (gpu !== null && device !== null) {
        updateGpuSpriteTexture(device, gpu, slot, source, x0, y0, x1 - x0, y1 - y0);
      }
    },

    init(passDevice: PassDevice): void {
      /*
       * The correction the *matrix* carries, because this stage builds its own clip position and
       * never multiplies by a camera. Without it the generated WGSL's Y negation stands
       * uncancelled and the whole 2D layer lands mirrored — `panel.ts` in core made the same
       * mistake once and its comment is where the reason is written out.
       */
      clipCorrection = passDevice.clipCorrection;
      if (passDevice.backend === 'webgl2') {
        context = passDevice.gl;
        gl = createWebgl2Sprites(passDevice.gl, capacity, slots + 1, label);
      } else {
        device = passDevice.device;
        gpu = createGpuSprites(
          passDevice.device,
          passDevice.format,
          passDevice.depthFormat,
          passDevice.samples,
          capacity,
          slots + 1,
          label,
        );
      }
      if (gl !== null && context !== null) setWebgl2WhiteTexture(context, gl, white);
      if (gpu !== null && device !== null) setGpuWhiteTexture(device, gpu, white);
      for (const entry of pending) applyTexture(entry);
      pending.length = 0;
    },

    draw(ctx: PassContext): void {
      if (batch.count === 0) return;
      if (ctx.backend === 'webgl2') {
        if (gl === null) return;
        uploadWebgl2Instances(ctx.gl, gl, batch);
        drawWebgl2Sprites(
          ctx.gl,
          gl,
          batch,
          toNdc,
          clipCorrection,
          interfaceGrade(ctx.outputTransform),
          1,
        );
        return;
      }
      if (gpu === null || device === null) return;
      const f = gpu.vertexFloats;
      f[VERT.fields.uToNdc0.offset / 4] = toNdc[0] as number;
      f[VERT.fields.uToNdc0.offset / 4 + 1] = toNdc[1] as number;
      f[VERT.fields.uToNdc0.offset / 4 + 2] = toNdc[2] as number;
      f[VERT.fields.uToNdc0.offset / 4 + 3] = toNdc[3] as number;
      f[VERT.fields.uToNdc1.offset / 4] = toNdc[4] as number;
      f[VERT.fields.uToNdc1.offset / 4 + 1] = toNdc[5] as number;
      f.set(clipCorrection, VERT.fields.uClipCorrection.offset / 4);
      /* A 2D layer is painted for the screen: encoded, never put through the scene's curve. */
      gpu.fragmentInts[FRAG.fields.uOutputTransform.offset / 4] = interfaceGrade(
        ctx.outputTransform,
      );
      gpu.fragmentFloats[FRAG.fields.uOutputExposure.offset / 4] = 1;
      /*
       * Written from inside an open render pass, which is allowed and ordered: a queue write
       * issued now lands before the command buffer this pass is being recorded into is submitted.
       * What it does mean is **one `drawPass` a frame per pass** — a second would overwrite the
       * first's instances before either had executed. A caller that wants the 2D layer in two
       * places in the frame registers two passes, which is also how two splat captures work.
       */
      device.queue.writeBuffer(gpu.vertexUniforms, 0, gpu.vertexScratch);
      device.queue.writeBuffer(gpu.fragmentUniforms, 0, gpu.fragmentScratch);
      uploadGpuInstances(device, gpu, batch);
      /* For the pass this lands in, which after `endFrame` is the canvas: see `spritePipelineFor`. */
      drawGpuSprites(
        ctx.pass,
        gpu,
        batch,
        spritePipelineFor(device, gpu, ctx.format, ctx.depthFormat, ctx.samples),
      );
    },

    dispose(): void {
      if (gl !== null && context !== null) disposeWebgl2Sprites(context, gl);
      if (gpu !== null) disposeGpuSprites(gpu);
      gl = null;
      gpu = null;
      context = null;
      device = null;
    },
  };
}

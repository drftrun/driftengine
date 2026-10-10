/**
 * A GPU image the caller supplies, sampled by the flat shader as surface colour — or several, as
 * the layers of one array.
 *
 * **Every surface texture is an array; a plain image is an array of one.** The lit pass has three of
 * WebGL2's guaranteed sixteen texture units free, so a second set of array samplers beside the 2D
 * ones was never affordable. Making the one set of samplers arrays costs no unit, and a one-layer
 * array samples exactly as a 2D texture does. A mesh names its layer per vertex (`MeshData.layers`),
 * so a merged block wearing forty facades is one draw.
 */
import type { SurfaceLayers } from './surfaceLayers.ts';
import type { SurfaceProjection } from './surfaceProjection.ts';
import type { SurfaceModel } from './surfaceModel.ts';
import { layerSize, refuseArrayUpdate, sourceSize } from './textureSource.ts';
import {
  compressedLayers,
  isCompressedSource,
  planBlocks,
  refuseBlockUpdate,
} from './compressedSource.ts';
import type {
  BlockFormat,
  CompressedTextureFormat,
  CompressedTextureSource,
  SurfaceSource,
} from './compressedSource.ts';
import { uploadCompressedArray } from './glCompressed.ts';
import { SURFACE_EFFECT_TEXELS, packSurfaceEffects } from './surfaceEffects.ts';
import type { SurfaceLayerEffect } from './surfaceEffects.ts';
import type { CutoutMode } from './cutoutDither.ts';
import { isLightmapTexels } from './lightmap.ts';
import type { LightmapTexels } from './lightmap.ts';
import { isSceneCaptureTexels } from './sceneCapture.ts';
import type { SceneCaptureTexels } from './sceneCapture.ts';

/**
 * How a texture behaves past its edges and between its texels.
 *
 * Deliberately small. Every knob here is one a tiling world actually needs; anything
 * beyond it — swizzles, borders, compressed formats — is a format decision that
 * belongs to whoever is generating the pixels, not to the surface that shows them.
 */
/**
 * Everything the flat pass needs to know about a surface, in one call.
 *
 * **Shaped for what comes after it.** ORM is the next map and emissive the one after; both are a
 * field here rather than a fourth and fifth setter, which is the whole reason this replaced
 * `setSurfaceTexture` rather than sitting beside it. A consumer setting four maps in four calls is
 * four chances to forget one, and four resets `bindMeshPass` has to reason about.
 *
 * **Every field is independent.** A material with a `normal` and no `albedo` is a legitimate one —
 * vertex colour with authored normals — and shades as such rather than as no material at all.
 *
 * **Generic over the texture, for the reason `SurfaceTextureHandle` exists.** The two backends have
 * different texture classes and the public API speaks in an opaque handle; parameterising here lets
 * each renderer take its own concrete type while a consumer sees one shape. Defaulted to the
 * WebGL2 class so the common spelling stays `SurfaceMaterial`.
 */
export interface SurfaceMaterial<Texture = SurfaceTexture> {
  albedo?: Texture | null;
  /**
   * Surface-space directions, turned into world space through the mesh's tangent frame.
   *
   * Read by the flat pass since 2026-08-22, from the attribute at location 10 where the mesh has
   * one and from a per-fragment cotangent frame where it does not. `normalStrength` gates it.
   * See `docs/RENDERING.md` for the normal-map path.
   */
  normal?: Texture | null;
  /**
   * Occlusion in R, roughness in G, metallic in B, in one image.
   *
   * glTF's packing, because that is what an import carries, and one unit for three channels rather
   * than three units for three maps. Sampled linear and never sRGB: these numbers *are* the data.
   */
  orm?: Texture | null;
  /**
   * Where a surface glows, and in what colour.
   *
   * **It modulates the surface's own emission rather than creating it**, which is glTF's rule
   * — emitted colour is `emissiveFactor * emissiveTexture` — and is the one thing about this map
   * that surprises people. A mesh whose `emissive` attribute is 0 emits nothing however bright
   * the image it binds, because there is nothing for the image to scale. An import carries the
   * factor for you: `gltf.ts` puts `max(emissiveFactor)` in the attribute and the factor itself
   * in `emissiveColor`. A procedurally built mesh has to say so the same way it says its colour,
   * which is in vertex data, because that is what makes a whole world one draw call here.
   *
   * Sampled **sRGB**, unlike `normal` and `orm`: this one is a colour a person picked, where
   * those two are numbers. glTF says the same.
   */
  emissive?: Texture | null;
  /** Repeats across the mesh's own UV range, per axis. Applies to every map the material holds. */
  uScale?: number;
  vScale?: number;
  /**
   * Where the texture starts, per axis, added after the scale: a surface samples
   * `uv · scale + offset`. Applies to every map, and to a cutout's shadow and depth as well.
   *
   * **What picks a cell of a flipbook or an atlas through the material**, so one quad draws any
   * cell: a strip of four frames is `uScale: 0.25` and `uOffset: frame * 0.25`. Without it a
   * consumer built one quad mesh per cell — 106 meshes for four strips — because the only way to
   * move a texture was to move the geometry's own coordinates.
   */
  uOffset?: number;
  vOffset?: number;
  /** Alpha below which a fragment is discarded. See `uCutout`. */
  cutout?: number;
  /**
   * How the cutout's edge is drawn: `'hard'`, the default and every cutout before 4.8.4, or
   * `'dithered'`, which keeps a pixel by the share of it the texture covers so a strand of hair, a
   * lash or a fringe of leaves has a soft edge instead of a stair of pixels.
   *
   * **The frame decides how a dithered edge is resolved**, because the material cannot know: under a
   * temporal resolve (TAA or DriftTR) the pattern moves every frame and the resolve averages it;
   * multisampled, the share goes to the GPU as alpha-to-coverage; with neither, the test is hard,
   * since a dither nothing averages is grain. A translucent draw tests hard whatever this says. See
   * `cutoutDither.ts`.
   */
  cutoutMode?: CutoutMode;
  /**
   * Whether both faces are seen: glTF's `doubleSided`, what a curtain or a leaf card is. Drawn
   * without culling, and a back face is lit as its front, with the normal turned to the viewer.
   */
  doubleSided?: boolean;
  /**
   * The lighting channels this surface takes light from, a mask: 1, 2, 3 … 255. **1 by default**,
   * which is every light's default too, so a scene that names no channel is lit as it always was.
   *
   * A point or spot light shades this surface only where its `PointLightSet.lightChannels` and this
   * share a bit — lighting channels. A character's own key and rim lights on channel 2,
   * and the character's materials on 3, light the character and leave the floor around it as the
   * stage's lights alone have it. **What it does not reach**: the sun, the sky and the probes, area
   * lights, DriftLight's volume and the GPU-driven pipeline light every surface whatever its mask.
   * A number that is not a whole mask from 1 to 255 is channel 1.
   */
  lightChannels?: number;
  /**
   * How hard the normal map turns the shading normal.
   *
   * **Defaults to 1 when a `normal` is supplied and 0 when it is not**, because binding a map and
   * saying nothing about strength means "use it" rather than "use it at nothing".
   */
  normalStrength?: number;
  /**
   * Scales the ORM map's G channel. glTF's `roughnessFactor`. Default 1.
   *
   * The map *replaces* the mesh's own roughness attribute rather than scaling it, and this is what
   * gives back the scaling. Scaling the attribute was the alternative and it is wrong outside an
   * import: `vertexDefaults.ts` hands an absent roughness **0.4277**, not 1, so every procedurally
   * built mesh would read far glossier than the image it was handed, with nothing in the API to
   * say it would.
   */
  roughnessScale?: number;
  /** Scales the ORM map's B channel. glTF's `metallicFactor`. Default 1. */
  metallicScale?: number;
  /**
   * How much of the ORM map's R channel to apply. glTF's `occlusionTexture.strength`. Default 1.
   *
   * **0 is no occlusion, not full occlusion.** glTF defines it as `1 + strength * (texel - 1)`, so
   * the shader mixes from 1 rather than multiplying — a multiply at 0 would black the surface out,
   * which is the opposite of what the caller asked for.
   */
  occlusionStrength?: number;
  /**
   * How much of the environment this material's draws mirror, 0 to 1: the number
   * `setSurfaceReflectivity` sets for every draw, stated by the material for its own. Absent, its
   * draws wear the setter's, as every material's did before this existed.
   *
   * **Here so a static list can carry it.** A list keeps each entry's material and none of the
   * renderer's state between draws (`createStaticDraws`), so a stage whose batches each mirror their
   * own share of a baked reflection says so in the material it records. What it gives up is nothing a
   * setter could do: one called after this material is set is ignored for the material's draws.
   */
  reflectivity?: number;
  /**
   * How bright the environment this material's draws reflect is: `setEnvironmentGain`'s number,
   * stated by the material for its own, and absent the setter's. Held non-negative.
   */
  environmentGain?: number;
  /**
   * Scales the emissive map, per channel. Default 1.
   *
   * The counterpart of `roughnessScale` and `metallicScale`: a factor that multiplies a texture is
   * not a value, and this is where the multiplier lives once an image supplies the shape. A
   * consumer who wants a bound map twice as bright asks here rather than rebuilding the mesh.
   */
  emissiveScale?: readonly [number, number, number];
  /**
   * How the surface answers light, when the standard model is not what it is made of: brushed
   * metal, hair, skin, an eye — `anisotropicModel`, `hairModel`, `skinModel`, `eyeModel`. Null or
   * absent is the standard model, exactly as before. **A pipeline of its own**, compiled the first
   * time a draw asks, so a scene that names no model pays for none. See `surfaceModel.ts`.
   */
  model?: SurfaceModel | null;
  /**
   * The model's own channels, in the albedo's coordinates and layers; what each channel means is
   * the model's to say. Absent, each model takes its own neutral. Sampled linear, like any map
   * that is not a colour.
   */
  modelMap?: Texture | null;
  /**
   * Whether a lamp's and the sun's highlight on this surface is GGX's own, `π · D · Vis · F · N·L`,
   * as physically based renderers and this engine's skin and eye shade it, rather than the engine's
   * lobe scaled to a peak of one. **False by default**, every surface as it was.
   *
   * The peak-normalised lobe is a look control: the specular attribute says how strong a highlight
   * is and roughness how wide, apart. Physical, they are entangled as they are in a real surface —
   * the peak is `1 / (4 α²)` of the light head-on, so a polished surface's highlight is many times
   * the look's and a rough one's lower and broader — and the specular attribute is read as the
   * reflectance at normal incidence, F0: `0.08 × Specular`, 0.04 at its default. Fresnel
   * then brightens every surface toward grazing, not only a metal. A rectangle's highlight is the
   * lobe integrated over it with the attribute as F0 already, so it is unchanged either way.
   *
   * On the standard, lightmap and anisotropic models. Skin and the eye are physical already; hair
   * keeps its own three lobes. **What it gives up**: the look's independence of strength and width,
   * and an 8-bit frame clips the brighter peak without `hdrScene`.
   */
  physicalSpecular?: boolean;
  /**
   * Texture coordinates from where a point is in the world rather than from the mesh: `'planar'`
   * across the horizontal axes for ground, `'triplanar'` on three planes for walls and rock, at so
   * many repeats a metre. Absent, the mesh's, as every material's were. **A lit switch**, compiled in
   * the first time a material asks, so a scene that never asks pays nothing. See
   * `surfaceProjection.ts` for what it gives up.
   */
  projection?: SurfaceProjection | null;
  /**
   * How much light from behind a thin surface lets through, 0 to 1: a banner lit from behind, a
   * leaf against the sun, a lampshade. The light falling on the far side — the sun, lamps, area
   * lights, DriftLight — reaches the eye through the surface, coloured by its own colour; a metal
   * lets none through. 0, the default, is every material as it was. Two-sided or not: a one-sided
   * surface seen from its front shows the light behind it as well.
   *
   * **What it gives up**: a thin surface, not a volume, so a thick one lets through as much as a
   * sheet; the light behind is not blurred by the surface; and none of it on glass, which lets
   * light through by its own rule (`TranslucentMeshOptions.glass`).
   */
  diffuseTransmission?: number;
  /**
   * The colour the light from behind takes through the surface, linear, in place of its own colour:
   * a banner whose cloth glows a flat red behind a printed face, a leaf whose veins are not what the
   * light through it shows. Absent, the surface's colour, as `diffuseTransmission` has always used.
   * Each component is held at zero or above. Read only where `diffuseTransmission` lets light through.
   */
  transmissionColor?: readonly [number, number, number] | null;
  /**
   * Up to five layers blended by a mask, each at its own repeat: `albedo`, `normal` and `orm` arrays
   * whose layers are the material's, and a mask laying each over the ones before it or summing them,
   * from a map, the ORM array or the vertex colour; under a `projection` the layers are placed by the
   * world. Absent, the material is one layer, as every material was. **A lit switch**, compiled in the
   * first time a material asks. A mask that is a map is read where `modelMap` goes, so such a
   * material carries one or the other; a lightmapped one keeps its mask in its ORM array or its
   * vertices. See `surfaceLayers.ts` for the rest and what it gives up.
   */
  layers?: SurfaceLayers<Texture> | null;
}

export interface SurfaceTextureOptions {
  /**
   * What each layer does beyond its picture — rooms behind windows, windows lit by night, wear,
   * animation, staying dry — one entry a layer, `undefined` for a layer with none. Read only where
   * this texture is a material's albedo. See `surfaceEffects.ts`.
   */
  effects?: readonly (SurfaceLayerEffect | undefined)[];
  /**
   * `repeat` tiles the image, `clamp` stretches its edge texels.
   *
   * Repeat is the default because the case this exists for is a wall: one small image
   * covering a large surface, with `uvScale` deciding how often it lands. Clamp is for
   * an image that is a *picture* — a portrait, a sign — where a second copy of it
   * appearing past the edge is a bug rather than a pattern.
   */
  wrap?: 'repeat' | 'clamp';
  /**
   * How the image's values are encoded, so the shader can sample light rather than pixels.
   *
   * `linear` is the default and the old behaviour: the bytes are handed to the shader as
   * they are. That is right for a mask, a height field, anything whose numbers *are* the
   * data.
   *
   * `srgb` is right for anything that was authored to be looked at — a photo, a painted
   * canvas, a biome tile. Those bytes are display values, and shading maths is linear, so
   * multiplying a light into them without decoding first is a category error: mid-greys
   * come out roughly twice as bright as they should, and the mistake is invisible until an
   * output transform is applied and everything blows out at once. The GPU decodes
   * `SRGB8_ALPHA8` in the sampler, so this costs nothing per fetch and, unlike decoding in
   * the shader, it happens *before* filtering — which is the only place it is correct.
   */
  colorSpace?: 'linear' | 'srgb';
  /**
   * How a texel is chosen when the image is magnified: smoothed between texels, or taken whole.
   *
   * **`linear` is the default and is every surface that shipped before this**, which is right for
   * anything photographic: a wall, a painted canvas, a biome tile, where the texel grid is an
   * artefact of resolution rather than the subject.
   *
   * `nearest` is for an image whose *pixels are the subject* — pixel art, an icon atlas, a
   * hand-authored tile. **Reported by a consumer whose block atlas is exactly that**: linear
   * magnification turns an authored tile into a smear as the camera approaches, and there was no
   * way to ask for anything else. They composed their atlas with `imageSmoothingEnabled = false`
   * and kept tiles at twice the resolution they wanted, and neither touches magnification — the
   * smoothing happens in the sampler, after everything a caller controls.
   *
   * **Minification still blends between mip levels**, and that is not the option being ignored. A
   * tiled floor at a grazing angle minifies far past one texel per pixel, which is what mips exist
   * for; taking the nearest *level* as well would trade a smear for a visible pop as the camera
   * pulls back. So the choice applies where it was asked about, and within a level either way.
   *
   * `@driftengine/ui2d` takes the same option and defaults it the other way, because a sprite sheet
   * is usually pixel art and a world surface usually is not.
   */
  filter?: 'linear' | 'nearest';
  /**
   * Build a mip chain. On by default, and it is not a quality preference.
   *
   * A tiled surface seen at a grazing angle — which is every floor and every corridor
   * wall — minifies far past one texel per pixel, and without mips that undersampling
   * is aliasing that *crawls* as the camera moves. It is the single most visible
   * artefact a textured world can have. Off is for a texture drawn at roughly its own
   * size, where the chain is memory spent on levels nothing will sample.
   */
  mipmap?: boolean;
  /**
   * Anisotropic samples, when the extension is present. 1 disables it.
   *
   * Mips fix the crawling and cost sharpness: a floor stretching to the horizon picks
   * its mip from the *worse* of the two axes, so it blurs along the one that was still
   * well sampled. Anisotropy is the standard repair, it is cheap at these sizes, and
   * on a machine without the extension the clamp below silently leaves it at 1.
   */
  anisotropy?: number;
}

const DEFAULT_ANISOTROPY = 4;

/**
 * An image uploaded once and bound per draw.
 *
 * The engine ships no image assets and fetches nothing — that payload rule is intact
 * and this does not weaken it. What it takes is a `TexImageSource` the *consumer*
 * already has: a canvas it generated procedurally at runtime, an `ImageBitmap` it
 * decoded, a video frame. The engine owns the GPU object and the sampler state; where
 * the pixels came from is the caller's business and stays that way.
 */
export class SurfaceTexture {
  private texture: WebGLTexture | null;
  private readonly mipmapped: boolean;
  /** Whether the sampler decodes sRGB on fetch. See `colorSpace`. */
  private readonly srgb: boolean;

  /** How many images the array holds: 1 for `createSurfaceTexture`, the list's length otherwise. */
  readonly layers: number;
  /** The per-layer effects table, or null for a texture given none. See `surfaceEffects.ts`. */
  private effectsTable: WebGLTexture | null = null;
  /** The block format a compressed texture holds, or null for one uploaded from images. */
  private blockFormat: BlockFormat | null;
  /** How the texture is sampled, kept so blocks swapped in by `update` are sampled the same way. */
  private readonly sampling: { wrap: number; nearest: boolean; anisotropy: number };
  /** Level 0's size, which `flatLayer` copies; kept as `update` changes it. */
  private width = 0;
  private height = 0;
  /** The texture's storage format, which `flatLayer`'s copy matches so the copy converts nothing. */
  private readonly storage: number;
  /** Layer 0 as a plain 2D texture, made by `flatLayer` and dropped when the pixels change. */
  private flat: WebGLTexture | null = null;

  /**
   * One image, or an array of images that must share one size (`layerSize` refuses otherwise).
   * Uploaded unflipped either way; see the constructor body for why. Or blocks, uploaded as they are
   * where `compressed` — the formats this context samples — has theirs; see `compressedSource.ts`.
   */
  constructor(
    gl: WebGL2RenderingContext,
    source: SurfaceSource | readonly SurfaceSource[] | LightmapTexels | SceneCaptureTexels,
    options: SurfaceTextureOptions = {},
    compressed: readonly CompressedTextureFormat[] = [],
  ) {
    /* A scene capture's target: one empty layer the renderer draws into. See `sceneCapture.ts`. */
    const capture = isSceneCaptureTexels(source) ? source : null;
    /* A lightmap's page: two layers of bytes, uploaded as they are. See `lightmap.ts`. */
    const baked = isLightmapTexels(source) ? source : null;
    const listed = (
      baked !== null || capture !== null ? [] : Array.isArray(source) ? source : [source]
    ) as readonly SurfaceSource[];
    const blocks = compressedLayers(listed);
    this.srgb = (options.colorSpace ?? 'linear') === 'srgb';
    /* Refused before anything is allocated, so a refusal leaves no texture behind. */
    const plan = blocks === null ? null : planBlocks(blocks, this.srgb, compressed);
    const texture = gl.createTexture();
    if (texture === null) throw new Error('SurfaceTexture: createTexture failed');
    this.texture = texture;
    const wrap = (options.wrap ?? 'repeat') === 'repeat' ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);

    if (capture !== null) {
      /* Immutable storage, one level: a framebuffer attachment, and radiance read linear. */
      this.layers = 1;
      this.blockFormat = null;
      this.mipmapped = false;
      this.width = capture.width;
      this.height = capture.height;
      this.storage = capture.float ? gl.RGBA16F : gl.RGBA8;
      gl.texStorage3D(
        gl.TEXTURE_2D_ARRAY,
        1,
        capture.float ? gl.RGBA16F : gl.RGBA8,
        capture.width,
        capture.height,
        1,
      );
    } else if (baked !== null) {
      /* No chain: a page is read at its own resolution, and a level of it would blend regions. */
      this.layers = baked.layers.length;
      this.blockFormat = null;
      this.mipmapped = false;
      this.width = baked.width;
      this.height = baked.height;
      this.storage = gl.RGBA8;
      /* A typed array refuses either flag set, so both are put down here rather than assumed. */
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      /* Bytes, and read by `texelFetch` alone: the shader decodes and filters. See `lightmap.ts`. */
      gl.texImage3D(
        gl.TEXTURE_2D_ARRAY,
        0,
        gl.RGBA8,
        baked.width,
        baked.height,
        this.layers,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null,
      );
      /* A layer at a time, so a page's arrays are uploaded where they lie rather than joined. */
      for (let layer = 0; layer < this.layers; layer++) {
        gl.texSubImage3D(
          gl.TEXTURE_2D_ARRAY,
          0,
          0,
          0,
          layer,
          baked.width,
          baked.height,
          1,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          baked.layers[layer] as Uint8Array,
        );
      }
    } else if (blocks !== null && plan !== null) {
      /* The stored chain, or level 0 alone where no chain was asked for. Nothing is generated:
         `generateMipmap` cannot write a compressed format. */
      this.layers = blocks.length;
      this.blockFormat = (blocks[0] as CompressedTextureSource).format;
      this.storage = gl.NONE;
      this.mipmapped = (options.mipmap ?? true) && plan.levels > 1;
      uploadCompressedArray(gl, plan.name, blocks, this.mipmapped ? plan.levels : 1);
    } else {
      const sources = listed as readonly TexImageSource[];
      this.layers = sources.length;
      this.blockFormat = null;
      this.mipmapped = options.mipmap ?? true;
      const { width, height } = layerSize(sources);
      this.width = width;
      this.height = height;
      this.storage = this.srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8;
      uploadImages(gl, sources, this.srgb);
    }
    this.sampling = {
      wrap,
      nearest: options.filter === 'nearest',
      anisotropy: options.anisotropy ?? DEFAULT_ANISOTROPY,
    };
    this.applySampling(gl);
    if (this.mipmapped && this.blockFormat === null) gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);

    /* Half floats, nearest, clamped: a table read by texelFetch, whose every whole number is under
       what a half holds exactly. */
    const effects = options.effects ?? [];
    if (effects.length > 0) {
      const table = gl.createTexture();
      if (table === null) throw new Error('SurfaceTexture: createTexture failed');
      gl.bindTexture(gl.TEXTURE_2D, table);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA16F,
        SURFACE_EFFECT_TEXELS,
        effects.length,
        0,
        gl.RGBA,
        gl.FLOAT,
        packSurfaceEffects(effects),
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
      this.effectsTable = table;
    }
  }

  /** Whether this texture carries an effects table, which the lit program reads only once one exists. */
  get hasEffects(): boolean {
    return this.effectsTable !== null;
  }

  bindEffects(gl: WebGL2RenderingContext, unit: number, fallback: WebGLTexture): void {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.effectsTable ?? fallback);
  }

  /**
   * Replace the pixels, keeping the GPU object and its sampler state.
   *
   * For a source that changes — a canvas being redrawn, a decoded frame. Re-uploading
   * beats constructing a second texture because the binding the caller already handed
   * to a draw stays valid, and because a texture created per frame is a leak in every
   * case where the caller forgets the matching dispose.
   *
   * Not a hot path: it re-uploads the whole image and regenerates the chain. A caller
   * doing this every frame at any size wants to know that it costs what it costs.
   */
  update(
    gl: WebGL2RenderingContext,
    source: TexImageSource | CompressedTextureSource,
    compressed: readonly CompressedTextureFormat[] = [],
  ): void {
    if (this.texture === null) return;
    refuseArrayUpdate(this.layers);
    if (isCompressedSource(source)) {
      this.swapToBlocks(gl, source, compressed);
      return;
    }
    refuseBlockUpdate(this.blockFormat);
    const { width, height } = sourceSize(source);
    this.width = width;
    this.height = height;
    this.dropFlat(gl);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
    /* Unflipped, matching the constructor. See it for why, and for what it cost. */
    gl.texImage3D(
      gl.TEXTURE_2D_ARRAY,
      0,
      this.srgb ? gl.SRGB8_ALPHA8 : gl.RGBA,
      width,
      height,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      source,
    );
    if (this.mipmapped) gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  }

  /**
   * Blocks in place of the image, behind the same handle: **a new GL object** rather than the
   * image's levels respecified, because a chain shorter than the image's would leave the levels
   * past it allocated, and immutable storage could not be respecified at all. Sampled as the image
   * was, and refused before anything changes where the context does not take the format.
   */
  private swapToBlocks(
    gl: WebGL2RenderingContext,
    source: CompressedTextureSource,
    compressed: readonly CompressedTextureFormat[],
  ): void {
    const plan = planBlocks([source], this.srgb, compressed);
    const texture = gl.createTexture();
    if (texture === null) throw new Error('SurfaceTexture: createTexture failed');
    this.dropFlat(gl);
    if (this.texture !== null) gl.deleteTexture(this.texture);
    this.texture = texture;
    this.blockFormat = source.format;
    this.width = source.width;
    this.height = source.height;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    uploadCompressedArray(gl, plan.name, [source], this.mipmapped ? plan.levels : 1);
    this.applySampling(gl);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  }

  /**
   * Wrap, filters and anisotropy on the bound texture. Nearest where the caller said their pixels
   * are the subject; see `filter`. The mip chain is still blended between levels, because that is
   * minification and this option is about magnification.
   */
  private applySampling(gl: WebGL2RenderingContext): void {
    const { wrap, nearest, anisotropy } = this.sampling;
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, wrap);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, nearest ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(
      gl.TEXTURE_2D_ARRAY,
      gl.TEXTURE_MIN_FILTER,
      this.mipmapped
        ? nearest
          ? gl.NEAREST_MIPMAP_LINEAR
          : gl.LINEAR_MIPMAP_LINEAR
        : nearest
          ? gl.NEAREST
          : gl.LINEAR,
    );
    applyAnisotropy(gl, anisotropy);
  }

  /**
   * Attach the only layer as the bound framebuffer's colour: a scene capture's target, drawn into
   * by `captureScene`. Engine-internal, as `bind` is.
   */
  attachColor(gl: WebGL2RenderingContext): void {
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.texture, 0, 0);
  }

  /** Bind to a unit for sampling. Engine-internal: the renderer owns unit assignment. */
  bind(gl: WebGL2RenderingContext, unit: number): void {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
  }

  /**
   * Layer 0 as a plain 2D texture: what a `sampler2D` can be handed, which an array cannot. Copied
   * the first time it is asked for, by a framebuffer blit into storage of the same format, and kept
   * until `update` or `dispose`. Engine-internal: a surface overlay's atlas is bound where the
   * lit stage's one 2D image slot is (`surfaceOverlay.ts`).
   *
   * **Null for blocks**, which no framebuffer can read; the caller says so. What it costs is a copy
   * of level 0 in memory beside the array, and the bindings of both framebuffer targets, which are
   * read back before the blit and put back after it — a sync query, paid once per image.
   */
  flatLayer(gl: WebGL2RenderingContext): WebGLTexture | null {
    if (this.texture === null || this.blockFormat !== null) return null;
    if (this.flat !== null) return this.flat;
    const flat = gl.createTexture();
    const read = gl.createFramebuffer();
    const draw = gl.createFramebuffer();
    if (flat === null || read === null || draw === null) return null;
    gl.bindTexture(gl.TEXTURE_2D, flat);
    gl.texStorage2D(gl.TEXTURE_2D, 1, this.storage, this.width, this.height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    const heldRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const heldDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read);
    gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.texture, 0, 0);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw);
    gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, flat, 0);
    const [w, h] = [this.width, this.height];
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, heldRead);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, heldDraw);
    gl.deleteFramebuffer(read);
    gl.deleteFramebuffer(draw);
    this.flat = flat;
    return flat;
  }

  private dropFlat(gl: WebGL2RenderingContext): void {
    if (this.flat !== null) gl.deleteTexture(this.flat);
    this.flat = null;
  }

  dispose(gl: WebGL2RenderingContext): void {
    if (this.texture === null) return;
    this.dropFlat(gl);
    gl.deleteTexture(this.texture);
    this.texture = null;
    if (this.effectsTable !== null) gl.deleteTexture(this.effectsTable);
    this.effectsTable = null;
  }
}

/** Images into the bound array, level 0 of each layer; the chain, if any, is generated after. */
function uploadImages(
  gl: WebGL2RenderingContext,
  sources: readonly TexImageSource[],
  srgb: boolean,
): void {
  const { width, height } = layerSize(sources);
  /*
   * **Not flipped, and this used to be, which is the bug it is written down for.**
   *
   * The flip was here with a comment saying every source is a 2D drawing surface whose Y
   * runs down from the top-left, so without it "every texture arrives mirrored". That is
   * true of a canvas and **WebGL ignores `UNPACK_FLIP_Y_WEBGL` entirely for an
   * `ImageBitmap`**, which carries its own orientation. So the two source types the same
   * method accepts arrived the opposite way up from each other, and nothing caught it
   * because every canvas-sourced texture in this repository was symmetric under a vertical
   * flip: eroded noise, a radial halo, a sleeve blurred to 24 pixels and back. One consumer
   * painted lettering to a canvas beside a sleeve decoded as a bitmap and the text was
   * upside down.
   *
   * **Made to agree by dropping the flip rather than by extending it**, and the direction
   * is a deliberate choice about blast radius rather than a coin toss: `drftLoader` builds
   * every model texture from an `ImageBitmap`, so flipping bitmaps to match canvases would
   * turn over every painted surface on every loaded model. Dropping it changes only
   * canvas-sourced textures, and every one of those that exists today is symmetric.
   *
   * A caller that was mirroring its own canvas to cancel this must stop.
   */
  /* Allocated mutable rather than with texStorage3D, so `update` can hand a one-layer texture a
       new size, as texImage2D always could. Each layer is then written in place. */
  gl.texImage3D(
    gl.TEXTURE_2D_ARRAY,
    0,
    srgb ? gl.SRGB8_ALPHA8 : gl.RGBA,
    width,
    height,
    sources.length,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    null,
  );
  for (let layer = 0; layer < sources.length; layer++) {
    gl.texSubImage3D(
      gl.TEXTURE_2D_ARRAY,
      0,
      0,
      0,
      layer,
      width,
      height,
      1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      sources[layer] as TexImageSource,
    );
  }
}

/**
 * Set anisotropic filtering when the driver offers it, and stay silent when it does not.
 *
 * Silent because the extension is an enhancement with an exact fallback — the same
 * texture, filtered isotropically — so a machine without it renders a slightly softer
 * floor rather than a broken one. Nothing here should fail init over that.
 */
function applyAnisotropy(gl: WebGL2RenderingContext, requested: number): void {
  if (requested <= 1) return;
  const ext =
    gl.getExtension('EXT_texture_filter_anisotropic') ??
    gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic');
  if (ext === null) return;
  const max = gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number;
  gl.texParameterf(gl.TEXTURE_2D_ARRAY, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(requested, max));
}

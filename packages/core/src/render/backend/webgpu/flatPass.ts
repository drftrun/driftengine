import { DEPTH_COMPARE, DEPTH_FORMAT, depthOffsetForLayer } from '../../depthConvention.ts';
import {
  FLAT_BINDINGS,
  FLAT_FRAG_WGSL,
  FLAT_VERT_WGSL,
} from '../../shaders/generated/flat.wgsl.ts';
import { vertexBufferLayouts } from './buffers.ts';
import type { PipelineCache } from './pipelineCache.ts';
import { shaderModule } from './shaderModules.ts';

/**
 * The flat pipeline: the shader that draws the world.
 *
 * Built from the generated WGSL, with the bind group layout, the uniform sizes and every
 * byte offset taken from the same generated file. **Nothing here restates a number the
 * generator already knows** — a binding or an offset written twice is one that can disagree,
 * and the disagreement draws a picture rather than raising an error.
 *
 * **Driven by the variant, not fixed to one.** `flatFrag` is sixteen permutations and they
 * are not interchangeable: the one that compiles in the directional shadow path declares
 * three more samplers and a 1,104-byte uniform block against the plain one's 1,072. Building
 * the right shader and binding it against the wrong layout is a mistake that validates,
 * draws, and is wrong, so the layout is derived from the variant every time.
 */

/** A key into `FLAT_FRAG_WGSL`: the flags that are on, sorted, joined by `+`, or `none`. */
export type FlatVariant = string;

/** The four flags `flatFrag` permutes on, which is what decides which of sixteen to build. */
export interface FlatVariantFlags {
  readonly directionalShadows: boolean;
  readonly environmentProbe: boolean;
  readonly nightEmissive: boolean;
  readonly pointShadows: boolean;
}

/**
 * The key for a set of flags.
 *
 * **The rule is `variantKey` in `scripts/wgsl.ts` and this is a second statement of it**, which
 * is exactly the kind of restatement that drifts — except that a drift here cannot be silent:
 * `flatFragmentBindings` throws on a key the generated table does not hold, at construction,
 * naming the key it looked for. `scripts/` is a build tool and nothing under `src/` may import
 * it, so a copy is the only option and a loud one is the acceptable form of it.
 */
export function flatVariant(flags: FlatVariantFlags): FlatVariant {
  const on = (Object.keys(flags) as (keyof FlatVariantFlags)[])
    .filter((flag) => flags[flag])
    .sort();
  return on.length === 0 ? 'none' : on.join('+');
}

/** Where one sampler's two halves ended up. */
export interface TextureBinding {
  readonly texture: number;
  readonly sampler: number;
  readonly type: string;
}

/** What the generator recorded about one shader stage. */
export interface StageBindings {
  readonly uniforms: number;
  readonly uniformSize: number;
  /**
   * Byte offsets, and for an array the shape a `std140` block gives it.
   *
   * `length` and `stride` are present only on arrays, and `stride` is not `size / length`:
   * every element gets its own sixteen-byte slot whatever it holds, so a `float[10]` is 160
   * bytes. A writer that assumed packing would put ten lights in the space of two and a half
   * and raise nothing, which is why the generator emits the number rather than leaving it to
   * be derived.
   */
  readonly fields: Readonly<
    Record<
      string,
      {
        readonly offset: number;
        readonly size: number;
        readonly length?: number;
        readonly stride?: number;
      }
    >
  >;
  readonly textures: Readonly<Record<string, TextureBinding>>;
}

/*
 * The generated file is `as const`, which makes every variant its own literal type and makes
 * indexing it by a computed key an error. Declaring the shape once here is what lets the
 * renderer choose a variant at runtime, and it is checked against the real object rather than
 * asserted about it: a generator that stopped emitting `uniformSize` would fail here.
 */
const FRAGMENT_BINDINGS = FLAT_BINDINGS.flatFrag as unknown as Readonly<
  Record<string, StageBindings>
>;

/**
 * The vertex stage's four variants, keyed like the fragment stage's sixteen.
 *
 * **The morphed variants have a larger uniform block — 384 bytes against 240 — and every shared
 * field keeps its offset anyway.** That is not luck: a block is packed in declaration order, and
 * `flat/index.ts` declares morph's uniforms after every other one for exactly this reason. The
 * assertion below is on the *offsets* rather than on the size, because the offsets are what the
 * renderer writes by and a moved one does not fail — it puts the model matrix where the view
 * projection should be and draws a scrambled frame.
 *
 * The first version of this guard compared only the unskinned and skinned sizes, which are equal
 * because skinning added a sampler and no uniform. It would have stayed silent through exactly the
 * change it was written to catch.
 */
const VERTEX_BINDINGS = FLAT_BINDINGS.flatVert as unknown as Readonly<
  Record<string, StageBindings>
>;

/** The key for a set of vertex flags: the same rule `variantKey` uses, flags on, sorted, joined. */
export function flatVertexKey(skinned: boolean, morphed: boolean, instanced = false): string {
  const on: string[] = [];
  /* Alphabetical, because the generator's own `variantKey` sorts and the two keys must agree. */
  if (instanced) on.push('instanced');
  if (morphed) on.push('morphed');
  if (skinned) on.push('skinned');
  return on.length === 0 ? 'none' : on.join('+');
}

/** Everything the generator recorded about one variant of the vertex stage. */
export function flatVertexBindings(
  skinned: boolean,
  morphed = false,
  instanced = false,
): StageBindings {
  const key = flatVertexKey(skinned, morphed, instanced);
  const found = VERTEX_BINDINGS[key];
  if (found === undefined) throw new Error(`flatPass: no vertex bindings for variant "${key}"`);
  return found;
}

const PLAIN_VERTEX = flatVertexBindings(false);
/*
 * **A variant may drop a field; it may never move one.**
 *
 * The renderer writes this block by offset, so two variants disagreeing about where a shared
 * field lives is a scrambled frame rather than an error. The check was `undefined || moved` until
 * the instanced variant, which legitimately declares neither `uModel` nor `uTint` — its placement
 * and tint arrive as vertex attributes — and an absent field is not a moved one: nothing writes
 * it, so nothing can write it to the wrong place.
 *
 * What still has to hold, and what this asserts, is that every field a variant *does* declare sits
 * where the plain variant has it. That is what `flat/index.ts` declares the optional uniforms last
 * for, and it was worth asserting: with `uModel` declared second, the instanced block put
 * `uHasTangents` at 64 against the plain variant's 128, and a draw writing by the plain table
 * would have put the tangent flag into the model matrix.
 *
 * **What would make this wrong** is a caller writing a field the variant it is drawing does not
 * declare. That is the failure this no longer catches, and it is `drawInstanced`'s to avoid by
 * writing the shared fields only.
 */
for (const [key, bindings] of Object.entries(VERTEX_BINDINGS)) {
  for (const [field, shared] of Object.entries(PLAIN_VERTEX.fields)) {
    const here = bindings.fields[field];
    if (here !== undefined && here.offset !== shared.offset) {
      throw new Error(
        `flatPass: vertex variant "${key}" puts ${field} at ${here.offset} where the ` +
          `plain variant has it at ${shared.offset}. A variant may omit a field, but every field ` +
          `it declares must sit where the plain variant has it, because the renderer writes them ` +
          `by offset — declare a new flag's uniforms after the existing ones.`,
      );
    }
  }
}

export const FLAT_VERT_FIELDS = FLAT_BINDINGS.flatVert.none.fields;
/**
 * The **largest** variant's block, because one ring serves every draw.
 *
 * A ring strided for the plain block would leave a morphed draw writing its weights into the next
 * slot, which is a scrambled neighbour rather than an error. The unused tail on a plain draw is
 * 144 bytes a slot and is what a single ring costs.
 */
export const FLAT_VERT_SIZE = Math.max(
  ...Object.values(VERTEX_BINDINGS).map((bindings) => bindings.uniformSize),
);
const FLAT_VERT_BINDING = PLAIN_VERTEX.uniforms;

/** Everything the generator recorded about one permutation of the fragment stage. */
export function flatFragmentBindings(variant: FlatVariant): StageBindings {
  const found = FRAGMENT_BINDINGS[variant];
  if (found === undefined) throw new Error(`flatPass: no bindings for variant "${variant}"`);
  return found;
}

/** The depth format both backends compare with. */
/* Re-exported so the twenty passes that already import it from here do not each learn a new
   module; `depthConvention.ts` is where the decision lives and why. */
export { DEPTH_FORMAT } from '../../depthConvention.ts';

const VISIBILITY_VERTEX = 0x1;
const VISIBILITY_FRAGMENT = 0x2;

/**
 * The layout this variant binds against.
 *
 * The vertex block is **dynamic**, because every draw supplies its own model matrix and tint
 * from its own slot of one buffer. The fragment block is not: it holds the lights, the fog
 * and the camera, settled once by `bindMeshPass` and unchanged between draws.
 */
export function createFlatBindGroupLayout(
  device: GPUDevice,
  variant: FlatVariant,
  skinned = false,
  morphed = false,
): GPUBindGroupLayout {
  const fragment = flatFragmentBindings(variant);
  const entries: GPUBindGroupLayoutEntry[] = [
    {
      binding: FLAT_VERT_BINDING,
      visibility: VISIBILITY_VERTEX,
      buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: FLAT_VERT_SIZE },
    },
    {
      binding: fragment.uniforms,
      visibility: VISIBILITY_FRAGMENT,
      /*
       * Dynamic, because this block carries the material and a material changes between draws.
       * See `WebGPURenderer.perFrame` for why one buffer cannot hold two answers.
       */
      buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: fragment.uniformSize },
    },
  ];

  /** What each sampler binding was declared as, so a shared one is declared once and agrees. */
  const samplerKind = new Map<number, 'filtering' | 'non-filtering'>();

  for (const [name, texture] of Object.entries(fragment.textures)) {
    /*
     * A shadow map is a depth texture, and a depth texture's supported sample types are
     * `UnfilterableFloat | Depth` — never plain `Float`, which is what an empty `texture: {}`
     * asks for. Declaring the wrong one is rejected at bind time:
     *
     *   None of the supported sample types (UnfilterableFloat|Depth) of [Texture
     *   "shadow.static"] match the expected sample types (Float)
     *
     * Unfilterable rather than a comparison sampler, because the shader does its own PCF
     * loop over explicit taps rather than asking the hardware to compare and blend.
     */
    const cube = texture.type === 'samplerCube';
    /*
     * The point-shadow array is a depth texture too, and is read the same way: `pointShadow`
     * takes one `textureLod(maps, vec3(octEncode(dir), layer), 0.0)` per tap and estimates its
     * own penumbra, so nothing here asks the hardware to filter.
     *
     * **`uEnvironment` is a cube and is *not* a shadow map.** It is a colour cubemap, and its
     * mip chain **is** the roughness: a polished surface reads level 0 and a satin one reads
     * further up, blending between them. That needs a filtering sampler and a filterable float,
     * and declaring it `non-filtering` alongside the depth textures made the pipeline invalid —
     * which, being a pipeline, drew nothing and said nothing beyond a device warning.
     *
     * Named explicitly rather than by a pattern. `uPointShadow0` did not end in `ShadowMap`, so
     * a rule wide enough to catch the twelve cubes also caught the probe; naming the one
     * exception was the answer then and there is one binding to catch now.
     */
    const array = texture.type === 'sampler2DArray';
    /*
     * **An integer texture is its own sample type and cannot be anything else.** The froxel table
     * is `rgba32uint`; declaring it `float` is rejected at bind time exactly as a depth texture
     * declared `float` is, with the same shape of message and the same consequence — a bind group
     * that is invalid, a pass that records nothing, and a frame that presents anyway.
     *
     * It is also the reason the entry below asks for a non-filtering sampler: WebGPU permits no
     * other kind against a `uint` texture, and the shader never samples it — every read is a
     * `texelFetch`, which is why the declaration shares a sampler rather than bringing its own.
     */
    const integer = texture.type === 'usampler2D';
    const isShadow =
      integer || (name !== 'uEnvironment' && (name.endsWith('ShadowMap') || cube || array));
    entries.push({
      binding: texture.texture,
      visibility: VISIBILITY_FRAGMENT,
      texture: {
        sampleType: integer ? 'uint' : isShadow ? 'unfilterable-float' : 'float',
        ...(cube ? { viewDimension: 'cube' as const } : {}),
        ...(array ? { viewDimension: '2d-array' as const } : {}),
      },
    });
    /*
     * **One entry per sampler *binding*, not per texture**, because the fifteen shadow
     * declarations now share one. `// wgsl:share shadow` in `flat.ts` is what collapsed them,
     * and it is what lets the environment probe fit under a sixteen-sampler ceiling at all.
     * Declaring the same binding fifteen times is rejected outright.
     */
    const declared = samplerKind.get(texture.sampler);
    const kind = isShadow ? ('non-filtering' as const) : ('filtering' as const);
    if (declared === undefined) {
      samplerKind.set(texture.sampler, kind);
      entries.push({
        binding: texture.sampler,
        visibility: VISIBILITY_FRAGMENT,
        sampler: { type: kind },
      });
    } else if (declared !== kind) {
      /*
       * Loud, at init, because the alternative is silent and wrong. A group whose members
       * disagree about filtering cannot share a sampler — `uEnvironment`'s mip chain *is* its
       * roughness and needs a filtering one, where a depth cube cannot have it — and a marker
       * that put them together would otherwise produce a pipeline that draws nothing and says
       * nothing beyond a device warning.
       */
      throw new Error(
        `flat: ${name} shares sampler binding ${texture.sampler} but wants ${kind} where the ` +
          `group is ${declared}. Check its wgsl:share marker in flat.ts.`,
      );
    }
  }
  /*
   * The joint palette, on the **vertex** stage.
   *
   * `unfilterable-float`, because `rgba32float` is not filterable without an extension and the
   * shader reads it with an integer fetch that involves no sampler at all. Declaring it filterable
   * is a pipeline-creation failure rather than a wrong picture, which is the loud direction.
   *
   * Added only for the skinned variant, so an unskinned layout declares nothing the unskinned
   * shader module cannot reach — a bind group layout and its module must agree exactly or WebGPU
   * refuses the pipeline.
   */
  if (morphed) {
    const deltas = flatVertexBindings(skinned, true).textures['uMorphDeltas'];
    if (deltas === undefined) {
      throw new Error('flatPass: the morphed vertex shader declares no uMorphDeltas');
    }
    entries.push({
      binding: deltas.texture,
      visibility: VISIBILITY_VERTEX,
      texture: { sampleType: 'unfilterable-float' },
    });
  }

  if (skinned) {
    const palette = flatVertexBindings(skinned, morphed).textures['uJointPalette'];
    if (palette === undefined) {
      throw new Error('flatPass: the skinned vertex shader declares no uJointPalette');
    }
    entries.push({
      binding: palette.texture,
      visibility: VISIBILITY_VERTEX,
      texture: { sampleType: 'unfilterable-float' },
    });
  }

  return device.createBindGroupLayout({
    label: `flat.layout:${variant}|${flatVertexKey(skinned, morphed)}`,
    entries,
  });
}

/**
 * Bind the buffers and one view per declared texture.
 *
 * `resolve` is asked for a view by the shader's own name for it, so a caller supplies the
 * shadow maps it has and a stand-in for the rest. **Every declared binding must be filled
 * even when the shader never samples it** — `uAlbedoEnabled` is zero for nearly all geometry
 * and WebGPU still requires something there, which is why `renderer.ts` keeps an
 * `emptyTexture2D` for the same reason on the other side.
 */
export function createFlatBindGroup(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  variant: FlatVariant,
  perDraw: GPUBuffer,
  perFrame: GPUBuffer,
  resolve: (name: string) => { view: GPUTextureView; sampler: GPUSampler },
  /** The palette view for a skinned bind group, or null for an unskinned one. */
  palette: GPUTextureView | null = null,
  /** The delta view for a morphed bind group, or null for an unmorphed one. */
  deltas: GPUTextureView | null = null,
): GPUBindGroup {
  const fragment = flatFragmentBindings(variant);
  const entries: GPUBindGroupEntry[] = [
    {
      binding: FLAT_VERT_BINDING,
      resource: { buffer: perDraw, size: FLAT_VERT_SIZE },
    },
    { binding: fragment.uniforms, resource: { buffer: perFrame, size: fragment.uniformSize } },
  ];

  /* The same dedupe the layout does, and for the same reason: the shadow bindings share one
     sampler, and a bind group that filled it fifteen times would be rejected. Every member
     resolves to the one object anyway — that is why sharing the declaration was free. */
  const filled = new Set<number>();
  for (const [name, texture] of Object.entries(fragment.textures)) {
    const supplied = resolve(name);
    entries.push({ binding: texture.texture, resource: supplied.view });
    if (filled.has(texture.sampler)) continue;
    filled.add(texture.sampler);
    entries.push({ binding: texture.sampler, resource: supplied.sampler });
  }
  if (deltas !== null) {
    const binding = flatVertexBindings(palette !== null, true).textures['uMorphDeltas'];
    if (binding === undefined) {
      throw new Error('flatPass: the morphed vertex shader declares no uMorphDeltas');
    }
    entries.push({ binding: binding.texture, resource: deltas });
  }

  if (palette !== null) {
    const binding = flatVertexBindings(true, deltas !== null).textures['uJointPalette'];
    if (binding === undefined) {
      throw new Error('flatPass: the skinned vertex shader declares no uJointPalette');
    }
    entries.push({ binding: binding.texture, resource: palette });
  }

  return device.createBindGroup({
    label: `flat.bindGroup:${variant}|${flatVertexKey(palette !== null, deltas !== null)}`,
    layout,
    entries,
  });
}

/**
 * The pipeline, cached by the state that distinguishes it.
 *
 * The key names the variant and which optional attributes the mesh supplied, because those
 * two decide the fragment module and the vertex layout. Built once per mesh at construction
 * time rather than per frame, which is the rule `PipelineCache` exists to keep.
 */
export function flatPipeline(
  cache: PipelineCache,
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  variant: FlatVariant,
  key: string,
  present: Readonly<Record<string, boolean>>,
  /**
   * Alpha-blended, for `drawTranslucentMesh`.
   *
   * **A second pipeline rather than a flag on the first**, because blend state is baked into a
   * WebGPU pipeline where WebGL2 toggles it around the draw with `gl.enable(BLEND)`. Keyed
   * separately, so one mesh drawn both ways gets both and neither is rebuilt per frame.
   *
   * Depth still written, matching the other backend: `drawTranslucentMesh` there leaves
   * `depthMask` alone and only turns blending on. A translucent part of a loaded model is a
   * pane of glass in a solid object, not a particle, and it has to occlude what is behind it
   * for the rest of the model to sort correctly.
   */
  translucent = false,
  /** Whether this pipeline reads a joint palette. See `FlatVertexOptions`. */
  skinned = false,
  /** Whether this pipeline reads morph deltas. See `FlatVertexOptions`. */
  morphed = false,
  /**
   * Whether this pipeline writes depth, and which coplanar layer it draws on.
   *
   * **Both are pipeline state here and per-draw state on the other backend**, which is why they
   * arrive as arguments and why the caller's key has to carry them: two draws of one mesh that
   * differ only in these would otherwise share a cached pipeline and the second would silently
   * get the first one's depth behaviour.
   */
  depthWrite = true,
  depthLayer = 0,
  /** Whether placement and tint arrive per instance. See `FlatVertexOptions`. */
  instanced = false,
  /** Which order-independent buffer this pipeline writes, if any. The key must carry it. */
  oit: OitTarget = 'none',
): GPURenderPipeline {
  return cache.get(key, () =>
    flatDescriptor(
      cache,
      device,
      layout,
      variant,
      key,
      present,
      translucent,
      skinned,
      morphed,
      depthWrite,
      depthLayer,
      instanced,
      oit,
    ),
  );
}

/**
 * The same pipeline, compiled off the main thread.
 *
 * **Preferred by everything that builds a mesh**, which is all of them: `createRenderPipeline`
 * defers the shader compile to the first draw, so a scene that builds its meshes and then
 * renders pays for every one of them inside a single frame. On a phone that is seconds of a
 * blocked GPU queue with an idle main thread, which is invisible to every timer that is not
 * this one. The descriptor is identical; only when the driver does the work changes.
 */
export function flatPipelineAsync(
  cache: PipelineCache,
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  variant: FlatVariant,
  key: string,
  present: Readonly<Record<string, boolean>>,
  translucent = false,
  /** Whether this pipeline reads a joint palette. See `FlatVertexOptions`. */
  skinned = false,
  /** Whether this pipeline reads morph deltas. See `FlatVertexOptions`. */
  morphed = false,
): Promise<GPURenderPipeline> {
  return cache.getAsync(key, () =>
    flatDescriptor(cache, device, layout, variant, key, present, translucent, skinned, morphed),
  );
}

/** Which of the two order-independent buffers a pipeline writes, or neither. */
export type OitTarget = 'none' | 'accum' | 'reveal';

/**
 * The colour target for an order-independent pass, or null where this is an ordinary draw.
 *
 * **The accumulation sums and the revealage multiplies**, which is the whole mechanism: a sum and
 * a product both commute, so the frame stops depending on the order its fragments arrived in.
 * `orderIndependent.ts` holds the same arithmetic on the CPU, where it is asserted against numbers.
 *
 * The revealage pass draws with the *ordinary* shader — `(zero, one-minus-src-alpha)` multiplies
 * whatever colour it computed by nothing, so only its alpha lands. Both passes therefore decide a
 * fragment's alpha with the same code and cannot disagree about it.
 */
function oitTarget(oit: OitTarget): GPUColorTargetState | null {
  if (oit === 'accum') {
    return {
      format: 'rgba16float',
      blend: {
        color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      },
    };
  }
  if (oit === 'reveal') {
    return {
      format: 'r8unorm',
      blend: {
        color: { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      },
    };
  }
  return null;
}

/** The descriptor both paths build, written once so the two can never diverge. */
function flatDescriptor(
  cache: PipelineCache,
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  variant: FlatVariant,
  key: string,
  present: Readonly<Record<string, boolean>>,
  translucent: boolean,
  /** Whether this pipeline reads a joint palette. See `FlatVertexOptions`. */
  skinned: boolean,
  /** Whether this pipeline reads morph deltas. See `FlatVertexOptions`. */
  morphed = false,
  /** Whether this pipeline writes depth. See `TranslucentMeshOptions.depthWrite`. */
  depthWrite = true,
  /** Which coplanar layer this pipeline draws on. See `TranslucentMeshOptions.depthLayer`. */
  depthLayer = 0,
  /** Whether placement and tint arrive per instance. See `FlatVertexOptions`. */
  instanced = false,
  /**
   * Which order-independent transparency buffer this pipeline writes, if any.
   *
   * **A pipeline variant and not a shader one.** The two buffers are two blend states and two
   * formats, both of which are pipeline state on this backend; the *shader* is the same one the
   * ordinary translucent path uses, weighted by a uniform. That is what keeps this off
   * `flatFrag`'s permutation axis, which `scripts/wgsl.ts` measures at about 247 KB gzipped.
   */
  oit: OitTarget = 'none',
): GPURenderPipelineDescriptor {
  const offset = depthOffsetForLayer(depthLayer);
  return {
    label: key,
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: {
      /*
       * Selected per draw, like the fragment variant beside it — and the layout, the bind group
       * and the cache key all carry the same flag. Building a skinned module against an unskinned
       * layout validates, draws, and is wrong, exactly as this file's header says.
       */
      module: shaderModule(device, {
        label: `flat.vert:${flatVertexKey(skinned, morphed, instanced)}`,
        code: FLAT_VERT_WGSL[flatVertexKey(skinned, morphed, instanced)] ?? '',
      }),
      entryPoint: 'main',
      buffers: vertexBufferLayouts(present, instanced),
    },
    fragment: {
      module: shaderModule(device, {
        label: `flat.frag:${variant}`,
        code: FLAT_FRAG_WGSL[variant] ?? '',
      }),
      entryPoint: 'main',
      targets: [
        oitTarget(oit) ??
          (translucent
            ? {
                format: cache.format,
                blend: {
                  color: {
                    srcFactor: 'src-alpha',
                    dstFactor: 'one-minus-src-alpha',
                    operation: 'add',
                  },
                  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                },
              }
            : { format: cache.format }),
      ],
    },
    primitive: { topology: 'triangle-list', cullMode: 'back' },
    multisample: { count: cache.sampleCount },
    /*
     * `less`, matching the WebGL2 path's `LESS` rather than `LEQUAL`, and for the reason
     * `drawMesh` documents there: under `LEQUAL` two coplanar surfaces do not merely tie,
     * they overwrite each other, and a unit of rounding decides which survives per pixel.
     */
    depthStencil: {
      format: DEPTH_FORMAT,
      depthWriteEnabled: depthWrite,
      depthCompare: DEPTH_COMPARE,
      /*
       * Baked in, where the other backend toggles it around the draw. Both read
       * `depthOffsetForLayer`, so a layer is worth the same depth on either one, and a pipeline
       * that asked for no layer carries the zeroes WebGPU's default already is.
       */
      depthBias: offset.units,
      depthBiasSlopeScale: offset.slope,
    },
  };
}

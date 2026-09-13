import { DEPTH_COMPARE } from '../../depthConvention.ts';
import {
  LIGHTVOLUME_BINDINGS,
  LIGHT_VOLUME_FRAG_WGSL,
  LIGHT_VOLUME_VERT_WGSL,
} from '../../shaders/generated/lightVolume.wgsl.ts';
import { vertexBufferLayouts } from './buffers.ts';
import { DEPTH_FORMAT, type StageBindings } from './flatPass.ts';
import type { PipelineCache } from './pipelineCache.ts';
import { shaderModule } from './shaderModules.ts';

/**
 * The light-volume pass: a closed hull, and a march down the view ray inside it.
 *
 * The geometry decides which pixels run and nothing else, so this is an ordinary indexed mesh
 * draw with an unusual pipeline: **additive, depth tested, depth never written, and culling
 * chosen per draw** rather than fixed.
 *
 * Culling is the part that is not boilerplate. A volume seen from outside is entered at its
 * front faces and a volume seen from inside is entered at its back ones, so which face survives
 * is a property of where the camera stands — `resolveLightVolume` answers it, and this file
 * turns the answer into one of two pipelines.
 */

/** Which permutation of the fragment stage: the sun-shadow lookup compiled in, or not. */
export type LightVolumeVariant = 'none' | 'directionalShadows';

export const LIGHT_VOLUME_VERT_FIELDS = LIGHTVOLUME_BINDINGS.LIGHT_VOLUME_VERT.fields;
export const LIGHT_VOLUME_VERT_SIZE = LIGHTVOLUME_BINDINGS.LIGHT_VOLUME_VERT.uniformSize;

const VERT_BINDING = LIGHTVOLUME_BINDINGS.LIGHT_VOLUME_VERT.uniforms;

/*
 * The generated file is `as const`, so indexing it by a computed key is an error until the
 * shape is declared once. Checked against the real object rather than asserted about it, which
 * is what `flatPass.ts` does with the sixteen flat permutations and for the same reason.
 */
const FRAGMENT_BINDINGS = LIGHTVOLUME_BINDINGS.lightVolumeFrag as unknown as Readonly<
  Record<string, StageBindings>
>;

/** Everything the generator recorded about one permutation of the fragment stage. */
export function lightVolumeFragmentBindings(variant: LightVolumeVariant): StageBindings {
  const found = FRAGMENT_BINDINGS[variant];
  if (found === undefined) throw new Error(`lightVolumePass: no bindings for variant "${variant}"`);
  return found;
}

const VISIBILITY_VERTEX = 0x1;
const VISIBILITY_FRAGMENT = 0x2;

/**
 * The layout this variant binds against. **Both blocks are dynamic.**
 *
 * Unlike the flat pass, where the fragment block holds the lights and the fog and is settled
 * once a frame, every field here belongs to one volume: its strength, its reach, its aperture,
 * its own placement and the camera expressed in its own space. Two beams in a frame have
 * nothing in common to hoist, so both blocks come out of a ring a slot at a time — see
 * `UniformRing` for what a single buffer does to a second draw.
 */
export function createLightVolumeBindGroupLayout(
  device: GPUDevice,
  variant: LightVolumeVariant,
): GPUBindGroupLayout {
  const fragment = lightVolumeFragmentBindings(variant);
  const entries: GPUBindGroupLayoutEntry[] = [
    {
      binding: VERT_BINDING,
      visibility: VISIBILITY_VERTEX,
      buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: LIGHT_VOLUME_VERT_SIZE },
    },
    {
      binding: fragment.uniforms,
      visibility: VISIBILITY_FRAGMENT,
      buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: fragment.uniformSize },
    },
  ];

  /*
   * Three depth textures, declared `unfilterable-float` beside a `non-filtering` sampler, for
   * the reason `flatPass.ts` gives: a depth format's supported sample types are
   * `UnfilterableFloat | Depth` and never plain `Float`, so an empty `texture: {}` is rejected
   * at bind time. It is also what this shader wants — `sunReach` takes one explicit-level tap
   * per map and asks the hardware to blend nothing.
   */
  for (const texture of Object.values(fragment.textures)) {
    entries.push({
      binding: texture.texture,
      visibility: VISIBILITY_FRAGMENT,
      texture: { sampleType: 'unfilterable-float' },
    });
    entries.push({
      binding: texture.sampler,
      visibility: VISIBILITY_FRAGMENT,
      sampler: { type: 'non-filtering' },
    });
  }
  return device.createBindGroupLayout({ label: `lightVolume.layout:${variant}`, entries });
}

/**
 * Bind the two rings and one view per declared map.
 *
 * `resolve` is asked by the shader's own name for each map, so the caller supplies what it has
 * and a stand-in for the rest. **The stand-in has to read as unoccluded, not as absent**: the
 * dynamic layer is sampled unconditionally, and `occlusion()` calls any stored depth below the
 * receiver's a blocker — so a stand-in of zero would put the whole beam in shadow, which is a
 * picture rather than an error. A white one-pixel texture is depth 1, the far plane, nothing in
 * the way. `emptyTexture.ts` is the same value on the other backend for the same reason.
 */
export function createLightVolumeBindGroup(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  variant: LightVolumeVariant,
  vertices: GPUBuffer,
  fragments: GPUBuffer,
  resolve: (name: string) => { view: GPUTextureView; sampler: GPUSampler },
): GPUBindGroup {
  const fragment = lightVolumeFragmentBindings(variant);
  const entries: GPUBindGroupEntry[] = [
    { binding: VERT_BINDING, resource: { buffer: vertices, size: LIGHT_VOLUME_VERT_SIZE } },
    {
      binding: fragment.uniforms,
      resource: { buffer: fragments, size: fragment.uniformSize },
    },
  ];
  for (const [name, texture] of Object.entries(fragment.textures)) {
    const supplied = resolve(name);
    entries.push({ binding: texture.texture, resource: supplied.view });
    entries.push({ binding: texture.sampler, resource: supplied.sampler });
  }
  return device.createBindGroup({
    label: `lightVolume.bindGroup:${variant}`,
    layout,
    entries,
  });
}

/**
 * The pipeline for one variant and one side of the hull.
 *
 * **`src-alpha, one`, which is `gl.blendFunc(SRC_ALPHA, ONE)` and the whole reason this pass
 * exists.** Alpha blending moves what is behind a surface *toward* it, so an unlit beam drawn
 * that way comes out darker than the sky and sweeps a solid dark wedge across the frame; see
 * the history at the top of `shaders/lightVolume.ts`. The shader puts its energy in the colour
 * and leaves alpha at 1, because a blend that multiplies by alpha squares anything written to
 * both.
 *
 * The alpha channel is left as it was rather than accumulated, which differs from the GL call
 * — `blendFunc` sets both channels — and is invisible here because the swap chain is
 * configured `alphaMode: 'opaque'` and the composited alpha is discarded. It would stop being
 * invisible the day a consumer wants the canvas composited against the page behind it, and
 * that is the line to change.
 *
 * **Depth tested, never written.** A beam passes behind whatever stands in front of it, and
 * occludes nothing itself: a volume of light is not a surface.
 */
export function lightVolumePipeline(
  cache: PipelineCache,
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  variant: LightVolumeVariant,
  cullMode: GPUCullMode,
  present: Readonly<Record<string, boolean>>,
  key: string,
): GPURenderPipeline {
  return cache.get(key, () => ({
    label: key,
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: {
      module: shaderModule(device, {
        label: 'lightVolume.vert',
        code: LIGHT_VOLUME_VERT_WGSL,
      }),
      entryPoint: 'main',
      /*
       * The mesh's own interleaved layout, not a four-attribute one. This shader reads
       * locations 0 to 3, and the pipeline still has to describe every buffer the draw sets —
       * the depth pass has the same shape with one attribute.
       */
      buffers: vertexBufferLayouts(present),
    },
    fragment: {
      module: shaderModule(device, {
        label: `lightVolume.frag:${variant}`,
        code: LIGHT_VOLUME_FRAG_WGSL[variant] ?? '',
      }),
      entryPoint: 'main',
      targets: [
        {
          format: cache.format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
            alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
          },
        },
      ],
    },
    primitive: { topology: 'triangle-list', cullMode },
    multisample: { count: cache.sampleCount },
    depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: DEPTH_COMPARE },
  }));
}

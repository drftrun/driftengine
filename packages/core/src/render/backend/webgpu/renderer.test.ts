import { DEPTH_FORMAT, REVERSED_DEPTH } from '../../depthConvention.ts';
import { describe, expect, it, vi } from 'vitest';
import { mat4, vec4 } from 'gl-matrix';

import { maskOf, resourceBit } from '../../frame/index.ts';
import { nodeCount } from '../../frame/arena.ts';
import { DEPTH_CUTOUT_VERT_FIELDS, DEPTH_VERT_FIELDS } from './depthPass.ts';
import { flatFragmentBindings, flatVariant, flatVertexBindings } from './flatPass.ts';
import { eyeModel, hairModel, skinModel } from '../../surfaceModel.ts';
import { lightVolumeFragmentBindings } from './lightVolumePass.ts';
import { BLOOM_PREFILTER_FIELDS, BLOOM_UPSAMPLE_FIELDS, RUSH_FRAG_FIELDS } from './postPass.ts';
import { SCATTER_DEPTH_FIELDS } from './scatterPass.ts';
import { TEXT_VERT_FIELDS } from './textPass.ts';
import { DEFAULT_TEXT_STYLE } from '../../textLayout.ts';
import { BLOOM_LEVELS, bloomLevelSizes } from '../../bloomChain.ts';
import { MAX_POINT_LIGHTS } from '../../lightBudget.ts';
import {
  resolveRenderQuality,
  type RenderQuality,
  type RenderQualityOptions,
} from '../../renderQuality.ts';
import type { GpuSurface } from './device.ts';
import type { ParticleInstances } from '../../particlePool.ts';
import { WebGPURenderer } from './renderer.ts';
import type { RendererApi } from '../api.ts';
import { WebGL2Renderer } from '../webgl2/renderer.ts';
import { recordingGl } from '../../rendererHarness.ts';
import { createLineSegments } from '../../linePoints.ts';
import { createWindField } from '../../windField.ts';
import { parseSdfFont } from '../../sdfFont.ts';
import { createMeshInstances } from '../../instances.ts';
import { createInstanceData } from '../../instancedMesh.ts';
import { DEFAULT_SDF_TEXT_STYLE } from '../../sdfTextLayout.ts';
import { Camera } from '../../camera.ts';
import { MeshBuilder } from '../../../geometry/meshBuilder.ts';
import { createEnvironment } from '../webgl2/renderer.ts';
import type { SkyColors } from '../webgl2/renderer.ts';
import { PROBE_HISTORY } from './probeBake.ts';
import {
  BAKE_FRAME,
  BAKE_HISTORY,
  BAKE_SKY_COLOUR,
  BAKE_SKY_DEEP,
  BAKE_SKY_DRAWN,
  BAKE_SKY_SUN,
  BAKE_SKY_TOP,
} from '../../shaders/gi/probeBake.wgsl.ts';
import {
  BODY_DYNAMIC,
  BODY_STATIC,
  PhysicsWorld,
  boxShape,
  createRayHit,
  fingerprintBodies,
} from '@driftengine/physics';

/**
 * A surface with no GPU behind it, whose loss can be flipped on demand.
 *
 * `limits` overrides what the stub device reports. The default is what a device gets when it
 * asks for nothing, which is what most of these tests want; a test about the environment probe
 * needs the ceiling this project's `select.ts` actually requests and this machine actually
 * grants, which is 48 sampled textures.
 */
function stubSurface(limits: Record<string, number> = {}, features: string[] = []) {
  const pass = {
    end: vi.fn(),
    setPipeline: vi.fn(),
    setBindGroup: vi.fn(),
    setVertexBuffer: vi.fn(),
    setIndexBuffer: vi.fn(),
    drawIndexed: vi.fn(),
    /* What a batch culled on the device draws with: the survivors' count is on the device. */
    drawIndexedIndirect: vi.fn(),
    draw: vi.fn(),
    /* An inset points both of these at its rectangle and `endInset` puts them back. */
    setViewport: vi.fn(),
    setScissorRect: vi.fn(),
    setBlendConstant: vi.fn(),
  };
  /* A compute pass records nothing but a pipeline, a bind group and a dispatch. */
  const computePass = {
    end: vi.fn(),
    setPipeline: vi.fn(),
    setBindGroup: vi.fn(),
    dispatchWorkgroups: vi.fn(),
  };
  const encoder = {
    /* Typed, so the descriptor a test reads back is not inferred as a zero-argument call. */
    beginRenderPass: vi.fn((_descriptor: GPURenderPassDescriptor) => pass),
    beginComputePass: vi.fn((_descriptor?: GPUComputePassDescriptor) => computePass),
    /* The temporal resolve copies its result back over the scene and a reconstruction keeps the
       previous depth the same way; neither had a test until reconstruction landed. */
    copyTextureToTexture: vi.fn(),
    /* The pair a measured pass resolves its stamps through. Only reached with `timestamp-query`. */
    resolveQuerySet: vi.fn(),
    copyBufferToBuffer: vi.fn(),
    finish: vi.fn(() => ({ label: 'commands' })),
  };
  /* The swap-chain image, whose size is the canvas' rather than a descriptor's. */
  const texture = {
    width: 640,
    height: 480,
    createView: vi.fn(() => ({ label: 'view' })),
    destroy: vi.fn(),
  };
  /*
   * A created texture reports the size it was asked for.
   *
   * It used to report 320x240 whatever the descriptor said, which is fine for a test that only
   * needs a handle back and wrong for one that reads a byte figure off an attachment. Anything
   * derived from a size was measuring the stub.
   */
  const createTexture = vi.fn((descriptor: GPUTextureDescriptor) => {
    const size = descriptor.size as number[];
    return {
      /* Its own label, so a copy between two of them can be read back as what it copied. */
      label: descriptor.label ?? '',
      width: size[0] ?? texture.width,
      height: size[1] ?? texture.height,
      createView: vi.fn(() => ({ label: descriptor.label ?? 'view' })),
      destroy: vi.fn(),
    };
  });
  /*
   * Enough of a device for a constructor that now builds a bind group layout, a uniform
   * ring, a frame buffer, a stand-in albedo and a sampler. Stubbed rather than mocked to a
   * contract: what these tests assert is the frame lifecycle, and the resources exist only
   * so the constructor can run at all.
   */
  const device = {
    /*
     * Error scopes, which a real device has and this stub did not.
     *
     * `probeReadback.ts` wraps its whole recording in one, because a WebGPU validation failure is
     * reported at `submit` rather than at the call that caused it and would otherwise be silence.
     * Without these the readback threw here and the warning it prints on failure was appearing in
     * the middle of an unrelated passing test, which is exactly the kind of noise that trains
     * people to stop reading test output.
     */
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(async () => null),
    /*
     * What the device granted, which a real one always reports and this stub did not.
     *
     * Empty by default, so everything that asks takes its unmeasured path — which is what
     * `gpuTimer.ts` says an unmeasured frame looks like. The field composer asked first and got
     * `undefined.has`. A test that wants the measured path names the feature it wants.
     */
    features: new Set<string>(features),
    createCommandEncoder: vi.fn(() => encoder),
    /* Only reached when `features` names `timestamp-query`, which a test asks for explicitly. */
    createQuerySet: vi.fn((descriptor: GPUQuerySetDescriptor) => ({
      label: descriptor.label ?? '',
      destroy: vi.fn(),
    })),
    createBindGroupLayout: vi.fn(() => ({ label: 'layout' })),
    createPipelineLayout: vi.fn(() => ({ label: 'pipelineLayout' })),
    /* Its own label, so a pass can be asked which of two groups over the same layout it bound. */
    createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => ({
      label: descriptor.label ?? 'bindGroup',
    })),
    /* Labelled, so a test can tell one uniform ring's upload from another's. */
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => ({
      label: descriptor.label,
      destroy: vi.fn(),
    })),
    /* Typed for the same reason `beginRenderPass` is: an untyped stub records no arguments. */
    createTexture,
    createSampler: vi.fn(() => ({ label: 'sampler' })),
    createShaderModule: vi.fn(() => ({ label: 'module' })),
    /*
     * Typed so the descriptor is recorded; a test reads the cull mode back off it.
     *
     * **It carries its own descriptor**, because the rule WebGPU enforces is about a pipeline
     * *and the pass it is set on*, and only the object handed to `setPipeline` connects the two.
     * A real `GPURenderPipeline` is opaque and a test cannot do this; the device can, which is
     * the half being stood in for.
     */
    createRenderPipeline: vi.fn((descriptor: GPURenderPipelineDescriptor) => ({
      label: descriptor.label ?? 'pipeline',
      descriptor,
      /* Real pipelines answer this, and any code path that rebuilds a bind group asks it. */
      getBindGroupLayout: vi.fn(() => ({ label: 'implicit-layout' })),
    })),
    createComputePipeline: vi.fn((descriptor: GPUComputePipelineDescriptor) => ({
      label: descriptor.label ?? 'computePipeline',
      getBindGroupLayout: vi.fn(() => ({ label: 'implicit-layout' })),
    })),
    queue: {
      submit: vi.fn(),
      writeBuffer: vi.fn(),
      writeTexture: vi.fn(),
      copyExternalImageToTexture: vi.fn(),
    },
    /* A real device always reports these, and the probe sizes its cube against them. */
    limits: {
      maxTextureDimension2D: 8192,
      /* Sixteen each, which is WebGPU's own default. This machine's adapter offers 48 sampled
         textures and exactly 16 samplers, and `select.ts` asks for both ceilings. */
      maxSampledTexturesPerShaderStage: 16,
      maxSamplersPerShaderStage: 16,
      ...limits,
    },
  };
  let lost = false;
  /* Enough canvas for the measurements a scene reads: drawing buffer and CSS box differ. */
  const canvas = {
    width: 640,
    height: 480,
    /* CSS box and drawing buffer differ on purpose; `sizeCanvas` sets both when a test needs
       them to agree, which anything reading a byte figure off an attachment does. */
    clientWidth: 320,
    clientHeight: 240,
    /* An inset is handed a page rectangle and measures it against the canvas' own box. */
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 240 }),
  } as unknown as HTMLCanvasElement;
  const surface = {
    device: device as unknown as GPUDevice,
    context: { getCurrentTexture: vi.fn(() => texture), canvas } as unknown as GPUCanvasContext,
    canvas,
    format: 'bgra8unorm' as GPUTextureFormat,
    get lost() {
      return lost;
    },
    onLost: vi.fn(),
    configure: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    surface: surface as unknown as GpuSurface,
    device,
    encoder,
    pass,
    computePass,
    canvas,
    /*
     * Put the drawing buffer and the CSS box at the same size.
     *
     * `beginFrame` allocates the frame's depth from `canvas.width`, and `resize` allocates the
     * mirror from `clientWidth` — so setting only one gives a frame whose attachments disagree
     * about how big it is, and any figure read off them is measuring the stub.
     */
    sizeCanvas: (width: number, height: number) => {
      const c = canvas as unknown as Record<string, unknown>;
      c.width = width;
      c.height = height;
      c.clientWidth = width;
      c.clientHeight = height;
    },
    markLost: () => {
      lost = true;
    },
  };
}

/** The least camera and environment `bindMeshPass` reads, so a test can watch what it writes. */
function stubScene() {
  return {
    camera: {
      viewProjection: mat4.create(),
      /* The sky unprojects its own NDC through this, so a stub without it throws there. */
      invViewProjection: mat4.create(),
      /*
       * The projection on its own, which occlusion inverts to carry a depth back to metres.
       *
       * A real `Camera` has always had it and this stub did not, so `runOcclusion` threw the
       * moment a test reached it — which no test did, because `ambientOcclusion` defaults to 0
       * and nothing here overrode it. That is the same hole the effect's missing blur lived in.
       * A perspective rather than an identity: inverting the identity is defined and meaningless.
       */
      projection: mat4.perspective(mat4.create(), Math.PI / 3, 16 / 9, 0.1, 500),
      /* The view on its own, which every pass now writes beside the frustum: a surface overlay's
         rim finds its place on the screen through the two, clustered or not. */
      view: mat4.create(),
      position: new Float32Array([0, 0, 0]),
    } as never,
    env: {
      directionalDir: new Float32Array([0, 1, 0]),
      directionalColor: new Float32Array([1, 1, 1]),
      ambient: new Float32Array([0.1, 0.1, 0.1]),
      ambientGround: new Float32Array([0.1, 0.1, 0.1]),
      shadowDepthSpan: 132,
      shadowStrength: 0.9,
      /* `Atmosphere` requires these; `bindMeshPass` resolves the medium from them. */
      fogColor: new Float32Array([0.5, 0.6, 0.7]),
      fogDensity: 0.02,
      fogHeightFalloff: 0.1,
      fogBaseY: 0,
      underwater: null,
      /* The material and grading terms `bindMeshPass` carries across from the environment. */
      emissiveGain: 0.25,
      nightFactor: 0.5,
      highlightMin: new Float32Array([0.1, 0.2, 0.3]),
      highlightMax: new Float32Array([0.7, 0.8, 0.9]),
      highlightGain: 1.5,
    } as never,
  };
}

/**
 * The permutation the renderer builds for a profile, derived the way it derives it.
 *
 * Named rather than written out, because the answer moved once: this file asked for
 * `directionalShadows` while the renderer had begun choosing `directionalShadows+pointShadows`
 * from the same profile, and every offset read after that landed in the wrong field. The test
 * failed with `expected NaN to be 1`, which is the right failure and an obscure one.
 */
function variantFor(quality: ReturnType<typeof resolveRenderQuality>): string {
  return flatVariant({
    directionalShadows: quality.directionalShadows,
    environmentProbe: false,
    nightEmissive: quality.nightEmissive,
    pointShadows: quality.pointShadows,
  });
}

/**
 * One triangle through the renderer's own `createMesh`, so the pipeline it draws with exists.
 *
 * `drawMesh` looks its pipeline up by key and throws when it is missing, deliberately —
 * `createMesh` is what builds it, and a draw of geometry that never went through it is a bug
 * rather than a case to handle. So a test that draws has to create.
 */
function stubMesh(renderer: WebGPURenderer) {
  return renderer.createMesh({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
    colors: new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]),
    emissive: new Float32Array([0, 0, 0]),
    indices: new Uint32Array([0, 1, 2]),
  } as never);
}

/** One live particle, which is all `drawParticles` needs to record a draw. */
function oneParticle(): ParticleInstances {
  return {
    positions: new Float32Array([0, 0, 0]),
    sizes: new Float32Array([1]),
    spins: new Float32Array([0]),
    colors: new Float32Array([1, 1, 1]),
    alphas: new Float32Array([1]),
    ages: new Float32Array([0]),
    seeds: new Float32Array([0]),
    velocities: new Float32Array([0, 0, 0]),
    count: 1,
    capacity: 1,
  };
}

/** The last upload a named ring made, so a test reads the buffer it means. */
function ringUpload(
  device: { queue: { writeBuffer: { mock: { calls: unknown[][] } } } },
  label: string,
): ArrayBuffer {
  const upload = device.queue.writeBuffer.mock.calls
    .filter((call) => (call[0] as { label?: string }).label === label)
    .at(-1);
  return upload?.[2] as ArrayBuffer;
}

/**
 * The material block as the device receives it, which now takes a draw to exist.
 *
 * **`bindMeshPass` no longer uploads it.** The block carries material state, a material changes
 * between draws, and one buffer rewritten mid-frame gives every draw the last write — so it is
 * a ring, filled when a draw takes a slot and uploaded once at flush. These tests assert the
 * same values they always did; the only thing that moved is where they are read from.
 */
function materialBlock(
  renderer: WebGPURenderer,
  device: { queue: { writeBuffer: { mock: { calls: unknown[][] } } } },
): ArrayBuffer {
  const mesh = stubMesh(renderer);
  renderer.beginFrame([0, 0, 0]);
  renderer.drawMesh(mesh, mat4.create());
  renderer.endFrame();
  return ringUpload(device, 'flat.fragRing');
}

/**
 * A renderer whose construction has been forgotten, so a test can count the *frame*.
 *
 * The constructor legitimately records GPU work now: it clears the directional shadow maps
 * once, because a WebGPU texture no pass has written holds undefined contents and a scene is
 * entitled to enable shadows and never open a pass. Every assertion below is about the frame
 * lifecycle, so the one-time setup is cleared away rather than counted — loosening the counts
 * instead would stop them noticing a second frame pass appearing.
 */
function freshRenderer(
  stub: ReturnType<typeof stubSurface>,
  quality?: RenderQuality,
): WebGPURenderer {
  const renderer =
    quality === undefined
      ? new WebGPURenderer(stub.surface)
      : new WebGPURenderer(stub.surface, quality);
  stub.device.createCommandEncoder.mockClear();
  stub.device.queue.submit.mockClear();
  stub.encoder.beginRenderPass.mockClear();
  stub.encoder.finish.mockClear();
  stub.pass.end.mockClear();
  return renderer;
}

/**
 * Every colour target the world is drawn into, by the label its descriptor carries.
 *
 * By label because that is what a validation message names, so a failure here reads in the same
 * words the device would have used. Depth attachments and the composite's own intermediates are
 * absent deliberately: no pipeline built from a mesh writes to any of them.
 */
const WORLD_TARGETS = new Set([
  'post.sceneColor',
  'post.sceneColorMsaa',
  'flat.colorMsaa',
  'reflection.color',
  'reflection.colorMsaa',
  'probe.cube',
]);

type StubDevice = ReturnType<typeof stubSurface>['device'];

function worldTargets(device: StubDevice): { label: string; format: string }[] {
  return device.createTexture.mock.calls
    .map(([descriptor]) => descriptor)
    .filter((descriptor) => WORLD_TARGETS.has(descriptor.label ?? ''))
    .map((descriptor) => ({ label: descriptor.label ?? '', format: String(descriptor.format) }));
}

/**
 * What a mesh pipeline was built to write.
 *
 * Found by key rather than by position: `createMesh` names it `<variant>|flat` and appends one
 * segment per optional attribute the data supplied, so the prefix is the only stable part.
 */
function meshTargetFormat(device: StubDevice): string {
  const pipeline = device.createRenderPipeline.mock.calls
    .map(([descriptor]) => descriptor)
    .find((descriptor) => (descriptor.label ?? '').includes('|flat'));
  return String([...(pipeline?.fragment?.targets ?? [])][0]?.format);
}

/**
 * The material ceiling, read off the renderer rather than written down beside it.
 *
 * **Both tests below used to hardcode 256, and both stopped testing what they are named for the
 * day that ceiling became 1024.** They kept passing: 257 draws against a 1024-slot ring never
 * reaches the null return, and the restore they assert happens on the ordinary path too. Measured
 * before this was changed — 257 slots taken of 1024.
 *
 * Reading the number from the budget means a future raise cannot unhook them again, and it is the
 * budget's first use in this suite: the reason it exists is that this ceiling was unobservable
 * from outside, and a test that could not see it either is the same defect one layer down.
 */
function materialCeiling(renderer: WebGPURenderer): number {
  const line = renderer.frameBudget.lines.find((entry) => entry.name === 'materials');
  if (line?.ceiling == null) throw new Error('no material ceiling to drive to');
  return line.ceiling;
}

describe('the webgpu renderer', () => {
  it('says which backend it is', () => {
    const { surface } = stubSurface();
    const renderer = new WebGPURenderer(surface);
    expect(renderer.rendererName).toMatch(/webgpu/i);
  });

  /*
   * **Text after `endFrame`, with nothing else on the overlay.**
   *
   * `canDraw` says in as many words that "after `endFrame` an overlay pass can still be opened",
   * and `openPass` implements it: past `framePresented` it makes a fresh encoder and opens the
   * overlay. `openTextPass` never reached that — it read the encoder `endFrame` had already
   * nulled and returned — so text drawn after the frame was a **silent no-op on WebGPU** and
   * drew normally on WebGL2, which has no encoder to miss.
   *
   * It hid for as long as it did because it is invisible whenever anything else has already
   * opened the overlay. `demo/dev/overlay.ts` draws an inset beside its label, so the engine's
   * own after-`endFrame` demo always had one and always looked right. A consumer whose overlay
   * is text and nothing else got no text and no warning.
   *
   * So this draws text and nothing else, which is the case that was broken.
   */
  it('opens an overlay for text drawn after the frame, with nothing else on it', () => {
    const stub = stubSurface();
    const { device } = stub;
    const renderer = freshRenderer(stub);

    renderer.beginFrame([0, 0, 0]);
    renderer.endFrame();
    const encodersBefore = device.createCommandEncoder.mock.calls.length;

    const text = renderer.createText();
    renderer.setText(text, 'AFTER');
    renderer.drawText(text, 640, 480, 10, 10, { ...DEFAULT_TEXT_STYLE, alpha: 1 }, 0);

    expect(
      device.createCommandEncoder.mock.calls.length,
      'the overlay needs an encoder of its own, and endFrame left none',
    ).toBeGreaterThan(encodersBefore);
  });

  it('clears and presents a frame', () => {
    const stub = stubSurface();
    const { device, encoder, pass } = stub;
    const renderer = freshRenderer(stub);

    renderer.beginFrame([0.1, 0.2, 0.3]);
    renderer.endFrame();

    /*
     * **Two passes, and that is what a frame is now.** The world lands in the scene target and
     * the composite puts it on the canvas — `screenEffects` is on by default, so this is the
     * ordinary path rather than an option. One submission still, because both are recorded into
     * the frame's own encoder.
     */
    expect(encoder.beginRenderPass).toHaveBeenCalledTimes(2);
    expect(pass.end).toHaveBeenCalledTimes(2);
    expect(device.queue.submit).toHaveBeenCalledTimes(1);
    expect(renderer.framePresented).toBe(true);
  });

  /**
   * **A pipeline's colour target must match the attachment's format exactly, and WebGPU says so
   * at `finish` rather than at the draw** — so a disagreement invalidates the whole command
   * buffer and the frame is dropped entire, with nothing on the canvas to say why.
   *
   * That is one bug and it had two faces. The pipelines were built against the *swap chain's*
   * format while the world lands in the scene target, which is `rgba8unorm` under a composite
   * and `rgba16float` with `hdrScene`. The two agreed only by coincidence on the development
   * machine, whose `getPreferredCanvasFormat()` is `rgba8unorm` — measured — so `hdrScene` read
   * as a broken effect while every `bgra8unorm` device in the world drew nothing at all with the
   * default profile.
   *
   * Every target below is somewhere the *same* mesh pipelines write, which is why one format
   * has to serve all of them: the scene target, its multisampled twin, the canvas twin, and the
   * mirror the water draws the world into a second time.
   */
  it('draws the world into targets its own pipelines were built against', () => {
    /* Every combination that moves one of these formats: the composite, the range it keeps, and
       the multisampled twins, over a surface whose format is neither of the scene target's. */
    for (const asked of [
      { screenEffects: true, hdrScene: false },
      { screenEffects: true, hdrScene: true },
      { screenEffects: true, hdrScene: true, sceneSamples: 4, planarReflections: true },
      { screenEffects: false, sceneSamples: 4 },
    ]) {
      const stub = stubSurface();
      const renderer = new WebGPURenderer(stub.surface, resolveRenderQuality(asked));
      const mesh = stubMesh(renderer);
      renderer.beginFrame([0, 0, 0]);
      renderer.drawMesh(mesh, mat4.create());
      renderer.endFrame();

      const written = worldTargets(stub.device);
      expect(written.length).toBeGreaterThan(0);
      for (const target of written) {
        /* Labelled on both sides of the comparison, because the failure worth reading is
         *which* target disagreed rather than that some format was not another. */
        expect(`${target.label} ${target.format}`).toBe(
          `${target.label} ${meshTargetFormat(stub.device)}`,
        );
      }
    }
  });

  /**
   * **Bloom is a pyramid, and a pyramid of one level is a threshold with no blur in it.**
   *
   * This backend ran the prefilter and stopped. It compiled, it validated, and it drew a
   * picture — a thresholded frame at half resolution, read bilinearly — which is why nothing
   * caught it until the effect was finally measured against the other backend: 7,512 pixels
   * moved on night-court against WebGL2's 47,574, and the whole glare was missing.
   *
   * Counted rather than eyeballed, and counted off the pass labels, because the stages differ
   * only in which texture they read: prefilter, then down to the smallest level, then back up
   * adding each octave into the one above it.
   */
  /**
   * **The occlusion blur is half the estimate, not a polish pass over it.**
   *
   * `ambientOcclusion.ts` designs the two together: twelve taps turned by a rotation that
   * repeats over a 4×4 tile, and a four-wide blur that averages all sixteen turns back into one
   * answer. So the estimate alone is not a rougher occlusion, it is a quarter of one, and it
   * reads as the salt and pepper that file names.
   *
   * This backend ran the estimate and stopped — `AO_BLUR_FRAG_WGSL` imported and never called,
   * under a `runOcclusion` whose own comment said "then a blur across it". It compiled,
   * validated and drew a plausible picture, exactly like the bloom pyramid above, and it was
   * reported from both consumers as a fine grain before any measurement found it: 41,106
   * speckled pixels on `gilded-chamber` under a consumer's grade against WebGL2's 28,107,
   * 25,939 once the blur ran.
   *
   * Counted off pass labels for the same reason bloom is: the two directions differ only in
   * which target they read, and both have to happen or the pattern survives along one axis.
   */
  it('blurs the occlusion estimate across and down, not only across', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({ ambientOcclusion: 0.85, hdrScene: true }),
    );
    const { camera, env } = stubScene();

    renderer.beginFrame([0, 0, 0]);
    /* Occlusion is guarded on a settled projection — an estimate built on an identity one
       samples the depth of a scene nobody drew — so the mesh pass has to have run. */
    renderer.bindMeshPass(camera, env);
    renderer.endFrame();

    const passes = stub.encoder.beginRenderPass.mock.calls
      .map(([descriptor]) => String(descriptor.label ?? ''))
      .filter((label) => label.startsWith('post.ao'));
    expect(passes).toEqual(['post.ao', 'post.aoBlurAcross', 'post.aoBlurDown']);

    /* Its own scratch target, because the second direction reads what the first wrote and a
       pass cannot sample the attachment it is writing. */
    const targets = stub.device.createTexture.mock.calls
      .map(([descriptor]) => String(descriptor.label ?? ''))
      .filter((label) => label.startsWith('post.ao'));
    expect(targets.sort()).toEqual(['post.ao', 'post.aoScratch']);
  });

  /**
   * A reconstruction draws the world small and lets the composite enlarge it.
   *
   * **The split is the whole of this change**: everything before the resolve is the render size and
   * everything after it is the drawing buffer's. Getting one target on the wrong side of the line
   * does not fail — the device accepts it, and the picture comes out with a piece of it at the
   * wrong scale, which reads as a driver fault.
   */
  it('DRAWS THE SCENE AT THE RECONSTRUCTION SIZE while the swap chain keeps the drawing buffer', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({ screenEffects: true, reconstruction: 1.5 }),
    );
    renderer.beginFrame([0, 0, 0]);
    renderer.endFrame();

    const sized = (label: string): number[] | undefined =>
      stub.device.createTexture.mock.calls
        .map(([descriptor]) => descriptor)
        .find((descriptor) => descriptor.label === label)?.size as number[] | undefined;

    /* 640 by 480 over 1.5, each axis rounded up on its own: 427 by 320. */
    for (const label of ['post.sceneColor', 'flat.depth', 'post.ao']) {
      expect(sized(label)?.slice(0, 2), label).toEqual([427, 320]);
    }
    /*
     * **The blended draws are on the far side of the line.** They are drawn after the upscale, so
     * the picture a pane refracts and the pair an order-independent set accumulates into are the
     * drawing buffer's size, like the reconstructed picture they read and land on.
     */
    for (const label of ['refract.snapshot', 'post.oitAccum', 'post.oitReveal']) {
      expect(sized(label)?.slice(0, 2), label).toEqual([640, 480]);
    }
    /* The canvas is untouched, which is what the composite draws into. */
    expect(stub.surface.canvas.width).toBe(640);
    expect(stub.surface.canvas.height).toBe(480);
  });

  /*
   * **The overlay is on the far side of the resolve**, so its depth is the drawing buffer's. It was
   * sized from the scene's depth, which a reconstruction draws small: the device refused a depth of
   * 427 by 320 beside a swap image of 640 by 480, every overlay command buffer came back invalid,
   * and a load screen or any interface drawn after `endFrame` vanished whenever reconstruction was
   * on. Found by a scene turning reconstruction on for the first time.
   */
  /*
   * **A cut is a new shot, and nothing temporal may carry the last one into it.** The motion blur
   * and the temporal resolve both reproject through the previous frame's view, so a transport that
   * seeks, a respawn or an edit smeared the first frame of the new view along the whole jump. The
   * renderer cannot tell a cut from a fast camera; the caller can, and `cameraCut` is how it says.
   */
  it('A CAMERA CUT LEAVES THE NEXT FRAME UNSMEARED, and the one after it blurs again', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({ screenEffects: true, cameraMotionBlur: 1 }),
    );
    const { camera, env } = stubScene();
    const mesh = stubMesh(renderer);
    const view = (camera as unknown as { viewProjection: mat4 }).viewProjection;
    const frame = (x: number): void => {
      mat4.fromTranslation(view, [x, 0, 0]);
      renderer.beginFrame([0, 0, 0]);
      renderer.bindMeshPass(camera, env);
      renderer.drawMesh(mesh, mat4.create());
      renderer.endFrame();
    };
    const strength = (): number => {
      const floats = new Float32Array(ringUpload(stub.device, 'post.rushUniforms'));
      return floats[(RUSH_FRAG_FIELDS['uMotionStrength']?.offset ?? -4) / 4] as number;
    };

    frame(0);
    frame(0.5);
    expect(strength(), 'a camera with a previous frame is blurred').toBe(1);
    renderer.cameraCut();
    frame(100);
    expect(strength(), 'the frame after a cut is not').toBe(0);
    frame(100.5);
    expect(strength(), 'and the one after that is again').toBe(1);
  });

  /*
   * **A lens and a print, reaching the composite.** Two uniforms added to a shader are two
   * uniforms a backend can forget to bind, and an unbound one is zero, which for these is off: the
   * failure would be a setter that does nothing on one backend with no error anywhere.
   */
  /**
   * **The occlusion is read where the frame's jitter put it.** It is measured from the jittered
   * depth and applied to a picture the resolve has taken the jitter out of, so read at the pixel's
   * own uv every crevice moved by the jitter each frame: at full strength a still tower view went
   * from 1,098 changing pixels between frames to 797 under the reconstruction, and 713 to 437 under
   * the temporal resolve. The signs were measured as well as derived — the other x sign took the
   * reconstruction to 1,531. A texel stands at its index plus a half less the jitter.
   */
  it('READS THE OCCLUSION A JITTER ON, in each resolve’s own convention', () => {
    const run = (quality: Parameters<typeof resolveRenderQuality>[0]) => {
      const stub = stubSurface();
      const renderer = freshRenderer(stub, resolveRenderQuality(quality));
      const { camera, env } = stubScene();
      const mesh = stubMesh(renderer);
      renderer.beginFrame([0, 0, 0]);
      renderer.bindMeshPass(camera, env);
      renderer.drawMesh(mesh, mat4.create());
      renderer.endFrame();
      const floats = new Float32Array(ringUpload(stub.device, 'post.rushUniforms'));
      const at = (RUSH_FRAG_FIELDS['uAoOffset']?.offset ?? -4) / 4;
      const inner = renderer as unknown as {
        reconJitter: Float32Array;
        temporalJitterX: number;
        temporalJitterY: number;
        renderWidth: number;
        renderHeight: number;
      };
      return { offset: [floats[at], floats[at + 1]], inner };
    };
    /* The reconstruction's y is given upward and negated into the corrected matrix. */
    const recon = run({ screenEffects: true, reconstruction: 1.5, ambientOcclusion: 0.5 });
    const r = recon.inner;
    expect(r.reconJitter[0], 'a frame with a jitter to take out').not.toBe(0);
    expect(recon.offset[0]).toBeCloseTo((r.reconJitter[0] as number) / r.renderWidth, 6);
    expect(recon.offset[1]).toBeCloseTo(-(r.reconJitter[1] as number) / r.renderHeight, 6);
    /* The temporal resolve's goes in as it is. */
    const taa = run({ screenEffects: true, temporalAa: true, ambientOcclusion: 0.5 });
    const t = taa.inner;
    expect(t.temporalJitterX, 'a frame with a jitter to take out').not.toBe(0);
    expect(taa.offset[0]).toBeCloseTo(t.temporalJitterX / t.renderWidth, 6);
    expect(taa.offset[1]).toBeCloseTo(t.temporalJitterY / t.renderHeight, 6);
    /* And an unjittered frame reads it where it is. */
    const still = run({ screenEffects: true, temporalAa: false, ambientOcclusion: 0.5 });
    expect(still.offset).toEqual([0, 0]);
  });

  it('HANDS THE VIGNETTE AND THE GRAIN TO THE COMPOSITE, and 0 takes them away again', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub, resolveRenderQuality({ screenEffects: true }));
    const { camera, env } = stubScene();
    const mesh = stubMesh(renderer);
    const frame = (): Float32Array => {
      renderer.beginFrame([0, 0, 0]);
      renderer.bindMeshPass(camera, env);
      renderer.drawMesh(mesh, mat4.create());
      renderer.endFrame();
      return new Float32Array(ringUpload(stub.device, 'post.rushUniforms'));
    };
    const read = (floats: Float32Array, name: string, index = 0): number =>
      floats[(RUSH_FRAG_FIELDS[name]?.offset ?? -4) / 4 + index] as number;

    renderer.setVignette(0.5);
    renderer.setFilmGrain(0.03, 7.9);
    const on = frame();
    expect(read(on, 'uVignette')).toBeCloseTo(0.5, 6);
    expect(read(on, 'uGrain', 0)).toBeCloseTo(0.03, 6);
    expect(read(on, 'uGrain', 1), 'the seed as a whole number a float carries exactly').toBe(7);

    renderer.setVignette(0);
    renderer.setFilmGrain(0, 7);
    const off = frame();
    expect(read(off, 'uVignette')).toBe(0);
    expect(read(off, 'uGrain', 0)).toBe(0);
  });

  /*
   * **Eye adaptation, metered in the frame and handed to the composite.** The meter and the
   * adaptation are recorded into the frame's own encoder, before the composite that reads them; a
   * separate submission would run before the frame that draws the scene it is meant to measure.
   */
  it('ADAPTS THE EXPOSURE WHEN ASKED, easing frame to frame, and a cut snaps it', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({ screenEffects: true, hdrScene: true }),
    );
    const { camera, env } = stubScene();
    const mesh = stubMesh(renderer);
    const labels = (): string[] =>
      stub.encoder.beginRenderPass.mock.calls.map((call) => String(call[0]?.label ?? ''));
    const frame = (): { rush: Float32Array; blend: number; passes: string[] } => {
      stub.encoder.beginRenderPass.mockClear();
      renderer.beginFrame([0, 0, 0]);
      renderer.bindMeshPass(camera, env);
      renderer.drawMesh(mesh, mat4.create());
      renderer.endFrame();
      const uniforms = ringUpload(stub.device, 'exposure.uniforms');
      return {
        rush: new Float32Array(ringUpload(stub.device, 'post.rushUniforms')),
        blend: uniforms === undefined ? Number.NaN : (new Float32Array(uniforms)[0] as number),
        passes: labels(),
      };
    };
    const strength = (floats: Float32Array): number =>
      floats[(RUSH_FRAG_FIELDS.uAutoExposure?.offset ?? -4) / 4] as number;

    const none = frame();
    expect(none.passes).not.toContain('exposure.meter');
    expect(strength(none.rush)).toBe(0);

    renderer.setAutoExposure(1, 1 / 60);
    const first = frame();
    expect(first.passes.indexOf('exposure.meter')).toBeGreaterThanOrEqual(0);
    expect(first.passes.indexOf('exposure.adapt')).toBeGreaterThan(
      first.passes.indexOf('exposure.meter'),
    );
    expect(first.passes.indexOf('post.composite')).toBeGreaterThan(
      first.passes.indexOf('exposure.adapt'),
    );
    expect(strength(first.rush)).toBe(1);
    expect(first.blend, 'nothing held yet: the first frame snaps').toBe(1);
    /* 1 - e^(-1.5 / 60) = 0.024690. */
    expect(frame().blend).toBeCloseTo(0.02469, 5);
    renderer.cameraCut();
    expect(frame().blend, 'a cut is a new shot, metered afresh').toBe(1);

    renderer.setAutoExposure(0, 1 / 60);
    const off = frame();
    expect(off.passes).not.toContain('exposure.meter');
    expect(strength(off.rush)).toBe(0);
  });

  /*
   * **Local exposure, in the same encoder and before the same composite.** Its grid is drawn beside
   * the meter, and the held brightness is kept whether or not the frame as a whole adapts, because
   * each region is moved relative to it.
   */
  it('DRAWS THE LOCAL EXPOSURE GRID WHEN ASKED, with or without the eye adapting', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({ screenEffects: true, hdrScene: true }),
    );
    const { camera, env } = stubScene();
    const mesh = stubMesh(renderer);
    const frame = (): { local: number; auto: number; passes: string[] } => {
      stub.encoder.beginRenderPass.mockClear();
      renderer.beginFrame([0, 0, 0]);
      renderer.bindMeshPass(camera, env);
      renderer.drawMesh(mesh, mat4.create());
      renderer.endFrame();
      const rush = new Float32Array(ringUpload(stub.device, 'post.rushUniforms'));
      return {
        local: rush[(RUSH_FRAG_FIELDS.uLocalExposure?.offset ?? -4) / 4] as number,
        auto: rush[(RUSH_FRAG_FIELDS.uAutoExposure?.offset ?? -4) / 4] as number,
        passes: stub.encoder.beginRenderPass.mock.calls.map((call) => String(call[0]?.label ?? '')),
      };
    };

    const none = frame();
    expect(none.passes).not.toContain('exposure.local');
    expect(none.local).toBe(0);

    renderer.setLocalExposure(0.5);
    const on = frame();
    expect(on.passes.indexOf('exposure.local')).toBeGreaterThan(
      on.passes.indexOf('exposure.meter'),
    );
    expect(on.passes.indexOf('exposure.adapt'), 'the held brightness').toBeGreaterThanOrEqual(0);
    expect(on.passes.indexOf('post.composite')).toBeGreaterThan(
      on.passes.indexOf('exposure.local'),
    );
    expect(on.local).toBe(0.5);
    expect(on.auto, 'the frame as a whole is not adapted for it').toBe(0);

    renderer.setLocalExposure(0);
    const off = frame();
    expect(off.passes).not.toContain('exposure.local');
    expect(off.local).toBe(0);
  });

  it('SIZES THE OVERLAY DEPTH TO THE DRAWING BUFFER, not to the reconstruction size', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({ screenEffects: true, reconstruction: 1.5 }),
    );
    renderer.beginFrame([0, 0, 0]);
    renderer.endFrame();
    const text = renderer.createText();
    renderer.setText(text, 'AFTER');
    renderer.drawText(text, 640, 480, 10, 10, { ...DEFAULT_TEXT_STYLE, alpha: 1 }, 0);

    const overlay = stub.device.createTexture.mock.calls
      .map(([descriptor]) => descriptor)
      .find((descriptor) => descriptor.label === 'overlay.depth');
    expect(overlay, 'the overlay opened').toBeDefined();
    expect((overlay?.size as number[] | undefined)?.slice(0, 2)).toEqual([640, 480]);
  });

  it('AN INSET AFTER THE PRESENT IS MEASURED IN THE DRAWING BUFFER, and gives the whole of it back', () => {
    /*
     * The overlay draws on the swap image, which is the drawing buffer's size; a reconstruction
     * draws the scene at two thirds of it. Measured against the scene's size, an interface's inset
     * landed two thirds of the way to where it was asked for, and `endInset` left the viewport at
     * two thirds of the canvas, so everything drawn after it shrank into the top-left corner.
     */
    const stub = stubSurface();
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({ screenEffects: true, reconstruction: 1.5 }),
    );
    renderer.beginFrame([0, 0, 0]);
    renderer.endFrame();
    /* The bottom-right quarter of a 320 × 240 CSS box over a 640 × 480 buffer. */
    renderer.beginInset({ left: 160, top: 120, width: 160, height: 120 } as DOMRect, [0, 0, 0]);
    renderer.endInset();
    const calls = stub.pass.setViewport.mock.calls.map((c) => c.slice(0, 4));
    expect(calls.slice(-2)).toEqual([
      [320, 240, 320, 240],
      [0, 0, 640, 480],
    ]);
  });

  it('draws everything at the drawing buffer when no reconstruction was asked for', () => {
    /* The gate every published scene is held to: off allocates exactly what it always did. */
    const stub = stubSurface();
    const renderer = freshRenderer(stub, resolveRenderQuality({ screenEffects: true }));
    renderer.beginFrame([0, 0, 0]);
    renderer.endFrame();
    const scene = stub.device.createTexture.mock.calls
      .map(([descriptor]) => descriptor)
      .find((descriptor) => descriptor.label === 'post.sceneColor');
    expect((scene?.size as number[] | undefined)?.slice(0, 2)).toEqual([640, 480]);
  });

  it('REFUSES TO SHRINK WITHOUT A COMPOSITE, because there would be nothing to enlarge from', () => {
    /*
     * With `screenEffects` off the world draws straight into the swap chain, so a smaller render
     * size would be a smaller *picture* in the corner of the frame rather than an upscaled one.
     */
    const stub = stubSurface();
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({ screenEffects: false, reconstruction: 2 }),
    );
    renderer.beginFrame([0, 0, 0]);
    renderer.endFrame();
    const depth = stub.device.createTexture.mock.calls
      .map(([descriptor]) => descriptor)
      .find((descriptor) => descriptor.label === 'flat.depth');
    expect((depth?.size as number[] | undefined)?.slice(0, 2)).toEqual([640, 480]);
  });

  /**
   * The resolve runs, and it runs where the temporal resolve would have.
   *
   * **Two dispatches and not one**: the first writes the next history and the second sharpens it
   * into the picture that is shown, because the history holds the *unsharpened* result — sharpening
   * into the history sharpens an already sharpened picture every frame.
   */
  it('DISPATCHES THE RESOLVE AND THE SHARPEN while reconstruction is on', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({ screenEffects: true, reconstruction: 1.5 }),
    );
    const { camera, env } = stubScene();
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.endFrame();

    const compute = stub.encoder.beginComputePass.mock.calls
      .map(([descriptor]) => String(descriptor?.label ?? ''))
      .filter((label) => label.startsWith('recon.'));
    expect(compute).toEqual(['recon.resolve']);

    /* Two dispatches, and the two pipelines are the two entry points rather than one twice. */
    expect(stub.computePass.dispatchWorkgroups).toHaveBeenCalledTimes(2);
    const set = stub.computePass.setPipeline.mock.calls.map(([pipeline]) =>
      String((pipeline as { label?: string }).label ?? ''),
    );
    expect(set).toEqual(['recon.resolve', 'recon.sharpen']);

    /* Last frame's depth is kept, which is what the disocclusion tests against. */
    const copies = stub.encoder.copyTextureToTexture.mock.calls.map(([from, to]) => [
      String((from.texture as { label?: string }).label ?? ''),
      String((to.texture as { label?: string }).label ?? ''),
    ]);
    expect(copies).toContainEqual(['post.resolvedDepth', 'recon.previousDepth']);

    /*
     * **And the composite reads the resolved picture rather than the scene.** The temporal resolve
     * copies its result back over the scene target so that nothing downstream needs a second bind
     * group; across two sizes that copy cannot happen, so this group is the one it declined.
     */
    const bound = stub.pass.setBindGroup.mock.calls.map(([, group]) =>
      String((group as { label?: string }).label ?? ''),
    );
    expect(bound).toContain('recon.rushBindGroup');
    expect(bound).not.toContain('post.rushBindGroup');
  });

  /**
   * The depth the resolve reprojects through is this frame's, resolved before the resolve reads it.
   *
   * **Nothing else in the frame asked for it**, which is the case this is about. The depth survives
   * the main pass only when something after it declares that it reads it, and reconstruction was
   * missing from that list — so the attachment was discarded, the resolve read zero, and zero is
   * the far plane reversed. Every surface stood at infinity: a camera that turned reprojected
   * correctly, since a turn moves every depth alike, and a camera that slid moved nothing, so the
   * history trailed behind every slide by the parallax it never saw. Measured on a probe before
   * this line existed: a turn within a quarter of a pixel of the native frame, a slide 1.5 to 3
   * pixels behind it.
   */
  it('RESOLVES THE DEPTH BEFORE THE RESOLVE, when nothing else in the frame reads it', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({ screenEffects: true, reconstruction: 1.5 }),
    );
    const { camera, env } = stubScene();
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.endFrame();

    const order = (
      mock: { mock: { calls: unknown[][]; invocationCallOrder: number[] } },
      label: string,
    ): number => {
      const at = mock.mock.calls.findIndex(
        ([descriptor]) => (descriptor as { label?: string } | undefined)?.label === label,
      );
      return at < 0 ? -1 : (mock.mock.invocationCallOrder[at] as number);
    };
    const depth = order(stub.encoder.beginRenderPass, 'post.depthResolve');
    const resolve = order(stub.encoder.beginComputePass, 'recon.resolve');
    expect(depth).toBeGreaterThan(0);
    expect(resolve).toBeGreaterThan(depth);
  });

  /**
   * A contributed pass is handed the jitter the frame's own verbs were drawn with.
   *
   * **The resolve un-jitters every sample it takes**, so geometry a pass drew without the frame's
   * offset is placed a fraction of a render pixel from where it was, differently every frame — and
   * the GPU-driven pipeline, which draws its whole world in `prepare`, drew all of it that way.
   * `prepare` runs at `beginFrame` and the jitter used to be settled in `bindMeshPass`, after it, so
   * no pass could have had it. Settled once a frame now: a frame binding its mesh pass twice, as one
   * with an inset does, advanced the sequence twice and resolved against the second offset.
   */
  it('HANDS A PASS THE FRAME’S OWN JITTER, settled once a frame and before it prepares', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({ screenEffects: true, reconstruction: 1.5 }),
    );
    const seen: number[][] = [];
    let reconstructs: boolean | null = null;
    renderer.registerPass({
      label: 'probe',
      init(device) {
        if (device.backend === 'webgpu') reconstructs = device.reconstruction;
      },
      prepare(ctx) {
        if (ctx.backend === 'webgpu') seen.push(Array.from(ctx.jitter));
      },
      draw() {},
    });
    const { camera, env } = stubScene();
    /* The offset each frame's resolve un-jittered by, in render pixels, and the render's size —
       copied after each frame, because every frame writes from the same staging buffer. */
    const resolved: { u: Uint32Array; f: Float32Array }[] = [];
    for (let frame = 0; frame < 2; frame += 1) {
      renderer.beginFrame([0, 0, 0]);
      renderer.bindMeshPass(camera, env);
      renderer.bindMeshPass(camera, env);
      renderer.endFrame();
      const call = stub.device.queue.writeBuffer.mock.calls
        .filter(([buffer]) => String((buffer as { label?: string }).label ?? '') === 'recon.params')
        .at(-1);
      if (call === undefined) continue;
      const bytes = (call[2] as ArrayBuffer).slice(0);
      resolved.push({ u: new Uint32Array(bytes), f: new Float32Array(bytes) });
    }
    expect(resolved).toHaveLength(2);
    expect(reconstructs).toBe(true);
    for (let frame = 0; frame < 2; frame += 1) {
      const { u, f } = resolved[frame] as { u: Uint32Array; f: Float32Array };
      const jitter = seen[frame] as number[];
      /* A fraction of the clip square: two over the render's size a pixel, y upward as the
         resolve's own rows run. */
      expect(jitter[0]).toBeCloseTo((2 * (f[4] as number)) / (u[0] as number), 6);
      expect(jitter[1]).toBeCloseTo((2 * (f[5] as number)) / (u[1] as number), 6);
      expect(Math.abs(jitter[0] as number) + Math.abs(jitter[1] as number)).toBeGreaterThan(0);
    }
    /* And the sequence moved between them, once. */
    expect((resolved[1] as { f: Float32Array }).f[6]).toBe(
      (resolved[0] as { f: Float32Array }).f[4],
    );
    expect((resolved[1] as { f: Float32Array }).f[7]).toBe(
      (resolved[0] as { f: Float32Array }).f[5],
    );
  });

  it('hands a pass no jitter, and says it does not reconstruct, when nothing is reconstructed', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub, resolveRenderQuality({ screenEffects: true }));
    const seen: number[][] = [];
    let reconstructs: boolean | null = null;
    renderer.registerPass({
      label: 'probe',
      init(device) {
        if (device.backend === 'webgpu') reconstructs = device.reconstruction;
      },
      prepare(ctx) {
        if (ctx.backend === 'webgpu') seen.push(Array.from(ctx.jitter));
      },
      draw() {},
    });
    const { camera, env } = stubScene();
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.endFrame();
    expect(reconstructs).toBe(false);
    expect(seen).toEqual([[0, 0]]);
  });

  /**
   * The uniform block the resolve reads, at the offsets its struct declares.
   *
   * **A block of seventy-two floats has seventy-two chances to be one out**, and every one of them
   * is a plausible picture rather than a failure: a jitter read out of the previous jitter's slot
   * resolves against a frame half a texel from where it was, and a `hasHistory` read out of the
   * clamp's slot trusts a history on the first frame. Nothing validates a uniform's *meaning*.
   */
  it('WRITES THE RESOLVE’S PARAMETERS WHERE ITS STRUCT SAYS, and says it has no history first', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({ screenEffects: true, reconstruction: 1.5 }),
    );
    const { camera, env } = stubScene();

    const params = (): { u: Uint32Array; f: Float32Array } | null => {
      const call = stub.device.queue.writeBuffer.mock.calls
        .filter(([buffer]) => String((buffer as { label?: string }).label ?? '') === 'recon.params')
        .at(-1);
      if (call === undefined) return null;
      /* Copied, because the renderer writes from one staging buffer every frame and a view of it
         is a view of whatever the *last* frame put there. */
      const bytes = (call[2] as ArrayBuffer).slice(0);
      return { u: new Uint32Array(bytes), f: new Float32Array(bytes) };
    };

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.endFrame();
    const first = params();
    expect(first).not.toBeNull();
    /* 640 by 480 over 1.5, rounded up per axis, against the drawing buffer. */
    expect(Array.from((first as NonNullable<typeof first>).u.slice(0, 4))).toEqual([
      427, 320, 640, 480,
    ]);
    /* No history on the first frame, whatever is in the texture. */
    expect((first as NonNullable<typeof first>).u[67]).toBe(0);
    /* The disocclusion's four numbers, last, in the order the struct lists them. A hundredth is
       not a float32, so this reads them as the single-precision numbers the device gets. */
    expect(Array.from((first as NonNullable<typeof first>).f.slice(68, 72))).toEqual(
      [0.01, 0.5, 0, 0.5].map((value) => Math.fround(value)),
    );

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.endFrame();
    const second = params() as NonNullable<ReturnType<typeof params>>;
    expect(second.u[67]).toBe(1);
    /*
     * And the jitter moved, with the previous frame's kept beside it — the resolve reads both,
     * because the history was drawn at last frame's sub-pixel offset and this frame's is not it.
     */
    const firstJitter = [
      (first as NonNullable<typeof first>).f[4],
      (first as NonNullable<typeof first>).f[5],
    ];
    expect([second.f[6], second.f[7]]).toEqual(firstJitter);
    expect([second.f[4], second.f[5]]).not.toEqual(firstJitter);
  });

  /**
   * A draw that says where it was gets drawn again into the motion target.
   *
   * **And a draw that says nothing does not**, which is the property that keeps this free for every
   * scene that never moves anything: the pass still runs, because its clear is what stops last
   * frame's motion being read as this frame's, but it draws nothing.
   */
  it('DRAWS A MOVER INTO THE MOTION TARGET, and only a mover', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({ screenEffects: true, reconstruction: 1.5 }),
    );
    const { camera, env } = stubScene();
    const mesh = stubMesh(renderer);
    const model = mat4.create();
    const previous = mat4.fromTranslation(mat4.create(), [1, 0, 0]);

    const motionDraws = (): number => {
      stub.pass.drawIndexed.mockClear();
      stub.encoder.beginRenderPass.mockClear();
      return 0;
    };
    motionDraws();

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(mesh, model, 0, null, previous);
    renderer.endFrame();
    const passes = stub.encoder.beginRenderPass.mock.calls.map(([d]) => String(d.label ?? ''));
    expect(passes).toContain('recon.motion');
    /*
     * The pipeline it bound is keyed by **this mesh's** stride, which is the bug that cost the
     * afternoon: a mesh's first vertex buffer is interleaved, not positions, so a layout that
     * assumed twelve bytes read a position out of the middle of a vertex and drew geometry that
     * was not the mesh — and nothing validated it.
     */
    const bound = stub.pass.setPipeline.mock.calls.map(([p]) =>
      String((p as { label?: string }).label ?? ''),
    );
    expect(mesh.vertexStride).toBeGreaterThan(12);
    expect(bound).toContain(`recon.motion.${String(mesh.vertexStride)}`);

    /* And the next frame draws nothing, because a frame states its movers afresh. */
    stub.pass.setPipeline.mockClear();
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(mesh, model);
    renderer.endFrame();
    const after = stub.pass.setPipeline.mock.calls.map(([p]) =>
      String((p as { label?: string }).label ?? ''),
    );
    expect(after.some((label) => label.startsWith('recon.motion.'))).toBe(false);
  });

  /*
   * **A blended draw of a reconstructing frame lands after the resolve**, at the output size and
   * unjittered, rather than in the scene the resolve reconstructs: a translucent surface has no one
   * motion per pixel, so a history can only smear it. With reconstruction off nothing moves.
   */
  it('DRAWS A BLENDED MESH AFTER THE RESOLVE while reconstructing, and never otherwise', () => {
    const passesFor = (reconstruction: number): string[] => {
      const stub = stubSurface();
      const renderer = freshRenderer(
        stub,
        resolveRenderQuality({ screenEffects: true, reconstruction }),
      );
      const { camera, env } = stubScene();
      const mesh = stubMesh(renderer);
      renderer.beginFrame([0, 0, 0]);
      renderer.bindMeshPass(camera, env);
      renderer.drawTranslucentMesh(mesh, mat4.create(), 0.5);
      renderer.endFrame();
      return stub.encoder.beginRenderPass.mock.calls.map(([d]) => String(d.label ?? ''));
    };
    const on = passesFor(1.5);
    expect(on).toContain('recon.late');
    /* After the motion pass the resolve reads, and after the depth it tests against. */
    expect(on.indexOf('recon.motion')).toBeLessThan(on.indexOf('recon.late'));
    expect(on.indexOf('recon.lateDepth')).toBeLessThan(on.indexOf('recon.late'));
    expect(passesFor(0)).not.toContain('recon.late');
  });

  /*
   * **Unless it says it moves with what it lies on.** A glow on a wall, a pane in a window: its one
   * motion is the surface's, so the resolve can reconstruct it with the surface — jittered, at the
   * render size — and it never meets the late pass's question of whether a jittered edge covered
   * an unjittered pixel, which it answered differently every frame.
   */
  it('RECONSTRUCTS A TRANSLUCENT SURFACE THAT MOVES WITH WHAT IT LIES ON, rather than drawing it late', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({ screenEffects: true, reconstruction: 1.5 }),
    );
    const { camera, env } = stubScene();
    const mesh = stubMesh(renderer);
    const batch = renderer.createInstanced(mesh, 1);
    const one = createMeshInstances(1);
    one.count = 1;
    one.models.set(mat4.create());
    renderer.uploadInstanced(batch, one);
    stub.pass.drawIndexed.mockClear();
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.drawTranslucentMesh(mesh, mat4.create(), 1, { additive: true, reconstructed: true });
    renderer.drawTranslucentMesh(mesh, mat4.create(), 0.5, { reconstructed: true });
    renderer.drawTranslucentInstanced(batch, one, 0.5, { reconstructed: true });
    renderer.endFrame();
    const passes = stub.encoder.beginRenderPass.mock.calls.map(([d]) => String(d.label ?? ''));
    expect(passes, 'nothing is left for the late pass to draw').not.toContain('recon.late');
    expect(
      stub.pass.drawIndexed.mock.calls.length,
      'and all three are drawn',
    ).toBeGreaterThanOrEqual(3);
  });

  /**
   * **An empty mesh draws nothing, anywhere.** A consumer's world can hold a mesh with no triangles,
   * for a level that has none of that kind; drawn, every pass it reached issued a draw of zero
   * indices, which WebGPU answers with a warning a pass, in a console that is meant to be quiet.
   */
  it('AN EMPTY MESH DRAWS NOTHING, in the frame, as a batch, or as a shadow caster', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub, resolveRenderQuality({ screenEffects: true }));
    const { camera, env } = stubScene();
    const empty = renderer.createMesh({
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      colors: new Float32Array(0),
      emissive: new Float32Array(0),
      indices: new Uint32Array(0),
    } as never);
    const batch = renderer.createInstanced(empty, 1);
    const one = createMeshInstances(1);
    one.count = 1;
    one.models.set(mat4.create());
    renderer.uploadInstanced(batch, one);
    stub.pass.drawIndexed.mockClear();
    renderer.beginShadowPass(mat4.create(), 'static');
    renderer.drawShadowCasters((sink) => {
      sink.mesh(empty, mat4.create());
      sink.instanced?.(batch, one);
    });
    renderer.endShadowPass();
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(empty, mat4.create());
    renderer.drawTranslucentMesh(empty, mat4.create(), 0.5);
    renderer.drawInstanced(batch, one);
    renderer.endFrame();
    const nothing = stub.pass.drawIndexed.mock.calls.filter(([count]) => count === 0);
    expect(nothing.length, 'no pass is handed a draw of nothing').toBe(0);
  });

  it('runs the motion pass even when nothing moved, because its clear is what it is for', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({ screenEffects: true, reconstruction: 1.5 }),
    );
    const { camera, env } = stubScene();
    const mesh = stubMesh(renderer);
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(mesh, mat4.create());
    renderer.endFrame();
    const passes = stub.encoder.beginRenderPass.mock.calls.map(([d]) => String(d.label ?? ''));
    expect(passes).toContain('recon.motion');
    const bound = stub.pass.setPipeline.mock.calls.map(([p]) =>
      String((p as { label?: string }).label ?? ''),
    );
    expect(bound.some((label) => label.startsWith('recon.motion.'))).toBe(false);
  });

  it('REFUSES TO RECONSTRUCT A MULTISAMPLED FRAME, in words, rather than drawing it wrong', () => {
    /*
     * The motion pass draws the frame's movers again against the depth the scene left, and every
     * attachment in a pass has to agree about its sample count — so a multisampled depth would want
     * a multisampled motion target, a resolve of it, and a second set of everything downstream. It
     * is also a combination nobody should want: the accumulation *is* the antialiasing.
     */
    const stub = stubSurface();
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const renderer = freshRenderer(
        stub,
        resolveRenderQuality({ screenEffects: true, reconstruction: 1.5, sceneSamples: 4 }),
      );
      const { camera, env } = stubScene();
      renderer.beginFrame([0, 0, 0]);
      renderer.bindMeshPass(camera, env);
      renderer.endFrame();
      const passes = stub.encoder.beginRenderPass.mock.calls.map(([d]) => String(d.label ?? ''));
      expect(passes).not.toContain('recon.motion');
      expect(warned.mock.calls.map(([line]) => String(line)).join('\n')).toContain('choice of one');
      /* And the scene is drawn at the drawing buffer, not at a size nothing will enlarge. */
      const scene = stub.device.createTexture.mock.calls
        .map(([descriptor]) => descriptor)
        .find((descriptor) => descriptor.label === 'post.sceneColor');
      expect((scene?.size as number[] | undefined)?.slice(0, 2)).toEqual([640, 480]);
    } finally {
      warned.mockRestore();
    }
  });

  it('ALTERNATES THE TWO HISTORIES, because a dispatch cannot read what it is writing', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({ screenEffects: true, reconstruction: 1.5 }),
    );
    const { camera, env } = stubScene();
    const resolves: string[] = [];
    for (let frame = 0; frame < 3; frame += 1) {
      stub.computePass.setBindGroup.mockClear();
      renderer.beginFrame([0, 0, 0]);
      renderer.bindMeshPass(camera, env);
      renderer.endFrame();
      resolves.push(
        String(
          (stub.computePass.setBindGroup.mock.calls[0]?.[1] as { label?: string } | undefined)
            ?.label ?? '',
        ),
      );
    }
    expect(resolves).toEqual(['recon.resolve0', 'recon.resolve1', 'recon.resolve0']);
  });

  it('runs neither the resolve nor the temporal one when reconstruction is off', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({ screenEffects: true, temporalAa: false }),
    );
    const { camera, env } = stubScene();
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.endFrame();
    const compute = stub.encoder.beginComputePass.mock.calls
      .map(([descriptor]) => String(descriptor?.label ?? ''))
      .filter((label) => label.startsWith('recon.'));
    expect(compute).toEqual([]);
  });

  it('RECONSTRUCTION REPLACES THE TEMPORAL RESOLVE rather than running beside it', () => {
    /*
     * Both accumulate a history out of a jittered sequence. Running them together resolves the
     * frame twice — once at the render size and again at the output size, against a history whose
     * frames had already been mixed — so a consumer asking for both gets reconstruction.
     */
    const stub = stubSurface();
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({ screenEffects: true, temporalAa: true, reconstruction: 1.5 }),
    );
    const { camera, env } = stubScene();
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.endFrame();
    const taa = stub.encoder.beginRenderPass.mock.calls
      .map(([descriptor]) => String(descriptor.label ?? ''))
      .filter((label) => label === 'post.taa');
    expect(taa).toEqual([]);
  });

  it('A FRAME MAY MOVE THE BLOOM THRESHOLD, AND IT HOLDS UNTIL MOVED AGAIN', () => {
    /*
     * A threshold is in scene units and exposure is applied after it, so one fixed at construction
     * means a different brightness on screen at every exposure. A day whose exposure spans 2.5 to
     * 14 had to choose between a courtyard blooming at noon and candles never blooming at night.
     */
    const stub = stubSurface();
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({ bloom: 1, hdrScene: true, bloomThreshold: 2 }),
    );
    const at = (BLOOM_PREFILTER_FIELDS['uThreshold']?.offset ?? -1) / 4;
    const threshold = (): number | undefined => {
      const writes = stub.device.queue.writeBuffer.mock.calls.filter(
        (call) => (call[0] as { label?: string }).label === 'post.bloomUniforms',
      );
      const last = writes[writes.length - 1];
      return last === undefined ? undefined : new Float32Array(last[2] as ArrayBuffer)[at];
    };
    const frame = (): void => {
      renderer.beginFrame([0, 0, 0]);
      renderer.endFrame();
    };
    frame();
    expect(threshold(), "the profile's own threshold, until a frame says otherwise").toBe(2);
    renderer.setBloom(1, 0.25);
    frame();
    expect(threshold()).toBe(0.25);
    renderer.setBloom(0.5);
    frame();
    expect(threshold(), 'a scale alone leaves the threshold where it was').toBe(0.25);
  });

  /*
   * **A frame may say how bloom answers**: a ramp in place of the subtraction, and a tint a level.
   * The ramp is the prefilter's; the deepest level's tint is the scale on the first draw up, and
   * every other level's is the blend constant of the draw adding onto it. Asked for by a stage
   * built for another engine's bloom, whose low threshold washed the frame white under the
   * subtraction.
   */
  it('A FRAME MAY SAY HOW BLOOM ANSWERS: A RAMP, AND A TINT EACH LEVEL TAKES', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({ bloom: 1, hdrScene: true, bloomThreshold: 0.1 }),
    );
    const block = (): Float32Array => {
      const writes = stub.device.queue.writeBuffer.mock.calls.filter(
        (call) => (call[0] as { label?: string }).label === 'post.bloomUniforms',
      );
      return new Float32Array(writes[writes.length - 1]?.[2] as ArrayBuffer);
    };
    const ramp = (BLOOM_PREFILTER_FIELDS['uRamp']?.offset ?? -1) / 4;
    const scale = (BLOOM_UPSAMPLE_FIELDS['uScale']?.offset ?? -1) / 4;
    const frame = (): void => {
      stub.pass.setBlendConstant.mockClear();
      stub.encoder.beginRenderPass.mockClear();
      renderer.beginFrame([0, 0, 0]);
      renderer.endFrame();
    };
    frame();
    expect(block()[ramp], 'the subtraction, until a frame says otherwise').toBe(0);
    expect(stub.pass.setBlendConstant.mock.calls.every(([c]) => (c as number[])[0] === 1)).toBe(
      true,
    );

    const tints = [0.5, 0.5, 0.5, 1, 0, 0, 1, 1, 1, 1, 1, 1, 0.25, 0.5, 2, 0, 0, 3];
    renderer.setBloom(1, undefined, { ramp: 2, tints });
    frame();
    /* One draw down into every level past the first, so their count is the deepest level's index. */
    const deepest = stub.encoder.beginRenderPass.mock.calls.filter(
      ([d]) => String(d.label ?? '') === 'post.bloomDown',
    ).length;
    expect(deepest, 'a frame with room for a few levels').toBeGreaterThan(1);
    expect(block()[ramp]).toBe(2);
    /* Drawn up from the deepest: each constant is the tint of the level being added onto. */
    const constants = stub.pass.setBlendConstant.mock.calls.map(([c]) =>
      Array.from(c as number[]).slice(0, 3),
    );
    expect(constants.at(-1), 'level 0, the finest').toEqual([0.5, 0.5, 0.5]);
    expect(constants.at(-2), 'level 1').toEqual([1, 0, 0]);
    /* The deepest level the frame has, read by the first draw up, at the slot after the rest. */
    const slot = ((BLOOM_LEVELS + 1) * 256) / 4;
    expect(Array.from(block().subarray(slot + scale, slot + scale + 3))).toEqual(
      tints.slice(deepest * 3, deepest * 3 + 3),
    );
    expect(
      Array.from(
        block()
          .subarray((BLOOM_LEVELS * 256) / 4 + scale)
          .slice(0, 3),
      ),
    ).toEqual([1, 1, 1]);
  });

  /**
   * **A reconstruction's bloom is the resolved picture's, at the drawing buffer's size.** Read off
   * the scene target instead, it bloomed the jittered render: a lamp's bulb smaller than a render
   * texel is caught in some phases and missed in others, and its halo — wide, and over everything
   * round it — flashed with it. Measured on a night street: a panel's luma swinging 113 to 119 frame
   * to frame where the native frame held 117.
   */
  it('BLOOMS THE RESOLVED PICTURE WHILE RECONSTRUCTING, not the jittered render', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({ screenEffects: true, reconstruction: 1.5, bloom: 1, hdrScene: true }),
    );
    renderer.beginFrame([0, 0, 0]);
    renderer.endFrame();

    const level0 = stub.device.createTexture.mock.calls
      .map(([descriptor]) => descriptor)
      .filter((descriptor) => descriptor.label === 'post.bloom0')
      .at(-1);
    /* Half of 640 by 480, not half of the 427 by 320 the scene is drawn at. */
    expect(level0?.size).toEqual([320, 240]);
    const group0 = stub.device.createBindGroup.mock.calls
      .map(([descriptor]) => descriptor as GPUBindGroupDescriptor)
      .filter((descriptor) => descriptor.label === 'post.bloomGroup0')
      .at(-1);
    const sources = [...(group0?.entries ?? [])].map(
      (entry) => (entry.resource as { label?: string }).label,
    );
    expect(sources, 'the resolved picture').toContain('recon.shown');
    expect(sources).not.toContain('post.sceneColor');
    /* And the prefilter steps across the picture it reads. */
    const at = (BLOOM_PREFILTER_FIELDS['uTexel']?.offset ?? -1) / 4;
    const block = stub.device.queue.writeBuffer.mock.calls
      .filter((call) => (call[0] as { label?: string }).label === 'post.bloomUniforms')
      .at(-1);
    const texel = new Float32Array(block?.[2] as ArrayBuffer).subarray(at, at + 2);
    expect(Array.from(texel)).toEqual([Math.fround(1 / 640), Math.fround(1 / 480)]);
  });

  it('builds the whole bloom pyramid rather than only its first level', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({ bloom: 1, hdrScene: true, bloomThreshold: 0.2 }),
    );
    renderer.beginFrame([0, 0, 0]);
    renderer.endFrame();

    const bloomPasses = stub.encoder.beginRenderPass.mock.calls
      .map(([descriptor]) => String(descriptor.label ?? ''))
      .filter((label) => label.startsWith('post.bloom'));

    /*
     * The pyramid the frame's own size asks for, read off the scene target rather than off the
     * canvas: the composite is sized to the drawing buffer, and asserting against the element
     * would be asserting against a number this class never saw.
     */
    const scene = stub.device.createTexture.mock.calls
      .map(([descriptor]) => descriptor)
      .find((descriptor) => descriptor.label === 'post.sceneColor');
    const [width = 0, height = 0] = (scene?.size ?? []) as number[];
    const levels = bloomLevelSizes(width, height).length;

    /* One down each step and one back up, which is what `bloomPass.ts` runs on the other side. */
    expect(levels).toBeGreaterThan(1);
    expect(bloomPasses.length).toBe(2 * levels - 1);
  });

  /**
   * **Camera motion blur reprojects through the clip space the depth was written in.**
   *
   * `rush.ts` is generated from the GLSL the WebGL2 path uses, and it rebuilds a clip position
   * from the depth texture as `depth * 2.0 - 1.0` — right for OpenGL, whose NDC z spans −1 to 1,
   * and wrong here, where `CLIP_CORRECTION` has already put z in 0 to 1. Every pixel then
   * reprojects from a depth roughly twice as far away as it is, so the smear points the right
   * way and travels the wrong distance: measured on the probe page, WebGPU moved 39,940 pixels
   * where WebGL2 moved 21,109, and the two frames differed in 29,246 of 857,600.
   *
   * Asserted end to end rather than against the matrix's shape, because the shape is exactly
   * what was wrong: the test walks a world point through the same expression the shader uses
   * and checks it lands where that point *was*.
   */
  it("reprojects a pixel to where it was, through this clip space and not OpenGL's", () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub, resolveRenderQuality({ cameraMotionBlur: 1 }));
    const { camera, env } = stubScene();

    /*
     * WebGPU's own clip space, written out because it is the API's convention rather than this
     * renderer's choice: y the other way from OpenGL's, and z in 0 to 1 instead of −1 to 1.
     */
    const CLIP = new Float32Array([
      1,
      0,
      0,
      0,
      0,
      -1,
      0,
      0,
      /* Read from the convention rather than copied, so a change of depth sense cannot leave this
         test agreeing with itself and disagreeing with the renderer. */
      0,
      0,
      REVERSED_DEPTH ? -0.5 : 0.5,
      0,
      0,
      0,
      0.5,
      1,
    ]);
    const corrected = (view: mat4): mat4 => mat4.multiply(mat4.create(), CLIP, view);

    /* Two frames a step apart, which is the only way a reprojection has anything to say. */
    const before = mat4.perspective(mat4.create(), 1, 1.5, 0.3, 200);
    mat4.translate(before, before, [0, -1, -8]);
    const after = mat4.perspective(mat4.create(), 1, 1.5, 0.3, 200);
    mat4.translate(after, after, [-0.4, -1, -8]);

    const moving = camera as unknown as { viewProjection: mat4 };
    for (const view of [before, after]) {
      moving.viewProjection = view;
      renderer.beginFrame([0, 0, 0]);
      renderer.bindMeshPass(camera, env);
      renderer.endFrame();
    }

    const block = ringUpload(stub.device, 'post.rushUniforms');
    const floats = new Float32Array(block);
    const at = RUSH_FRAG_FIELDS['uReprojection']?.offset ?? -1;
    expect(at).toBeGreaterThanOrEqual(0);
    const reprojection = floats.slice(at / 4, at / 4 + 16) as unknown as mat4;

    /* A point the camera can see, carried through both frames' matrices by hand. */
    const world = vec4.fromValues(1.3, 0.4, -2.1, 1);
    const nowClip = vec4.transformMat4(vec4.create(), world, corrected(after));
    const wasClip = vec4.transformMat4(vec4.create(), world, corrected(before));
    const ndc = (clip: vec4): number[] => [clip[0] / clip[3], clip[1] / clip[3], clip[2] / clip[3]];
    const [x = 0, y = 0, depth = 0] = ndc(nowClip);

    /* Exactly what `cameraBlur` builds, including the remap that was wrong. */
    /* The same recovery the shader makes, and it has to be the same one: reversed depth stores
       `0.5 - 0.5z`, whose inverse is `1 - 2 * stored` and not `2 * stored - 1`. Getting this wrong
       is what this test exists to catch, and it did catch it. */
    const shaderClip = vec4.fromValues(x, y, REVERSED_DEPTH ? 1 - depth * 2 : depth * 2 - 1, 1);
    const previous = vec4.transformMat4(vec4.create(), shaderClip, reprojection);
    const [wasX = 0, wasY = 0] = ndc(wasClip);

    expect(previous[0] / previous[3]).toBeCloseTo(wasX, 4);
    expect(previous[1] / previous[3]).toBeCloseTo(wasY, 4);
  });

  /**
   * **A veil set for one frame must not persist into the next.**
   *
   * `setFrameVeil` is documented to clear itself in `endFrame`, unlike `setSpeedRush` and
   * `setCameraMotionBlur`, which are held until a caller changes them — precisely because a
   * forgotten veil is a frame stuck white or black, which is a worse failure than a transition
   * that has to ask again every frame. Asserted against the actual bytes the composite
   * uploads, not against the setter's own field, so a bug that clears the field but forgets to
   * feed the pass a fresh number would still be caught.
   */
  it('clears the frame veil once the frame that set it has been composited', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub);
    const at = RUSH_FRAG_FIELDS['uVeilAlpha']?.offset ?? -1;
    expect(at).toBeGreaterThanOrEqual(0);

    renderer.setFrameVeil(1, 1, 1, 0.6);
    renderer.beginFrame([0, 0, 0]);
    renderer.endFrame();

    const veiled = new Float32Array(ringUpload(stub.device, 'post.rushUniforms'));
    expect(veiled[at / 4]).toBeCloseTo(0.6, 5);

    /* No second call to setFrameVeil — the transition it belonged to is over. */
    renderer.beginFrame([0, 0, 0]);
    renderer.endFrame();

    const cleared = new Float32Array(ringUpload(stub.device, 'post.rushUniforms'));
    expect(cleared[at / 4]).toBe(0);
  });

  /**
   * **A probe must not be reflecting in the room it is baking**, and the second bake is where
   * that bites.
   *
   * `probeBaked` turns true at the end of the first one, so from then on the flat bind group
   * holds the cube — and the next bake writes a face of that very cube while it is still bound
   * for reading. WebGPU rejects it outright: *"[Texture "probe.cube"] usage
   * (TextureBinding|RenderAttachment) includes writable usage and another usage in the same
   * synchronization scope"*, the encoder is invalidated, and the whole bake is dropped.
   *
   * `renderer.ts` has had the guard all along and says why the uniform alone is not enough: a
   * driver may fetch a sampler's descriptor before it evaluates the arithmetic that would have
   * discarded the result. So the flag turns the term off *and* swaps the binding.
   *
   * The one bake this repository could run had never run — both scenes that ask for a probe
   * gate it on a car model that returns 404 — so nothing had reached the second one.
   */
  it('stops the probe reflecting in itself while it is being baked', () => {
    /* The ceiling `select.ts` requests and this machine grants; the default 16 would stand the
       probe down and there would be nothing to test. */
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const quality = resolveRenderQuality({ reflectionProbeSize: 64 });
    const renderer = freshRenderer(stub, quality);
    const { camera, env } = stubScene();

    /* `variantFor` pins the probe off, which is right for every other test here and is the one
       thing this test needs on. Built directly rather than by widening the shared helper. */
    const variant = flatVariant({
      directionalShadows: quality.directionalShadows,
      environmentProbe: true,
      nightEmissive: quality.nightEmissive,
      pointShadows: quality.pointShadows,
    });
    const bindings = flatFragmentBindings(variant);
    const at = bindings.fields['uEnvironmentEnabled']?.offset;
    /*
     * Read out of *every* slot rather than the first. The ring is not reset between bakes, so
     * the second one's draws take slots after the first one's and slot 0 still holds the first
     * bake's answer — which is a reading that agrees with the fix whether or not it is there.
     */
    const slotSize = Math.ceil(bindings.uniformSize / 256) * 256;
    const everySlot = (block: ArrayBuffer): number[] => {
      const floats = new Float32Array(block);
      const out: number[] = [];
      for (let offset = 0; offset + slotSize <= block.byteLength; offset += slotSize) {
        out.push(floats[(offset + (at ?? 0)) / 4] ?? -1);
      }
      return out;
    };
    expect(at, 'the probe variant must compile the term in, or this asserts nothing').toBeTypeOf(
      'number',
    );

    /* Twice: the first leaves `probeBaked` true, and the second is the one that used to fail. */
    const mesh = stubMesh(renderer);
    const baked: boolean[] = [];
    const seen: number[] = [];
    for (let bake = 0; bake < 2; bake++) {
      baked.push(
        renderer.bakeReflectionProbe([0, 1, 0], [0, 0, 0], (probeCamera) => {
          renderer.bindMeshPass(probeCamera, env);
          /* A draw, because the block only reaches the ring when one takes a slot. */
          renderer.drawMesh(mesh, mat4.create());
        }),
      );
      seen.push(...everySlot(ringUpload(stub.device, 'flat.fragRing')));
    }

    /* The control: a bake that declined would leave the term at whatever the slot held, and
       every assertion below would be measuring an empty buffer. */
    expect(baked, 'both bakes must have run, or this test asserts nothing').toEqual([true, true]);
    expect(
      seen.filter((value) => value !== 0),
      'no face of any bake may have the probe on, the re-bake least of all',
    ).toEqual([]);

    /* And on afterwards, or the guard would have turned the feature off rather than fenced it. */
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(mesh, mat4.create());
    renderer.endFrame();
    /* And on afterwards in at least one slot, or the guard would have turned the feature off
       rather than fenced it to the bake. */
    expect(everySlot(ringUpload(stub.device, 'flat.fragRing'))).toContain(1);
  });

  /**
   * **A bake draws the world with the world's pipelines, so its faces carry the world's sample
   * count**, and a pipeline whose count disagrees with its attachment is rejected at `finish`
   * with the whole command buffer behind it.
   *
   * The probe page that first ran a bake runs at one sample, so it could not have shown this;
   * `showroom` asks for four and the device answered *"[RenderPassEncoder "probe.face0"]
   * expects sampleCount: 1, [RenderPipeline] has sampleCount: 4"*. The mirror had the same
   * problem and solved it before: render into a multisampled twin and resolve into the texture
   * that gets sampled. A cube face is no different.
   */
  /**
   * **A probe can be asked for the reflection alone, and until 2026-09-03 it could not.**
   *
   * A bake filled the cube *and* read it back, projected it onto spherical harmonics and raised
   * `uEnvIrradianceEnabled` — from which frame on every diffuse surface took its ambient from the
   * projection rather than from the consumer's `Environment`. A consumer who wanted a reflection
   * got the whole scene changing what lights it, once, at whatever moment the bake landed.
   *
   * **The readback is gone entirely**, on both paths, and that is what this asserts now. The
   * diffuse term is a level of the probe array, convolved on the GPU at bake time, so
   * `probe.readback.target` and `probe.readback.staging` are never allocated whatever a caller
   * asks for — and with them went the frame-or-two skew that made this backend's ambient land
   * after its reflection.
   *
   * `ProbeBakeOptions.irradiance` survives with its meaning intact and is purely a uniform now:
   * `uProbeGridAmbient`, which `flat.test.ts` asserts collapses the whole term at zero.
   */
  it('bakes the reflection without reading anything back, whatever was asked for', () => {
    const readbackAllocations = (irradiance: boolean | undefined): string[] => {
      const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
      const quality = resolveRenderQuality({ reflectionProbeSize: 64 });
      const renderer = freshRenderer(stub, quality);
      const { env } = stubScene();
      const mesh = stubMesh(renderer);

      const baked = renderer.bakeReflectionProbe(
        [0, 1, 0],
        [0, 0, 0],
        (probeCamera) => {
          renderer.bindMeshPass(probeCamera, env);
          renderer.drawMesh(mesh, mat4.create());
        },
        irradiance === undefined ? undefined : { irradiance },
      );
      expect(baked, 'the bake must have run, or this asserts nothing').toBe(true);

      const labels = [
        ...stub.device.createTexture.mock.calls,
        ...stub.device.createBuffer.mock.calls,
      ].map(([descriptor]) => String(descriptor.label ?? ''));
      return labels.filter((label) => label.startsWith('probe.readback'));
    };

    expect(readbackAllocations(undefined), 'the default reads nothing back').toEqual([]);
    expect(readbackAllocations(true), 'nor does asking for the ambient').toEqual([]);
    expect(readbackAllocations(false), 'nor does declining it').toEqual([]);
  });

  it('bakes probe faces at the sample count its pipelines were built for', () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const quality = resolveRenderQuality({ reflectionProbeSize: 64, sceneSamples: 4 });
    const renderer = freshRenderer(stub, quality);
    const { env } = stubScene();
    const mesh = stubMesh(renderer);

    expect(
      renderer.bakeReflectionProbe([0, 1, 0], [0, 0, 0], (probeCamera) => {
        renderer.bindMeshPass(probeCamera, env);
        renderer.drawMesh(mesh, mat4.create());
      }),
      'the bake must have run, or this test asserts nothing',
    ).toBe(true);

    /* Every attachment the bake renders into has to be multisampled, and every face has to
       resolve — a stored multisample cube face is not something the shader can read. */
    const faces = stub.encoder.beginRenderPass.mock.calls
      .map(([descriptor]) => descriptor)
      .filter((descriptor) => String(descriptor.label ?? '').startsWith('probe.face'));
    expect(faces.length).toBe(6);
    for (const face of faces) {
      const attachment = [...(face.colorAttachments ?? [])][0];
      expect(
        attachment?.resolveTarget,
        `${String(face.label)} must resolve into the cube`,
      ).toBeDefined();
    }

    /* And both attachments carry the count, not just the colour: WebGPU requires every
       attachment in a pass to agree, and a single-sample depth beside a four-sample colour is
       rejected at `beginRenderPass` in words that read as a depth problem. */
    const made = stub.device.createTexture.mock.calls.map(([descriptor]) => descriptor);
    const counts = made
      .filter((descriptor) => String(descriptor.label ?? '').startsWith('probe.'))
      .filter((descriptor) => descriptor.label !== 'probe.cube')
      /* The irradiance readback's own target, which is not an attachment of the bake and is
         single-sampled on purpose: it is sampled from the finished cube after every face has
         resolved, so multisampling it would be a copy of a copy. */
      .filter((descriptor) => descriptor.label !== 'probe.readback.target')
      /* The prefilter's target, for the same reason and one more. It is not an attachment of the
         bake — the convolution runs after every face has resolved, reading the finished cube —
         and a multisampled convolution would be resolving an average of an integral, which is an
         average of an average. Single-sampled is what it should be. */
      .filter((descriptor) => !String(descriptor.label ?? '').startsWith('probe.array'))
      .map((descriptor) => `${String(descriptor.label)}:${descriptor.sampleCount ?? 1}`);
    expect(counts.sort()).toEqual(['probe.colorMsaa:4', 'probe.depth:4']);
  });

  /**
   * **A bake must draw the scene whether or not the frame graph is on.**
   *
   * With the graph on, every verb `drawFace` calls *records* instead of drawing, and nothing in
   * `bakeReflectionProbe` replayed those records before each face's pass ended. Measured: six draws
   * reached the cube with the graph off and **zero** with it on. So a probe stored its clear colour
   * and nothing else — a mirror reflecting an empty room, with no error anywhere to say so — and
   * the six recorded draws then outlived the bake and were replayed into whichever pass opened
   * next, carrying a four-sample pipeline into a one-sample overlay.
   *
   * The mirror already states the rule this bake was missing: what is recorded and not yet replayed
   * belongs to the pass that is about to end. A bake is the fourth such boundary in this backend
   * and was the only one never given the treatment.
   *
   * Asserted as **parity between the two settings** rather than against the number six, because
   * what matters is that the switch changes nothing about what the bake draws — and a count would
   * have to be rewritten the day a face draws twice.
   */
  it('bakes from the scene rather than from nothing, with the graph on or off', () => {
    const drawsPerSetting = [false, true].map((frameGraph) => {
      const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
      const quality = resolveRenderQuality({ reflectionProbeSize: 64, frameGraph });
      const renderer = freshRenderer(stub, quality);
      const { camera, env } = stubScene();
      const mesh = stubMesh(renderer);
      const arena = (renderer as unknown as { arena: never }).arena;

      renderer.beginFrame([0, 0, 0]);
      renderer.bindMeshPass(camera, env);
      stub.pass.drawIndexed.mockClear();

      const baked = renderer.bakeReflectionProbe([0, 1, 0], [0, 0, 0], (probeCamera) => {
        renderer.bindMeshPass(probeCamera, env);
        renderer.drawMesh(mesh, mat4.create());
      });
      expect(baked, 'the bake must have run, or this asserts nothing').toBe(true);

      /* Nothing may outlive the bake: a record left here is replayed into whatever opens next. */
      expect(nodeCount(arena), `graph=${frameGraph}: the bake left records behind`).toBe(0);
      renderer.endFrame();
      return stub.pass.drawIndexed.mock.calls.length;
    });

    const [withoutGraph, withGraph] = drawsPerSetting;
    expect(withoutGraph, 'the control: the bake draws at all').toBeGreaterThan(0);
    expect(withGraph, 'and the graph changes nothing about what it draws').toBe(withoutGraph);
  });

  /**
   * **A bake after `endFrame` still wants the scene's pipelines.**
   *
   * `targetPipelines` answers the overlay's cache once the frame is presented, because after
   * `endFrame` the only pass that normally opens is the overlay. A probe bake is the exception: it
   * builds faces of its own at the scene's sample count, and a scene is entitled to bake one
   * whenever it likes — the showroom bakes when its model finishes streaming, which is usually
   * after the frame it was asked in.
   *
   * Routing that bake to the overlay cache put a one-sample pipeline into a four-sample face, which
   * is the original fault inverted. The device caught it; the comment on `targetPipelines` had
   * asserted that nothing wanted the scene's cache after presentation, and it was wrong.
   */
  it("bakes with the scene's pipelines even after the frame is presented", () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const quality = resolveRenderQuality({ reflectionProbeSize: 64, frameGraph: true });
    const renderer = freshRenderer(stub, quality);
    const { camera, env } = stubScene();
    const mesh = stubMesh(renderer);
    const caches = renderer as unknown as {
      pipelines: { peek(key: string): unknown };
      overlayPipelines: { peek(key: string): unknown };
    };

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(mesh, mat4.create());
    renderer.endFrame();

    stub.pass.setPipeline.mockClear();
    expect(
      renderer.bakeReflectionProbe([0, 1, 0], [0, 0, 0], (probeCamera) => {
        renderer.bindMeshPass(probeCamera, env);
        renderer.drawMesh(mesh, mat4.create());
      }),
      'the bake must have run, or this asserts nothing',
    ).toBe(true);

    const key = (mesh as unknown as { key?: string }).key ?? '';
    /* Only the flat pipelines: a bake also builds its mip chain, which has a pipeline of its own
       and no business in this comparison. */
    const used = stub.pass.setPipeline.mock.calls.map((call: unknown[]) => call[0]);
    expect(used, "the scene's flat pipeline is what the faces were drawn with").toContain(
      caches.pipelines.peek(key),
    );
    const overlayFlat = caches.overlayPipelines.peek(key);
    expect(
      overlayFlat === undefined || !used.includes(overlayFlat),
      "and the overlay's one-sample pipeline never reached a four-sample face",
    ).toBe(true);
  });

  /*
   * The clear colour is the one it was handed, or the sky is whatever the driver had.
   *
   * **`beginFrame` no longer opens the pass**, so the clear arrives on the first draw that wants
   * one. That deferral is what lets a scene open a mirror without the frame's own attachment
   * being closed and read back; see `ensurePass`.
   */
  it('clears to the colour it was given, on the first pass that draws', () => {
    const stub = stubSurface();
    const { encoder } = stub;
    /* The direct path: the graph has its own clear tests in its describe block. */
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({ deferFramePass: true, frameGraph: false }),
    );
    const scene = stubScene();

    renderer.beginFrame([0.25, 0.5, 0.75]);
    expect(
      encoder.beginRenderPass.mock.calls.length,
      'beginFrame must not open the frame attachment by itself',
    ).toBe(0);

    renderer.bindMeshPass(scene.camera, scene.env);
    renderer.drawMesh(stubMesh(renderer), mat4.create());

    const descriptor = encoder.beginRenderPass.mock.calls[0]?.[0];
    const attachment = [...(descriptor?.colorAttachments ?? [])][0];
    expect(attachment?.clearValue).toEqual({ r: 0.25, g: 0.5, b: 0.75, a: 1 });
    expect(attachment?.loadOp).toBe('clear');
  });

  /*
   * A frame nobody drew into still owes the canvas its clear. With the pass deferred, `endFrame`
   * is the last chance to honour that: returning early on a null pass would present whatever the
   * swap chain last held.
   */
  it('clears an empty frame rather than presenting whatever was there', () => {
    const stub = stubSurface();
    const { encoder } = stub;
    const renderer = freshRenderer(stub);

    renderer.beginFrame([0.1, 0.2, 0.3]);
    renderer.endFrame();

    const frame = encoder.beginRenderPass.mock.calls
      .map(([d]) => d)
      .find((d) => String(d.label ?? '') === 'frame');
    expect(frame, 'an empty frame must still open and clear its attachment').toBeDefined();
    const attachment = [...(frame?.colorAttachments ?? [])][0];
    expect(attachment?.loadOp).toBe('clear');
    expect(attachment?.clearValue).toEqual({ r: 0.1, g: 0.2, b: 0.3, a: 1 });
  });

  /*
   * **The reopen this change exists to remove.** A scene that opens a mirror before it draws used
   * to cost the frame's attachment a close, a submit and a reopen with `loadOp: 'load'` — a full
   * read back into tile memory and a full write at the end, per mirror. Measured on the consuming
   * game, which has a sea and a fountain, at 92 MB a frame of reload alone at 824x1830.
   */
  it('opens the frame attachment once, however many mirrors precede the drawing', () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({
        water: true,
        waterReflections: true,
        deferFramePass: true,
        frameGraph: false,
      }),
    );
    const scene = stubScene();
    renderer.resize();

    renderer.beginFrame([0, 0, 0]);
    renderer.beginPlanarReflection(scene.camera, 0, [0, 0, 0]);
    renderer.endPlanarReflection();
    renderer.beginPlanarReflection(scene.camera, 1, [0, 0, 0]);
    renderer.endPlanarReflection();
    renderer.bindMeshPass(scene.camera, scene.env);
    renderer.drawMesh(stubMesh(renderer), mat4.create());
    renderer.endFrame();

    const labels = stub.encoder.beginRenderPass.mock.calls.map(([d]) => String(d.label ?? ''));
    expect(labels.filter((l) => l === 'reflection').length, 'both mirrors must have drawn').toBe(2);
    expect(
      labels.filter((l) => l === 'frame.resumed'),
      'a resumed frame is the attachment being read back in full',
    ).toEqual([]);
    expect(labels.filter((l) => l === 'frame').length, 'and it opens exactly once').toBe(1);
  });

  /*
   * **`AGENTS.md` forbids throwing in the frame loop**, and a lost device does not stop the
   * consumer's loop calling into it. Every entry point has to be safe to call afterwards,
   * because the alternative is an exception thrown sixty times a second out of a
   * requestAnimationFrame callback nobody wrapped.
   */
  /*
   * **The handle the renderer hands back has to be the one the upload is filling.** It was not:
   * `createMesh` returned a *spread* of the mesh in order to staple its pipeline key on, and a
   * spread copies the value a getter had at that instant. Completeness would have been frozen at
   * false for the life of every mesh, and nothing incremental would ever have been drawn.
   */
  it('hands back a handle that says when its geometry has landed', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub);

    const { mesh, upload } = renderer.createMeshIncremental({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
      colors: new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]),
      emissive: new Float32Array([0, 0, 0]),
      indices: new Uint32Array([0, 1, 2]),
    } as never);

    expect(mesh.complete).toBe(false);
    while (upload.next().done !== true);
    expect(mesh.complete).toBe(true);
  });

  /*
   * **An upload that spans frames can straddle a lost device**, and this says what happens: the
   * iterator ends and the mesh is never complete. That pair is the signal — *done and not
   * complete* is an abandoned upload, which a consumer can act on, where an iterator that went
   * on writing to a dead device would raise validation errors it could do nothing about.
   */
  it('abandons an upload the device did not survive', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub);
    const { mesh, upload } = renderer.createMeshIncremental({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
      colors: new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]),
      emissive: new Float32Array([0, 0, 0]),
      indices: new Uint32Array([0, 1, 2]),
    } as never);

    stub.markLost();

    expect(upload.next().done).toBe(true);
    expect(mesh.complete).toBe(false);
  });

  it('does not throw a frame after the device is lost', () => {
    const stub = stubSurface();
    const { device, markLost } = stub;
    const renderer = freshRenderer(stub);

    markLost();

    expect(() => {
      renderer.beginFrame([0, 0, 0]);
      renderer.endFrame();
    }).not.toThrow();
    expect(device.createCommandEncoder).not.toHaveBeenCalled();
    expect(renderer.framePresented).toBe(false);
  });

  it('does not submit a frame that was never begun', () => {
    const stub = stubSurface();
    const { device } = stub;
    const renderer = freshRenderer(stub);

    renderer.endFrame();

    expect(device.queue.submit).not.toHaveBeenCalled();
  });

  /*
   * **A missing *property* is silent where a missing method is loud, and this is what that
   * costs.** `demo/dayClock` passes this straight into `computeLightMatrix`, which divides by
   * it; `undefined` makes `texelWorldSize` NaN, and NaN spreads through the whole matrix.
   *
   * Measured, on hardware, before this test existed: the shadow map came back
   * `min 1, max 1, written 0` — 4,194,304 texels still at the clear value, because every
   * vertex of the depth pass was NaN and nothing rasterised. The frame then drew uniformly
   * black, because `vLightPos` was NaN too and every comparison in `shadowFactor` is false
   * against a NaN. It looked exactly like a broken shadow lookup and was not one.
   *
   * So the assertion is `toBeTypeOf('number')` as much as it is the value: what has to hold is
   * that a scene reading this gets arithmetic rather than poison.
   */
  /**
   * **Reported the way `rendererName` is, and for the same reason.** A consumer choosing a near
   * plane needs to know which way this machine's depth runs: a conventional buffer resolves about
   * `z² / (near · 2^bits)` and a reversed float one is near enough uniform, which is the difference
   * between a decal a millimetre off its surface and one seven and a half. Reported from outside
   * as the half that was missing — the seam was built and none of it was reachable.
   *
   * On this backend it always equals what the engine asked for: WebGPU's clip space is `[0, 1]`
   * already, so reversing needs no extension and cannot be refused. WebGL2's can differ.
   */
  it('reports which way its depth buffer runs', () => {
    const renderer = freshRenderer(stubSurface());
    expect(typeof renderer.reversedDepth).toBe('boolean');
    expect(renderer.reversedDepth).toBe(REVERSED_DEPTH);
  });

  it('reports the size of the shadow map it allocated', () => {
    const { surface, device } = stubSurface();
    const renderer = new WebGPURenderer(surface);

    expect(renderer.shadowMapSize).toBeTypeOf('number');
    expect(Number.isFinite(renderer.shadowMapSize)).toBe(true);

    const allocated = device.createTexture.mock.calls
      .map(([descriptor]) => descriptor)
      .find((descriptor) => descriptor.label === 'shadow.sun');
    /* Width and height; the third is how many of the sun's maps the profile keeps as layers. */
    expect([...((allocated?.size ?? []) as number[])].slice(0, 2)).toEqual([
      renderer.shadowMapSize,
      renderer.shadowMapSize,
    ]);
  });

  /*
   * **The shadow map is sampled, not shown, and that decides its clip correction.**
   *
   * The frame's correction flips Y so a projection built for OpenGL reaches the canvas the
   * right way up. Applying the same flip to the shadow map mirrors it about its horizontal
   * centre, and `flat.ts` looks it up with `p = p * 0.5 + 0.5` — the OpenGL convention — so
   * every fetch lands a mirrored number of rows away from the row it wanted.
   *
   * That shipped once and it did not look like a bug. It looked like shadows: broad dark bands
   * where a mirrored sample happened to find a nearer occluder, and stipple wherever a receiver
   * stopped matching its own texel. It was caught by reading both backends' maps back and
   * comparing them texel for texel — 63,718 of 65,536 differing as stored, 285 when one was
   * mirrored — and no test could have caught it, because no test looked at the matrix.
   *
   * This one does. `[5]` is the Y scale and it must stay +1; the depth remap must still be
   * there, or the map loses the near half of its range.
   */
  it('renders the shadow map without the Y flip the frame needs', () => {
    const { surface, device } = stubSurface();
    const renderer = new WebGPURenderer(surface);
    const caster = {
      key: 'flat:s0:u0',
      vertexBuffers: [{ label: 'vertices' }],
      indexBuffer: { label: 'indices' },
      indexCount: 3,
      /* A real mesh says whether its geometry has landed, and nothing incomplete is drawn. */
      complete: true,
    };

    renderer.beginShadowPass(mat4.create(), 'static');
    renderer.drawShadowCasters((sink) => {
      sink.mesh(caster as never, mat4.create());
    });
    renderer.endShadowPass();

    /* The ring uploads its whole staging buffer; the matrix sits at the generated offset. */
    const staging = ringUpload(device, 'shadow.drawRing');
    const written = new Float32Array(staging, DEPTH_VERT_FIELDS.uLightViewProj.offset, 16);

    expect(written[5]).toBe(1);
    expect(written[10]).toBeCloseTo(0.5);
    expect(written[14]).toBeCloseTo(0.5);
  });

  /**
   * **Glass lets its light through.** A caster whose material says it is glass writes no depth into
   * a shadow map, so a lamp behind a pane lights what is beyond it; the other caster in the same
   * enumeration still casts. Glass B turns the same information into a coloured shadow.
   */
  it('A GLASS CASTER WRITES NO DEPTH, and the caster beside it still does', () => {
    const { surface, pass } = stubSurface();
    const renderer = new WebGPURenderer(surface);
    const caster = {
      key: 'flat:s0:u0',
      vertexBuffers: [{ label: 'vertices' }],
      indexBuffer: { label: 'indices' },
      indexCount: 3,
      complete: true,
    };
    renderer.beginShadowPass(mat4.create(), 'static');
    pass.drawIndexed.mockClear();
    renderer.drawShadowCasters((sink) => {
      sink.mesh(caster as never, mat4.create());
      sink.mesh(caster as never, mat4.create(), { glass: { transmission: 0.9, frost: 0.5 } });
    });
    expect(pass.drawIndexed, 'the opaque caster alone reaches the depth').toHaveBeenCalledTimes(1);
    /* Kept aside for its own passes (Glass B), not dropped: see `glassCasters.ts`. */
    const kept = (renderer as unknown as { glassCasters: { count: number } }).glassCasters;
    expect(kept.count, 'the glass caster is kept aside').toBe(1);
    renderer.endShadowPass();
  });

  /*
   * **The sun draws its glass twice once its opaque casters are in**, and the first glass grows
   * the sun's texture by two layers, carrying every layer it held across: the static map a
   * consumer baked once survives, because the glass arrives in the very pass that drew it.
   */
  it('THE SUN DRAWS ITS GLASS TWICE, and the first glass grows its texture without losing a map', () => {
    const stub = stubSurface();
    const quality = resolveRenderQuality({ directionalShadowDepthLayers: 2 });
    const renderer = freshRenderer(stub, quality);
    const caster = {
      key: 'flat:s0:u0',
      vertexBuffers: [{ label: 'vertices' }],
      indexBuffer: { label: 'indices' },
      indexCount: 3,
      complete: true,
    };
    const pane = {
      glass: { transmission: 0.9, frost: 0.5, tint: [1, 0.5, 0.25] as [number, number, number] },
    };
    const frame = (): void => {
      renderer.beginShadowPass(mat4.create(), 'static');
      renderer.drawShadowCasters((sink) => {
        sink.mesh(caster as never, mat4.create());
        sink.mesh(caster as never, mat4.create(), pane);
      });
      renderer.endShadowPass();
    };
    stub.encoder.beginRenderPass.mockClear();
    stub.pass.drawIndexed.mockClear();
    frame();

    const suns = stub.device.createTexture.mock.calls
      .map(([descriptor]) => descriptor)
      .filter((descriptor) => descriptor.label === 'shadow.sun');
    expect(suns.map((descriptor) => (descriptor.size as number[])[2])).toEqual([3, 5]);
    /* The tint carries its whole chain: frost reads the level its spread asks for. */
    const tintTexture = stub.device.createTexture.mock.calls
      .map(([descriptor]) => descriptor)
      .find((descriptor) => descriptor.label === 'shadow.sunTint');
    const edge = (tintTexture?.size as number[] | undefined)?.[0] as number;
    expect(tintTexture?.mipLevelCount).toBe(Math.floor(Math.log2(edge)) + 1);
    expect(stub.encoder.copyTextureToTexture, 'every layer held is carried').toHaveBeenCalledTimes(
      3,
    );
    const labels = stub.encoder.beginRenderPass.mock.calls.map(([d]) => String(d.label ?? ''));
    /* The new layers are born clear once — two glass depths, two tints — and then drawn. */
    expect(labels.filter((label) => label.endsWith('.clear'))).toEqual([
      'shadow.glass.clear',
      'shadow.glass.clear',
      'shadow.tint.clear',
      'shadow.tint.clear',
    ]);
    expect(labels.filter((label) => !label.endsWith('.clear'))).toEqual([
      'shadow.static',
      'shadow.glass',
      'shadow.tint',
    ]);
    const tintPass = stub.encoder.beginRenderPass.mock.calls
      .map(([descriptor]) => descriptor)
      .find((descriptor) => descriptor.label === 'shadow.tint');
    const colour = (tintPass?.colorAttachments as GPURenderPassColorAttachment[] | undefined)?.[0];
    expect(colour?.loadOp).toBe('clear');
    expect(colour?.clearValue).toEqual([1, 1, 1, 1]);
    expect(tintPass?.depthStencilAttachment).toBeUndefined();
    expect(
      stub.pass.drawIndexed,
      'the opaque caster, the pane depth, the pane tint',
    ).toHaveBeenCalledTimes(3);
    const tinted = stub.device.createRenderPipeline.mock.calls
      .map(([descriptor]) => descriptor)
      .find((descriptor) => String(descriptor.label ?? '').startsWith('glass-tint'));
    expect(tinted?.fragment?.targets[0]?.blend).toEqual({
      color: { operation: 'add', srcFactor: 'dst', dstFactor: 'zero' },
      alpha: { operation: 'add', srcFactor: 'dst-alpha', dstFactor: 'zero' },
    });

    stub.device.createTexture.mockClear();
    stub.encoder.beginRenderPass.mockClear();
    frame();
    expect(
      stub.device.createTexture.mock.calls.filter(([d]) => d.label === 'shadow.sun'),
      'a second frame allocates nothing',
    ).toHaveLength(0);
    expect(
      stub.encoder.beginRenderPass.mock.calls.map(([d]) => d.label),
      'and clears nothing it already has',
    ).toEqual(['shadow.static', 'shadow.glass', 'shadow.tint']);
  });

  /*
   * **A lit pipeline reads glass once a glass caster has been offered, and not before.** The
   * lookups cost the lit pass about three thousand instructions and their registers on every
   * surface, finding nothing in a world with no pane, and every scene paid for them from 4.5.0 —
   * on a phone, the difference in the lit pass. The first pane a shadow pass is offered switches
   * every cache a lit pipeline can come from: the world's, the overlay's after the present, and the
   * late pass's at output size. Glass shadows off never switches at all.
   */
  it('A LIT PIPELINE READS GLASS ONCE A GLASS CASTER IS OFFERED, in every cache, and never with glass shadows off', async () => {
    for (const glassShadows of ['full', 'off'] as const) {
      const stub = stubSurface();
      const renderer = new WebGPURenderer(stub.surface, resolveRenderQuality({ glassShadows }));
      const mesh = stubMesh(renderer);
      renderer.beginFrame([0, 0, 0]);
      renderer.drawMesh(mesh, mat4.create());
      renderer.endFrame();
      const lit = (): GPURenderPipelineDescriptor[] =>
        stub.device.createRenderPipeline.mock.calls
          .map(([descriptor]) => descriptor)
          /* A lit pipeline is one carrying the glass switch; a caster's pipelines carry none. */
          .filter((descriptor) => descriptor.fragment?.constants !== undefined);
      const built = lit().length;
      expect(built, glassShadows).toBeGreaterThan(0);
      for (const descriptor of lit()) {
        /* The switch's id, which is what an override declared with one answers to. */
        expect(descriptor.fragment?.constants?.['0'], `${glassShadows}: before any glass`).toBe(0);
      }

      const caster = {
        key: 'flat:s0:u0',
        vertexBuffers: [{ label: 'vertices' }],
        indexBuffer: { label: 'indices' },
        indexCount: 3,
        complete: true,
      };
      const pane = {
        glass: { transmission: 0.9, frost: 0, tint: [1, 0.5, 0.25] as [number, number, number] },
      };
      renderer.beginShadowPass(mat4.create(), 'static');
      renderer.drawShadowCasters((sink) => sink.mesh(caster as never, mat4.create(), pane));
      renderer.endShadowPass();
      await new Promise((settle) => setTimeout(settle, 0));

      const caches = renderer as unknown as Record<
        'pipelines' | 'overlayPipelines' | 'latePipelines',
        { litSwitches: { GLASS_SHADOWS: boolean } }
      >;
      for (const name of ['pipelines', 'overlayPipelines', 'latePipelines'] as const) {
        expect(caches[name].litSwitches.GLASS_SHADOWS, `${glassShadows}: ${name}`).toBe(
          glassShadows !== 'off',
        );
      }
      const rebuilt = lit().slice(built);
      if (glassShadows === 'off') {
        expect(rebuilt, 'nothing rebuilt with glass shadows off').toHaveLength(0);
        continue;
      }
      expect(rebuilt.length, 'every lit pipeline rebuilt').toBe(built);
      for (const descriptor of rebuilt) {
        expect(descriptor.fragment?.constants?.['0'], `rebuilt: ${descriptor.label}`).toBe(1);
      }
    }
  });

  it('A GLASS CASTER IS DROPPED ENTIRELY WHEN GLASS SHADOWS ARE OFF, as it was before they existed', () => {
    const { surface, pass } = stubSurface();
    const renderer = new WebGPURenderer(surface, resolveRenderQuality({ glassShadows: 'off' }));
    const caster = {
      key: 'flat:s0:u0',
      vertexBuffers: [{ label: 'vertices' }],
      indexBuffer: { label: 'indices' },
      indexCount: 3,
      complete: true,
    };
    renderer.beginShadowPass(mat4.create(), 'static');
    pass.drawIndexed.mockClear();
    renderer.drawShadowCasters((sink) => {
      sink.mesh(caster as never, mat4.create(), { glass: { transmission: 0.9, frost: 0.5 } });
    });
    renderer.endShadowPass();
    expect(pass.drawIndexed).toHaveBeenCalledTimes(0);
    const kept = (renderer as unknown as { glassCasters: { count: number } }).glassCasters;
    expect(kept.count).toBe(0);
  });

  /**
   * **The night-side emissive term reaches the shader that was compiled for it.**
   *
   * `renderer.ts` writes `uNightEmissive` unconditionally, because a missing GL location is a
   * silent no-op. Here the name simply was not written at all, and an unwritten uniform is zero
   * — which does not weaken the term, it removes it. Same shape as `uGrain` and `uEmissiveGain`
   * before it, and found the same way: by diffing what each backend writes against the generated
   * field list, not by looking at a frame.
   *
   * Pinned at a value nothing else in the block holds, so a wrong offset cannot pass by
   * coincidence.
   */
  it('gives the night emissive term to the variant that declares it', () => {
    const { surface, device } = stubSurface();
    const quality = resolveRenderQuality({ nightEmissive: true });
    const renderer = new WebGPURenderer(surface, quality);
    const { camera, env } = stubScene();

    renderer.bindMeshPass(camera, { ...(env as object), nightEmissive: 0.63 } as never);

    const fields = flatFragmentBindings(variantFor(quality)).fields;
    const term = fields['uNightEmissive'];
    if (term === undefined) throw new Error('this variant does not declare the term');
    const floats = new Float32Array(materialBlock(renderer, device));
    expect(floats[term.offset / 4]).toBeCloseTo(0.63);
  });

  /**
   * **A mover casts a shadow, and it does it in its own layer.**
   *
   * `beginShadowPass` returned false for `'dynamic'` and there was no map behind it, so every
   * moving caster a scene submitted went nowhere. It degraded honestly rather than wrongly —
   * `uDynamicShadowMap` fell through to the white stand-in, which reads as the far plane and so
   * as lit — which is exactly why it survived: nothing looked broken, only empty. Reported from
   * a consumer as *"sun shadow works for other than the character itself"*, with towers casting
   * across the ground in the same frame the character stood on it casting nothing.
   *
   * Three layers, three maps, and the shader multiplies them. Asserted by pass label because
   * that is the thing a scene's three calls have to reach — the same instrument the device
   * itself used to name the overlay mismatch.
   */
  it('opens a pass for every shadow layer a scene submits', () => {
    const stub = stubSurface();
    const quality = resolveRenderQuality({ directionalShadowDepthLayers: 2 });
    const renderer = freshRenderer(stub, quality);
    const caster = {
      key: 'flat:s0:u0',
      vertexBuffers: [{ label: 'vertices' }],
      indexBuffer: { label: 'indices' },
      indexCount: 3,
      /* A real mesh says whether its geometry has landed, and nothing incomplete is drawn. */
      complete: true,
    };
    const submit = (layer: 'static' | 'static-peel' | 'dynamic'): boolean => {
      const opened = renderer.beginShadowPass(mat4.create(), layer);
      renderer.drawShadowCasters((sink) => {
        sink.mesh(caster as never, mat4.create());
      });
      renderer.endShadowPass();
      return opened;
    };

    expect(submit('static'), 'the static layer must open').toBe(true);
    expect(submit('static-peel'), 'the peel layer must open').toBe(true);
    expect(submit('dynamic'), 'the movers must have somewhere to draw').toBe(true);

    const labels = stub.encoder.beginRenderPass.mock.calls
      .map(([descriptor]) => String(descriptor.label ?? ''))
      .filter((label) => label.startsWith('shadow.'));
    expect(labels).toEqual(['shadow.static', 'shadow.peel', 'shadow.dynamic']);

    /*
     * Its own layer, at the profile's map size — not a second name for the static one, which
     * would put the movers and the world in one depth buffer and lose whichever is further. One
     * texture since the sun's maps became an array (`shadowMap.ts`), a layer each.
     */
    const maps = stub.device.createTexture.mock.calls
      .map(([descriptor]) => descriptor)
      .filter((descriptor) => String(descriptor.label ?? '').startsWith('shadow.'));
    expect(maps.map((descriptor) => descriptor.label)).toEqual(['shadow.sun']);
    expect(maps[0]?.size, 'three layers at the profile map size').toEqual([
      quality.directionalShadowMapSize,
      quality.directionalShadowMapSize,
      3,
    ]);
    const attached = stub.encoder.beginRenderPass.mock.calls
      .map(([descriptor]) => descriptor)
      .filter((descriptor) => String(descriptor.label ?? '').startsWith('shadow.'))
      .map((descriptor) => descriptor.depthStencilAttachment?.view);
    expect(new Set(attached).size, 'each pass attaches a layer of its own').toBe(3);
  });

  /**
   * The peel survives the layer that opens after it.
   *
   * `peelFilled` was reset on `!peel`, which was right while there were two layers and wrong the
   * moment there were three: the dynamic pass opens last, so it invalidated the peel that had
   * just been filled and the frame sampled none of it. A frame drawing three layers must end
   * with all three readable.
   */
  it('keeps the peel it filled when the movers draw after it', () => {
    const stub = stubSurface();
    const quality = resolveRenderQuality({ directionalShadowDepthLayers: 2 });
    const renderer = freshRenderer(stub, quality);
    const { camera, env } = stubScene();

    for (const layer of ['static', 'static-peel', 'dynamic'] as const) {
      renderer.beginShadowPass(mat4.create(), layer);
      renderer.endShadowPass();
    }
    renderer.bindMeshPass(camera, env);

    const staging = materialBlock(renderer, stub.device);
    const fields = flatFragmentBindings(variantFor(quality)).fields;
    const enabled = fields['uPeeledShadowEnabled'];
    if (enabled === undefined) throw new Error('the peel flag is not in this variant');
    expect(new Int32Array(staging)[enabled.offset / 4]).toBe(1);
  });

  /*
   * **The shadow terms come from the resolved profile, not from the defaults.**
   *
   * They were constants here, justified as "taken from `DEFAULT_RENDER_QUALITY` so a
   * comparison at default quality compares the same numbers". `renderer.ts` binds
   * `this.quality.*`, and a scene overrides it: `demo/dayClock` resolves
   * `directionalShadowMaxSlope` to 9 where the default is 3, read off both live renderers.
   * A copied default is wrong for whichever scene overrides it next, so nothing here may be
   * a copy.
   *
   * `uShadowMaxSlope` is the one that was measurably wrong, so it is the one pinned; it only
   * enters through `lowElevationFade` and so bites on a low sun rather than at noon, which is
   * exactly the kind of difference a screenshot at one time of day cannot show.
   */
  it('binds the shadow terms the resolved profile asks for', () => {
    const { surface, device } = stubSurface();
    const quality = resolveRenderQuality({
      directionalShadowMaxSlope: 9,
      directionalShadowMaxDistance: 11,
    });
    const renderer = new WebGPURenderer(surface, quality);
    const { camera, env } = stubScene();

    renderer.bindMeshPass(camera, env);

    const staging = materialBlock(renderer, device);
    const floats = new Float32Array(staging);
    const fields = flatFragmentBindings(variantFor(quality)).fields;
    const read = (name: string): number => floats[(fields[name]?.offset ?? -4) / 4] as number;

    expect(read('uShadowMaxSlope')).toBe(9);
    expect(read('uShadowMaxDistance')).toBe(11);
    expect(read('uShadowMapSize')).toBe(quality.directionalShadowMapSize);
    expect(renderer.shadowMapSize).toBe(quality.directionalShadowMapSize);
  });

  /*
   * The nine value-typed members that were absent, and absent quietly — see `shadowMapSize`
   * for what one of them cost. Asserted as a group because the hazard is the group: each is
   * a number or a flag a scene reads and does arithmetic on, and `undefined` in arithmetic
   * draws a picture instead of raising.
   */
  it('answers the measurements a scene reads off it', () => {
    const { surface, canvas, markLost } = stubSurface();
    const renderer = new WebGPURenderer(surface, resolveRenderQuality({}));

    expect(renderer.canvas).toBe(canvas);
    expect(renderer.cssWidth).toBe(320);
    expect(renderer.cssHeight).toBe(240);
    expect(renderer.aspect).toBeCloseTo(640 / 480);
    expect(renderer.contextLost).toBe(false);
    expect(renderer.capabilityClamped).toBe(false);
    expect(renderer.sampledShadowLights).toBe(0);
    expect(renderer.quality.directionalShadowMapSize).toBeTypeOf('number');

    markLost();
    expect(renderer.contextLost).toBe(true);
  });

  /*
   * **The sky reconstructs its ray from NDC, so it needs the inverse of the *corrected*
   * projection.**
   *
   * `sky.ts` emits its own fullscreen triangle — `gl_Position = vec4(vNdc, 1, 1)` — and
   * unprojects that same `vNdc` with `uInvViewProj` to get a view ray. It is the one draw in
   * the engine with no matrix on its vertex position, so `CLIP_CORRECTION` never reaches it,
   * while every other draw is corrected. That leaves the sky disagreeing with the world by a
   * Y flip: the top of the screen renders the ray for the bottom.
   *
   * It shipped looking like a plausible sky, which is why it took a numeric check to see.
   * Predicted colour at the top of `demo/collapse` from the captured matrix and uniforms —
   * upward ray 142,159,186 against the mirrored ray 79,102,147, measured WebGL2 150,166,192
   * and WebGPU 60,85,137. WebGPU was rendering the below-horizon `uDeepColor` at the zenith.
   *
   * Corrected in the matrix rather than the shader, as `CLIP_CORRECTION` documents: the sky is
   * handed `invViewProjection * INVERSE_CLIP_CORRECTION`, which takes WebGPU NDC back to GL NDC
   * — flipping Y and mapping z from [0,1] to [-1,1] — before the camera's own inverse. With an
   * identity camera that is exactly `INVERSE_CLIP_CORRECTION`, which is what this pins.
   */
  it('unprojects the sky through the corrected clip space', () => {
    const { surface, device } = stubSurface();
    const renderer = new WebGPURenderer(surface, resolveRenderQuality({}));
    const camera = {
      viewProjection: mat4.create(),
      invViewProjection: mat4.create(),
      position: new Float32Array([0, 0, 0]),
    } as never;
    const sky = {
      top: new Float32Array([0, 0, 0]),
      horizon: new Float32Array([0, 0, 0]),
      deep: new Float32Array([0, 0, 0]),
      sunDir: new Float32Array([0, 1, 0]),
      sunColor: new Float32Array([0, 0, 0]),
      sunAngularRadius: 0.01,
      moonDir: new Float32Array([0, -1, 0]),
      moonColor: new Float32Array([0, 0, 0]),
      moonAngularRadius: 0.01,
      moonPhase: 0.5,
      nightFactor: 0,
      cloudOffsetX: 0,
      cloudOffsetZ: 0,
    } as never;

    renderer.beginFrame([0, 0, 0]);
    /*
     * A real atmosphere rather than `{}`, because the sky resolves the camera's medium now.
     *
     * It did not before, which is the defect: the block declares `uUnderwaterColor` and
     * `uUnderwaterFactor` and this method wrote neither, so a camera under the sea drew the
     * sky it would have seen from above it. `stubScene`'s environment carries the same fields
     * for the same reason on the mesh pass.
     */
    renderer.drawSky(camera, sky, stubScene().env);
    /* The sky is a ring slot now and uploads with the other rings, when the frame is flushed. */
    renderer.endFrame();

    const upload = device.queue.writeBuffer.mock.calls
      .filter((call: unknown[]) => (call[0] as { label?: string }).label === 'sky.ring')
      .at(-1);
    const written = new Float32Array(upload?.[2] as ArrayBuffer, 0, 16);

    /* Y comes back the other way, and depth comes back to [-1, 1]. */
    expect(written[5]).toBe(-1);
    expect(written[10]).toBe(2);
    expect(written[14]).toBe(-1);
    expect(written[0]).toBe(1);
  });

  /*
   * **Every mesh-pass uniform the other backend writes, with the value it writes.**
   *
   * Found by listing both `bindMeshPass` implementations' uniforms and diffing the two sets
   * rather than by noticing one at a time — which is how `uEmissiveGain` had gone unnoticed
   * while pinned at 1. `demo/dayClock` computes it as `nightFactor² · 1.4`, so it is **0** in
   * daylight, and a hard-coded 1 lit every lamp head at full strength at 10:21. Measured as
   * the worst pixels in the frame: 139,140,82 against 255,255,136, blown out.
   *
   * `uGrain` is the same shape of mistake and less visible: the other backend binds a plain
   * 1 and an unwritten uniform is 0, so grain — a per-vertex material term multiplied by it —
   * was switched off wholesale rather than being subtly wrong.
   *
   * The two constants are constants in `renderer.ts` too, and are pinned here at its values
   * rather than at what looks reasonable: `uReliefCycles` is 60 and not 0, and nothing in
   * either file explains 60, so a copy is all this can honestly be.
   */
  it('binds the material and grading terms the environment carries', () => {
    const { surface, device } = stubSurface();
    const quality = resolveRenderQuality({});
    const renderer = new WebGPURenderer(surface, quality);
    const { camera, env } = stubScene();

    renderer.bindMeshPass(camera, env);

    const staging = materialBlock(renderer, device);
    const floats = new Float32Array(staging);
    const ints = new Int32Array(staging);
    const fields = flatFragmentBindings(variantFor(quality)).fields;
    const off = (name: string): number => (fields[name]?.offset ?? -4) / 4;

    /* From the environment, not from a constant. */
    expect(floats[off('uEmission')]).toBeCloseTo(0.25);
    expect(floats[off('uEmission') + 1]).toBeCloseTo(0.5);
    expect(floats[off('uHighlightMax') + 3], 'the gain, in the far corner').toBeCloseTo(1.5);
    expect([0, 1, 2].map((k) => floats[off('uHighlightMin') + k])).toEqual([
      expect.closeTo(0.1),
      expect.closeTo(0.2),
      expect.closeTo(0.3),
    ]);

    /* Constants, matching `renderer.ts` — an unwritten uniform is 0 and 0 is wrong for both. */
    expect(floats[off('uGrain')]).toBe(1);
    expect(floats[off('uRelief') + 1]).toBe(60);
    expect(floats[off('uOpacity')]).toBe(1);
    expect(floats[off('uOutputExposure')]).toBe(1);
    expect(ints[off('uOutputTransform')]).toBe(0);
  });

  /*
   * **A uniform block is not a packed array, and getting that wrong draws a picture.**
   *
   * The engine's light arrays hold three floats per position and one per radius, back to back.
   * std140 gives every array element its own sixteen-byte slot whatever it holds, so a
   * `float[10]` occupies 160 bytes and not 40. Copying straight in would lay ten lights across
   * the first two and a half slots — lights in the wrong places, at the wrong sizes, and no
   * error anywhere.
   *
   * So the second light is what this asserts: its position four floats along rather than three,
   * and its radius four floats along rather than one. The stride comes from the generated
   * layout in both the code and the test, so a generator that changed it would move both.
   */
  it('scatters the point lights at the stride the block declares', () => {
    const { surface, device } = stubSurface();
    const quality = resolveRenderQuality({});
    const renderer = new WebGPURenderer(surface, quality);
    const { camera, env } = stubScene();
    /*
     * Sized from `MAX_POINT_LIGHTS` rather than from a literal ten.
     *
     * `resolvePointLights` replaces any array shorter than the budget with a zero-filled
     * stand-in — deliberately, because a caller that binds a short array gets unlit lights
     * rather than a console flood of `INVALID_VALUE`. A fixture with a literal length is a
     * fixture that silently starts testing that fallback the moment the budget moves, which is
     * what raising the cap to sixteen did to this one: every assertion below read zero.
     */
    const lit = {
      ...(env as object),
      lightCount: 2,
      lightPositions: new Float32Array(MAX_POINT_LIGHTS * 3).fill(0).map((_, k) => k + 1),
      lightColors: new Float32Array(MAX_POINT_LIGHTS * 3).fill(0.5),
      lightRadii: new Float32Array(MAX_POINT_LIGHTS).fill(0).map((_, k) => 100 + k),
      lightSourceRadii: new Float32Array(MAX_POINT_LIGHTS).fill(0.2),
      lightWeights: new Float32Array(MAX_POINT_LIGHTS).fill(1),
    } as never;

    renderer.bindMeshPass(camera, lit);

    const staging = materialBlock(renderer, device);
    const floats = new Float32Array(staging);
    const ints = new Int32Array(staging);
    const fields = flatFragmentBindings(variantFor(quality)).fields;
    const pos = fields['uLightPos']!;
    const radius = fields['uLightRadius']!;
    if (pos.stride === undefined || radius.stride === undefined) throw new Error('no stride');

    expect(ints[fields['uLightCount']!.offset / 4]).toBe(2);

    /* Light 0 at the base; light 1 one whole stride along, not one element along. */
    expect(floats[pos.offset / 4]).toBe(1);
    expect(floats[pos.offset / 4 + pos.stride / 4]).toBe(4);
    expect(floats[radius.offset / 4]).toBe(100);
    expect(floats[radius.offset / 4 + radius.stride / 4]).toBe(101);
    /* The padding between elements stays untouched rather than holding the next light. */
    expect(floats[pos.offset / 4 + 3]).toBe(0);
  });

  /*
   * **A light volume culls the half of its hull the camera is not on, and that is per draw.**
   *
   * Every other pass here fixes its culling at pipeline construction. This one cannot: from
   * outside a volume the front faces are where a view ray enters it, and from inside they are
   * behind the viewer. Pinning it to `back` is not a validation error and not a wrong colour —
   * it is a beam that vanishes the moment somebody walks into it, which reads as a shader or a
   * clipping bug and is neither.
   */
  it('culls the far half of the hull, from whichever side the camera is on', () => {
    const { surface, device } = stubSurface();
    const renderer = new WebGPURenderer(surface, resolveRenderQuality({}));
    const mesh = {
      key: 'flat:s0:u0',
      vertexBuffers: [{ label: 'vertices' }, { label: 'constants' }],
      indexBuffer: { label: 'indices' },
      indexCount: 3,
      /* A real mesh says whether its geometry has landed, and nothing incomplete is drawn. */
      complete: true,
    };
    const cullModes = (): (GPUCullMode | undefined)[] =>
      device.createRenderPipeline.mock.calls.map((call) => call[0].primitive?.cullMode);

    /* Behind the apex, looking down the beam: outside, so the near faces are the back ones. */
    renderer.beginFrame([0, 0, 0]);
    renderer.drawLightVolume(
      mesh as never,
      mat4.create(),
      { viewProjection: mat4.create(), position: new Float32Array([0, 0, -5]) } as never,
      1,
      20,
      0.5,
    );
    expect(cullModes()).toContain('back');
    expect(cullModes()).not.toContain('front');

    /* Five metres along the axis and one off it, where the cone is 2.5 wide: standing in it. */
    renderer.drawLightVolume(
      mesh as never,
      mat4.create(),
      { viewProjection: mat4.create(), position: new Float32Array([1, 0, 5]) } as never,
      1,
      20,
      0.5,
    );
    expect(cullModes()).toContain('front');
  });

  /*
   * **The shadow pass keeps the faces the light can see, and its own projection decides which
   * those are.**
   *
   * Facing is settled in framebuffer coordinates, whose Y points down while clip space's points
   * up, so the two are opposite: a triangle wound counter-clockwise in clip space arrives at the
   * rasteriser clockwise. Every other pass in this backend is projected through `CLIP_CORRECTION`,
   * which negates Y and turns that back over, so the default `frontFace` is right for all of
   * them. **The directional shadow map is the one target that is sampled rather than presented**,
   * so `SHADOW_CLIP_CORRECTION` deliberately leaves Y alone — and then `cullMode: 'back'` throws
   * away exactly the faces the pass exists to record.
   *
   * That shipped, and what it cost is why this is asserted rather than commented: on a world
   * built out of a vault over an arcade, the vault was absent from the map, the light reached
   * through it, and the arcade under it was lit on this backend and dark on the other. Read back
   * texel for texel, 2,000,709 texels of 2,095,575 differed by more than 0.2 m and 805,117 by
   * more than 2 m, with the map recording surfaces 8.4 m further from the light on average.
   *
   * Written against the projection rather than against the literal, because the failure that put
   * it here is the two disagreeing: a later change that gives this pass the Y flip has to move
   * the winding with it, and this is what says so.
   */
  /*
   * **A scatter batch takes a slot, because a shadow round is more than one pass.**
   *
   * The block used to be one buffer rewritten before each batch. `queue.writeBuffer` is ordered
   * on the queue timeline and the encoder is submitted afterwards, so every batch recorded
   * before that submit reads the last write — and a point light's bake records six cube faces on
   * one encoder, so a field of grass went into all six faces under the last face's projection.
   * Five sixths of it landed in the octahedral map at directions the grass does not occupy,
   * which is a patch of shadow beside a lamp with nothing above it.
   *
   * Two batches with different wind is the smallest thing that shows it: with one buffer both
   * slots hold the second batch's numbers, and the two draws bind the same offset.
   */
  it('gives every scatter batch in a shadow round its own slot', () => {
    const { surface, device, pass } = stubSurface();
    const renderer = new WebGPURenderer(surface, resolveRenderQuality({}));
    const scatter = {
      vertexBuffers: [{ label: 'vertices' }],
      indexBuffer: { label: 'indices' },
      indexCount: 3,
      /* A real mesh says whether its geometry has landed, and nothing incomplete is drawn. */
      complete: true,
    };
    const data = { count: 4 } as never;

    renderer.beginShadowPass(mat4.create(), 'static');
    renderer.drawShadowCasters((sink) => {
      sink.scatter(scatter as never, data, 1, 0, 0.25, 0, null);
      sink.scatter(scatter as never, data, 0, 1, 0.75, 0, null);
    });
    renderer.endShadowPass();

    const written = new Float32Array(ringUpload(device, 'scatter.depthDrawRing'));
    const stride = 256 / 4;
    const gust = SCATTER_DEPTH_FIELDS['uWindGust']?.offset ?? -4;
    expect(written[gust / 4]).not.toBe(written[stride + gust / 4]);

    /* And the two draws address those two slots rather than both reading offset zero. */
    const offsets = pass.setBindGroup.mock.calls
      .map((call) => (call[2] as number[] | undefined)?.[0])
      .filter((offset): offset is number => typeof offset === 'number');
    expect(new Set(offsets).size).toBeGreaterThan(1);
  });

  it('keeps the faces the light sees, whichever way its projection winds them', () => {
    const { surface, device } = stubSurface();
    const renderer = new WebGPURenderer(surface, resolveRenderQuality({}));
    const mesh = {
      key: 'flat:s0:u0',
      vertexBuffers: [{ label: 'vertices' }, { label: 'constants' }],
      indexBuffer: { label: 'indices' },
      indexCount: 3,
      /* A real mesh says whether its geometry has landed, and nothing incomplete is drawn. */
      complete: true,
    };

    renderer.beginShadowPass(mat4.create(), 'static');
    renderer.drawShadowCasters((sink) => {
      sink.mesh(mesh as never, mat4.create());
    });
    renderer.endShadowPass();

    const written = new Float32Array(ringUpload(device, 'shadow.drawRing'));
    const yScale = written[DEPTH_VERT_FIELDS.uLightViewProj.offset / 4 + 5];
    const descriptor = device.createRenderPipeline.mock.calls
      .map((call) => call[0])
      .find((call) => String(call.label).startsWith('depth|'));

    expect(descriptor?.primitive?.cullMode).toBe('back');
    /* Y preserved: the light's own front faces reach the rasteriser clockwise. Y negated: they
       reach it counter-clockwise, which is the default and what every presented pass wants. */
    expect(descriptor?.primitive?.frontFace).toBe(yScale > 0 ? 'cw' : 'ccw');
  });

  /*
   * **The volume projects with the light matrix the scene built, not the one the map was
   * rendered with.** They differ by `SHADOW_CLIP_CORRECTION`, and `sunReach` is `flat.ts`'s
   * lookup — `p * 0.5 + 0.5` on all three axes, the OpenGL convention — so handing it the
   * corrected matrix mirrors and rescales every bar a shaft carries. The same mistake in the
   * flat pass cost a day and produced something that still looked like shadows.
   *
   * With an identity light matrix the corrected one is `SHADOW_CLIP_CORRECTION` itself, so the
   * depth row is what separates them: 1 and 0 uncorrected, 0.5 and 0.5 corrected.
   */
  it('gives a light volume the uncorrected light matrix to project with', () => {
    const { surface, device } = stubSurface();
    const renderer = new WebGPURenderer(surface, resolveRenderQuality({}));
    const { env } = stubScene();
    const mesh = {
      key: 'flat:s0:u0',
      vertexBuffers: [{ label: 'vertices' }],
      indexBuffer: { label: 'indices' },
      indexCount: 3,
      /* A real mesh says whether its geometry has landed, and nothing incomplete is drawn. */
      complete: true,
    };

    renderer.beginFrame([0, 0, 0]);
    renderer.drawLightVolume(
      mesh as never,
      mat4.create(),
      { viewProjection: mat4.create(), position: new Float32Array([0, 0, -5]) } as never,
      0.7,
      20,
      0.5,
      { sunShadow: 0.85, env: { ...(env as object), lightViewProj: mat4.create() } as never },
    );
    renderer.endFrame();

    /* By label: the composite writes its own blocks after the rings, so "last" is not this. */
    const floats = new Float32Array(ringUpload(device, 'lightVolume.fragRing'));
    const fields = lightVolumeFragmentBindings('directionalShadows').fields;
    const at = (name: string): number => (fields[name]?.offset ?? -4) / 4;

    expect(floats[at('uLightViewProj') + 10]).toBe(1);
    expect(floats[at('uLightViewProj') + 14]).toBe(0);
    expect(floats[at('uSunShadow')]).toBeCloseTo(0.85);
    expect(floats[at('uStrength')]).toBeCloseTo(0.7);
  });

  /*
   * **A point light with no cubemap is index −1, and zero is a real index meaning light 0.**
   *
   * `flat.ts` picks a map with a chain of `i == uPointShadowIndex[k]`, and its own comment
   * says the arms survive compilation precisely because nothing proves every index is −1. So
   * an unwritten array is not "no shadows", it is light zero of every scene reading whatever
   * the stand-in cube holds and calling the result occlusion. That is the shape `uGrain` and
   * `uEmissiveGain` already cost a day each, one permutation further in.
   *
   * Pinned at both guards: the index that selects, and the weight the term is mixed by.
   */
  /*
   * **The ceiling is one backend's and it used to be silent.**
   *
   * `renderer.ts`'s `drawText` has no ceiling — it draws whatever it is handed. This one runs
   * out of uniform ring at `MAX_OVERLAYS` and returned without a word, so a consumer past it got
   * every text object on WebGL2 and the first sixty-four on WebGPU, with a clean console on both.
   * There is nothing in the picture to debug that from: the text is just absent.
   *
   * Its two siblings, `drawSdfText` and `drawLine`, both warn. This asserts that the third one
   * does too, which is the property that was missing rather than the ceiling itself.
   */
  it('says so when a frame runs past the text ceiling, as its siblings do', () => {
    const { surface } = stubSurface();
    const renderer = new WebGPURenderer(surface, resolveRenderQuality({}));
    const { camera, env } = stubScene();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      renderer.beginFrame([0, 0, 0]);
      renderer.bindMeshPass(camera, env);
      const text = renderer.createText();
      renderer.setText(text, 'RING');
      for (let i = 0; i < 80; i++) {
        renderer.drawText(text, 640, 480, 0, 0, { ...DEFAULT_TEXT_STYLE, alpha: 1 }, 0);
      }
      const said = warn.mock.calls.some((c) => String(c[0]).includes('text draws in a frame'));
      expect(said, 'the ceiling is announced rather than silently applied').toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  /*
   * **And the panels, which had neither the warning nor a line.** `fillPanel` takes a slot of the
   * same `MAX_OVERLAYS` ring its text and line siblings do, and past it returned without a word, so
   * an interface drawn of panels lost everything after its sixty-fourth on this backend and nothing
   * on WebGL2. Found by an editor on the native host whose props stopped being drawn after the
   * second.
   */
  it('counts the panels a frame asks for and says once when it runs past the ceiling', () => {
    const { surface } = stubSurface();
    const renderer = new WebGPURenderer(surface, resolveRenderQuality({}));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const panels = renderer.frameBudget.lines.find((line) => line.name === 'panels');
      const ceiling = panels?.ceiling ?? 0;
      for (let frame = 0; frame < 2; frame += 1) {
        renderer.beginFrame([0, 0, 0]);
        for (let i = 0; i < ceiling + 16; i++) {
          renderer.fillPanel({ left: i, top: 0, width: 1, height: 1 }, [1, 1, 1], 1);
        }
      }
      expect(panels?.used).toBe(ceiling + 16);
      expect(panels?.dropped).toBe(16);
      expect(renderer.frameBudget.dropped).toBe(true);
      const said = warn.mock.calls.filter((c) => String(c[0]).includes('panels in a frame'));
      expect(said.length, 'announced, and once rather than every frame').toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('claims no shadow layer for any point light until the maps exist', () => {
    const { surface, device } = stubSurface();
    const quality = resolveRenderQuality({ pointShadows: true });
    const renderer = new WebGPURenderer(surface, quality);
    const { camera, env } = stubScene();

    renderer.bindMeshPass(camera, env);

    const staging = materialBlock(renderer, device);
    const fields = flatFragmentBindings(variantFor(quality)).fields;
    const layers = fields['uPointShadowLayer'];
    const weights = fields['uPointShadowWeight'];
    if (layers?.stride === undefined || weights?.stride === undefined) {
      throw new Error('the point-shadow arrays are not in this variant');
    }
    const ints = new Int32Array(staging);
    const floats = new Float32Array(staging);

    /*
     * −1 and not 0, and the sentinel matters more than it used to: this was a *slot* index,
     * where zero was often an empty slot, and it is a *layer* now, where zero is always
     * allocated and belongs to a live transition map. An unwritten array would put every light
     * in the scene on one lamp's shadow rather than on nothing.
     */
    for (let light = 0; light < (layers.length ?? 0); light++) {
      expect(ints[(layers.offset + light * layers.stride) / 4]).toBe(-1);
      expect(floats[(weights.offset + light * weights.stride) / 4]).toBe(0);
    }
  });

  /**
   * **Text builds its own clip position, so nothing else can correct it.**
   *
   * Every other draw meets `CLIP_CORRECTION` inside a view-projection. This one multiplies by
   * no camera at all — it goes from pixels straight to NDC — which is the gap that left the sky
   * unprojecting through the wrong space. Two things break without the correction and only one
   * is visible: the generated vertex shader negates Y, so the message renders upside down; and
   * `depth` here is a narrow slice about zero, inside OpenGL's [-1, 1] and outside WebGPU's
   * [0, 1], so half of every glyph is clipped away.
   *
   * Pinned by the two rows that differ from identity: Y at -1, and the depth row at 0.5/0.5.
   */
  it('gives text the clip correction, because no matrix reaches it', () => {
    const { surface, device } = stubSurface();
    const renderer = new WebGPURenderer(surface, resolveRenderQuality({}));
    const text = renderer.createText();
    renderer.setText(text, 'A');

    renderer.beginFrame([0, 0, 0]);
    renderer.drawText(text, 1280, 720, 10, 20, DEFAULT_TEXT_STYLE, 0);
    renderer.endFrame();

    const at = (name: string): number => (TEXT_VERT_FIELDS[name]?.offset ?? -4) / 4;
    /* By label, because every ring uploads its whole staging and they are the same size. */
    const upload = device.queue.writeBuffer.mock.calls
      .filter((call: unknown[]) => (call[0] as { label?: string }).label === 'text.vertRing')
      .at(-1);
    const floats = new Float32Array(upload?.[2] as ArrayBuffer);
    const correction = floats.subarray(at('uClipCorrection'), at('uClipCorrection') + 16);

    expect(correction?.[5]).toBe(-1);
    /* The depth row follows the convention: reversed depth negates the scale so the near plane
       lands at 1. The offset does not move. */
    expect(correction?.[10]).toBe(REVERSED_DEPTH ? -0.5 : 0.5);
    expect(correction?.[14]).toBe(0.5);
  });

  /**
   * **Material state is per draw, and one buffer cannot hold two answers.**
   *
   * `setSurfaceGrain` and its siblings are *pass state*: a material covers many draws, and a
   * scene changes material between them. On WebGL2 that is a `uniform1f` and it lands
   * immediately. Here the terms live in the fragment block, and `queue.writeBuffer` does not
   * interleave with recorded commands — so a single block rewritten between two draws gives
   * **both** the second value. That is bug 7 exactly, the one that left a flame leaning forty
   * degrees in still air, and it would show up as every surface in a scene wearing the last
   * material set.
   *
   * So the block is a ring and a draw binds its own slot. Two draws, two grains, two values.
   */
  it('gives two draws their own material, not the last one set', () => {
    const { surface, device } = stubSurface();
    const renderer = new WebGPURenderer(surface, resolveRenderQuality({}));
    const { camera, env } = stubScene();
    const mesh = stubMesh(renderer);

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.setSurfaceGrain(0.25);
    renderer.drawMesh(mesh, mat4.create());
    renderer.setSurfaceGrain(0.75);
    renderer.drawMesh(mesh, mat4.create());
    renderer.endFrame();

    const upload = device.queue.writeBuffer.mock.calls
      .filter((call: unknown[]) => (call[0] as { label?: string }).label === 'flat.fragRing')
      .at(-1);
    const floats = new Float32Array(upload?.[2] as ArrayBuffer);
    const bindings = flatFragmentBindings(variantFor(resolveRenderQuality({})));
    const grain = (bindings.fields['uGrain']?.offset ?? 0) / 4;
    /* Slots are 256-byte aligned, so the second draw's block starts a whole slot along. */
    const slotFloats = (Math.ceil(bindings.uniformSize / 256) * 256) / 4;

    expect(floats[grain]).toBeCloseTo(0.25);
    expect(floats[slotFloats + grain]).toBeCloseTo(0.75);
  });

  /**
   * **Added light fades in the medium; it is never mixed toward the medium's colour.** Mixed and
   * then added, a glow puts the haze into the frame a second time — grey cones under every street
   * lamp on a hazy morning. See `drawFog.ts`. The shader fades where `uFogEnabled` is 2, so each
   * draw's own material slot has to say so, single and instanced, and the pass's own 1 has to come
   * back for the draw after.
   */
  it('ADDS LIGHT THAT FADES IN THE MEDIUM, single and instanced, and puts the surface rule back', () => {
    const { surface, device } = stubSurface();
    const quality = resolveRenderQuality({});
    const renderer = new WebGPURenderer(surface, quality);
    const { camera, env } = stubScene();
    const mesh = stubMesh(renderer);
    const batch = renderer.createInstanced(mesh, 2);
    const placed = createMeshInstances(2);
    placed.count = 1;

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.drawTranslucentMesh(mesh, mat4.create(), 1, { additive: true });
    renderer.drawTranslucentMesh(mesh, mat4.create(), 1, { additive: true, fog: false });
    renderer.drawTranslucentMesh(mesh, mat4.create(), 1);
    renderer.drawTranslucentInstanced(batch, placed, 1, { additive: true });
    renderer.drawTranslucentMesh(mesh, mat4.create(), 1);
    renderer.endFrame();

    const upload = device.queue.writeBuffer.mock.calls
      .filter((call: unknown[]) => (call[0] as { label?: string }).label === 'flat.fragRing')
      .at(-1);
    const ints = new Int32Array(upload?.[2] as ArrayBuffer);
    const bindings = flatFragmentBindings(variantFor(quality));
    const fog = (bindings.fields['uFogEnabled']?.offset ?? 0) / 4;
    const slotInts = (Math.ceil(bindings.uniformSize / 256) * 256) / 4;
    /* Each draw with options of its own takes a slot, and so does the plain draw after it. */
    expect(
      [0, 1, 2, 3, 4].map((slot) => ints[slot * slotInts + fog]),
      'faded, out of the medium, a surface, faded, a surface',
    ).toEqual([2, 0, 1, 2, 1]);
  });

  /**
   * **The restore has to run even when the draw itself could not.**
   *
   * `materialSlotForDraw` returns null once the material ring's 256 slots are gone, and an early
   * `return` on that null used to skip the two lines putting `uLightingEnabled`/`uFogEnabled`
   * back — because those live in `perFrameFloats`/`perFrameInts`, the *cumulative* scratch block
   * every draw's own dirty-then-restore pair shares for the rest of the frame. Fix round 1 on
   * Task E1: the reviewer traced this exactly, and noted `dimmed`/`uOpacity` had the identical
   * shape from the original commit.
   *
   * **There is no black-box way to watch this from outside**, which is worth stating rather than
   * pretending otherwise. `UniformRing.allocate()` never recovers mid-frame — it only resets in
   * `beginFrame` — so a draw whose own allocation fails is *skipped* (no `setPipeline`, no
   * `drawIndexed`) in both the buggy code and the fixed one, and every draw after it fails the
   * same allocation for the same reason: nothing renders visibly wrong, because nothing renders
   * at all past that point in the frame. And the very next `bindMeshPass` call would mask a leak
   * anyway, since it rewrites both fields unconditionally. So this reads the scratch state
   * directly — the only way to prove the restore ran rather than trust it by inspection.
   */
  it('restores uLightingEnabled/uFogEnabled even when the material ring is exhausted', () => {
    const { surface } = stubSurface();
    const quality = resolveRenderQuality({});
    const renderer = new WebGPURenderer(surface, quality);
    const { camera, env } = stubScene();
    const mesh = stubMesh(renderer);
    const bindings = flatFragmentBindings(variantFor(quality));
    const uLightingEnabled = (bindings.fields['uLightingEnabled']?.offset ?? 0) / 4;

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    /*
     * 256 distinct unlit draws, one slot each: the dirty-then-restore pair invalidates the
     * cached slot both before and after every call, so each takes a fresh one rather than
     * reusing the last — exactly the shape 39 cover quads at four frame boxes each, the glow
     * shells and the backdrop planes take, per the reviewer's count.
     */
    const materialRingCapacity = materialCeiling(renderer);
    for (let i = 0; i < materialRingCapacity; i++) {
      renderer.drawTranslucentMesh(mesh, mat4.create(), 1, { lit: false });
    }
    /* The 257th: the ring has nothing left, `materialSlotForDraw` returns null, and this draw's
       own dirtying (`uLightingEnabled` set to 0) is the one that has to be put back regardless
       of whether a slot existed to draw it with. */
    renderer.drawTranslucentMesh(mesh, mat4.create(), 1, { lit: false });

    const scratch = (renderer as unknown as { perFrameInts: Int32Array }).perFrameInts;
    expect(
      scratch[uLightingEnabled],
      'the scratch default is restored, not left dirtied at 0',
    ).toBe(1);
    const materialSlot = (renderer as unknown as { materials: { slot: number } }).materials.slot;
    expect(
      materialSlot,
      'the cache is invalidated too, so the next successful draw takes a fresh slot ' +
        'rather than one still holding the unlit value',
    ).toBe(-1);
  });

  /**
   * The same trap, for the third switch, and it is worth its own test rather than a line in the
   * one above.
   *
   * `toneMapped: false` dirties `uOutputTransform` down to sRGB alone, and that field is not
   * like the other two: `uLightingEnabled` and `uFogEnabled` leaking would draw the rest of the
   * frame flat, which reads as a renderer fault and gets found. `uOutputTransform` leaking draws
   * the rest of the frame *ungraded*, which is the failure this release just spent a fix on and
   * which reads as a slightly different colour rather than as a fault.
   */
  it('restores uOutputTransform even when the material ring is exhausted', () => {
    const { surface } = stubSurface();
    const quality = resolveRenderQuality({ outputTransform: 'aces' });
    const renderer = new WebGPURenderer(surface, quality);
    const { camera, env } = stubScene();
    const mesh = stubMesh(renderer);
    const bindings = flatFragmentBindings(variantFor(quality));
    const uOutputTransform = (bindings.fields['uOutputTransform']?.offset ?? 0) / 4;

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    for (let i = 0; i < materialCeiling(renderer); i++) {
      renderer.drawTranslucentMesh(mesh, mat4.create(), 1, { toneMapped: false });
    }
    renderer.drawTranslucentMesh(mesh, mat4.create(), 1, { toneMapped: false });

    const scratch = (renderer as unknown as { perFrameInts: Int32Array }).perFrameInts;
    expect(
      scratch[uOutputTransform],
      'the frame is graded again after the draw that asked not to be',
    ).toBe(2);
  });

  /**
   * **A translucent draw at full opacity is still a translucent draw**, and the difference is the
   * whole of what `drawTranslucentMesh` means for a textured quad.
   *
   * `uOpacity` is one of the two things multiplied into `outColor.a`; the other is the bound
   * texture's own alpha, and a caller passing 1 is saying *the coverage is in the image*. That is
   * a caption, a decal, a painted shadow, a glow — the shape lives in the alpha channel and the
   * draw has nothing to dim. Choosing the pipeline from the opacity alone reads that as opaque,
   * and an unblended pass writes every texel the cutout kept at full strength: the soft edge of a
   * blurred shadow comes out as a solid slab bounded by the cutout's iso-contour. Measured on Drift
   * Cut's cover visualizer, where the caption's shadow drew as a hard black outline around every
   * letter and the same frame on `?backend=webgl2` had none.
   *
   * WebGL2's `drawTranslucentMesh` enables `BLEND` before the draw and disables it after, without
   * consulting the opacity, which is the behaviour this matches. The blend belongs to the *entry
   * point* rather than to the number it was handed.
   */
  it('blends a translucent draw whose coverage is the texture, not the opacity', () => {
    const { surface, pass } = stubSurface();
    const renderer = new WebGPURenderer(surface, resolveRenderQuality({}));
    const { camera, env } = stubScene();
    const mesh = stubMesh(renderer);

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    /* Taken rather than assumed: `endFrame` composites through pipelines of its own. */
    const before = pass.setPipeline.mock.calls.length;
    renderer.drawTranslucentMesh(mesh, mat4.create(), 1);
    renderer.endFrame();

    const drawn = pass.setPipeline.mock.calls
      .slice(before, before + 1)
      .map((call) => (call[0] as { descriptor: GPURenderPipelineDescriptor }).descriptor)[0];
    const target = [...(drawn?.fragment?.targets ?? [])][0];

    expect(String(drawn?.label), 'the opaque pipeline was taken').toContain('|blend');
    expect(target?.blend?.color).toEqual({
      srcFactor: 'src-alpha',
      dstFactor: 'one-minus-src-alpha',
      operation: 'add',
    });
  });

  it('disposes the surface it was given', () => {
    const { surface } = stubSurface();
    const renderer = new WebGPURenderer(surface);

    renderer.dispose();

    expect(surface.dispose).toHaveBeenCalledTimes(1);
  });
});

/*
 * `beginInset` returns an **aspect**, and returning anything else is undetectable.
 *
 * It answered the viewport's height in device pixels, and both that and the aspect are a
 * `number`, so the shared surface could not catch it and neither could a consumer. What a caller
 * does with it is documented on `Renderer.beginInset` and is the only sensible thing:
 * `camera.updateMatrices(renderer.beginInset(rect, colour))`. A portrait 240 pixels tall then
 * composed for an aspect of 240 rather than 4/3, so the figure it was aiming at landed off the
 * side of a projection squeezed flat and the box filled with unrecognisable geometry. Reported
 * from the game against the character replica and the display showcase, which are both of the places
 * it draws an inset.
 */
/*
 * **A dynamic mesh and a static one with the same attributes do not share a pipeline.** The dynamic
 * one binds its positions and normals as buffers of their own, four buffers where the static one
 * binds two, so its key says so and its pipelines read positions at a stride of twelve from buffer 0.
 * Without the key the second mesh created would draw through the first one's pipeline, and the
 * device would refuse every draw of one of them.
 */
describe('a dynamic mesh', () => {
  it('IS KEYED APART FROM ITS STATIC TWIN, AND ITS PIPELINES READ FOUR BUFFERS', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub);
    const data = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
      colors: new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]),
      emissive: new Float32Array([0, 0, 0]),
      indices: new Uint32Array([0, 1, 2]),
    };
    const built = (): GPURenderPipelineDescriptor[] =>
      stub.device.createRenderPipeline.mock.calls.map(([descriptor]) => descriptor);
    const still = renderer.createMesh(data as never) as unknown as { key: string };
    const before = built().length;
    const moving = renderer.createMesh(data as never, { dynamic: true }) as unknown as {
      key: string;
    };
    expect(moving.key).not.toBe(still.key);
    expect(moving.key).toContain(':dynamic');
    const flat = built()
      .slice(before)
      .filter((descriptor) => (descriptor.label ?? '').includes('|flat'));
    expect(flat.length, 'the dynamic mesh warmed pipelines of its own').toBeGreaterThan(0);
    for (const descriptor of flat) {
      const buffers = [...(descriptor.vertex.buffers ?? [])];
      expect(buffers).toHaveLength(4);
      expect(buffers[0]?.arrayStride).toBe(12);
    }

    /* And a pass that recovers the layout from the key, as the shadow pass does, reads four too. */
    const cast = built().length;
    renderer.beginShadowPass(new Float32Array(16), 'static');
    renderer.drawShadowCasters((sink) => sink.mesh(moving as never, new Float32Array(16)));
    renderer.endShadowPass();
    const depth = built()
      .slice(cast)
      .filter((descriptor) => (descriptor.label ?? '').includes(':dynamic'));
    expect(depth.length, 'the shadow pass built a pipeline for it').toBeGreaterThan(0);
    for (const descriptor of depth) expect([...(descriptor.vertex.buffers ?? [])]).toHaveLength(4);
  });
});

describe('drawing after endFrame', () => {
  /**
   * **Every pipeline set in the reopened pass must match that pass, and the pass is the canvas.**
   *
   * An application is allowed to draw its interface after `endFrame` and one does: a consumer puts
   * its announcements, its character portrait and its display cases there so the interface escapes the
   * screen-space chain that samples the scene target. `ensurePass` reopens on the canvas for that
   * reason — one sample, the surface format — while the world's pipelines are built for wherever
   * the world lands, which under a composite at `sceneSamples: 4` is neither.
   *
   * WebGPU rejects the disagreement at `finish` and drops the **whole** command buffer, so the
   * failure is a missing overlay from a frame that recorded correctly. Measured on
   * `overlay.html?after=1&samples=4`, where the device said exactly this and nothing else did:
   *
   *     Attachment state of [RenderPipeline "inset|color"] is not compatible with
   *     [RenderPassEncoder "overlay"]. [RenderPassEncoder "overlay"] expects ... sampleCount: 1
   *     [RenderPipeline "inset|color"] has ... sampleCount: 4
   *
   * Asserted over *whatever* was set rather than over a list of the four paths that exist today,
   * because the next draw call reachable after `endFrame` is the one that will be forgotten. The
   * stub's surface is `bgra8unorm` against a `rgba8unorm` scene target, so the format axis is
   * live here too — that is the pairing no machine in this repository has to test it.
   */
  it('sets pipelines built for the canvas, not for the scene target', () => {
    const stub = stubSurface();
    /* The direct path: the recorded one is covered by "replays a draw recorded after the frame". */
    const quality = resolveRenderQuality({ sceneSamples: 4, frameGraph: false });
    const renderer = freshRenderer(stub, quality);
    const { camera, env } = stubScene();
    const mesh = stubMesh(renderer);
    const text = renderer.createText();
    renderer.setText(text, 'RUIN FOUND');
    const rect = { left: 8, top: 8, width: 120, height: 90 };

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(mesh, mat4.create());
    renderer.endFrame();

    /* Everything from here is the overlay's. The composite sets pipelines of its own inside
       `endFrame`, so the boundary is taken rather than assumed. */
    const beforeOverlay = stub.pass.setPipeline.mock.calls.length;
    renderer.beginInset(rect, [0, 0.16, 0.1]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(mesh, mat4.create());
    renderer.drawTranslucentMesh(mesh, mat4.create(), 0.5);
    renderer.endInset();
    renderer.fillPanel(rect, [1, 1, 1], 0.5);
    renderer.drawText(text, 1280, 720, 10, 20, DEFAULT_TEXT_STYLE, 0);

    const overlay = stub.pass.setPipeline.mock.calls
      .slice(beforeOverlay)
      .map((call) => (call[0] as { descriptor: GPURenderPipelineDescriptor }).descriptor);

    expect(overlay.length, 'nothing was drawn, so this asserts nothing').toBeGreaterThanOrEqual(5);
    /* The depth `ensurePass` built, read back rather than restated: it is the other half of the
       attachment state, and a four-sample depth beside a one-sample colour is its own rejection. */
    const overlayDepth = stub.device.createTexture.mock.calls
      .map(([descriptor]) => descriptor)
      .find((descriptor) => descriptor.label === 'overlay.depth');
    expect(overlayDepth?.sampleCount).toBe(1);

    for (const descriptor of overlay) {
      const target = [...(descriptor.fragment?.targets ?? [])][0];
      expect(target?.format, `${String(descriptor.label)} writes the wrong format`).toBe(
        'bgra8unorm',
      );
      expect(
        descriptor.multisample?.count ?? 1,
        `${String(descriptor.label)} rasterises wide`,
      ).toBe(1);
      expect(descriptor.depthStencil?.format).toBe(overlayDepth?.format);
    }
  });

  /**
   * The other half, and the one that makes the test above mean something: the *world* still
   * targets the world. A fix that pointed everything at the canvas would satisfy the assertions
   * above and quietly undo the 2026-08-14 rule that put the format on the cache.
   */
  it('leaves the world drawing into the scene target it was built for', () => {
    const stub = stubSurface();
    const quality = resolveRenderQuality({ sceneSamples: 4, frameGraph: false });
    const renderer = freshRenderer(stub, quality);
    const { camera, env } = stubScene();
    const mesh = stubMesh(renderer);

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(mesh, mat4.create());
    const [world] = stub.pass.setPipeline.mock.calls.at(-1) as [
      { descriptor: GPURenderPipelineDescriptor },
    ];
    renderer.endFrame();

    expect([...(world.descriptor.fragment?.targets ?? [])][0]?.format).toBe('rgba8unorm');
    expect(world.descriptor.multisample?.count).toBe(4);
  });
});

describe('an inset viewport', () => {
  it('answers the aspect of the pixels it actually got, not their height', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub);
    renderer.beginFrame([0, 0, 0]);

    /* Half the CSS box each way, so the drawing-buffer viewport is 320x240 at this dpr of 2. */
    const aspect = renderer.beginInset({ left: 0, top: 0, width: 160, height: 120 }, [0, 0, 0]);
    renderer.endInset();

    expect(aspect).toBeCloseTo(320 / 240, 5);
    /* The value it used to return, named so a regression reads as itself rather than as a ratio. */
    expect(aspect).not.toBe(240);
  });

  /*
   * **Found by packaging a real game.** A panel that slides in from the left is momentarily
   * partly off the canvas, and this backend passed the negative origin straight to
   * `setScissorRect`, which is `[EnforceRange] unsigned long`: it threw *inside the frame*, so
   * every draw after the inset was lost, on every frame of the animation. WebGL2 takes the same
   * numbers without complaint — `gl.scissor` accepts negatives — which is why nothing had ever
   * shown it.
   */
  it('clamps an inset that hangs off the left edge instead of throwing', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub);
    renderer.beginFrame([0, 0, 0]);

    expect(() =>
      renderer.beginInset({ left: -40, top: -10, width: 160, height: 120 }, null),
    ).not.toThrow();

    const scissor = stub.pass.setScissorRect.mock.calls.at(-1) ?? [];
    expect(scissor[0]).toBeGreaterThanOrEqual(0);
    expect(scissor[1]).toBeGreaterThanOrEqual(0);
    /* Inside the attachment at both ends, which is the other half of what the API requires. */
    expect((scissor[0] ?? 0) + (scissor[2] ?? 0)).toBeLessThanOrEqual(640);
    expect((scissor[1] ?? 0) + (scissor[3] ?? 0)).toBeLessThanOrEqual(480);
    renderer.endInset();
  });

  it('clamps an inset that hangs off the far edge as well', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub);
    renderer.beginFrame([0, 0, 0]);

    renderer.beginInset({ left: 300, top: 220, width: 160, height: 120 }, null);

    const scissor = stub.pass.setScissorRect.mock.calls.at(-1) ?? [];
    expect((scissor[0] ?? 0) + (scissor[2] ?? 0)).toBeLessThanOrEqual(640);
    expect((scissor[1] ?? 0) + (scissor[3] ?? 0)).toBeLessThanOrEqual(480);
    renderer.endInset();
  });

  /*
   * Entirely outside is not a rectangle to clamp, it is nothing to draw. Setting a zero-width
   * scissor is itself invalid, so the pass is left alone — and the aspect still answers what the
   * caller asked for, because its camera should not lurch when a panel finishes leaving.
   */
  it('draws nothing, and does not touch the pass, for an inset that is entirely off screen', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub);
    renderer.beginFrame([0, 0, 0]);
    const before = stub.pass.setScissorRect.mock.calls.length;

    const aspect = renderer.beginInset({ left: -400, top: 0, width: 160, height: 120 }, null);

    expect(stub.pass.setScissorRect.mock.calls.length).toBe(before);
    expect(aspect).toBeCloseTo(320 / 240, 5);
    renderer.endInset();
  });

  /*
   * **An aspect is the one answer, whatever the device is doing.** With the device gone there is
   * no pass to set a viewport on, and this returned 0 — which a caller hands to
   * `camera.updateMatrices` as the documentation tells it to, and a zero aspect is a projection
   * full of infinities. WebGL2 has no such branch and always answers the ratio.
   */
  it('answers the aspect of the box it was asked for when the device is gone', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub);
    stub.markLost();

    const aspect = renderer.beginInset({ left: 0, top: 0, width: 160, height: 120 }, null);
    renderer.endInset();

    expect(aspect).toBeCloseTo(4 / 3, 5);
  });

  it('answers a square inset with a square aspect', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub);
    renderer.beginFrame([0, 0, 0]);

    const aspect = renderer.beginInset({ left: 20, top: 20, width: 100, height: 100 }, null);
    renderer.endInset();

    expect(aspect).toBeCloseTo(1, 5);
  });
});

/*
 * **A view model's draws land in the nearest sliver of depth, and the range is handed back.** The
 * viewport's depth bounds are pass state, applied when a draw is issued, so both ends are a
 * boundary of the frame graph exactly as an inset's are. Reversed depth on this backend always, so
 * the near end is 1.
 */
describe('a view model', () => {
  it('squeezes the depth of what is drawn between its two calls into the near end', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub);
    renderer.beginFrame([0, 0, 0]);

    renderer.beginViewModel();
    const squeezed = stub.pass.setViewport.mock.calls.at(-1) ?? [];
    expect(squeezed[4]).toBeCloseTo(0.99, 6);
    expect(squeezed[5]).toBe(1);

    renderer.endViewModel();
    const handed = stub.pass.setViewport.mock.calls.at(-1) ?? [];
    expect([handed[4], handed[5]]).toEqual([0, 1]);
  });
});

/**
 * What a tile-based GPU is charged for, which a desktop one hides completely.
 *
 * Measured on the consumer at a phone viewport (824x1830, four samples): 388.7 MB of
 * attachment load and store per frame, of which 161 MB went to textures created with
 * `RENDER_ATTACHMENT` usage and nothing else — so no shader on either backend is able to read
 * them. On a tiler that traffic is the frame, and none of it buys a pixel.
 *
 * These assert the descriptors rather than a picture, because a picture cannot show the
 * difference: `discard` is correct precisely when the stored copy is one nothing sampled.
 */
describe('what a pass keeps when it ends', () => {
  it('discards the mirror it resolves, which nothing reopens', () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({
        sceneSamples: 4,
        water: true,
        waterReflections: true,
        discardResolvedAttachments: true,
      }),
    );
    const scene = stubScene();
    renderer.resize();

    renderer.beginFrame([0, 0, 0]);
    renderer.beginPlanarReflection(scene.camera, 0, [0, 0, 0]);
    renderer.endPlanarReflection();
    renderer.endFrame();

    const mirrors = stub.encoder.beginRenderPass.mock.calls
      .map(([descriptor]) => descriptor)
      .filter((descriptor) => String(descriptor.label ?? '') === 'reflection')
      .flatMap((descriptor) => [...(descriptor.colorAttachments ?? [])])
      .filter((attachment) => attachment?.resolveTarget !== undefined);

    expect(mirrors.length, 'the mirror must resolve, or this asserts nothing').toBeGreaterThan(0);
    for (const attachment of mirrors) {
      expect(
        attachment?.storeOp,
        'the mirror resolves once and is then sampled; its four samples are never read',
      ).toBe('discard');
    }
  });

  /**
   * **The rule that cost two black scenes.**
   *
   * `discard` is sound only where nothing loads the attachment back. This backend reopens the
   * frame's own pass with `loadOp: 'load'` — for the mirror, the light volume's depth snapshot
   * and text — so discarding there hands the reopened pass undefined contents. Applied to the
   * frame attachment, the gilded chamber went from mean luminance 37.2 to 3.3 and the storm at
   * sea from 50.7 to 4.4.
   *
   * This asserts the constraint rather than the saving, so that removing the reopens and
   * flipping these to `discard` is a change that has to come to this test and say so.
   */
  it('keeps the frame attachment, because a reopened pass loads it back', () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({ sceneSamples: 4, screenEffects: true }),
    );
    const scene = stubScene();
    const mesh = stubMesh(renderer);

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(scene.camera, scene.env);
    renderer.drawMesh(mesh, mat4.create());
    renderer.endFrame();

    const frames = stub.encoder.beginRenderPass.mock.calls
      .map(([descriptor]) => descriptor)
      .filter((descriptor) => String(descriptor.label ?? '').startsWith('frame'))
      .flatMap((descriptor) => [...(descriptor.colorAttachments ?? [])])
      .filter((attachment) => attachment?.resolveTarget !== undefined);

    expect(frames.length, 'the frame must resolve, or this asserts nothing').toBeGreaterThan(0);
    for (const attachment of frames) expect(attachment?.storeOp).toBe('store');
  });

  it('keeps the single-sample colour it resolves into, which is the one that is read', () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = freshRenderer(stub, resolveRenderQuality({ sceneSamples: 1 }));
    const scene = stubScene();

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(scene.camera, scene.env);
    renderer.endFrame();

    const plain = stub.encoder.beginRenderPass.mock.calls
      .map(([descriptor]) => descriptor)
      .flatMap((descriptor) => [...(descriptor.colorAttachments ?? [])])
      .filter((attachment) => attachment !== null && attachment?.resolveTarget === undefined);

    expect(plain.length, 'a one-sample profile still has colour to keep').toBeGreaterThan(0);
    for (const attachment of plain) expect(attachment?.storeOp).toBe('store');
  });

  it('discards the depth of the mirror, which is a render attachment and nothing else', () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({
        water: true,
        waterReflections: true,
        discardResolvedAttachments: true,
      }),
    );
    const scene = stubScene();
    /* The mirror is allocated from the drawing buffer, so it does not exist until a resize. */
    renderer.resize();

    renderer.beginFrame([0, 0, 0]);
    renderer.beginPlanarReflection(scene.camera, 0, [0, 0, 0]);
    renderer.endPlanarReflection();
    renderer.endFrame();

    const mirrors = stub.encoder.beginRenderPass.mock.calls
      .map(([descriptor]) => descriptor)
      .filter((descriptor) => String(descriptor.label ?? '') === 'reflection');

    expect(mirrors.length, 'the mirror must have opened, or this asserts nothing').toBeGreaterThan(
      0,
    );
    for (const mirror of mirrors) {
      expect(
        mirror.depthStencilAttachment?.depthStoreOp,
        'reflection.depth sorts the mirror’s own draws and is never sampled',
      ).toBe('discard');
    }
  });

  it('keeps the shadow depth, which is the whole point of drawing it', () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = freshRenderer(stub, resolveRenderQuality({ directionalShadows: true }));

    expect(renderer.beginShadowPass(mat4.create(), 'static')).toBe(true);
    renderer.endShadowPass();

    const shadows = stub.encoder.beginRenderPass.mock.calls
      .map(([descriptor]) => descriptor)
      .filter((descriptor) => String(descriptor.label ?? '').startsWith('shadow.'));

    expect(shadows.length).toBeGreaterThan(0);
    for (const pass of shadows) {
      expect(
        pass.depthStencilAttachment?.depthStoreOp,
        'a shadow map that is discarded is a shadow map nothing can sample',
      ).toBe('store');
    }
  });
});

/**
 * The capability clamp, which this backend reported as never having fired because it could not.
 *
 * `rendererName` was the literal string `WebGPU`, so `isWeakGpuFamily` had nothing to match and
 * `capabilityClamp: true` from a consumer was silently inert — on the backend that replaced the
 * one where the clamp had rescued an Adreno 619 from 156 ms a frame.
 */
describe('the capability clamp on WebGPU', () => {
  it('lowers the pixel terms on a part the table recognises', () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = new WebGPURenderer(
      stub.surface,
      resolveRenderQuality({
        maxDevicePixelRatio: 2.625,
        waterReflectionScale: 1,
        capabilityClamp: true,
      }),
      'ANGLE (Qualcomm, Adreno (TM) 619, OpenGL ES 3.2)',
    );

    expect(renderer.capabilityClamped, 'a 619 is on the weak list').toBe(true);
    expect(renderer.quality.maxDevicePixelRatio).toBe(1);
    expect(renderer.quality.waterReflectionScale).toBe(0.5);
  });

  it('leaves a part it does not recognise entirely alone', () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = new WebGPURenderer(
      stub.surface,
      resolveRenderQuality({ maxDevicePixelRatio: 2, capabilityClamp: true }),
      'Apple M3 Max',
    );

    expect(
      renderer.capabilityClamped,
      'guessing weak on an unknown part would soften every GPU released after the table',
    ).toBe(false);
    expect(renderer.quality.maxDevicePixelRatio).toBe(2);
  });

  it('honours a caller who turned the clamp off, however weak the part', () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = new WebGPURenderer(
      stub.surface,
      resolveRenderQuality({ maxDevicePixelRatio: 2.625, capabilityClamp: false }),
      'ANGLE (Qualcomm, Adreno (TM) 619, OpenGL ES 3.2)',
    );

    expect(
      renderer.capabilityClamped,
      'a player who chose these numbers is entitled to them and to the frame rate with them',
    ).toBe(false);
    expect(renderer.quality.maxDevicePixelRatio).toBe(2.625);
  });

  it('does not clamp when the adapter withheld its name', () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = new WebGPURenderer(
      stub.surface,
      resolveRenderQuality({ capabilityClamp: true }),
    );
    expect(renderer.rendererName).toBe('WebGPU');
    expect(renderer.capabilityClamped).toBe(false);
  });
});

/**
 * A frame that fails must not blank the screen.
 *
 * `getCurrentTexture` is an acquisition, not a read: whatever is in the texture it returns is
 * what the browser presents when the task ends, drawn into or not. `beginFrame` used to take it
 * unconditionally, so every path that acquired and then failed to submit — a lost surface, a
 * null encoder, an exception in the consumer's own frame code — presented an untouched texture.
 * That is a black frame, and it looks exactly like a rendering fault while being nothing of the
 * kind. Reported from a phone as intermittent flashing.
 */
describe('a frame that never finishes', () => {
  it('does not take the swap chain until something is going to draw', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub, resolveRenderQuality({ deferFramePass: true }));
    (stub.surface.context.getCurrentTexture as ReturnType<typeof vi.fn>).mockClear();

    renderer.beginFrame([0, 0, 0]);

    expect(
      (stub.surface.context.getCurrentTexture as ReturnType<typeof vi.fn>).mock.calls.length,
      'beginFrame acquiring is what let a dropped frame present as black',
    ).toBe(0);
  });

  it('takes it by the time the frame is presented', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub);
    (stub.surface.context.getCurrentTexture as ReturnType<typeof vi.fn>).mockClear();

    renderer.beginFrame([0, 0, 0]);
    renderer.endFrame();

    expect(
      (stub.surface.context.getCurrentTexture as ReturnType<typeof vi.fn>).mock.calls.length,
      'a frame that completes still has to present, empty or not',
    ).toBeGreaterThan(0);
  });

  it('leaves the swap chain alone when the surface goes before the frame ends', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub, resolveRenderQuality({ deferFramePass: true }));
    (stub.surface.context.getCurrentTexture as ReturnType<typeof vi.fn>).mockClear();

    renderer.beginFrame([0, 0, 0]);
    stub.markLost();
    renderer.endFrame();

    expect(
      (stub.surface.context.getCurrentTexture as ReturnType<typeof vi.fn>).mock.calls.length,
      'nothing acquired means the browser presents nothing and the last good frame stays up',
    ).toBe(0);
  });

  it('leaves it alone when the consumer never ends the frame at all', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub, resolveRenderQuality({ deferFramePass: true }));
    (stub.surface.context.getCurrentTexture as ReturnType<typeof vi.fn>).mockClear();

    /* What an exception in a consumer's own frame code looks like from here. */
    renderer.beginFrame([0, 0, 0]);

    expect(
      (stub.surface.context.getCurrentTexture as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(0);
  });
});

/**
 * `presentedFrames` is the count an offline export reads to tell a frame that changed the
 * canvas from one that repeated it — see `ExportTarget.duplicateFrame`, which is built on it.
 * It has to agree exactly with the swap-chain acquisition traced above: a count that moved on
 * a frame the browser never actually got new pixels for is indistinguishable, to a consumer
 * comparing two readings of it, from the duplicate frame this counter exists to catch.
 */
describe('presentedFrames', () => {
  it('advances by one for every frame that reaches the swap chain', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub);

    expect(renderer.presentedFrames).toBe(0);

    renderer.beginFrame([0, 0, 0]);
    renderer.endFrame();
    expect(renderer.presentedFrames).toBe(1);

    renderer.beginFrame([0, 0, 0]);
    renderer.endFrame();
    expect(renderer.presentedFrames).toBe(2);
  });

  /*
   * The case this counter exists to get right: a frame with no draw calls in it still clears
   * and presents (see 'clears an empty frame rather than presenting whatever was there' above),
   * so it is not a repeat of the frame before it and must still count.
   */
  it('counts an empty frame, because the canvas still changed', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub);

    renderer.beginFrame([0.4, 0.1, 0.2]);
    renderer.endFrame();

    expect(renderer.presentedFrames).toBe(1);
  });

  /*
   * The failure this test would catch: if the count were bumped in `beginFrame` or `endFrame`
   * instead of at the swap-chain acquisition itself, it would advance here even though the
   * surface being lost mid-frame means `getCurrentTexture` is never called and the browser
   * goes on showing the last good frame — exactly the false "something new was presented"
   * signal that would make a consumer skip encoding a real duplicate.
   */
  it('does not count a frame that dies before the swap chain is taken', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub, resolveRenderQuality({ deferFramePass: true }));

    renderer.beginFrame([0, 0, 0]);
    stub.markLost();
    renderer.endFrame();

    expect(renderer.presentedFrames).toBe(0);
  });

  /* Same failure mode, reached the other way: no `endFrame` at all, as a consumer's own frame
     code throwing between `beginFrame` and `endFrame` would leave things. */
  it('does not count a frame the consumer never finishes', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub, resolveRenderQuality({ deferFramePass: true }));

    renderer.beginFrame([0, 0, 0]);

    expect(renderer.presentedFrames).toBe(0);
  });

  /*
   * Drawing after `endFrame` reopens a pass on the canvas (see 'drawing after endFrame' below)
   * and that reopen calls `swapView` again — it must return the view already taken this frame
   * rather than acquiring a second time, or one presented frame would count twice.
   */
  it('does not double-count a swap chain reopened for an overlay after endFrame', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub);

    renderer.beginFrame([0, 0, 0]);
    renderer.endFrame();
    renderer.drawText(
      renderer.createText(),
      stub.canvas.width,
      stub.canvas.height,
      0,
      0,
      DEFAULT_TEXT_STYLE,
      0,
    );

    expect(renderer.presentedFrames).toBe(1);
  });
});

/**
 * Nothing may end the mirror's pass while the mirror is being drawn.
 *
 * `takeVolumeDepth` and `openTextPass` both end whatever pass is current and reopen on the
 * *composite* target. Called during a planar reflection that ends the mirror's pass, throws
 * away what it held, and sends everything drawn afterwards into the frame — a mirror that is
 * empty and a frame with the mirror's geometry in it.
 *
 * **On an immediate-mode GPU the first half is invisible**, because a discarded attachment has
 * nowhere else to be and keeps its contents regardless; on a tile-based GPU it is precisely
 * what `storeOp: 'discard'` promises. So this is a fault that can only appear on a phone, and
 * the tests for it have to assert the pass structure rather than the picture.
 */
describe('drawing inside the mirror', () => {
  const withMirror = () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({
        water: true,
        waterReflections: true,
        screenEffects: true,
        ambientOcclusion: 0.5,
      }),
    );
    renderer.resize();
    return { stub, renderer, scene: stubScene() };
  };

  const labelsAfter = (stub: ReturnType<typeof stubSurface>) =>
    stub.encoder.beginRenderPass.mock.calls.map(([d]) => String(d.label ?? ''));

  it('does not let a light volume take the mirror away', () => {
    const { stub, renderer, scene } = withMirror();
    const mesh = stubMesh(renderer);

    renderer.beginFrame([0, 0, 0]);
    renderer.beginPlanarReflection(scene.camera, 0, [0, 0, 0]);
    renderer.bindMeshPass(scene.camera, scene.env);
    renderer.drawLightVolume(mesh, mat4.create(), scene.camera, 1, 10, 1);
    renderer.endPlanarReflection();
    renderer.endFrame();

    expect(
      labelsAfter(stub).filter((l) => l === 'volume.depthTaken'),
      'a depth snapshot during the mirror ends the mirror and redirects the rest of it',
    ).toEqual([]);
  });

  it('does not let text take the mirror away', () => {
    const { stub, renderer, scene } = withMirror();

    renderer.beginFrame([0, 0, 0]);
    renderer.beginPlanarReflection(scene.camera, 0, [0, 0, 0]);
    const text = renderer.createText();
    renderer.drawText(text, 320, 240, 0, 0, DEFAULT_TEXT_STYLE, 0);
    renderer.endPlanarReflection();
    renderer.endFrame();

    expect(
      labelsAfter(stub).filter((l) => l === 'text'),
      'a text pass during the mirror ends the mirror and redirects the rest of it',
    ).toEqual([]);
  });

  it('still takes a depth snapshot for a volume drawn outside the mirror', () => {
    const { stub, renderer, scene } = withMirror();
    const mesh = stubMesh(renderer);

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(scene.camera, scene.env);
    renderer.drawLightVolume(mesh, mat4.create(), scene.camera, 1, 10, 1);
    renderer.endFrame();

    expect(
      labelsAfter(stub).filter((l) => l === 'volume.depthTaken').length,
      'the guard must be about the mirror, not about volumes',
    ).toBeGreaterThan(0);
  });
});

/**
 * Two particle batches of one material, drawn in the same frame, used to draw whichever one's
 * uniforms were written last — for *both* of them.
 *
 * The bug: `createParticles` used to resolve a single, material-keyed `ParticleResources`
 * (one uniform buffer pair, one bind group) shared by every batch naming that material.
 * WebGL2's `gl.uniform*`/`gl.draw*` run synchronously in call order, so a shared location
 * always held whatever the draw right after it wrote — invisible there. WebGPU records every
 * `drawParticles` call into one open encoder and does not submit it until `endFrame`, so every
 * `device.queue.writeBuffer` aimed at that one shared buffer completes before any of the
 * encoder's draws run at all; by the time the GPU actually executes them, the buffer holds only
 * the *last* JS-side write. Two `'mote'` batches — a near field left `fog` unset and a far one
 * at `{ fog: true }`, exactly the shape this material exists to let a caller ask for — drew
 * identically on WebGPU, both taking whichever batch happened to upload last, while WebGL2 drew
 * them correctly. `demo/dev/particles.ts` is where this was first seen, on real hardware: the
 * near clump vanished and the far pair stopped disagreeing about fog.
 */
describe('particle batches', () => {
  it('shares one bind group layout per material but gives every batch its own uniform buffers, staging and bind group', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub);
    const layoutCallsBefore = stub.device.createBindGroupLayout.mock.calls.length;

    const near = renderer.createParticles(4, { material: 'mote', blend: 'alpha' });
    const far = renderer.createParticles(4, { material: 'mote', blend: 'alpha', fog: true });

    /* Structural, not data: one layout built for the material, reused by the second batch. */
    expect(stub.device.createBindGroupLayout.mock.calls.length).toBe(layoutCallsBefore + 1);

    /* Everything that carries a value is each batch's own — the property the shared cache
       broke. Reference inequality alone proves neither batch's `writeBuffer` can reach the
       other's buffer, regardless of draw order or how many frames run. */
    expect(near.instances).not.toBe(far.instances);
    expect(near.vertUniforms).not.toBe(far.vertUniforms);
    expect(near.fragUniforms).not.toBe(far.fragUniforms);
    expect(near.bindGroup).not.toBe(far.bindGroup);
  });

  it('A BATCH DRAWN TWICE IN ONE ENCODER IS REFUSED BY NAME, not drawn twice with its last data', () => {
    /*
     * **A batch's instances and uniforms are its own buffers, written at each draw.** Queue writes
     * land before the encoder runs, so a second draw of one batch in one encoder — a mirror and the
     * view, or a probe's six faces — would draw the second draw's particles twice, from the second
     * camera. WebGL2 draws both correctly, and the two backends are held to one rule: what one
     * cannot do fails loudly. A batch per view is the way to draw one effect twice.
     */
    const stub = stubSurface();
    const renderer = freshRenderer(stub);
    const scene = stubScene();
    const batch = renderer.createParticles(4, { material: 'mote', blend: 'alpha' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      renderer.beginFrame([0, 0, 0]);
      stub.pass.draw.mockClear();
      stub.pass.drawIndexed.mockClear();
      renderer.drawParticles(batch, oneParticle(), scene.camera, scene.env, 0);
      renderer.drawParticles(batch, oneParticle(), scene.camera, scene.env, 0);
      renderer.endFrame();
      const said = warn.mock.calls.map((c) => String(c[0])).filter((m) => /drawn twice/.test(m));
      expect(said).toHaveLength(1);
      /*
       * And the next frame is a new encoder, so the same batch draws again. Asked of the upload a
       * drawn batch makes rather than of the warning, which is said once per renderer and so is
       * silent whether or not the second frame was refused.
       */
      const uploads = () =>
        stub.device.queue.writeBuffer.mock.calls.filter((call) => call[0] === batch.instances)
          .length;
      const before = uploads();
      renderer.beginFrame([0, 0, 0]);
      renderer.drawParticles(batch, oneParticle(), scene.camera, scene.env, 0);
      renderer.endFrame();
      expect(uploads() - before, 'the next frame draws the batch').toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('writes each batch of the same material to its own fragment uniform buffer when both draw in one frame', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub);
    const scene = stubScene();

    const near = renderer.createParticles(4, { material: 'mote', blend: 'alpha' });
    const far = renderer.createParticles(4, { material: 'mote', blend: 'alpha', fog: true });

    renderer.beginFrame([0, 0, 0]);
    renderer.drawParticles(near, oneParticle(), scene.camera, scene.env, 0);
    renderer.drawParticles(far, oneParticle(), scene.camera, scene.env, 0);
    renderer.endFrame();

    const targets = new Set(
      stub.device.queue.writeBuffer.mock.calls
        .map((call) => call[0] as unknown)
        .filter((buffer) => buffer === near.fragUniforms || buffer === far.fragUniforms),
    );
    expect(targets.has(near.fragUniforms), 'the near batch wrote to its own buffer').toBe(true);
    expect(targets.has(far.fragUniforms), 'the far batch wrote to its own buffer').toBe(true);
  });
});

describe.each([
  ['masks', false],
  ['identifiers', true],
] as const)('the frame graph, scheduled by %s', (scheduler, identifierGraph) => {
  /*
   * **Every test in this block holds under either scheduler**, which is the claim
   * `quality.identifierGraph` makes: the identifier graph groups a flush into the passes, clears
   * and discards the mask scheduler does, so nothing downstream of the schedule can tell them apart.
   */
  const graphQuality = (options: RenderQualityOptions = {}) =>
    resolveRenderQuality({ ...options, identifierGraph });

  /*
   * And the switch is shown to engage, because two schedulers that agree are indistinguishable from
   * one that never ran. The identifier graph keeps what it last scheduled; the mask path has none.
   */
  it(`schedules a flush by ${scheduler}`, () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = new WebGPURenderer(stub.surface, graphQuality({ frameGraph: true }));
    const mesh = stubMesh(renderer);
    const { camera, env } = stubScene();
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(mesh, mat4.create());
    renderer.drawMesh(mesh, mat4.create());
    renderer.endFrame();
    const state = (renderer as unknown as { flushSchedule: { deps: { count: number } } | null })
      .flushSchedule;
    if (identifierGraph) {
      expect(state?.deps.count, 'the last flush was recorded as identifier nodes').toBeGreaterThan(
        1,
      );
    } else {
      expect(state, 'a renderer scheduling by masks carries no graph').toBeNull();
    }
    expect(renderer.graphPasses).toBe(1);
  });

  /**
   * The switch has to be shown to *do* something.
   *
   * An identical picture with `frameGraph` on is equally consistent with the recording working
   * perfectly and with the switch never engaging, and a capture cannot tell those apart. This
   * can: with the graph on a draw must reach the pass through the replay rather than from
   * `submitMesh`, and it must reach it exactly once.
   */
  it('records a mesh draw and replays it exactly once', () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = new WebGPURenderer(stub.surface, graphQuality({ frameGraph: true }));
    const mesh = stubMesh(renderer);
    const { camera, env } = stubScene();
    stub.pass.drawIndexed.mockClear();

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(mesh, mat4.create());
    expect(
      stub.pass.drawIndexed.mock.calls.length,
      'the draw is recorded, so nothing has reached the pass yet',
    ).toBe(0);

    renderer.endFrame();
    expect(stub.pass.drawIndexed.mock.calls.length, 'and endFrame flushes it, exactly once').toBe(
      1,
    );
  });

  /**
   * The loss the arena is designed against: a frame whose last work is a mesh draw has nothing
   * calling `ensurePass` afterwards, so without a flush in `endFrame` those draws would sit in
   * the arena until `beginFrame` reset it — silently.
   */
  it('loses no draw when a frame ends on one', () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = new WebGPURenderer(stub.surface, graphQuality({ frameGraph: true }));
    const mesh = stubMesh(renderer);
    const { camera, env } = stubScene();
    stub.pass.drawIndexed.mockClear();

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(mesh, mat4.create());
    renderer.drawMesh(mesh, mat4.create());
    renderer.drawMesh(mesh, mat4.create());
    renderer.endFrame();

    expect(stub.pass.drawIndexed.mock.calls.length).toBe(3);
  });

  /**
   * The same loss as the test above, at the boundary `endFrame` does not own.
   *
   * A consumer draws its interface *after* `endFrame` so the interface escapes the post chain.
   * Those verbs record like any other, but the pass they record into is closed and submitted by
   * `flushOverlay` on a microtask, and nothing calls `ensurePass` in between — so the frame's
   * last panel or caption sat in the arena until `beginFrame` reset it. Silent, and invisible to
   * every capture, because no published scene draws an overlay.
   */
  it('loses no overlay draw when the frame ends on one', () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = new WebGPURenderer(stub.surface, graphQuality({ frameGraph: true }));

    renderer.beginFrame([0, 0, 0]);
    renderer.endFrame();
    stub.pass.draw.mockClear();

    renderer.fillPanel({ left: 0, top: 0, width: 10, height: 10 }, [1, 1, 1], 1);
    expect(
      stub.pass.draw.mock.calls.length,
      'the panel is recorded, so nothing has reached the overlay pass yet',
    ).toBe(0);

    /* What the microtask does, and what the next frame does before replacing the encoder. */
    renderer.beginFrame([0, 0, 0]);
    expect(
      stub.pass.draw.mock.calls.length,
      'and the overlay flush replays it rather than dropping it',
    ).toBe(1);
  });

  /**
   * An inset is a scope boundary, and a recorded draw must not cross one.
   *
   * `beginInset` points the pass' viewport and scissor at a rectangle and `endInset` gives the
   * whole canvas back. Both are state on the pass, applied when a command is *issued* — so a
   * draw recorded inside the box and replayed after `endInset` is drawn across the whole frame
   * instead of into the box. The failure is a figure at the wrong size in the wrong place,
   * which is the one thing an inset exists to prevent.
   */
  it('flushes at an inset boundary, so a draw lands in the viewport it was issued under', () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = new WebGPURenderer(stub.surface, graphQuality({ frameGraph: true }));
    const mesh = stubMesh(renderer);
    const { camera, env } = stubScene();

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    stub.pass.drawIndexed.mockClear();

    renderer.drawMesh(mesh, mat4.create());
    renderer.beginInset({ left: 0, top: 0, width: 10, height: 10 }, null);
    expect(
      stub.pass.drawIndexed.mock.calls.length,
      'the draw before the boundary belongs to the viewport before it',
    ).toBe(1);

    renderer.drawMesh(mesh, mat4.create());
    renderer.endInset();
    expect(
      stub.pass.drawIndexed.mock.calls.length,
      'and the draw inside the box belongs to the box',
    ).toBe(2);

    renderer.endFrame();
  });

  /**
   * The progress metric the whole migration is measured by, asserted rather than watched.
   *
   * Every verb used to obtain its pass through `ensurePass`, which flushes — so each verb
   * scheduled and replayed the one before it, and a frame of *n* recorded draws cost *n*
   * flushes however complete the migration got. Zero is the precondition for narrowing
   * `liveOut`, so it is the thing to hold a test against.
   */
  it('costs one flush a frame however many verbs record', () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = new WebGPURenderer(stub.surface, graphQuality({ frameGraph: true }));
    const mesh = stubMesh(renderer);
    const { camera, env } = stubScene();

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    stub.pass.drawIndexed.mockClear();

    renderer.drawMesh(mesh, mat4.create());
    renderer.drawMesh(mesh, mat4.create());
    renderer.drawMesh(mesh, mat4.create());
    expect(
      stub.pass.drawIndexed.mock.calls.length,
      'three recorded draws, and not one of them has flushed another',
    ).toBe(0);

    renderer.endFrame();
    expect(stub.pass.drawIndexed.mock.calls.length, 'all three arrive at the one flush').toBe(3);
  });

  /** Everything `SkyColors` requires, at values a shader accepts without meaning anything. */
  function stubSky() {
    return {
      top: [0.2, 0.4, 0.8],
      horizon: [0.6, 0.7, 0.9],
      deep: [0.05, 0.05, 0.1],
      sunDir: [0, 1, 0],
      sunColor: [1, 1, 0.9],
      sunAngularRadius: 0.005,
      moonDir: [0, -1, 0],
      moonColor: [0.5, 0.5, 0.6],
      moonAngularRadius: 0.005,
      moonPhase: 0.5,
      nightFactor: 0,
      cloudOffsetX: 0,
      cloudOffsetZ: 0,
    } as never;
  }

  /**
   * The atmosphere verbs, held to the standard the mesh path is held to.
   *
   * Asserted on what reaches the pass and when, because that is the only thing separating a
   * recording that works from a switch that never engaged — and no capture can separate them.
   */
  it('records the sky and the wind streaks rather than issuing them', () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = new WebGPURenderer(stub.surface, graphQuality({ frameGraph: true }));
    const streaks = renderer.createWindStreaks();
    const { camera, env } = stubScene();
    stub.pass.draw.mockClear();

    renderer.beginFrame([0, 0, 0]);
    renderer.drawSky(camera, stubSky(), env);
    renderer.drawWindStreaks(
      streaks,
      camera,
      { velocityX: 12, velocityZ: 0, speed: 12, driftX: 1, driftZ: 0 } as never,
      0,
      [1, 1, 1],
      env,
    );
    expect(
      stub.pass.draw.mock.calls.length,
      'both are recorded, so neither has reached the pass',
    ).toBe(0);

    /* Flushed at a boundary rather than by `endFrame`, whose composite is a `draw` of its own
       and would be counted here without belonging to either verb. */
    renderer.endInset();
    expect(stub.pass.draw.mock.calls.length, 'and one flush replays both, exactly once each').toBe(
      2,
    );

    renderer.endFrame();
  });

  /**
   * What a draw inside the mirror says it writes.
   *
   * `beginPlanarReflection` draws the whole world a second time through the same verbs, so a
   * mesh between it and `endPlanarReflection` writes the mirror's attachments. Declaring the
   * scene's there is invisible in the picture — the executor replays into whichever pass is
   * open — and becomes a dropped or discarded attachment the moment `liveOut` narrows. The
   * pass count is where it shows: one target declared consistently is one pass, and the scope
   * marker plus a differing write-set is two.
   */
  it('declares the mirror for a draw inside the mirror', () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = new WebGPURenderer(
      stub.surface,
      /* `planarReflections` is what allocates the mirror at all; without it the verb declines. */
      graphQuality({ frameGraph: true, planarReflections: true }),
    );
    const mesh = stubMesh(renderer);
    const { camera, env } = stubScene();
    /* The mirror's target is allocated on a resize, which nothing else here triggers. */
    renderer.resize();

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    const mirror = renderer.beginPlanarReflection(camera, 0, [0, 0, 0]);
    expect(mirror, 'the mirror has to open for this test to be testing anything').not.toBeNull();

    renderer.drawMesh(mesh, mat4.create());
    renderer.drawMesh(mesh, mat4.create());
    renderer.endPlanarReflection();

    expect(
      renderer.graphPasses,
      'the boundary and both draws write the mirror, so they schedule as one pass',
    ).toBe(1);

    renderer.endFrame();
  });

  /**
   * The last drawing verb, and the one whose pass is re-read rather than obtained.
   *
   * `takeVolumeDepth` ends the pass this was called on and opens another, so `drawLightVolume`
   * holds `this.pass` directly — which is why the sweep for verbs still drawing directly kept
   * missing it.
   */
  it('records a light volume rather than issuing it', () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = new WebGPURenderer(stub.surface, graphQuality({ frameGraph: true }));
    const mesh = stubMesh(renderer);
    const { camera } = stubScene();

    renderer.beginFrame([0, 0, 0]);
    stub.pass.drawIndexed.mockClear();

    renderer.drawLightVolume(mesh, mat4.create(), camera, 1, 10, 0.5);
    expect(
      stub.pass.drawIndexed.mock.calls.length,
      'recorded, so it has not reached the pass',
    ).toBe(0);

    renderer.endInset();
    expect(stub.pass.drawIndexed.mock.calls.length, 'and the flush replays it once').toBe(1);

    renderer.endFrame();
  });

  /**
   * The gate the whole migration exists to pass, asserted rather than watched in a capture.
   *
   * A verb flush is one caused by a verb about to issue commands itself. Zero of them means
   * every verb in the frame recorded, which is the precondition for narrowing `liveOut` —
   * because a flush that sees only a fragment of the frame cannot tell what is read after it.
   *
   * Boundary flushes are not counted here and never reach zero: the mirror takes its own
   * encoder, the snapshot ends the pass to copy depth out, an inset changes the viewport. The
   * plan asks for `flushesThisFrame` to reach zero and that number cannot; this is the one that
   * can, and it is the number the gate belongs on.
   */
  it('costs no verb flush once every verb records', () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = new WebGPURenderer(stub.surface, graphQuality({ frameGraph: true }));
    const mesh = stubMesh(renderer);
    const streaks = renderer.createWindStreaks();
    const { camera, env } = stubScene();

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    /*
     * A mesh first, and deliberately. Every verb here has something recorded ahead of it, so a
     * verb that still drew directly would have to flush it — which is the only arrangement in
     * which this counter can catch anything at all.
     */
    renderer.drawMesh(mesh, mat4.create());
    renderer.drawSky(camera, stubSky(), env);
    renderer.drawWindStreaks(
      streaks,
      camera,
      { velocityX: 12, velocityZ: 0, speed: 12, driftX: 1, driftZ: 0 } as never,
      0,
      [1, 1, 1],
      env,
    );
    renderer.drawLightVolume(mesh, mat4.create(), camera, 1, 10, 0.5);
    renderer.beginInset({ left: 0, top: 0, width: 10, height: 10 }, [0, 0, 0]);
    renderer.drawMesh(mesh, mat4.create());
    renderer.endInset();
    renderer.endFrame();
    renderer.fillPanel({ left: 0, top: 0, width: 10, height: 10 }, [1, 1, 1], 1);

    expect(
      renderer.graphVerbFlushes,
      'not one verb in that frame reached ensurePass to draw for itself',
    ).toBe(0);
  });

  /**
   * What the whole design was for: a derived `storeOp` rather than a judgement.
   *
   * `resolvedStoreOp` takes a `terminal` boolean from a person, and the code's own comment says
   * what a wrong answer does — renders perfectly on every machine that can be tested here and
   * returns garbage on exactly the device the change was made for. This is the same decision
   * computed from what the frame declares, so it is at least a thing a test can reach.
   *
   * **Not switched on.** The executor still replays every node into the pass `openPass` gives
   * it, so nothing here changes a byte on any GPU yet. What it changes is the kind of claim.
   */
  it('derives a discard for the frame depth nothing reads back', () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = new WebGPURenderer(
      stub.surface,
      /* No motion blur and no occlusion, so the composite never resolves depth out. */
      graphQuality({ frameGraph: true, cameraMotionBlur: 0, ambientOcclusion: 0 }),
    );
    const mesh = stubMesh(renderer);
    const { camera, env } = stubScene();

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(mesh, mat4.create());
    renderer.endFrame();

    expect(
      renderer.graphDiscards & resourceBit('sceneDepth'),
      'nothing loads the frame depth after the last flush, so it need not be stored',
    ).not.toBe(0);
    expect(
      renderer.graphDiscards & resourceBit('sceneColor'),
      'and the composite reads the colour, so that one must survive',
    ).toBe(0);
  });

  /** The same frame, with the one consumer of depth switched on. */
  it('keeps the frame depth when the composite resolves it', () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = new WebGPURenderer(
      stub.surface,
      graphQuality({ frameGraph: true, ambientOcclusion: 0.5 }),
    );
    const mesh = stubMesh(renderer);
    const { camera, env } = stubScene();

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(mesh, mat4.create());
    renderer.endFrame();

    expect(
      renderer.graphDiscards & resourceBit('sceneDepth'),
      'occlusion resolves the depth out, so discarding it would hand the pass garbage',
    ).toBe(0);
  });

  /**
   * The figure the design has been arguing about, read off the derivation rather than estimated.
   *
   * 412x915 and four samples, which is the viewport and profile `IMPROVEMENTS.md` measured the
   * 69 MB estimate at, so the two numbers are about the same frame. `storm-sea` is the shipped
   * scene at those samples.
   */
  it('says what the derived discards are worth', () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    stub.sizeCanvas(412, 915);
    const renderer = new WebGPURenderer(
      stub.surface,
      graphQuality({
        frameGraph: true,
        sceneSamples: 4,
        cameraMotionBlur: 0,
        ambientOcclusion: 0,
      }),
    );
    const mesh = stubMesh(renderer);
    const { camera, env } = stubScene();
    renderer.resize();

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(mesh, mat4.create());
    renderer.endFrame();

    const bytes = renderer.graphDiscardBytes;
    /*
     * The whole depth attachment, once: 412 x 915 x 4 bytes x 4 samples. Asserted exactly,
     * because a figure quoted in a document has to be a figure something fails over.
     */
    expect(bytes).toBe(412 * 915 * 4 * 4);
    expect(bytes / (1024 * 1024)).toBeCloseTo(5.75, 1);
  });

  /** The other dead attachment, which only a reflecting frame has. */
  it('says what the mirror depth is worth on a reflecting frame', () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    stub.sizeCanvas(412, 915);
    const renderer = new WebGPURenderer(
      stub.surface,
      graphQuality({
        frameGraph: true,
        sceneSamples: 4,
        planarReflections: true,
        cameraMotionBlur: 0,
        ambientOcclusion: 0,
      }),
    );
    const mesh = stubMesh(renderer);
    const { camera, env } = stubScene();
    renderer.resize();

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    expect(renderer.beginPlanarReflection(camera, 0, [0, 0, 0])).not.toBeNull();
    renderer.drawMesh(mesh, mat4.create());
    renderer.endPlanarReflection();

    /* Read at the mirror's own flush, which is where its depth is derived dead. */
    /*
     * The mirror's depth, whole: `waterReflectionScale` is 1 by default, so the target is the
     * frame's own size and this attachment costs exactly what the frame's depth costs.
     */
    expect(renderer.graphDiscardBytes).toBe(412 * 915 * 4 * 4);

    renderer.drawMesh(mesh, mat4.create());
    renderer.endFrame();
    /* And the frame's own depth at the last flush, for the same again. */
    expect(renderer.graphDiscardBytes).toBe(412 * 915 * 4 * 4);
  });

  /**
   * The pass a flush describes must not already be open when the flush describes it.
   *
   * A verb called `openPass` for its guard, so the frame's pass opened on the first draw and its
   * store ops were fixed before a single node was recorded. Everything the scheduler derives is
   * then a report about a pass somebody else already decided.
   */
  it('opens no pass while verbs are recording', () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = new WebGPURenderer(stub.surface, graphQuality({ frameGraph: true }));
    const mesh = stubMesh(renderer);
    const { camera, env } = stubScene();

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    stub.encoder.beginRenderPass.mockClear();

    renderer.drawMesh(mesh, mat4.create());
    renderer.drawMesh(mesh, mat4.create());
    expect(
      stub.encoder.beginRenderPass.mock.calls.length,
      'both draws recorded, and nothing has been opened for them yet',
    ).toBe(0);

    renderer.endFrame();
    expect(
      stub.encoder.beginRenderPass.mock.calls.length,
      'the flush opens it, knowing what is in it',
    ).toBeGreaterThan(0);
  });

  /** The frame's own pass descriptor, from whichever open produced it. */
  function frameDescriptor(stub: ReturnType<typeof stubSurface>) {
    return stub.encoder.beginRenderPass.mock.calls
      .map((call) => call[0])
      .find((descriptor) => String(descriptor.label).startsWith('frame'));
  }

  /**
   * The derived `storeOp` reaches the descriptor, which is the whole difference between a
   * derivation and a report about one.
   *
   * `resolvedStoreOp` takes a `terminal` boolean from a person and the frame's depth was simply
   * hardcoded to `store`, with a comment naming three readers. Each of those three is a declared
   * read the scheduler can see, so the answer is computable.
   */
  it('opens the frame pass with the depth store op the schedule derived', () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = new WebGPURenderer(
      stub.surface,
      graphQuality({
        frameGraph: true,
        discardResolvedAttachments: true,
        cameraMotionBlur: 0,
        ambientOcclusion: 0,
      }),
    );
    const mesh = stubMesh(renderer);
    const { camera, env } = stubScene();

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(mesh, mat4.create());
    renderer.endFrame();

    const frame = frameDescriptor(stub);
    expect(frame, 'the frame opened a pass').toBeDefined();
    expect(
      frame?.depthStencilAttachment?.depthStoreOp,
      'nothing loads the frame depth back, and the schedule says so',
    ).toBe('discard');
  });

  /** And the reader that keeps it: occlusion resolves the depth out of the frame. */
  it('keeps the frame depth in the descriptor when occlusion reads it', () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = new WebGPURenderer(
      stub.surface,
      graphQuality({
        frameGraph: true,
        discardResolvedAttachments: true,
        ambientOcclusion: 0.5,
      }),
    );
    const mesh = stubMesh(renderer);
    const { camera, env } = stubScene();

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(mesh, mat4.create());
    renderer.endFrame();

    expect(frameDescriptor(stub)?.depthStencilAttachment?.depthStoreOp).toBe('store');
  });

  /**
   * A derived discard belongs to the pass the schedule just described, and to no other.
   *
   * The mask used to be held on the instance until something opened a pass, which meant one
   * frame's "the depth is dead" reached the next frame's first open. `storm-sea` found it in a
   * capture: it draws a light volume, whose snapshot opens the frame's pass outside any flush,
   * and the pass then ended by discarding a depth buffer `resolveDepth` reads one line later.
   * 41,783 pixels of sea, and the only reason it was visible at all is that this adapter really
   * does drop a discarded attachment.
   */
  it('never carries a discard into a pass the schedule did not describe', () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = new WebGPURenderer(
      stub.surface,
      graphQuality({
        frameGraph: true,
        discardResolvedAttachments: true,
        cameraMotionBlur: 0,
        ambientOcclusion: 0,
      }),
    );
    const mesh = stubMesh(renderer);
    const { camera, env } = stubScene();

    /*
     * A frame that ends with a pass already open, which is the arrangement that leaked.
     *
     * The light volume's snapshot reopens the pass, so `endFrame`'s flush finds one open, cannot
     * apply a store op to it, and used to leave the mask standing for whatever opened next.
     */
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(mesh, mat4.create());
    renderer.drawLightVolume(mesh, mat4.create(), camera, 1, 10, 0.5);
    renderer.endFrame();

    /* A second frame whose pass is opened by something that is not a flush. */
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    stub.encoder.beginRenderPass.mockClear();
    renderer.drawLightVolume(mesh, mat4.create(), camera, 1, 10, 0.5);

    expect(
      frameDescriptor(stub)?.depthStencilAttachment?.depthStoreOp,
      'no schedule described this pass, so nothing may be thrown away at the end of it',
    ).toBe('store');

    renderer.endFrame();
  });

  /**
   * A clear is owed by an attachment, not by a frame, and it is owed until something performs it.
   *
   * `frameNeedsClear` was a boolean, so the rule it carried — a scene that opens the mirror
   * before it draws anything gets its single clear late — lived in one branch and could not be
   * asked about. It is the same rule as a mask, and the scheduler computes it too.
   */
  it('derives the frame clear, and derives it once', () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = new WebGPURenderer(stub.surface, graphQuality({ frameGraph: true }));
    const mesh = stubMesh(renderer);
    const { camera, env } = stubScene();

    renderer.beginFrame([0.1, 0.2, 0.3]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(mesh, mat4.create());
    renderer.endFrame();

    expect(
      renderer.graphClears & maskOf('sceneColor', 'sceneDepth'),
      'the frame owed a clear, and the schedule is what said so',
    ).toBe(maskOf('sceneColor', 'sceneDepth'));

    const frame = frameDescriptor(stub);
    expect(frame?.colorAttachments?.[0]?.loadOp).toBe('clear');
    expect(frame?.depthStencilAttachment?.depthLoadOp).toBe('clear');
  });

  /**
   * The rule the boolean carried, now asked directly.
   *
   * A scene that opens the mirror before it has drawn anything still owes the frame its clear,
   * and gets it when the frame's own pass finally opens.
   */
  it('still owes the frame its clear after a mirror that came first', () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = new WebGPURenderer(
      stub.surface,
      graphQuality({ frameGraph: true, planarReflections: true }),
    );
    const mesh = stubMesh(renderer);
    const { camera, env } = stubScene();
    renderer.resize();

    renderer.beginFrame([0.1, 0.2, 0.3]);
    renderer.bindMeshPass(camera, env);
    expect(renderer.beginPlanarReflection(camera, 0, [0, 0, 0])).not.toBeNull();
    renderer.drawMesh(mesh, mat4.create());
    renderer.endPlanarReflection();

    stub.encoder.beginRenderPass.mockClear();
    renderer.drawMesh(mesh, mat4.create());
    renderer.endFrame();

    expect(
      frameDescriptor(stub)?.colorAttachments?.[0]?.loadOp,
      'nothing had drawn into the frame yet, so it still owes its clear',
    ).toBe('clear');
  });

  /**
   * The mirror's depth is thrown away because nothing reads it, and the scheduler is what says so.
   *
   * It was already discarded, by a hand-written `discardResolvedAttachments ? 'discard' : 'store'`
   * with a comment costing it at 23 MB a mirror — so this changes no bytes at all. What it
   * changes is that a verb which one day samples the mirror's depth would keep it, rather than
   * quietly reading something that was thrown away.
   */
  it('derives the mirror depth discard rather than asserting it', () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = new WebGPURenderer(
      stub.surface,
      graphQuality({
        frameGraph: true,
        planarReflections: true,
        discardResolvedAttachments: true,
      }),
    );
    const mesh = stubMesh(renderer);
    const { camera, env } = stubScene();
    renderer.resize();

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    expect(renderer.beginPlanarReflection(camera, 0, [0, 0, 0])).not.toBeNull();

    const mirrorOf = () =>
      stub.encoder.beginRenderPass.mock.calls
        .map((call) => call[0])
        .find((descriptor) => descriptor.label === 'reflection');

    expect(
      mirrorOf(),
      'opening a reflection describes no pass yet, because nothing has been recorded into it',
    ).toBeUndefined();

    renderer.drawMesh(mesh, mat4.create());
    renderer.endPlanarReflection();

    const mirror = mirrorOf();
    expect(mirror, 'the flush opened it').toBeDefined();
    expect(mirror?.depthStencilAttachment?.depthLoadOp).toBe('clear');
    expect(mirror?.depthStencilAttachment?.depthStoreOp).toBe('discard');
    expect(
      renderer.graphDiscards & maskOf('mirrorDepth'),
      'and it is the schedule that decided it',
    ).not.toBe(0);
  });

  /**
   * A reflection nobody draws into still has to be cleared.
   *
   * `endPlanarReflection` marks the mirror ready either way, so water samples it regardless —
   * and an unopened lazy pass would hand it whatever the target held last frame.
   */
  it('clears a mirror that nothing drew into', () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = new WebGPURenderer(
      stub.surface,
      graphQuality({ frameGraph: true, planarReflections: true }),
    );
    const { camera, env } = stubScene();
    renderer.resize();

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    expect(renderer.beginPlanarReflection(camera, 0, [0, 0, 0])).not.toBeNull();
    /* Not one draw between the two. */
    renderer.endPlanarReflection();

    const mirror = stub.encoder.beginRenderPass.mock.calls
      .map((call) => call[0])
      .find((descriptor) => descriptor.label === 'reflection');
    expect(mirror, 'the mirror still opened, because it still owed a clear').toBeDefined();
    expect(mirror?.colorAttachments?.[0]?.loadOp).toBe('clear');

    renderer.endFrame();
  });

  /**
   * A pass is told everything a pipeline needs, and the depth format is part of that.
   *
   * **It was not, until 2026-08-25**, and the only contributed pass in the tree hard-coded
   * `depth24plus` — right about this frame, and a contributor guessing. It stayed invisible for
   * as long as nothing registered through this seam depth-tested; a Gaussian splat is composed
   * *into* the scene and has to be occluded by the geometry in front of it, so it is the first
   * thing that cannot guess. Asserted rather than left to prose, because a claim that can drift
   * has to fail somewhere.
   */
  it("hands a pass the frame's colour format, depth format and sample count", () => {
    const stub = stubSurface();
    const renderer = new WebGPURenderer(stub.surface);
    const init = vi.fn();
    renderer.registerPass({ label: 'probe', draw: vi.fn(), init });

    expect(init).toHaveBeenCalledTimes(1);
    const device = init.mock.calls[0]?.[0] as { backend: string; depthFormat?: string };
    expect(device.backend).toBe('webgpu');
    expect(device.depthFormat, 'the attachment every world pass targets').toBe(DEPTH_FORMAT);
  });

  /**
   * A pass is told the frame's grade, because a contributed pass is a forward pass.
   *
   * `AGENTS.md`, 2026-08-17: with a composite the resolve grades and a pass that also graded
   * would apply the curve twice; without one, each pass is last and each must grade itself. That
   * decision was private to the renderer, so a package could only guess — and both guesses are
   * wrong half the time.
   */
  it("hands a pass the frame's output transform and exposure", () => {
    const stub = stubSurface();
    const renderer = new WebGPURenderer(stub.surface);
    const draw = vi.fn();
    const handle = renderer.registerPass({ label: 'probe', draw });
    const { camera, env } = stubScene();

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.drawPass(handle);
    renderer.endFrame();

    expect(draw).toHaveBeenCalled();
    const context = draw.mock.calls[0]?.[0] as {
      outputTransform?: number;
      outputExposure?: number;
    };
    expect(typeof context.outputTransform, 'a number, not undefined').toBe('number');
    expect(typeof context.outputExposure).toBe('number');
  });

  /**
   * A registered pass is recorded like any verb and replayed like any verb.
   *
   * Run at the flush rather than at the call, so it lands in the caller's order among the draws
   * around it rather than ahead of all of them. That ordering is the whole of what a contributor
   * is buying: alpha and depth make *after* different from *before*.
   */
  it('records a registered pass and runs it at the flush', () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = new WebGPURenderer(stub.surface, graphQuality({ frameGraph: true }));
    const mesh = stubMesh(renderer);
    const { camera, env } = stubScene();
    let ran = 0;
    const handle = renderer.registerPass({
      label: 'probe',
      draw: () => {
        ran += 1;
      },
    });

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(mesh, mat4.create());
    renderer.drawPass(handle);
    expect(ran, 'recorded, so it has not run yet').toBe(0);

    renderer.endFrame();
    expect(ran, 'and the flush runs it, once').toBe(1);
  });

  /**
   * The thing Phase B exists to deliver: a declaration from outside the renderer that the
   * scheduler acts on.
   *
   * Nothing inside the frame reads the depth back in this configuration, so it derives a
   * discard — until a package says it is going to sample it, at which point the frame may not
   * throw it away. That sentence is the whole argument for a graph rather than a callback list.
   */
  it('keeps an attachment a registered pass says it reads', () => {
    const quality = {
      frameGraph: true,
      discardResolvedAttachments: true,
      cameraMotionBlur: 0,
      ambientOcclusion: 0,
    };
    const withPass = new WebGPURenderer(
      stubSurface({ maxSampledTexturesPerShaderStage: 48 }).surface,
      graphQuality(quality),
    );
    const withoutPass = new WebGPURenderer(
      stubSurface({ maxSampledTexturesPerShaderStage: 48 }).surface,
      graphQuality(quality),
    );
    const { camera, env } = stubScene();

    const run = (renderer: WebGPURenderer, declare: boolean): number => {
      const mesh = stubMesh(renderer);
      const handle = renderer.registerPass({
        label: 'probe',
        ...(declare ? { reads: ['sceneDepth' as const] } : {}),
        draw: () => {},
      });
      renderer.beginFrame([0, 0, 0]);
      renderer.bindMeshPass(camera, env);
      renderer.drawMesh(mesh, mat4.create());
      renderer.drawPass(handle);
      renderer.endFrame();
      return renderer.graphDiscards & resourceBit('sceneDepth');
    };

    expect(
      run(withoutPass, false),
      'nothing reads the depth, so the frame is entitled to throw it away',
    ).not.toBe(0);
    expect(run(withPass, true), 'a package said it samples the depth, so the frame may not').toBe(
      0,
    );
  });

  /**
   * A camera with a real projection in it.
   *
   * `stubScene`'s carries an identity view-projection, which is right for the uniform-writing
   * tests it was built for and useless here: the frustum of an identity matrix is the unit cube
   * in normalised device coordinates, so nothing a metre away is ever inside it. Built locally
   * rather than changed there, because a dozen tests read what that stub writes.
   */
  function cameraLookingDownZ() {
    const projection = mat4.perspective(mat4.create(), Math.PI / 2, 1, 1, 500);
    const view = mat4.lookAt(mat4.create(), [0, 0, 0], [0, 0, -1], [0, 1, 0]);
    const viewProjection = mat4.multiply(mat4.create(), projection, view);
    return {
      viewProjection,
      projection,
      invViewProjection: mat4.invert(mat4.create(), viewProjection),
      view,
      position: new Float32Array([0, 0, 0]),
    } as never;
  }

  /** The query a consumer uses, which is the half that can save more than a draw. */
  it('says what is on screen and what is behind the camera', () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = new WebGPURenderer(stub.surface, graphQuality({}));
    const mesh = stubMesh(renderer);
    const { env } = stubScene();

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(cameraLookingDownZ(), env);
    expect(
      renderer.visible(mesh.bounds, mat4.fromTranslation(mat4.create(), [0, 0, -10])),
      'ten metres down the axis the stub camera looks along',
    ).toBe(true);
    expect(
      renderer.visible(mesh.bounds, mat4.fromTranslation(mat4.create(), [0, 0, 400])),
      'four hundred the other way',
    ).toBe(false);
    renderer.endFrame();
  });

  /**
   * And the flag, which saves only the draw.
   *
   * Off by default and asserted in both directions, because a cull is a behaviour change: the
   * same frame has to keep drawing when nobody asked for one.
   */
  it('skips an off-screen draw only when asked to', () => {
    const far = () => mat4.fromTranslation(mat4.create(), [0, 0, 400]);
    const run = (cullDraws: boolean): number => {
      const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
      const renderer = new WebGPURenderer(stub.surface, graphQuality({ cullDraws }));
      const mesh = stubMesh(renderer);
      const { env } = stubScene();
      renderer.beginFrame([0, 0, 0]);
      renderer.bindMeshPass(cameraLookingDownZ(), env);
      stub.pass.drawIndexed.mockClear();
      renderer.drawMesh(mesh, far());
      renderer.endFrame();
      return stub.pass.drawIndexed.mock.calls.length;
    };

    expect(run(false), 'nobody asked, so it is drawn').toBe(1);
    expect(run(true), 'asked, and it is behind the camera').toBe(0);
  });

  it('draws exactly as before when the switch is off', () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    /* Explicit now that the switch defaults on: this test is the one that says what "off" means. */
    const renderer = new WebGPURenderer(stub.surface, graphQuality({ frameGraph: false }));
    const mesh = stubMesh(renderer);
    const { camera, env } = stubScene();
    stub.pass.drawIndexed.mockClear();

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(mesh, mat4.create());
    expect(
      stub.pass.drawIndexed.mock.calls.length,
      'no recording, so the draw reaches the pass immediately',
    ).toBe(1);
    renderer.endFrame();
  });

  /**
   * **A recorded draw must take the pipeline of the pass it will land in, not the one that
   * happened to be open when it was recorded.**
   *
   * This is the defect that keeps `frameGraph` off by default. On an AMD RX 9070 XT with the
   * default flipped, six of the seven published scenes are pixel-identical and the showroom throws:
   *
   *     Attachment state of [RenderPipeline "…|flat:…"] is not compatible with
   *     [RenderPassEncoder "overlay"] … overlay expects sampleCount: 1 … pipeline has sampleCount: 4
   *
   * and WebGPU reports that at `finish`, so the whole command buffer is dropped.
   *
   * **Direct execution hides it and recording exposes it**, because the two halves of the decision
   * sit next to each other in one and arbitrarily far apart in the other: `submitMesh` resolves its
   * pipeline through `targetPipelines()` — which reads `overlayActive` — and the pass is not chosen
   * until the graph is flushed, by which time `openPass` has opened the overlay and set that flag.
   *
   * Measured here rather than reasoned about: with the graph on, `overlayActive` is `false` at
   * record and `true` at flush, and the pipeline handed to `setPipeline` is the *scene* cache's
   * object.
   *
   * **Two earlier attempts at this test failed for the wrong reason and are worth not repeating.**
   * Through `drawText`, it passed with and without the fix — that verb settles its pass before it
   * resolves a pipeline, so it never had the defect. Through `drawMesh`, it failed with and without
   * the fix, building no pipeline at all: `submitMesh` returns on its first line unless `viewProj`
   * is set, and only `bindMeshPass` sets it. A repro that never binds a camera never reaches the
   * resolution it is about.
   */
  it('replays a draw recorded after the frame with the pipeline of the pass it lands in', () => {
    const quality = graphQuality({ frameGraph: true });
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = new WebGPURenderer(stub.surface, quality);
    const mesh = stubMesh(renderer);
    const { camera, env } = stubScene();
    const inside = renderer as unknown as {
      pipelines: { peek(key: string): unknown };
      overlayPipelines: { peek(key: string): unknown };
      /* The replay seam. Driven directly because what is under test is the gap between recording
         and replaying, and every production trigger for it is a verb with its own reasons. */
      flushGraph(): void;
    };

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(mesh, mat4.create());
    renderer.endFrame();

    const key = (mesh as unknown as { key?: string }).key ?? '';
    const scenePipeline = inside.pipelines.peek(key);
    expect(
      scenePipeline,
      'the frame built the scene pipeline this draw would wrongly reuse',
    ).toBeDefined();

    stub.pass.setPipeline.mockClear();
    /* After the frame: this lands on the canvas, through the overlay, and is recorded first. */
    renderer.drawMesh(mesh, mat4.create());
    inside.flushGraph();

    const used = stub.pass.setPipeline.mock.calls.at(-1)?.[0];
    expect(used, 'the recorded draw was replayed at all').toBeDefined();
    expect(used, "the overlay's pipeline, which is what the overlay pass accepts").toBe(
      inside.overlayPipelines.peek(key),
    );
    expect(used, "not the scene's, which is multisampled where the overlay is not").not.toBe(
      scenePipeline,
    );
  });
});

/*
 * **What is recorded after the frame is submitted before the browser presents, whatever the verb.**
 * The overlay's submission was queued only where a verb *opened* its pass, and with the graph on a
 * verb records instead: `fillPanel` and a contributed pass's `drawPass` recorded, nothing queued
 * the submission, and the next `beginFrame` replayed them onto a canvas texture already presented —
 * "Destroyed texture used in a submit", and no interface. Reported from a game drawing its HUD
 * after `endFrame`, which turned the graph off to get it back.
 */
describe('drawing after endFrame with the graph on', () => {
  it('submits a panel and a contributed pass on the microtask after them, before the present', async () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub, resolveRenderQuality({ frameGraph: true }));
    const drawn: string[] = [];
    const handle = renderer.registerPass({ label: 'hud', draw: () => void drawn.push('hud') });

    renderer.beginFrame([0, 0, 0]);
    renderer.endFrame();
    const submits = stub.device.queue.submit.mock.calls.length;
    renderer.fillPanel({ left: 8, top: 8, width: 120, height: 90 }, [1, 1, 1], 0.5);
    renderer.drawPass(handle);
    await Promise.resolve();

    expect(drawn, 'the contributed pass drew').toEqual(['hud']);
    expect(stub.device.queue.submit.mock.calls.length, 'and the overlay went').toBe(submits + 1);
  });

  /*
   * **A contributed pass is told what it is drawing into.** Its device says what the *frame* is —
   * the scene target's format at the scene's samples — and nothing said that a pass drawn after
   * `endFrame` lands on the canvas at one sample, so a pipeline built from the device was refused
   * there. Reported from a game whose HUD, a ui2d sprite pass drawn over the finished frame, was
   * registered for the canvas by hand to get round it.
   */
  it('tells a contributed pass the format and samples of the pass it lands in', async () => {
    for (const frameGraph of [false, true]) {
      const stub = stubSurface();
      const quality = resolveRenderQuality({ sceneSamples: 4, hdrScene: true, frameGraph });
      const renderer = freshRenderer(stub, quality);
      const seen: string[] = [];
      const handle = renderer.registerPass({
        label: 'where',
        draw: (context) => {
          if (context.backend !== 'webgpu') return;
          seen.push(`${context.format}/${context.samples}/${context.depthFormat}`);
        },
      });
      renderer.beginFrame([0, 0, 0]);
      renderer.drawPass(handle);
      renderer.endFrame();
      renderer.drawPass(handle);
      await Promise.resolve();
      expect(seen, `graph ${frameGraph}`).toEqual([
        'rgba16float/4/depth32float',
        'bgra8unorm/1/depth32float',
      ]);
    }
  });
});

/**
 * Disposing a bound map must take its view out of the flat bind group.
 *
 * `disposeSurfaceTexture` cleared the albedo and nothing else, so a consumer that disposed a
 * *normal* map left the flat group holding a view of a destroyed texture — until some later
 * `setMaterial` happened to bind a different one and trigger a rebuild. The albedo's own comment
 * says exactly why that is not survivable: the group "hands a destroyed texture to the next draw
 * that asks".
 *
 * Counting `createBindGroup` separates the two here, unlike the stale-group case in
 * `IMPROVEMENTS.md`: the broken version creates **no** group on dispose and the fixed one creates
 * one.
 */
describe('disposing a map bound to the flat pass', () => {
  for (const field of ['normal', 'orm'] as const) {
    it(`rebuilds the flat bind group when the ${field} map goes`, () => {
      const stub = stubSurface();
      const renderer = freshRenderer(stub);
      const map = renderer.createSurfaceTexture(
        { width: 4, height: 4 } as unknown as TexImageSource,
        {},
      );

      renderer.setMaterial({ [field]: map });
      stub.device.createBindGroup.mockClear();
      renderer.disposeSurfaceTexture(map);

      expect(
        stub.device.createBindGroup.mock.calls.length,
        'the group is rebuilt without the destroyed view',
      ).toBeGreaterThan(0);
    });
  }
});

/*
 * **The sequence that reported `Destroyed texture ... used in a submit` on loading a second
 * model**, and the one the first version of this fix did not cover.
 *
 * `blankAlbedoBindGroup` is only refreshed by a rebuild that happens while the albedo is null. So
 * a group built when an ORM map was bound keeps that map's view for ever, and a later rebuild
 * driven by a *different* ORM map does not touch it. Disposing the first map then left a
 * destroyed view inside the group every untextured draw reaches for.
 *
 * Rebuilding on every dispose rather than only when the disposed texture is one of the three
 * currently bound is what closes it, and this asserts the rebuild rather than the symptom because
 * the stub has no GPU to raise the real error.
 */
it('rebuilds the blank flat group when a map it was built against is disposed', () => {
  const stub = stubSurface();
  const renderer = freshRenderer(stub);
  const make = () =>
    renderer.createSurfaceTexture({ width: 4, height: 4 } as unknown as TexImageSource, {});
  const first = make();

  /* Built while the albedo is null, so it becomes the blank group and holds `first`. */
  renderer.setMaterial({ orm: first });
  /* A different ORM map rebuilds the live group and leaves the blank one alone. */
  renderer.setMaterial({ albedo: make(), orm: make() });

  stub.device.createBindGroup.mockClear();
  renderer.disposeSurfaceTexture(first);

  expect(
    stub.device.createBindGroup.mock.calls.length,
    'the blank group no longer holds the destroyed view',
  ).toBeGreaterThan(0);
});

/**
 * **A map updated to another size is a new GPU texture, so every group holding its view is
 * rebuilt, and the texture it replaced outlives any draw already recorded against it.**
 *
 * Found as the showroom not repeating itself: a model's preview image lands first, the real image
 * then updates it at four times the size, and the texture was left the preview's size. The fix
 * makes a new texture — which is a new view — so this is `disposeSurfaceTexture`'s invalidation
 * again, for the same reason, plus one thing disposal does not need: the old texture may already
 * be read by a draw recorded earlier in this frame, so it is destroyed when the next frame begins
 * rather than now.
 */
it('rebuilds the groups of a map updated to another size, and retires the old texture at the next frame', () => {
  const stub = stubSurface();
  const renderer = freshRenderer(stub);
  const map = renderer.createSurfaceTexture(
    { width: 4, height: 4 } as unknown as TexImageSource,
    {},
  );
  const old = stub.device.createTexture.mock.results
    .map((result) => result.value)
    .filter((texture) => texture.label === 'surface.texture')
    .at(-1);
  renderer.setMaterial({ albedo: map });
  /* A group naming the map's view, which only a material group does: the mip chain's groups name
     single levels. */
  const groupsNaming = (view: unknown) =>
    stub.device.createBindGroup.mock.calls.filter(([descriptor]) =>
      Array.from(descriptor.entries).some((entry) => entry.resource === view),
    ).length;

  /* The same size first: nothing to rebuild and nothing to retire, which a video relies on. */
  stub.device.createBindGroup.mockClear();
  renderer.updateSurfaceTexture(map, { width: 4, height: 4 } as unknown as TexImageSource);
  expect(groupsNaming(map.view)).toBe(0);

  renderer.updateSurfaceTexture(map, { width: 8, height: 2 } as unknown as TexImageSource);
  expect(groupsNaming(map.view), 'the groups are rebuilt around the new view').toBeGreaterThan(0);
  expect(old?.destroy, 'still readable by what this frame recorded').not.toHaveBeenCalled();

  renderer.beginFrame([0, 0, 0]);
  expect(old?.destroy, 'and destroyed once nothing recorded can read it').toHaveBeenCalledTimes(1);
});

it('destroys a retired texture with the renderer when no frame follows the update', () => {
  const stub = stubSurface();
  const renderer = freshRenderer(stub);
  const map = renderer.createSurfaceTexture(
    { width: 4, height: 4 } as unknown as TexImageSource,
    {},
  );
  const old = stub.device.createTexture.mock.results
    .map((result) => result.value)
    .filter((texture) => texture.label === 'surface.texture')
    .at(-1);
  renderer.updateSurfaceTexture(map, { width: 8, height: 2 } as unknown as TexImageSource);
  renderer.dispose();
  expect(old?.destroy).toHaveBeenCalledTimes(1);
});

/**
 * A material change must cost a bind group only the first time that combination is seen.
 *
 * **The cache was keyed on the albedo alone while every group it held also carried the normal,
 * ORM and emissive views current when it was built.** Keyed on one thing and holding four, it
 * could only be correct by being emptied whenever any of the other three moved, and `setMaterial`
 * did exactly that: one `rebuildFlatBindGroup` per changed map, each one a `clear()`, so a
 * material carrying a different normal map from the one before it threw away every entry and then
 * missed the cache it had just emptied.
 *
 * What that costs is not a slow first frame, it is a cost that never stops. A consumer measured it
 * over the materials its cars merge to: 476 `createBindGroup` calls a pass across seven models
 * whose distinct signatures number 247, drawn twice a frame for the water's mirror, so about 950 a
 * frame in steady state where the correct number is nought. It scales with distinct *models* on
 * screen rather than with cars, because identical cars share a batch, which is how it was reported
 * — the frame rate falling off when a second kind of car came into view.
 *
 * The second pass is the assertion, because a warm cache building anything at all is the defect
 * whatever the first pass cost. The first is bounded too: one group per distinct signature and no
 * more.
 */
describe('the flat bind group cache across material changes', () => {
  it('builds one group per distinct signature and nothing at all on a second pass', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub);
    const make = () =>
      renderer.createSurfaceTexture({ width: 4, height: 4 } as unknown as TexImageSource, {});

    /* Two maps in each slot, so every combination differs from its neighbour in one slot only. */
    const albedo = [make(), make()];
    const normal = [make(), make()];
    const orm = [make(), make()];
    const signatures = albedo.flatMap((a) =>
      normal.flatMap((n) => orm.map((o) => ({ albedo: a, normal: n, orm: o }))),
    );

    stub.device.createBindGroup.mockClear();
    for (const material of signatures) renderer.setMaterial(material);
    expect(
      stub.device.createBindGroup.mock.calls.length,
      'the first pass builds one group per distinct signature',
    ).toBe(signatures.length);

    stub.device.createBindGroup.mockClear();
    for (const material of signatures) renderer.setMaterial(material);
    expect(
      stub.device.createBindGroup.mock.calls.length,
      'a warm cache builds nothing, however many maps moved between draws',
    ).toBe(0);
  });

  /**
   * And the count is reachable from outside, which is the half a consumer could not get at.
   *
   * The measurement that found this had to be taken by reading the baked models and replaying the
   * backend's state machine over them, because the frame itself reports draws and material changes
   * and never said how many native groups either produced.
   */
  it('reports groups built on the frame budget', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub);
    const line = renderer.frameBudget.lines.find((l) => l.name === 'bind groups');
    expect(line, 'the budget declares a line for it').toBeDefined();

    const map = renderer.createSurfaceTexture(
      { width: 4, height: 4 } as unknown as TexImageSource,
      {},
    );
    const before = line!.used;
    renderer.setMaterial({ albedo: map });
    expect(line!.used, 'a new signature counts one').toBe(before + 1);
    renderer.setMaterial({ albedo: null });
    renderer.setMaterial({ albedo: map });
    expect(line!.used, 'a repeat counts nothing').toBe(before + 1);
  });
});

/**
 * A caster enumeration replayed into the colour pass keeps its materials.
 *
 * **The list used to carry a handle, a matrix and a palette and nothing else**, which is exactly
 * right for a depth pass — a material cannot change a depth — and is why nobody noticed what it
 * cost until somebody wanted the scene from a second viewpoint. A consumer tried replaying
 * the caster list into its water's mirror, because that list already existed and was already
 * recorded, and got **every car unpainted**. So it re-enters its whole draw path with a mirrored
 * camera instead and pays its heaviest phase, 2.3 to 9.4 ms, a second time.
 *
 * The material rides the sink now, and this asserts the half that was missing: two draws carrying
 * two different materials reach the pass as two different bind groups. Counting groups rather than
 * inspecting state is deliberate — a group is what a material *becomes* by the time it reaches the
 * GPU, so this fails if the material is dropped anywhere between the sink and the draw.
 */
describe('replaying a caster enumeration into the colour pass', () => {
  it('carries the material of each draw through to the pass', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub);
    const mesh = stubMesh(renderer);
    const { camera, env } = stubScene();
    const make = () =>
      renderer.createSurfaceTexture({ width: 4, height: 4 } as unknown as TexImageSource, {});
    const first = make();
    const second = make();

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);

    const line = renderer.frameBudget.lines.find((l) => l.name === 'bind groups');
    const before = line!.used;
    stub.pass.drawIndexed.mockClear();

    renderer.drawSceneCasters((sink) => {
      sink.mesh(mesh, mat4.create(), { albedo: first });
      sink.mesh(mesh, mat4.create(), { albedo: second });
    });
    /* Draws are recorded and replayed at the end of the frame, so the pass sees them here. */
    renderer.endFrame();

    expect(stub.pass.drawIndexed.mock.calls.length, 'both draws reached the pass').toBe(2);
    expect(
      line!.used - before,
      'and each arrived with a material of its own rather than unpainted',
    ).toBe(2);
  });

  /**
   * Scatter is declined rather than drawn, and the absence is meant to be in the picture.
   *
   * A scatter batch's colour draw needs the camera and the environment of the pass it is going
   * into, and this enumeration records what a thing is rather than what the pass looks like.
   * Drawing it against whatever camera happened to be bound is the plausible-picture failure the
   * two-backends rule forbids, so a replayed pass has no scatter in it and a caller that wants
   * grass in a mirror draws it with the camera it already has.
   */
  it('declines scatter rather than drawing it against the wrong camera', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub);
    const mesh = stubMesh(renderer);
    const { camera, env } = stubScene();
    const scatterData = {
      capacity: 1,
      count: 1,
      matrices: new Float32Array(16),
      colors: new Float32Array(3),
    } as never;
    const scatter = renderer.createScatter(
      {
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
        colors: new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]),
        emissive: new Float32Array([0, 0, 0]),
        indices: new Uint32Array([0, 1, 2]),
      } as never,
      scatterData,
    );

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    stub.pass.drawIndexed.mockClear();

    renderer.drawSceneCasters((sink) => {
      sink.mesh(mesh, mat4.create());
      sink.scatter(scatter, scatterData, 0, 0, 0, 0);
    });
    renderer.endFrame();

    expect(stub.pass.drawIndexed.mock.calls.length, 'the mesh drew and the scatter did not').toBe(
      1,
    );
  });

  /**
   * A run of entries sharing one material spends one slot, which is what keeps a replay affordable.
   *
   * `ShadowCasterSink`'s material is optional and omitting it means *no material* rather than
   * *unchanged*, so the sink had no way of being told one was still standing and bound per entry.
   * Here a bind is not a slope but a cliff: `setMaterial` dirties `materialSlot`, so binding per
   * entry spends a slot **per draw** out of `materialChangesPerFrame`, and past the ring the draws
   * are skipped rather than mispainted. A consumer measured 82 materials a model over two to four
   * draws each and wrote a deduping sink of its own over the public verbs.
   *
   * Asserted on the budget line rather than on the ring, because that number is the one a consumer
   * can read; the draw count sits beside it so a sink that skipped the *draw* instead of the bind
   * fails here rather than looking like a saving.
   */
  it('spends one material slot on a run of draws that share a material', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub);
    const mesh = stubMesh(renderer);
    const { camera, env } = stubScene();
    /* Two references, and structurally different so that a deep compare would agree with them. */
    const stone = { roughnessScale: 0.8 };
    const glass = { roughnessScale: 0.1 };

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    const line = renderer.frameBudget.lines.find((l) => l.name === 'materials');
    const before = line!.used;
    stub.pass.drawIndexed.mockClear();

    renderer.drawSceneCasters((sink) => {
      for (const material of [stone, stone, stone, glass, glass, glass]) {
        sink.mesh(mesh, mat4.create(), material);
      }
    });
    const spent = line!.used - before;
    renderer.endFrame();

    expect(stub.pass.drawIndexed.mock.calls.length, 'every entry in the run drew').toBe(6);
    expect(spent, 'and the six of them spent two slots of the ring').toBe(2);
  });

  /**
   * The replay assumes nothing about what the pass around it left bound.
   *
   * The dedupe holds one reference, and a caller is free to set a material between two replays —
   * a mirror does, since it draws its own water. Carrying the standing material across a call
   * would paint the second replay's first run with whatever the frame set in between, which is a
   * wrong picture rather than a slow one.
   */
  it('takes a slot again when something else moved the material in between', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub);
    const mesh = stubMesh(renderer);
    const { camera, env } = stubScene();
    const stone = { roughnessScale: 0.8 };
    const water = { roughnessScale: 0.05 };

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    const line = renderer.frameBudget.lines.find((l) => l.name === 'materials');

    renderer.drawSceneCasters((sink) => sink.mesh(mesh, mat4.create(), stone));
    renderer.setMaterial(water);
    renderer.drawMesh(mesh, mat4.create());

    const before = line!.used;
    renderer.drawSceneCasters((sink) => sink.mesh(mesh, mat4.create(), stone));
    const spent = line!.used - before;
    renderer.endFrame();

    expect(spent, 'the second replay took a slot of its own back').toBe(1);
  });
});

/**
 * The compute seam, and the one invariant that shapes all of it.
 *
 * **`beginComputePass` cannot be opened while a render pass is open.** This frame's render pass is
 * opened late and then deliberately kept open, because closing and reopening it was measured at
 * 92 MB a frame at 824x1830 — so a dispatch records into an encoder of its own and the frame's is
 * never touched. That is what the second test here asserts, and it is the reason the seam looks
 * the way it does rather than a detail of it.
 */
describe('the compute seam', () => {
  const definition = () => ({
    label: 'binner',
    init: vi.fn(),
    dispatch: vi.fn(),
    dispose: vi.fn(),
  });

  it('reports that it can compute, and builds a definition once at registration', () => {
    const { surface, device } = stubSurface();
    const renderer = new WebGPURenderer(surface);
    const d = definition();

    expect(renderer.computeSupported).toBe(true);
    renderer.registerCompute(d);

    /* Once, at registration: building a pipeline in the frame loop is the allocation the house
       rules are about, which is the same argument `registerPass` makes for `init`. */
    expect(d.init).toHaveBeenCalledTimes(1);
    expect(d.init.mock.calls[0]?.[0]).toMatchObject({ backend: 'webgpu', device });
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it('dispatches on an encoder of its own, leaving the frame pass open', () => {
    const stub = stubSurface();
    const { surface, device, encoder, pass, computePass } = stub;
    const renderer = new WebGPURenderer(surface);
    const handle = renderer.registerCompute(definition());

    renderer.beginFrame([0, 0, 0]);
    /*
     * Cleared at the boundary, because the constructor and `beginFrame` both do encoder work of
     * their own — a shadow clear submits during construction. What is under test is what the
     * dispatch does, so the counters have to start at the dispatch.
     */
    device.createCommandEncoder.mockClear();
    device.queue.submit.mockClear();
    pass.end.mockClear();
    renderer.dispatchCompute(handle);

    expect(device.createCommandEncoder, 'an encoder of its own').toHaveBeenCalledTimes(1);
    expect(encoder.beginComputePass).toHaveBeenCalledTimes(1);
    expect(computePass.end).toHaveBeenCalledTimes(1);
    /* The whole point. A closed frame pass is a reopen, and a reopen is the 92 MB. */
    expect(pass.end, 'and the frame pass is never closed for it').not.toHaveBeenCalled();
    /* Submitted here rather than deferred: submission order is execution order, and a frame with
       a mirror in it submits three times before `endFrame` ever runs. */
    expect(device.queue.submit).toHaveBeenCalledTimes(1);
  });

  it('hands over the pass it opened, and nothing else', () => {
    const { surface, computePass } = stubSurface();
    const renderer = new WebGPURenderer(surface);
    const d = definition();

    renderer.dispatchCompute(renderer.registerCompute(d));

    const ctx = d.dispatch.mock.calls[0]?.[0] as { backend: string; pass: unknown };
    expect(ctx.backend).toBe('webgpu');
    /* Identity: the definition must be given the encoder, not a copy of a descriptor for one. */
    expect(ctx.pass).toBe(computePass);
  });

  it('dispatches nothing from a released handle, and disposes it once', () => {
    const { surface, device } = stubSurface();
    const renderer = new WebGPURenderer(surface);
    const d = definition();
    const handle = renderer.registerCompute(d);

    renderer.unregisterCompute(handle);
    expect(d.dispose).toHaveBeenCalledTimes(1);
    expect(d.dispose.mock.calls[0]?.[0]).toMatchObject({ backend: 'webgpu', device });

    /* Twice frees once, or one slot is handed to two definitions. */
    renderer.unregisterCompute(handle);
    expect(d.dispose).toHaveBeenCalledTimes(1);

    renderer.dispatchCompute(handle);
    expect(d.dispatch, 'a handle kept past release dispatches nothing').not.toHaveBeenCalled();
  });

  it('dispatches nothing once the device has gone', () => {
    const stub = stubSurface();
    const renderer = new WebGPURenderer(stub.surface);
    const d = definition();
    const handle = renderer.registerCompute(d);

    stub.markLost();
    stub.device.queue.submit.mockClear();
    renderer.dispatchCompute(handle);

    expect(d.dispatch).not.toHaveBeenCalled();
    expect(stub.device.queue.submit).not.toHaveBeenCalled();
  });
});

/**
 * Teardown releases what registration built, on the surface every contributing package uses.
 *
 * **The registries are private fields, and a field going out of scope is not a GPU object being
 * destroyed.** `unregisterPass` and `unregisterCompute` have always released the definition they
 * removed; nothing called either one on teardown. A pass and a compute definition each hold a
 * pipeline, a bind group and whatever buffers `init` built, so a consumer that creates and
 * destroys renderers leaked all of it per registration per renderer.
 *
 * **Drained before `surface.dispose()`, never after.** That call is `device.destroy()` — see
 * `device.ts` — and a definition releasing a buffer against a destroyed device is the one way
 * this fix can be wrong.
 */
describe('teardown', () => {
  it('releases every registered pass and definition, exactly once', () => {
    const { surface, device } = stubSurface();
    const renderer = new WebGPURenderer(surface);
    const pass = { label: 'probe', draw: vi.fn(), dispose: vi.fn() };
    const compute = { label: 'binner', dispatch: vi.fn(), dispose: vi.fn() };
    renderer.registerPass(pass);
    renderer.registerCompute(compute);

    renderer.dispose();

    expect(pass.dispose, 'the pass let go of what it built').toHaveBeenCalledTimes(1);
    expect(pass.dispose.mock.calls[0]?.[0]).toMatchObject({ backend: 'webgpu', device });
    expect(compute.dispose, 'and so did the definition').toHaveBeenCalledTimes(1);
    expect(compute.dispose.mock.calls[0]?.[0]).toMatchObject({ backend: 'webgpu', device });
  });

  it('drains the registries before the device is destroyed', () => {
    const stub = stubSurface();
    const order: string[] = [];
    /* Stands in for `device.destroy()`, which is what the real surface's `dispose` ends with. */
    (stub.surface as unknown as { dispose: () => void }).dispose = () => order.push('surface');
    const renderer = new WebGPURenderer(stub.surface);
    renderer.registerPass({ label: 'probe', draw: vi.fn(), dispose: () => order.push('pass') });
    renderer.registerCompute({
      label: 'binner',
      dispatch: vi.fn(),
      dispose: () => order.push('compute'),
    });

    renderer.dispose();

    expect(order, 'both released, and both before the device went').toEqual([
      'pass',
      'compute',
      'surface',
    ]);
  });

  it('does not release a definition that was already unregistered', () => {
    const { surface } = stubSurface();
    const renderer = new WebGPURenderer(surface);
    const pass = { label: 'probe', draw: vi.fn(), dispose: vi.fn() };
    const compute = { label: 'binner', dispatch: vi.fn(), dispose: vi.fn() };
    renderer.unregisterPass(renderer.registerPass(pass));
    renderer.unregisterCompute(renderer.registerCompute(compute));

    renderer.dispose();

    /* Released by the caller, and the registry no longer holds it for teardown to find. */
    expect(pass.dispose).toHaveBeenCalledTimes(1);
    expect(compute.dispose).toHaveBeenCalledTimes(1);
  });
});

/**
 * **A bake into an array that does not exist has to say so.**
 *
 * `prepareStaticPointShadows` builds the octahedral array and is a separate call a consumer makes
 * once. Forgetting it used to be completely silent: `updatePointShadows` ran, the bake budget was
 * spent every frame, and no light cast anything anywhere. The picture is indistinguishable from a
 * world whose lamps simply do not cast, which is what made it cost an investigation — four
 * confident eliminations, every one of them measuring the missing call.
 *
 * Asserted on the warning rather than on a pixel, because there is no pixel: the failure is the
 * absence of one.
 */
describe('point shadows without an array', () => {
  const LIGHT = {
    x: 0,
    y: 2,
    z: 0,
    radius: 8,
    shadowNear: 0.25,
    sourceRadius: 0.05,
    castsShadow: true,
  };

  it('says which call is missing, once, rather than baking into nothing', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const active = new Int32Array([0]);
      const noCasters = (): void => undefined;
      renderer.updatePointShadows([LIGHT], active, 1, 0, 0, 0, 1 / 60, noCasters, noCasters);
      renderer.updatePointShadows([LIGHT], active, 1, 0, 0, 0, 1 / 60, noCasters, noCasters);

      const said = warn.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => /prepareStaticPointShadows/.test(line));
      /* Once per renderer, not once per frame: a per-frame warning is a flood nobody reads. */
      expect(said.length).toBe(1);
      expect(said[0]).toMatch(/no point light will cast/);
    } finally {
      warn.mockRestore();
    }
  });

  it('stops warning once the array exists', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      renderer.prepareStaticPointShadows([LIGHT]);
      const noCasters = (): void => undefined;
      renderer.updatePointShadows(
        [LIGHT],
        new Int32Array([0]),
        1,
        0,
        0,
        0,
        1 / 60,
        noCasters,
        noCasters,
      );
      const said = warn.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => /prepareStaticPointShadows/.test(line));
      expect(said).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * A skinned triangle, so `mesh.isSkinned` is true and the skinned pipeline exists.
 *
 * Every vertex is weighted wholly to joint 0, which is all it takes: what these tests read is
 * where a palette was uploaded, not what the shader did with it.
 */
function skinnedStubMesh(renderer: WebGPURenderer) {
  return renderer.createMesh({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
    colors: new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]),
    emissive: new Float32Array([0, 0, 0]),
    indices: new Uint32Array([0, 1, 2]),
    joints: new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    weights: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
  } as never);
}

/** One joint, translated along X, so two palettes are distinguishable by value. */
function onePalette(x: number): Float32Array {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]);
}

/**
 * Where a palette upload landed: which texture, and where in it.
 *
 * A string rather than the objects, so the assertion below reads as "these two are not the same
 * place" without caring *how* they differ — a second texture and a second row are both correct
 * answers and the test must not pick one.
 */
function uploadedTo(device: StubDevice, palette: Float32Array): string | null {
  const call = device.queue.writeTexture.mock.calls.find(([, data]) => data === palette);
  if (call === undefined) return null;
  const at = call[0] as { texture: unknown; origin?: { x?: number; y?: number } };
  const textures = device.createTexture.mock.results.map((result) => result.value);
  return `${textures.indexOf(at.texture)}@${at.origin?.x ?? 0},${at.origin?.y ?? 0}`;
}

/** Every texture the device was asked for whose label names it a joint palette. */
function paletteTextures(device: StubDevice): string[] {
  return device.createTexture.mock.calls
    .map(([descriptor]) => String(descriptor.label ?? ''))
    .filter((label) => label.startsWith('skin.palette'));
}

/**
 * Two characters in one frame, which is the case the palette was a single texture for.
 *
 * **`queue.writeTexture` does not interleave with draw commands** — the same fact `UniformRing`
 * exists for. Writes are ordered on the queue timeline and the frame's encoder is submitted
 * afterwards, so two palettes uploaded into one texture between two draws give *both* draws the
 * last palette written. Measured in the product before this was a ring: a game drawing a ghost
 * of a previous run and then the live character drew the ghost with the *character's* palette, which
 * put a translucent second body exactly on top of the player and read as a transparency bug.
 *
 * Nothing caught it because nothing drew two rigs in one frame: no published scene has one, and
 * `demo/dev/skinning.ts` had a single character until `?pair=1` was added beside this.
 */
describe('the skin palette', () => {
  it('gives two skinned draws in one frame their own palette', () => {
    const stub = stubSurface();
    const { device } = stub;
    const renderer = freshRenderer(stub);
    const { camera, env } = stubScene();
    const mesh = skinnedStubMesh(renderer);
    const first = onePalette(-2);
    const second = onePalette(2);

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.setSkinPalette(first);
    renderer.drawMesh(mesh, mat4.create());
    renderer.setSkinPalette(second);
    renderer.drawMesh(mesh, mat4.create());
    renderer.endFrame();

    const one = uploadedTo(device, first);
    const two = uploadedTo(device, second);
    expect(one, 'the first palette must have been uploaded at all').not.toBeNull();
    expect(two, 'the second palette must have been uploaded at all').not.toBeNull();
    expect(
      one,
      'two palettes in one frame cannot share a place: the second overwrites the first before either draw runs',
    ).not.toBe(two);
  });

  it('reuses the same palette slots frame after frame', () => {
    const stub = stubSurface();
    const { device } = stub;
    const renderer = freshRenderer(stub);
    const { camera, env } = stubScene();
    const mesh = skinnedStubMesh(renderer);

    for (let frame = 0; frame < 3; frame++) {
      renderer.beginFrame([0, 0, 0]);
      renderer.bindMeshPass(camera, env);
      renderer.setSkinPalette(onePalette(-2));
      renderer.drawMesh(mesh, mat4.create());
      renderer.setSkinPalette(onePalette(2));
      renderer.drawMesh(mesh, mat4.create());
      renderer.endFrame();
    }

    /* Two characters, two slots, three frames: a slot allocated per frame is an allocation in
       the frame loop, which `AGENTS.md` forbids of a per-frame path. */
    expect(paletteTextures(device)).toHaveLength(2);
  });
});

/** A binding for `skinnedStubMesh`: every vertex wholly on particle `v` of three. */
function stubClothBinding() {
  return {
    triangles: new Uint32Array([0, 0, 0, 1, 1, 1, 2, 2, 2]),
    coordinates: new Float32Array(6),
    offsets: new Float32Array(3),
    weights: new Float32Array([1, 1, 1]),
    rest: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  };
}

/**
 * Every skinned colour draw a frame replayed, in order: whether its pipeline places by the cloth,
 * and every view held by the groups bound when it ran. Read off the pass in call order, because a
 * frame records its draws and replays them at `endFrame`.
 */
function skinnedDraws(stub: ReturnType<typeof stubSurface>) {
  const cloth = String(flatVertexBindings(true, false).overrides?.['CLOTH_BOUND']);
  const groups = stub.device.createBindGroup.mock.results.map((result) => result.value);
  type Call = { order: number; run: () => void };
  const calls: Call[] = [];
  let pipeline: GPURenderPipelineDescriptor | null = null;
  const bound = new Map<number, unknown[]>();
  const out: { cloth: boolean; views: unknown[] }[] = [];
  stub.pass.setPipeline.mock.calls.forEach(([p], k) => {
    calls.push({
      order: stub.pass.setPipeline.mock.invocationCallOrder[k] as number,
      run: () =>
        (pipeline = (p as unknown as { descriptor: GPURenderPipelineDescriptor }).descriptor),
    });
  });
  stub.pass.setBindGroup.mock.calls.forEach(([index, group], k) => {
    calls.push({
      order: stub.pass.setBindGroup.mock.invocationCallOrder[k] as number,
      run: () => {
        const descriptor = stub.device.createBindGroup.mock.calls[groups.indexOf(group)]?.[0];
        bound.set(
          index,
          (descriptor?.entries ?? []).map((entry) => entry.resource),
        );
      },
    });
  });
  stub.pass.drawIndexed.mock.calls.forEach((_, k) => {
    calls.push({
      order: stub.pass.drawIndexed.mock.invocationCallOrder[k] as number,
      run: () => {
        const constants = (pipeline as GPURenderPipelineDescriptor | null)?.vertex.constants;
        if (constants?.[cloth] === undefined || pipeline?.fragment?.constants === undefined) return;
        out.push({ cloth: constants[cloth] === 1, views: [...bound.values()].flat() });
      },
    });
  });
  calls.sort((a, b) => a.order - b.order);
  for (const call of calls) call.run();
  return out;
}

/** The two textures a character's particles swap between, and the views of each. */
function particleViews(stub: ReturnType<typeof stubSurface>) {
  return stub.device.createTexture.mock.results
    .map((result) => result.value)
    .filter((texture) => texture.label === 'cloth.particles')
    .map((texture) => ({
      texture,
      views: texture.createView.mock.results.map((result: { value: unknown }) => result.value),
    }));
}

/**
 * **A garment's draw reads this frame's particles, through a pipeline built with the binding on,
 * and the draw after it reads none.** Two frames, so the swap is watched: each update writes the
 * texture the frame before did not, and the draw binds the one just written — the other holds the
 * frame before, for a motion vector.
 */
describe('a cloth binding', () => {
  it("A GARMENT DRAW READS THIS FRAME'S PARTICLES, AND THE DRAW AFTER IT NONE", () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub);
    const { camera, env } = stubScene();
    const mesh = skinnedStubMesh(renderer);
    const binding = renderer.createClothBinding(mesh, stubClothBinding());
    const particles = renderer.createClothParticles(3);
    const [one, two] = particleViews(stub);
    expect(one, 'two particle textures').toBeDefined();
    expect(two, 'two particle textures').toBeDefined();
    const written: unknown[] = [];

    for (let frame = 0; frame < 2; frame++) {
      stub.device.queue.writeTexture.mockClear();
      renderer.updateClothParticles(particles, new Float32Array(9).fill(frame));
      written.push(stub.device.queue.writeTexture.mock.calls.at(-1)?.[0].texture);
      stub.pass.setPipeline.mockClear();
      stub.pass.setBindGroup.mockClear();
      stub.pass.drawIndexed.mockClear();
      renderer.beginFrame([0, 0, 0]);
      renderer.bindMeshPass(camera, env);
      renderer.setSkinPalette(onePalette(0));
      renderer.setCloth(binding, particles);
      renderer.drawMesh(mesh, mat4.create());
      renderer.setCloth(null);
      renderer.drawMesh(mesh, mat4.create());
      renderer.endFrame();
      const draws = skinnedDraws(stub);
      expect(
        draws.map((draw) => draw.cloth),
        `frame ${frame}`,
      ).toEqual([true, false]);
      const [bound, loose] = draws as [(typeof draws)[0], (typeof draws)[0]];

      const now = [one, two].find((entry) => entry?.texture === written[frame]);
      expect(now, `frame ${frame}: the update wrote a particle texture`).toBeDefined();
      expect(
        bound.views.some((view) => now?.views.includes(view)),
        `frame ${frame}: the garment binds the particles just written`,
      ).toBe(true);
      const anyParticles = [...(one?.views ?? []), ...(two?.views ?? [])];
      expect(
        loose.views.some((view) => anyParticles.includes(view)),
        `frame ${frame}: the draw after it binds no particles`,
      ).toBe(false);
    }
    expect(written[0], 'the second update writes the other texture').not.toBe(written[1]);
  });

  /*
   * **A garment's motion is drawn from its particles' last place, even with no previous place
   * named**, as a rewritten mesh's is: a coat swinging on a character standing still moves, and
   * only the particles know it. Not on the first update, which has no past, and not on a frame
   * that did not update them, which did not move them.
   */
  it("A GARMENT'S MOTION READS THIS FRAME'S PARTICLES AND LAST FRAME'S", () => {
    const stub = stubSurface();
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({ screenEffects: true, reconstruction: 1.5 }),
    );
    const { camera, env } = stubScene();
    const mesh = skinnedStubMesh(renderer);
    const binding = renderer.createClothBinding(mesh, stubClothBinding());
    const particles = renderer.createClothParticles(3);
    const viewOf = new Map(
      particleViews(stub).map((entry) => [entry.texture, entry.views[0]] as const),
    );
    const bindingView = stub.device.createTexture.mock.results
      .map((result) => result.value)
      .find((texture) => texture.label === 'cloth.binding')?.createView.mock.results[0]?.value;

    const frame = (update: boolean) => {
      let written: unknown = null;
      if (update) {
        stub.device.queue.writeTexture.mockClear();
        renderer.updateClothParticles(particles, new Float32Array(9));
        written = viewOf.get(stub.device.queue.writeTexture.mock.calls.at(-1)?.[0].texture);
      }
      stub.pass.setPipeline.mockClear();
      stub.pass.setBindGroup.mockClear();
      renderer.beginFrame([0, 0, 0]);
      renderer.bindMeshPass(camera, env);
      renderer.setSkinPalette(onePalette(0));
      renderer.setCloth(binding, particles);
      renderer.drawMesh(mesh, mat4.create());
      renderer.setCloth(null);
      renderer.endFrame();
      const pipelines = stub.pass.setPipeline.mock.calls.map(([p]) =>
        String((p as { label?: string }).label ?? ''),
      );
      const groups = stub.device.createBindGroup.mock.results.map((result) => result.value);
      const cloth = stub.pass.setBindGroup.mock.calls
        .filter(([index, group]) => index === 2 && group?.label === 'recon.motion.cloth')
        .map(
          ([, group]) => stub.device.createBindGroup.mock.calls[groups.indexOf(group)]?.[0].entries,
        )
        .at(-1);
      return {
        written,
        drawn: pipelines.some((label) => label.startsWith('recon.motion.cloth.')),
        views: Array.from(cloth ?? [], (entry: GPUBindGroupEntry) => entry.resource),
      };
    };

    expect(frame(true).drawn, 'a first update has no past').toBe(false);
    const last = frame(true);
    expect(last.drawn, 'a second update moved them').toBe(true);
    const other = [...viewOf.values()].find((view) => view !== last.written);
    /* By identity: two views of one label are deep-equal stubs, and the order is the point. */
    const expected = [bindingView, last.written, other];
    expect(last.views.map((view, k) => view === expected[k])).toEqual([true, true, true]);
    expect(frame(false).drawn, 'a frame that did not update them did not move them').toBe(false);
  });

  it('refuses a binding for a rigid mesh, or particles it does not name', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub);
    expect(() => renderer.createClothBinding(stubMesh(renderer), stubClothBinding())).toThrow(
      /no rig/,
    );
    const binding = renderer.createClothBinding(skinnedStubMesh(renderer), stubClothBinding());
    expect(() => renderer.setCloth(binding, renderer.createClothParticles(4))).toThrow(
      /3 particles and these are 4/,
    );
  });
});

/** Whether `triple` stands in a ring upload at a field's offset in some slot (slots are 256 apart). */
function holdsAt(floats: Float32Array, field: number, triple: number[]): boolean {
  for (let p = field; p + 2 < floats.length; p += 64) {
    if (triple.every((v, k) => Math.abs((floats[p + k] as number) - v) < 1e-6)) return true;
  }
  return false;
}

describe('a shading model', () => {
  /*
   * **A material's model chooses its pipeline, and the next material goes back to the standard
   * one.** The model's switch is set from the draw's key, and only for the draw whose material
   * named it; its numbers reach the block at `uModelParams` as `packModel` lays them.
   */
  it("A MATERIAL'S MODEL CHOOSES THE PIPELINE, AND ITS NUMBERS REACH THE BLOCK", () => {
    const stub = stubSurface();
    const quality = resolveRenderQuality({});
    const renderer = freshRenderer(stub, quality);
    const { camera, env } = stubScene();
    const mesh = stubMesh(renderer);
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.setMaterial({ model: hairModel({ shift: -0.125, scatter: 0.25, backlit: 2 }) });
    renderer.drawMesh(mesh, mat4.create());
    renderer.setMaterial(null);
    renderer.drawMesh(mesh, mat4.create());
    renderer.endFrame();
    const hair = (p: unknown) =>
      (p as { descriptor?: GPURenderPipelineDescriptor }).descriptor?.fragment?.constants?.['6'];
    const lit = stub.pass.setPipeline.mock.calls
      .map(([p]) => hair(p))
      .filter((c) => c !== undefined);
    expect(lit).toEqual([1, 0]);
    const field =
      (flatFragmentBindings(variantFor(quality)).fields['uModelParams']?.offset ?? -4) / 4;
    const floats = new Float32Array(ringUpload(stub.device, 'flat.fragRing'));
    expect(holdsAt(floats, field, [-0.125, 0.25, 2])).toBe(true);
  });

  /*
   * **An eye's axis is its draw's.** Turned a quarter about Y, the eye looking along +Z looks along
   * +X; drawn again unturned, along +Z — in a slot of its own, or the first draw would read the
   * second's axis.
   */
  it("AN EYE'S AXIS IS TURNED BY EACH DRAW, IN A SLOT OF ITS OWN", () => {
    const stub = stubSurface();
    const quality = resolveRenderQuality({});
    const renderer = freshRenderer(stub, quality);
    const { camera, env } = stubScene();
    const mesh = stubMesh(renderer);
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.setMaterial({ model: eyeModel() });
    renderer.drawMesh(mesh, mat4.fromYRotation(mat4.create(), Math.PI / 2));
    renderer.drawMesh(mesh, mat4.create());
    renderer.endFrame();
    const field =
      (flatFragmentBindings(variantFor(quality)).fields['uModelParams']?.offset ?? -4) / 4;
    const floats = new Float32Array(ringUpload(stub.device, 'flat.fragRing'));
    expect(holdsAt(floats, field + 4, [1, 0, 0]), 'the turned draw').toBe(true);
    expect(holdsAt(floats, field + 4, [0, 0, 1]), 'the unturned draw').toBe(true);
  });

  /*
   * **Screen-space skin draws in three halves and is spread once, and only where the profile
   * asked.** Under `skinScattering: 'screen-space'` a skin draw lands in the frame through its
   * scene half, and its diffuse's light and its colour are replayed when the frame first draws
   * something blended: the frame's pass broken once for the light, once for the colour, the blur's
   * two axes, and the frame reopened. A skin drawn after that is the whole surface again, and a
   * standard draw never splits. By default, none of it.
   */
  it('SCREEN-SPACE SKIN DRAWS THREE HALVES AND IS SPREAD ONCE, BEFORE THE FIRST BLENDED DRAW', () => {
    for (const skinScattering of ['screen-space', 'pre-integrated'] as const) {
      const stub = stubSurface();
      const quality = resolveRenderQuality({ skinScattering });
      const renderer = freshRenderer(stub, quality);
      const { camera, env } = stubScene();
      const mesh = stubMesh(renderer);
      renderer.beginFrame([0, 0, 0]);
      renderer.bindMeshPass(camera, env);
      renderer.setMaterial({ model: skinModel() });
      renderer.drawMesh(mesh, mat4.create());
      renderer.setMaterial(null);
      renderer.drawMesh(mesh, mat4.create());
      renderer.drawTranslucentMesh(mesh, mat4.create(), 0.5);
      renderer.setMaterial({ model: skinModel() });
      renderer.drawMesh(mesh, mat4.create());
      renderer.endFrame();
      const passes = stub.encoder.beginRenderPass.mock.calls.map((c) => String(c[0]?.label ?? ''));
      const skinPasses = passes.filter((label) => label.startsWith('skin.'));
      /* Each lit draw's model and halves, by their switches' ids: skin 7, scene 9, diffuse 10,
         colour 11. */
      const halves = stub.pass.setPipeline.mock.calls
        .map(([p]) => (p as { descriptor?: GPURenderPipelineDescriptor }).descriptor)
        .map((d) => d?.fragment?.constants)
        .filter((c) => c !== undefined && c['7'] !== undefined)
        .map((c) => `${c?.['7']}${c?.['9']}${c?.['10']}${c?.['11']}`);
      if (skinScattering === 'screen-space') {
        expect(skinPasses).toEqual([
          'skin.diffuse',
          'skin.albedo',
          'skin.blurAcross',
          'skin.blurDown',
          'skin.scattered',
        ]);
        expect(halves, "the first skin's frame half").toContain('1100');
        expect(halves, 'its diffuse half, replayed once').toContain('1010');
        expect(halves.filter((h) => h === '1010')).toHaveLength(1);
        expect(halves, 'its colour half, replayed once').toContain('1001');
        expect(halves.filter((h) => h === '1001')).toHaveLength(1);
        expect(halves, 'the skin drawn after the spread, whole').toContain('1000');
      } else {
        expect(skinPasses).toEqual([]);
        expect(halves).not.toContain('1100');
        expect(halves).not.toContain('1010');
        expect(halves).not.toContain('1001');
      }
    }
    /* A skin drawn after the frame's first blended draw is the whole surface, skin before it or not. */
    {
      const stub = stubSurface();
      const renderer = freshRenderer(
        stub,
        resolveRenderQuality({ skinScattering: 'screen-space' }),
      );
      const { camera, env } = stubScene();
      const mesh = stubMesh(renderer);
      renderer.beginFrame([0, 0, 0]);
      renderer.bindMeshPass(camera, env);
      renderer.drawTranslucentMesh(mesh, mat4.create(), 0.5);
      renderer.setMaterial({ model: skinModel() });
      renderer.drawMesh(mesh, mat4.create());
      renderer.endFrame();
      const passes = stub.encoder.beginRenderPass.mock.calls.map((c) => String(c[0]?.label ?? ''));
      expect(passes.filter((label) => label.startsWith('skin.'))).toEqual([]);
    }
    /* And a frame with nothing blended in it spreads its skin before its end, all the same. */
    const stub = stubSurface();
    const renderer = freshRenderer(stub, resolveRenderQuality({ skinScattering: 'screen-space' }));
    const { camera, env } = stubScene();
    const mesh = stubMesh(renderer);
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.setMaterial({ model: skinModel() });
    renderer.drawMesh(mesh, mat4.create());
    renderer.endFrame();
    const passes = stub.encoder.beginRenderPass.mock.calls.map((c) => String(c[0]?.label ?? ''));
    expect(passes.filter((label) => label.startsWith('skin.'))).toEqual([
      'skin.diffuse',
      'skin.albedo',
      'skin.blurAcross',
      'skin.blurDown',
      'skin.scattered',
    ]);
  });
});

/**
 * The budget, and the message that never described what this code does.
 *
 * **`WebGPU: more than 1024 materials in a frame; the rest reuse the last` was wrong in the commit
 * that wrote it.** `materialSlotForDraw` has returned null and the caller has skipped the draw
 * since `9d90bf7`; nothing has ever reused the last material. The doc comment at
 * The ring's ceiling said the same thing and was the stated argument for raising the ring
 * from 256 to 1024 — "reads as a stretch of the world losing its texture and has been reported
 * twice from a consumer". What those consumers saw was geometry that was not drawn.
 *
 * The tests below pin the behaviour rather than the wording, so the two cannot part again without
 * something failing.
 */
describe('the frame budget', () => {
  it('counts what a frame asked for past a ceiling, not what fit', () => {
    const { surface } = stubSurface();
    const renderer = new WebGPURenderer(surface, resolveRenderQuality({}));
    const { camera, env } = stubScene();
    const mesh = stubMesh(renderer);

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    const ceiling = materialCeiling(renderer);
    for (let i = 0; i < ceiling + 40; i++) {
      renderer.drawTranslucentMesh(mesh, mat4.create(), 1, { lit: false });
    }

    const materials = renderer.frameBudget.lines.find((line) => line.name === 'materials');
    expect(materials?.used, 'asked for, not fitted').toBe(ceiling + 40);
    expect(materials?.ceiling).toBe(ceiling);
    expect(materials?.dropped).toBe(40);
    expect(renderer.frameBudget.dropped).toBe(true);
  });

  /**
   * **The draw past the ceiling is not issued at all**, which is what the warning denied.
   *
   * Asserted on the recorded pipeline count rather than on a flag: what a consumer sees is
   * geometry missing, and the thing that produces missing geometry is a draw that was never
   * recorded. If somebody ever does implement "reuse the last", this fails and they have to
   * come back and change the message with it.
   */
  it('skips the draw that found no material slot rather than drawing it with the last one', () => {
    const { surface, pass } = stubSurface();
    const renderer = new WebGPURenderer(surface, resolveRenderQuality({}));
    const { camera, env } = stubScene();
    const mesh = stubMesh(renderer);

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    const ceiling = materialCeiling(renderer);
    for (let i = 0; i < ceiling; i++) {
      renderer.drawTranslucentMesh(mesh, mat4.create(), 1, { lit: false });
    }
    const drawnWhenFull = pass.drawIndexed.mock.calls.length;

    renderer.drawTranslucentMesh(mesh, mat4.create(), 1, { lit: false });
    expect(
      pass.drawIndexed.mock.calls.length,
      'the draw past the ceiling is skipped, not drawn with another material',
    ).toBe(drawnWhenFull);
  });

  /*
   * **A bought city of 1,139 materials and the planar mirror of its river did not fit 1,024**,
   * measured: the street alone spent about nine hundred changes and the mirror the rest twice over,
   * so the reflection came and went as the camera turned. The ring is a construction-time option
   * so a scene that measures past the default can ask, and the line reports the ceiling it got.
   */
  it('A RING SIZED BY materialChangesPerFrame HOLDS WHAT THE DEFAULT DROPS, and its line says so', () => {
    const cases = [
      { quality: resolveRenderQuality({}), ceiling: 1024, dropped: 76 },
      {
        quality: resolveRenderQuality({ materialChangesPerFrame: 1100 }),
        ceiling: 1100,
        dropped: 0,
      },
    ];
    for (const { quality, ceiling, dropped } of cases) {
      const { surface } = stubSurface();
      const renderer = new WebGPURenderer(surface, quality);
      const { camera, env } = stubScene();
      const mesh = stubMesh(renderer);
      renderer.beginFrame([0, 0, 0]);
      renderer.bindMeshPass(camera, env);
      for (let i = 0; i < 1100; i++)
        renderer.drawTranslucentMesh(mesh, mat4.create(), 1, { lit: false });
      const materials = renderer.frameBudget.lines.find((line) => line.name === 'materials');
      expect(materials?.ceiling).toBe(ceiling);
      expect(materials?.dropped, `dropped on a ring of ${ceiling}`).toBe(dropped);
      expect(renderer.frameBudget.lines[1]?.name, 'still the second line a report reads').toBe(
        'materials',
      );
    }
  });

  it('A DRAW RING SIZED BY drawsPerFrame skips what is past it, and the default does not', () => {
    const cases = [
      { quality: resolveRenderQuality({}), ceiling: 4096, dropped: 0 },
      { quality: resolveRenderQuality({ drawsPerFrame: 50 }), ceiling: 50, dropped: 10 },
    ];
    for (const { quality, ceiling, dropped } of cases) {
      const { surface } = stubSurface();
      const renderer = new WebGPURenderer(surface, quality);
      const { camera, env } = stubScene();
      const mesh = stubMesh(renderer);
      renderer.beginFrame([0, 0, 0]);
      renderer.bindMeshPass(camera, env);
      for (let i = 0; i < 60; i++) renderer.drawMesh(mesh, mat4.create());
      const draws = renderer.frameBudget.lines.find((line) => line.name === 'draws');
      expect(draws?.ceiling).toBe(ceiling);
      expect(draws?.dropped, `dropped on a ring of ${ceiling}`).toBe(dropped);
      const shadows = renderer.frameBudget.lines.find((line) => line.name === 'shadow draws');
      expect(shadows?.ceiling, 'the shadow ring is the same size').toBe(ceiling);
    }
    expect(() => resolveRenderQuality({ drawsPerFrame: 0 })).toThrow(/drawsPerFrame/);
    expect(() => resolveRenderQuality({ drawsPerFrame: 65537 })).toThrow(/at most 65536/);
  });

  it('refuses a material ring that is not a whole positive number, or past the most kept', () => {
    expect(() => resolveRenderQuality({ materialChangesPerFrame: 0 })).toThrow(
      /materialChangesPerFrame/,
    );
    expect(() => resolveRenderQuality({ materialChangesPerFrame: 1.5 })).toThrow(
      /materialChangesPerFrame/,
    );
    expect(() => resolveRenderQuality({ materialChangesPerFrame: 8193 })).toThrow(/at most 8192/);
  });

  it('clears every line at the start of a frame, and keeps the objects', () => {
    const { surface } = stubSurface();
    const renderer = new WebGPURenderer(surface, resolveRenderQuality({}));
    const { camera, env } = stubScene();
    const mesh = stubMesh(renderer);

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(mesh, mat4.create());
    const lines = renderer.frameBudget.lines;
    const draws = lines.find((line) => line.name === 'draws');
    expect(draws?.used).toBeGreaterThan(0);

    renderer.beginFrame([0, 0, 0]);
    expect(draws?.used, 'cleared, and the same object as before').toBe(0);
    expect(renderer.frameBudget.lines).toBe(lines);
  });

  /**
   * **Every ceiling that writes a warning also reports a number**, checked as a set rather than
   * one by one. A ceiling added with a warning and no line is the shape this whole change exists
   * to remove, and it would otherwise be found by a consumer rather than here.
   */
  it('names a line for every ceiling this backend imposes', () => {
    const { surface } = stubSurface();
    const renderer = new WebGPURenderer(surface, resolveRenderQuality({}));
    expect(renderer.frameBudget.lines.map((line) => line.name)).toEqual([
      'draws',
      'materials',
      'bind groups',
      'shadow draws',
      'scatter shadow draws',
      'water bodies',
      'light volumes',
      'wind streak fields',
      'flocks',
      'bolt batches',
      'caustics',
      'text draws',
      'sdf text draws',
      'line draws',
      'panels',
    ]);
    for (const line of renderer.frameBudget.lines) {
      /*
       * `bind groups` counts rather than rations, so it is the one line here with nothing to
       * publish. Exempted by name rather than by relaxing the assertion to "null or positive",
       * which would let a real ceiling go missing without anything noticing.
       */
      if (line.name === 'bind groups') {
        expect(line.ceiling, 'a counted line imposes no ceiling and says so').toBeNull();
        continue;
      }
      expect(line.ceiling, `${line.name} publishes the ceiling it enforces`).toBeGreaterThan(0);
    }
  });
});

/**
 * Growth: a frame that ran out is not condemned to run out forever.
 *
 * **The ceiling stays, and so does the skip.** What changes is that the ceiling follows the scene
 * instead of the scene being cut to the ceiling. A frame that asks for 1,267 material changes
 * against 1,024 loses 243 of them once and is drawn whole from the next frame on, where before it
 * lost them for as long as the scene stayed that size — which, for a consumer whose world simply
 * got bigger, is forever.
 *
 * These run against a stub device, so what they can prove is the bookkeeping: the ring is bigger,
 * nothing is refused the second time, and the bind groups holding the old buffer were dropped.
 * That the *rebuilt* groups are valid is a question only a real device answers, and it is answered
 * in `scripts/ring-growth-check.mjs`.
 */
describe('rings that grow', () => {
  function drawMaterials(
    renderer: WebGPURenderer,
    mesh: ReturnType<typeof stubMesh>,
    count: number,
  ): void {
    const { camera, env } = stubScene();
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    for (let i = 0; i < count; i++) {
      renderer.drawTranslucentMesh(mesh, mat4.create(), 1, { lit: false });
    }
  }

  it('draws whole the frame after one that ran out of material slots', () => {
    const { surface } = stubSurface();
    const renderer = new WebGPURenderer(surface, resolveRenderQuality({}));
    const mesh = stubMesh(renderer);
    const asked = materialCeiling(renderer) + 243;

    drawMaterials(renderer, mesh, asked);
    const first = renderer.frameBudget.lines.find((line) => line.name === 'materials');
    expect(first?.dropped, 'the frame that discovers the ceiling still loses work').toBe(243);

    drawMaterials(renderer, mesh, asked);
    const second = renderer.frameBudget.lines.find((line) => line.name === 'materials');
    expect(second?.used).toBe(asked);
    expect(second?.dropped, 'and the next one does not').toBe(0);
    expect(renderer.frameBudget.dropped).toBe(false);
  });

  it('grows to a power of two, so a scene creeping upwards does not reallocate every frame', () => {
    const { surface } = stubSurface();
    const renderer = new WebGPURenderer(surface, resolveRenderQuality({}));
    const mesh = stubMesh(renderer);
    const ceiling = materialCeiling(renderer);

    drawMaterials(renderer, mesh, ceiling + 1);
    /* Growth is the next frame's first act, not this one's last: see `growRings`. */
    renderer.beginFrame([0, 0, 0]);
    const ring = (renderer as unknown as { perFrame: { slots: number } }).perFrame;
    expect(ring.slots, 'one past 1024 takes 2048, not 1025').toBe(ceiling * 2);

    /* And the frames after it, up to the new size, do not grow again. */
    const created = (surface.device.createBuffer as ReturnType<typeof vi.fn>).mock.calls.length;
    drawMaterials(renderer, mesh, ceiling + 400);
    expect((surface.device.createBuffer as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      created,
    );
  });

  /**
   * **Every bind group that held the old buffer is gone**, which is the half of growth that has
   * teeth: a stale group is a validation failure on a real device, or worse, a draw reading a
   * destroyed buffer. Asserted by identity, because that is what the caches compare.
   */
  it('drops every flat bind group built against the buffer it replaced', () => {
    const { surface } = stubSurface();
    const renderer = new WebGPURenderer(surface, resolveRenderQuality({}));
    const mesh = stubMesh(renderer);
    const inner = renderer as unknown as {
      bindGroup: GPUBindGroup;
      blankAlbedoBindGroup: GPUBindGroup;
      flatBindGroups: Map<unknown, unknown>;
      skinnedGroups: unknown[];
      perFrame: { buffer: GPUBuffer };
    };

    const beforeBuffer = inner.perFrame.buffer;
    const beforeBlank = inner.blankAlbedoBindGroup;

    drawMaterials(renderer, mesh, materialCeiling(renderer) + 1);
    renderer.beginFrame([0, 0, 0]);

    expect(inner.perFrame.buffer, 'the ring took a new buffer').not.toBe(beforeBuffer);
    expect(inner.blankAlbedoBindGroup, 'and the blank group was rebuilt over it').not.toBe(
      beforeBlank,
    );
    expect(inner.flatBindGroups.size, 'every cached flat group dropped').toBe(0);
    expect(inner.skinnedGroups.length, 'and every skinned twin').toBe(0);
  });

  it('stops growing at its memory ceiling and goes back to reporting what it drops', () => {
    const { surface } = stubSurface();
    const renderer = new WebGPURenderer(surface, resolveRenderQuality({}));
    const ring = (renderer as unknown as { perFrame: { growTo: (n: number) => boolean } }).perFrame;
    expect(ring.growTo(1_000_000_000), 'refused, rather than allocating a gigabyte').toBe(false);
  });
});

/**
 * **The other half of the sample-count guard, whose WebGL2 twin lives in that backend's own
 * suite.** Neither test is meaningful alone: together they say that one `RenderQuality` produces
 * the same composite on both backends, which is the whole of the 2026-08-13 rule.
 *
 * This backend has excluded multisampling from the decision since the effect shipped, and said so
 * only in a comment — so a profile carrying `orderIndependent: true` beside `sceneSamples: 4` got
 * sorted blending and no account of why on either backend. A graphics screen puts a player either
 * side of that with an antialiasing switch.
 */
describe('order-independent transparency against multisampling', () => {
  function refusals(quality: Partial<RenderQuality>): string[] {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { surface } = stubSurface();
      const renderer = new WebGPURenderer(surface, resolveRenderQuality(quality));
      renderer.beginFrame([0, 0, 0]);
      renderer.beginFrame([0, 0, 0]);
      return warn.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('order-independent transparency'));
    } finally {
      vi.restoreAllMocks();
    }
  }

  it('says once that multisampling excludes the effect, rather than only sorting', () => {
    const said = refusals({ orderIndependent: true, sceneSamples: 4 });

    expect(said, 'once for the renderer, not once a frame').toHaveLength(1);
    expect(said[0], 'and it names the reason, so the setting can be found').toMatch(/multisampl/);
  });

  /**
   * The control. A refusal that also fires for the profile the effect *does* run in would be
   * noise a consumer learns to ignore, which is the same failure as saying nothing.
   */
  it('says nothing where the profile can have the effect', () => {
    expect(refusals({ orderIndependent: true, sceneSamples: 1 })).toEqual([]);
  });

  /** And nothing at all where nobody asked for it, multisampled or not. */
  it('says nothing to a profile that never asked for it', () => {
    expect(refusals({ sceneSamples: 4 })).toEqual([]);
  });
});

/**
 * The fields a frame declares, and the field the renderer composes from them.
 *
 * **The gate here is the first test, not the rest of them.** Wave 4A's own constraint is that
 * indirect light off is byte-for-byte what the renderer did before it existed, and a composition
 * that ran anyway would be a compute pass in every frame of every scene that never asked. The
 * others are about the seam being wired at all.
 */
describe('the distance fields a frame declares', () => {
  /** A field small enough that a test allocates nothing worth mentioning. */
  function field(): { field: Float32Array; dims: [number, number, number]; bounds: Float32Array } {
    return {
      field: new Float32Array(4 ** 3).fill(1),
      dims: [4, 4, 4],
      bounds: Float32Array.from([-1, -1, -1, 1, 1, 1]),
    };
  }

  /** One frame that declares `count` fields, under the asked profile. */
  function frame(quality: RenderQualityOptions, count: number) {
    const stub = stubSurface();
    const renderer = freshRenderer(stub, resolveRenderQuality(quality));
    const { camera, env } = stubScene();
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    const source = field();
    for (let i = 0; i < count; i += 1) renderer.addDistanceField(source, mat4.create());
    stub.encoder.beginComputePass.mockClear();
    renderer.endFrame();
    return { stub, renderer };
  }

  it('COMPOSES NOTHING AT ALL WITH INDIRECT LIGHT OFF, whatever was declared', () => {
    const { stub } = frame({}, 3);
    expect(stub.encoder.beginComputePass).not.toHaveBeenCalled();
  });

  it('ALLOCATES NOTHING WHEN THE FLAG IS ON AND NO FIELD WAS DECLARED', () => {
    /*
     * **The dispatch is not what this guard saves, and a test that only counted dispatches passed
     * with the guard removed.** `FieldComposer.compose` already returns early on an empty scene,
     * so the renderer's own check changes no command it records. What it changes is whether the
     * composer is *built* — 1.4 MB of device buffers and a compute pipeline — for a profile with
     * the flag on that declares no fields, which is a scene lit entirely from a baked grid.
     */
    const { stub } = frame({ indirectLight: true }, 0);
    expect(stub.encoder.beginComputePass).not.toHaveBeenCalled();
    const made = stub.device.createBuffer.mock.calls.filter((call) =>
      String(call[0]?.label ?? '').startsWith('gi-field'),
    );
    expect(made, 'no composer was built at all').toEqual([]);
  });

  it('composes one pass a frame once the flag is on and a field was declared', () => {
    const { stub } = frame({ indirectLight: true }, 1);
    const composed = stub.encoder.beginComputePass.mock.calls.filter(
      (call) => call[0]?.label === 'gi compose',
    );
    expect(composed).toHaveLength(1);
  });

  it('offers the composed field to a pass, and offers null before one was composed', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub, resolveRenderQuality({ indirectLight: true }));
    const { camera, env } = stubScene();
    const seen: (unknown | null)[] = [];
    renderer.registerPass({
      label: 'reader',
      prepare: (ctx) => {
        seen.push(ctx.backend === 'webgpu' ? ctx.distanceField : null);
      },
      draw: () => undefined,
    });

    /* The first frame prepares before anything has been composed, so it is offered null. */
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.addDistanceField(field(), mat4.create());
    renderer.endFrame();

    /* And the second is offered the field the first composed — one frame behind, by design. */
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.endFrame();

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeNull();
    expect(seen[1]).toMatchObject({ levels: 3, side: 49 });
  });

  it('forgets what a frame declared, so a field nobody redeclares stops lighting', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub, resolveRenderQuality({ indirectLight: true }));
    const { camera, env } = stubScene();

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.addDistanceField(field(), mat4.create());
    renderer.endFrame();

    stub.encoder.beginComputePass.mockClear();
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.endFrame();
    expect(stub.encoder.beginComputePass).not.toHaveBeenCalled();
  });
});

/**
 * The probes traced from the field, and the gate that says off costs nothing.
 *
 * **The first test is the gate and the rest are the wiring.** Wave 4A's constraint is that indirect
 * light off is byte-for-byte what the renderer did before it existed, and a bake that ran anyway
 * would be two compute dispatches and five render passes in every frame of every scene.
 */
describe('the probes a frame traces', () => {
  function field(): { field: Float32Array; dims: [number, number, number]; bounds: Float32Array } {
    return {
      field: new Float32Array(4 ** 3).fill(1),
      dims: [4, 4, 4],
      bounds: Float32Array.from([-2, -2, -2, 2, 2, 2]),
    };
  }

  /** Two frames, because the field is composed at the end of one and traced against in the next. */
  function frames(quality: RenderQualityOptions, count: number) {
    /*
     * The ceiling `select.ts` actually requests, because `probeFits` refuses a probe array on a
     * device that reports the bare minimum — and with no array there is nothing to bake into.
     */
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({ reflectionProbeSize: 64, ...quality }),
    );
    const { camera, env } = stubScene();
    const source = field();
    for (let frame = 0; frame < count; frame += 1) {
      renderer.beginFrame([0, 0, 0]);
      renderer.bindMeshPass(camera, env);
      renderer.addDistanceField(source, mat4.create());
      renderer.endFrame();
    }
    return stub;
  }

  it('TRACES THE SAME DIRECTIONS AT EVERY REFRESH, so a still scene lights a still picture', () => {
    /*
     * The direction set used to turn every frame, so every refresh of a probe was a new estimate a
     * few per cent from the last, and a courtyard held perfectly still flickered: 77% of its pixels
     * moved by more than 3 levels over a dozen frames, against 2.5% with the rasterised grid.
     * Blending in history only shrinks that; a set that does not turn removes it.
     */
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({ reflectionProbeSize: 64, indirectLight: true }),
    );
    const { camera, env } = stubScene();
    const source = field();
    const turns = new Set<number>();
    for (let frame = 0; frame < 12; frame += 1) {
      renderer.beginFrame([0, 0, 0]);
      renderer.bindMeshPass(camera, env);
      renderer.addDistanceField(source, mat4.create());
      renderer.endFrame();
      const writes = stub.device.queue.writeBuffer.mock.calls.filter(
        (call) => (call[0] as { label?: string }).label === 'probe bake bake',
      );
      const last = writes[writes.length - 1];
      if (last !== undefined) turns.add(((last as unknown[])[2] as Float32Array)[BAKE_FRAME] ?? -1);
    }
    expect(Array.from(turns)).toEqual([0]);
  });

  it('BLENDS A REFRESH INTO THE PROBE ONLY ONCE THE WHOLE GRID HAS BEEN TRACED', () => {
    /*
     * Before every probe has one traced value there is nothing to blend with but whatever filled
     * the layer first, so the first pass is taken as it comes and the grid lights at once; after
     * it, each refresh keeps `PROBE_HISTORY` of what the layer held.
     */
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({ reflectionProbeSize: 64, indirectLight: true }),
    );
    const { camera, env } = stubScene();
    const source = field();
    const blocks: number[] = [];
    for (let frame = 0; frame < 40; frame += 1) {
      renderer.beginFrame([0, 0, 0]);
      renderer.bindMeshPass(camera, env);
      renderer.addDistanceField(source, mat4.create());
      renderer.endFrame();
      const writes = stub.device.queue.writeBuffer.mock.calls.filter(
        (call) => (call[0] as { label?: string }).label === 'probe bake bake',
      );
      const last = writes[writes.length - 1];
      if (last !== undefined)
        blocks.push(((last as unknown[])[2] as Float32Array)[BAKE_HISTORY] ?? -1);
    }
    expect(blocks[0], 'the first pass blended with nothing').toBe(0);
    expect(blocks[blocks.length - 1]).toBeCloseTo(PROBE_HISTORY, 6);
  });

  it('HANDS THE BAKE THE SKY THE FRAME DREW, and the ambient only where it drew none', () => {
    /*
     * **A ray that leaves the world sees the sky, and the sky is the one the frame drew.** The bake
     * read the environment's ambient for every escaping ray, a grade's fill a palette sets apart
     * from the sky: at ten degrees of sun a courtyard's ambient was five times dimmer than its
     * horizon and blue where the horizon was amber, so traced shade at dusk came out cool. So the
     * block carries the drawn sky, and says so with a flag; a frame that drew none still gets one
     * colour for outside, and the flag says that too.
     */
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({ reflectionProbeSize: 64, indirectLight: true }),
    );
    const { camera, env } = stubScene();
    const source = field();
    const sky = {
      top: new Float32Array([0.3, 0.45, 0.8]),
      horizon: new Float32Array([1.5, 1.08, 0.66]),
      deep: new Float32Array([0.05, 0.05, 0.06]),
      sunDir: new Float32Array([0.6, 0.13, 0.79]),
      sunColor: new Float32Array([1, 1, 1]),
      sunAngularRadius: 0.01,
      moonDir: new Float32Array([0, -1, 0]),
      moonColor: new Float32Array([0, 0, 0]),
      moonAngularRadius: 0.01,
      moonPhase: 0.5,
      nightFactor: 0,
      cloudOffsetX: 0,
      cloudOffsetZ: 0,
    } as never as SkyColors;
    const draw = (withSky: boolean): Float32Array => {
      for (let frame = 0; frame < 2; frame += 1) {
        renderer.beginFrame([0, 0, 0]);
        if (withSky) renderer.drawSky(camera, sky, env);
        renderer.bindMeshPass(camera, env);
        renderer.addDistanceField(source, mat4.create());
        renderer.endFrame();
      }
      const writes = stub.device.queue.writeBuffer.mock.calls.filter(
        (call) => (call[0] as { label?: string }).label === 'probe bake bake',
      );
      const last = writes[writes.length - 1];
      expect(last, 'the bake wrote no block').toBeDefined();
      return Float32Array.from((last as unknown[])[2] as Float32Array);
    };
    const three = (block: Float32Array, at: number): number[] =>
      Array.from(block.subarray(at, at + 3));

    const drawn = draw(true);
    expect(drawn[BAKE_SKY_DRAWN]).toBe(1);
    expect(three(drawn, BAKE_SKY_COLOUR)).toEqual(Array.from(sky.horizon));
    expect(three(drawn, BAKE_SKY_TOP)).toEqual(Array.from(sky.top));
    expect(three(drawn, BAKE_SKY_DEEP)).toEqual(Array.from(sky.deep));
    expect(three(drawn, BAKE_SKY_SUN)).toEqual(Array.from(sky.sunDir));

    const none = draw(false);
    expect(none[BAKE_SKY_DRAWN]).toBe(0);
    /* `stubScene`'s ambient, 0.1 a channel, as the device holds it. */
    expect(three(none, BAKE_SKY_COLOUR)).toEqual(Array.from(Float32Array.from([0.1, 0.1, 0.1])));
  });

  /** Every compute pass this frame opened, by the label its descriptor carries. */
  function computeLabels(stub: ReturnType<typeof stubSurface>): string[] {
    return stub.encoder.beginComputePass.mock.calls.map((call) => String(call[0]?.label ?? ''));
  }

  it('TIMES ITS OWN DISPATCHES where the device has a clock, so the cost is measured', () => {
    /*
     * **The figure `CAPABILITIES.md` quotes has to come from the pass that pays it.** The field
     * composer carries a `timestamp-query` pair around its dispatch for that reason, and the bake
     * beside it had none — so the only cost ever published for indirect light was the composition's
     * and the trace's was left to be guessed at.
     */
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 }, ['timestamp-query']);
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({ reflectionProbeSize: 64, indirectLight: true }),
    );
    const { camera, env } = stubScene();
    const source = field();
    for (let frame = 0; frame < 3; frame += 1) {
      renderer.beginFrame([0, 0, 0]);
      renderer.bindMeshPass(camera, env);
      renderer.addDistanceField(source, mat4.create());
      renderer.endFrame();
    }

    const timed = stub.encoder.beginComputePass.mock.calls
      .map((call) => call[0] as GPUComputePassDescriptor)
      .filter((descriptor) => String(descriptor.label ?? '') === 'probe bake')
      .filter((descriptor) => descriptor.timestampWrites !== undefined);
    expect(timed.length, 'the bake opened no measured pass').toBeGreaterThan(0);
    /* And nothing is reported until a readback has landed, which is a frame behind by design. */
    expect(renderer.indirectBakeMs).toBe(null);
  });

  it('CLEARS THE PROBE ARRAY WHEN IT ALLOCATES IT, because an unwritten texture is not black', () => {
    /*
     * **The same reason the directional shadow maps are cleared in the constructor**, arrived at
     * from the other end. A WebGPU texture no pass has written holds undefined contents, and a
     * traced grid reads its own irradiance level back as the bounce that has already happened —
     * so an unwritten array is not "no light yet", it is whatever the allocator left.
     *
     * Measured on `demo/dev/bounce.html` with `?seed=0`: a room whose grid was never rasterised
     * settled on a uniform **209 of 255** in every channel, which looks like a working ambient
     * term and is memory. That is what made a rasterised seed look mandatory, and with the array
     * cleared the trace bootstraps from black — which is what Wave 4's "no baked lighting" asks.
     */
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = freshRenderer(stub, resolveRenderQuality({ reflectionProbeSize: 64 }));
    stub.encoder.beginRenderPass.mockClear();
    stub.device.queue.submit.mockClear();

    expect(
      renderer.setProbeGrid({ origin: [0, 0, 0], spacing: [1, 1, 1], counts: [2, 1, 1] }),
    ).toBe(true);

    /* **And submitted**, because an encoder nobody finishes clears nothing on a device. */
    expect(stub.device.queue.submit).toHaveBeenCalledTimes(1);

    const clears = stub.encoder.beginRenderPass.mock.calls
      .map((call) => call[0] as GPURenderPassDescriptor)
      .filter((descriptor) => String(descriptor.label ?? '') === 'probe.clear');
    /*
     * **Two layers times every mip the array was created with**, read off the descriptor rather
     * than written down: the edge is twice the asked-for probe size and the level count follows
     * from it, so a number here would be a second spelling of `octahedralEdgeFor` that drifts.
     */
    const array = stub.device.createTexture.mock.calls
      .map((call) => call[0])
      .find((descriptor) => descriptor.label === 'probe.array');
    expect(array).toBeDefined();
    expect(clears.length).toBe(2 * Number(array?.mipLevelCount));
    for (const descriptor of clears) {
      const attachment = [...descriptor.colorAttachments][0];
      expect(attachment?.loadOp).toBe('clear');
      expect(attachment?.clearValue).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    }
  });

  it('A PROBE GRID BAKED IN ONE CALL GETS EVERY DRAW, however many the grid adds up to', () => {
    /*
     * **Each probe submits its own encoder, and its ring slots were never given back.** So a grid
     * baked in one call spent the *frame's* rings: 64 probes of six faces over a real scene is
     * thousands of draws, the per-draw ring holds 4,096 and the material ring 1,024, and every
     * probe past the ceiling was baked with its draws skipped. Found by a bought courtyard whose
     * grid came back with the warning and a floor lit by half its walls.
     *
     * 64 probes × 6 faces × 20 draws, each a material change: 7,680 of each. Any one probe needs
     * 120, which fits; the grid does not unless the slots come back after each submit.
     */
    const stub = stubSurface();
    const renderer = freshRenderer(stub, resolveRenderQuality({ reflectionProbeSize: 64 }));
    const { env } = stubScene();
    const mesh = stubMesh(renderer);
    const model = mat4.create();
    expect(
      renderer.setProbeGrid({ origin: [0, 0, 0], spacing: [1, 1, 1], counts: [8, 2, 4] }),
    ).toBe(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stub.pass.drawIndexed.mockClear();
    try {
      renderer.bakeProbeGrid([0, 0, 0], (camera) => {
        renderer.bindMeshPass(camera, env);
        for (let i = 0; i < 20; i++) {
          renderer.setSurfaceReflectivity(i % 2 === 0 ? 0.1 : 0.2);
          renderer.drawMesh(mesh, model);
        }
      });
      const ceilings = warn.mock.calls.map((c) => String(c[0])).filter((m) => /in a frame/.test(m));
      expect(ceilings).toEqual([]);
      expect(stub.pass.drawIndexed.mock.calls.length).toBe(64 * 6 * 20);
    } finally {
      warn.mockRestore();
    }
  });

  it('CONVOLVES A PROBE BAKED A FEW FACES AT A TIME ONCE, when its last face lands', () => {
    /* Each face is a pass named for it, and the convolution's passes name their level. */
    const stub = stubSurface();
    const renderer = freshRenderer(stub, resolveRenderQuality({ reflectionProbeSize: 64 }));
    expect(
      renderer.setProbeGrid({ origin: [0, 0, 0], spacing: [1, 1, 1], counts: [2, 1, 1] }),
    ).toBe(true);
    const bake = (faces: readonly [number, number]): { faces: string[]; convolved: boolean } => {
      stub.encoder.beginRenderPass.mockClear();
      renderer.bakeProbe(1, [0, 0, 0], () => {}, { faces });
      const labels = stub.encoder.beginRenderPass.mock.calls.map((call) =>
        String(call[0]?.label ?? ''),
      );
      return {
        faces: labels.filter((label) => label.startsWith('probe.face')),
        convolved: labels.some((label) => label.startsWith('probe.prefilter')),
      };
    };
    expect(bake([0, 2]), 'the first two faces, and nothing to convolve yet').toEqual({
      faces: ['probe.face0', 'probe.face1'],
      convolved: false,
    });
    expect(bake([2, 2])).toEqual({ faces: ['probe.face2', 'probe.face3'], convolved: false });
    expect(bake([4, 2]), 'the last two, and the layer is written').toEqual({
      faces: ['probe.face4', 'probe.face5'],
      convolved: true,
    });
  });

  it('WRITES EACH SWEEP OF A CROSSFADING GRID INTO A SET THE SHADING IS NOT READING', () => {
    /* Three sets of two layers; each bake's convolution names its layer in its label. */
    const stub = stubSurface();
    const renderer = freshRenderer(stub, resolveRenderQuality({ reflectionProbeSize: 64 }));
    expect(
      renderer.setProbeGrid({
        origin: [0, 0, 0],
        spacing: [1, 1, 1],
        counts: [2, 1, 1],
        crossfade: true,
      }),
    ).toBe(true);
    const array = stub.device.createTexture.mock.calls
      .map(([descriptor]) => descriptor)
      .filter((descriptor) => descriptor.label === 'probe.array')
      .at(-1);
    expect((array?.size as number[] | undefined)?.[2], 'three sets of two').toBe(6);
    const layerOf = (probe: number): string | undefined => {
      stub.encoder.beginRenderPass.mockClear();
      renderer.bakeProbe(probe, [0, 0, 0], () => {});
      const label = stub.encoder.beginRenderPass.mock.calls
        .map((call) => String(call[0]?.label ?? ''))
        .find((name) => name.startsWith('probe.prefilter0.'));
      return label?.replace('probe.prefilter0.', '');
    };
    expect([layerOf(0), layerOf(1)], 'the first sweep, the first set').toEqual([
      'layer0',
      'layer1',
    ]);
    expect([layerOf(1), layerOf(0)], 'the second, the second').toEqual(['layer3', 'layer2']);
    expect([layerOf(0), layerOf(1)], 'the third, the third').toEqual(['layer4', 'layer5']);
    expect(layerOf(0), 'and round again').toBe('layer0');
  });

  it('EVERY SKY DRAW IN ONE ENCODER READS ITS OWN CAMERA, not the last one written', () => {
    /*
     * **The sky's uniforms were one buffer, written with `queue.writeBuffer` at each draw.** Queue
     * writes land before the encoder that records the draws is submitted, so every sky in one
     * encoder drew with the last one's matrix. A probe bake records six faces in one encoder, so a
     * probe drawing the sky saw one direction's sky on all six faces. The 2026-08-27 rule again: a
     * per-draw resource is a ring, a slot a draw.
     */
    const stub = stubSurface();
    const renderer = freshRenderer(stub, resolveRenderQuality({ reflectionProbeSize: 64 }));
    const { env } = stubScene();
    const sky = {
      top: [0, 0, 1],
      horizon: [0, 1, 0],
      deep: [1, 0, 0],
      sunDir: [0, 1, 0],
      sunColor: [1, 1, 1],
      sunAngularRadius: 0.01,
      moonDir: [0, -1, 0],
      moonColor: [1, 1, 1],
      moonAngularRadius: 0.01,
      moonPhase: 0,
      nightFactor: 0,
      cloudOffsetX: 0,
      cloudOffsetZ: 0,
    } as never;
    expect(
      renderer.setProbeGrid({ origin: [0, 0, 0], spacing: [1, 1, 1], counts: [1, 1, 1] }),
    ).toBe(true);
    stub.pass.setBindGroup.mockClear();
    renderer.bakeProbe(0, [0, 0, 0], (camera) => {
      renderer.bindMeshPass(camera, env);
      renderer.drawSky(camera, sky, env);
    });
    const offsets = stub.pass.setBindGroup.mock.calls
      .filter((call) => (call[1] as { label?: string } | undefined)?.label === 'sky.bindGroup')
      .map((call) => (call[2] as number[] | undefined)?.[0]);
    expect(offsets).toHaveLength(6);
    expect(new Set(offsets).size, 'six faces, six slots').toBe(6);
  });

  it("SCATTER DRAWN IN SEVERAL PASSES OF ONE ENCODER READS EACH PASS'S OWN CAMERA", () => {
    /*
     * **The scatter's fragment block was one buffer, on the argument that it is settled per pass.**
     * It holds the camera, the sun, the lights and the medium, and a pass is not an encoder: a probe
     * records six passes in one, and a mirror and the view share the frame's. Queue writes land
     * before the encoder runs, so every pass drew its grass lit and fogged from the last camera.
     */
    const stub = stubSurface();
    const renderer = freshRenderer(stub, resolveRenderQuality({ reflectionProbeSize: 64 }));
    const { env } = stubScene();
    const scatter = renderer.createScatter(
      {
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
        colors: new Float32Array(9).fill(1),
        emissive: new Float32Array(3),
        indices: new Uint32Array([0, 1, 2]),
      } as never,
      createInstanceData(4),
    );
    const blades = createInstanceData(4);
    blades.count = 2;
    expect(
      renderer.setProbeGrid({ origin: [0, 0, 0], spacing: [1, 1, 1], counts: [1, 1, 1] }),
    ).toBe(true);
    stub.pass.setBindGroup.mockClear();
    renderer.bakeProbe(0, [0, 0, 0], (camera) => {
      renderer.bindMeshPass(camera, env);
      renderer.drawScatter(scatter, blades, camera, env, 0, 0, 0, 0);
    });
    const fragmentOffsets = stub.pass.setBindGroup.mock.calls
      .filter((call) => (call[1] as { label?: string } | undefined)?.label === 'scatter.bindGroup')
      .map((call) => (call[2] as number[] | undefined)?.[1]);
    expect(fragmentOffsets).toHaveLength(6);
    expect(new Set(fragmentOffsets).size, 'six faces, six fragment slots').toBe(6);
  });

  it('A CUTOUT CASTER CASTS THROUGH THE CUTOUT PIPELINE WITH ITS CUTOFF IN ITS OWN SLOT', () => {
    /*
     * A leaf card cast its whole quad on this backend as on the other: the depth pass had no alpha
     * test. The cutout variant reads the map and discards by the material's cutoff, which is
     * written into the draw's own ring slot, never into a shared buffer (the 2026-08-27 rule).
     */
    const stub = stubSurface();
    const renderer = freshRenderer(stub, resolveRenderQuality({}));
    const mesh = stubMesh(renderer);
    const leaf = renderer.createSurfaceTexture(
      { width: 4, height: 4 } as unknown as TexImageSource,
      {},
    );
    const light = mat4.create();
    const model = mat4.create();
    const pipelineLabels = () =>
      stub.pass.setPipeline.mock.calls.map((call) => String((call[0] as { label?: string }).label));
    const groupLabels = () =>
      stub.pass.setBindGroup.mock.calls.map((call) =>
        String((call[1] as { label?: string }).label),
      );

    stub.pass.setPipeline.mockClear();
    stub.pass.setBindGroup.mockClear();
    stub.device.queue.writeBuffer.mockClear();
    renderer.beginShadowPass(light, 'static');
    renderer.drawShadowCasters((sink) => sink.mesh(mesh, model, { albedo: leaf, cutout: 0.5 }));
    renderer.endShadowPass();
    expect(pipelineLabels().filter((l) => l.startsWith('depth'))).toEqual([
      expect.stringMatching(/^depth-cutout\|/),
    ]);
    expect(groupLabels()).toContain('depth.bindGroup.cutout');
    /* The cutoff, read out of the ring's upload at the cutout variant's own offset. */
    const upload = stub.device.queue.writeBuffer.mock.calls.find(
      (call) => (call[0] as { label?: string }).label === 'shadow.drawRing',
    );
    const floats = new Float32Array(upload?.[2] as ArrayBuffer);
    expect(floats[DEPTH_CUTOUT_VERT_FIELDS.uAlphaCutout.offset / 4]).toBe(0.5);

    stub.pass.setPipeline.mockClear();
    renderer.beginShadowPass(light, 'static');
    renderer.drawShadowCasters((sink) => sink.mesh(mesh, model, { albedo: leaf, cutout: 0 }));
    renderer.endShadowPass();
    expect(pipelineLabels().filter((l) => l.startsWith('depth'))).toEqual([
      expect.stringMatching(/^depth\|/),
    ]);
  });

  it('A TWO-SIDED SURFACE IS DRAWN AND CAST WITH NOTHING CULLED, and a one-sided one keeps its culling', () => {
    /*
     * glTF's \`doubleSided\` is what a curtain and a leaf card are, and every pipeline here culled
     * back faces: a curtain seen from behind its arch was a hole, and one whose front faced away
     * from the sun cast nothing. Culling is pipeline state on this backend, so a two-sided draw
     * needs a pipeline of its own, in the colour pass and in the depth pass alike.
     */
    const stub = stubSurface();
    const renderer = freshRenderer(stub, resolveRenderQuality({}));
    const mesh = stubMesh(renderer);
    const { camera, env } = stubScene();
    const model = mat4.create();
    const culls = () =>
      stub.device.createRenderPipeline.mock.calls.map((call) => ({
        label: String(call[0]?.label ?? ''),
        cull: call[0]?.primitive?.cullMode,
      }));

    stub.device.createRenderPipeline.mockClear();
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.setMaterial({ doubleSided: true });
    renderer.drawMesh(mesh, model);
    renderer.setMaterial({});
    renderer.drawMesh(mesh, model);
    renderer.beginShadowPass(mat4.create(), 'static');
    renderer.drawShadowCasters((sink) => {
      sink.mesh(mesh, model, { doubleSided: true });
      sink.mesh(mesh, model, {});
    });
    renderer.endShadowPass();
    renderer.endFrame();

    /* Labels lead with the shader variant, so the pass is told apart by its name inside them. */
    const flat = culls().filter((c) => c.label.includes('|flat') && !c.label.startsWith('depth'));
    const depth = culls().filter((c) => c.label.startsWith('depth'));
    expect(flat.find((c) => c.label.includes('|2s'))?.cull).toBe('none');
    expect(flat.filter((c) => !c.label.includes('|2s')).map((c) => c.cull)).not.toContain('none');
    expect(depth.map((c) => c.cull)).toContain('none');
    expect(depth.map((c) => c.cull).filter((c) => c !== 'none').length).toBeGreaterThan(0);
  });

  it('A BOUNCE BAKE READS THE GRID IT IS REFILLING, ONCE THE GRID IS WHOLE, AND A PLAIN BAKE NEVER DOES', () => {
    /*
     * One sweep of the grid holds one bounce, which left a courtyard's arcades two stops under a
     * reference render. `bounce` keeps the array bound while the faces are drawn: they go into the
     * probe's own cube and only the resolve writes the array, so no pass both reads and writes it.
     * Never before every probe is filled, when the array has undefined contents.
     */
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const quality = resolveRenderQuality({ reflectionProbeSize: 64 });
    const renderer = freshRenderer(stub, quality);
    const { env } = stubScene();
    const mesh = stubMesh(renderer);
    expect(
      renderer.setProbeGrid({ origin: [0, 0, 0], spacing: [1, 1, 1], counts: [2, 1, 1] }),
    ).toBe(true);
    const at = flatFragmentBindings(
      flatVariant({
        directionalShadows: quality.directionalShadows,
        environmentProbe: true,
        nightEmissive: quality.nightEmissive,
        pointShadows: quality.pointShadows,
      }),
    ).fields['uEnvironmentEnabled']?.offset;
    expect(at, 'the probe variant must compile the term in').toBeTypeOf('number');

    /** Whether the faces of this bake were bound to the grid and told to read it. */
    const readsGrid = (layer: number, options?: { bounce: boolean }) => {
      stub.device.queue.writeBuffer.mockClear();
      stub.pass.setBindGroup.mockClear();
      const baked = renderer.bakeProbe(
        layer,
        [0, 0, 0],
        (camera) => {
          renderer.bindMeshPass(camera, env);
          renderer.drawMesh(mesh, mat4.create());
        },
        options,
      );
      expect(baked, 'the bake must have run').toBe(true);
      /*
       * **What the faces were drawn with, not what was built during the bake.** A group is built
       * once and kept, and a bounce bake binds exactly what the frame does, so it builds nothing:
       * the question is which group each draw set, traced back to the descriptor it was built
       * from, whenever that was. Only a flat group binds the grid's array.
       */
      const built = stub.device.createBindGroup.mock;
      const bound = stub.pass.setBindGroup.mock.calls
        .map((call) => built.calls[built.results.findIndex((r) => r.value === call[1])]?.[0])
        .some(
          (descriptor) =>
            descriptor !== undefined &&
            [...descriptor.entries].some(
              (entry) =>
                String((entry.resource as { label?: string }).label ?? '') === 'probe.array',
            ),
        );
      const upload = stub.device.queue.writeBuffer.mock.calls.find(
        (call) => (call[0] as { label?: string }).label === 'flat.fragRing',
      );
      const enabled = new Float32Array(upload?.[2] as ArrayBuffer)[(at ?? 0) / 4];
      return { bound, enabled };
    };

    expect(readsGrid(0, { bounce: true }), 'a grid never baked has nothing to read').toEqual({
      bound: false,
      enabled: 0,
    });
    readsGrid(1);
    expect(readsGrid(0), 'a plain bake lights its faces by the ambient').toEqual({
      bound: false,
      enabled: 0,
    });
    expect(readsGrid(0, { bounce: true }), 'a bounce bake of a whole grid reads it').toEqual({
      bound: true,
      enabled: 1,
    });
  });

  it('BINDS THE PROBE ARRAY TO THE SHADING ONCE THE TRACE HAS FILLED IT', () => {
    /*
     * **A bind group holds whatever texture existed when it was built, for ever**, and this
     * backend has now paid for that three times: the refraction snapshot, the point shadow array,
     * and this. `flatTextures` resolves `uEnvironment` to a one-texel **white** stand-in until the
     * grid is baked, so a renderer whose grid is filled by the trace rather than by
     * `bakeProbeGrid` builds its flat groups before there is anything to bind and keeps the white
     * for the life of the renderer. The uniform flips to "use the grid" and the grid the shader
     * reads is pure white.
     *
     * Measured on `demo/dev/bounce.html?seed=0`: every surface in the room came back at exactly
     * its own albedo times 255 — 209 for the white walls, 229 for the red one — with the sun
     * switched off entirely and with the trace pinned to a constant. Nothing about the bake could
     * change it, which is what said the shading was not reading the bake at all. It had been
     * recorded as undefined memory; it is a deliberate white texture, read on purpose.
     */
    const stub = frames({ indirectLight: true }, 30);
    const boundToProbes = stub.device.createBindGroup.mock.calls
      .map((call) => call[0] as GPUBindGroupDescriptor)
      .filter((descriptor) => String(descriptor.label ?? '') !== 'probe bake')
      .some((descriptor) =>
        [...descriptor.entries].some(
          (entry) => String((entry.resource as { label?: string }).label ?? '') === 'probe.array',
        ),
      );
    expect(boundToProbes, 'the shading is still reading the one-texel white stand-in').toBe(true);
  });

  it('TRACES NOTHING WITH INDIRECT LIGHT OFF, however many fields were declared', () => {
    const stub = frames({}, 3);
    expect(computeLabels(stub)).toEqual([]);
  });

  it('traces once the flag is on and a field has been composed', () => {
    const stub = frames({ indirectLight: true }, 3);
    const labels = computeLabels(stub);
    expect(labels.filter((label) => label === 'gi compose').length).toBeGreaterThan(0);
    expect(labels.filter((label) => label === 'probe bake').length).toBeGreaterThan(0);
  });

  it('TRACES NOTHING IN THE FRAME THAT FIRST DECLARED A FIELD, because none is composed yet', () => {
    /*
     * The composition runs at `endFrame` and the bake runs after it on the same encoder, so the
     * first frame does compose and then does bake. What it cannot do is bake against a field from
     * a frame that never happened — this pins the order rather than the count.
     */
    const stub = frames({ indirectLight: true }, 1);
    const labels = computeLabels(stub);
    expect(labels.indexOf('gi compose')).toBeLessThan(labels.indexOf('probe bake'));
  });

  it('STOPS TRACING WHEN A FRAME STOPS DECLARING, rather than tracing a field it no longer has', () => {
    /*
     * The composer survives the frame that made it, so a frame declaring nothing finds it there
     * and holding the *previous* frame's field. Tracing against that would light a room out of
     * geometry a consumer has deleted — so `FieldComposer.compose` reports no field at all for an
     * empty frame, and this is the branch that depends on it.
     */
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({ reflectionProbeSize: 64, indirectLight: true }),
    );
    const { camera, env } = stubScene();

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.addDistanceField(field(), mat4.create());
    renderer.endFrame();

    stub.encoder.beginComputePass.mockClear();
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.endFrame();
    expect(computeLabels(stub)).toEqual([]);
  });

  it('fits a grid to the declared fields when the scene declared none', () => {
    const stub = frames({ indirectLight: true }, 2);
    /*
     * The probe array is reallocated for the fitted grid, so its descriptor names more than one
     * layer — a scene with no grid starts at a single probe.
     */
    const arrays = stub.device.createTexture.mock.calls
      .map((call) => call[0])
      .filter((descriptor) => descriptor?.label === 'probe.array');
    const layers = arrays.map((descriptor) => (descriptor.size as number[])[2]);
    expect(Math.max(...layers), 'a grid was fitted and is larger than one probe').toBeGreaterThan(
      1,
    );
  });

  it('THE BAKED GRID BECOMES SAMPLEABLE, which is the only way the traced light reaches a pixel', () => {
    /*
     * **`probeBaked` gates the whole array**, and it used to be set only by a rasterised bake. A
     * grid filled entirely by tracing would otherwise never be bound: the lit pass would keep the
     * hemispheric gradient, every number here would be right, and the picture would not change.
     * The seam that shows it from outside is `PrepareContext.environment`, which the renderer
     * offers only once every layer holds a convolution.
     */
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({ reflectionProbeSize: 64, indirectLight: true }),
    );
    const { camera, env } = stubScene();
    const offered: boolean[] = [];
    renderer.registerPass({
      label: 'reader',
      prepare: (ctx) => {
        offered.push(ctx.backend === 'webgpu' && ctx.environment !== null);
      },
      draw: () => undefined,
    });

    const source = field();
    /* Enough frames for a round robin of five to reach every layer of the fitted grid. */
    for (let frame = 0; frame < 24; frame += 1) {
      renderer.beginFrame([0, 0, 0]);
      renderer.bindMeshPass(camera, env);
      renderer.addDistanceField(source, mat4.create());
      renderer.endFrame();
    }

    expect(offered[0], 'nothing is offered before anything is baked').toBe(false);
    expect(offered.at(-1), 'and the grid is offered once every layer holds one').toBe(true);
  });

  it('A RASTERISED BAKE LEAVES THE IRRADIANCE OF A TRACED LAYER TO THE TRACE', () => {
    /*
     * **Two writers of one texel is a flicker, and a scene found it.** A courtyard re-rasterised a
     * probe a frame for its reflections while the trace refreshed the same grid five probes a frame.
     * Each raster bake overwrote a layer's irradiance with its own answer and the trace pulled it
     * back over the next frames, so light swept down the courtyard a probe at a time, for ever,
     * with the clock paused. Measured on the held frame: region-scale flicker of 1.11 levels (peaks
     * of 6.3) against 0.17 with the trace alone and 0.13 with the raster grid alone.
     *
     * So once the trace has written a layer it owns that layer's diffuse level, and a rasterised
     * bake refreshes only the roughness chain a reflection reads. The control is the same bake with
     * no trace, which still writes every level: the raster grid is the whole grid there.
     */
    const prefilterLevels = (indirectLight: boolean): number[] => {
      const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
      const renderer = freshRenderer(
        stub,
        resolveRenderQuality({ reflectionProbeSize: 64, indirectLight }),
      );
      const { camera, env } = stubScene();
      expect(
        renderer.setProbeGrid({ origin: [0, 0, 0], spacing: [1, 1, 1], counts: [2, 1, 1] }),
      ).toBe(true);
      const source = field();
      /* Two layers and five traced a frame: every layer is the trace's after the second frame. */
      for (let frame = 0; frame < 3; frame += 1) {
        renderer.beginFrame([0, 0, 0]);
        renderer.bindMeshPass(camera, env);
        renderer.addDistanceField(source, mat4.create());
        renderer.endFrame();
      }
      stub.encoder.beginRenderPass.mockClear();
      renderer.bakeProbe(0, [0, 0, 0], (face) => renderer.bindMeshPass(face, env));
      return stub.encoder.beginRenderPass.mock.calls
        .map((call) => /^probe\.prefilter(\d+)\.layer0$/.exec(String(call[0]?.label ?? '')))
        .filter((match) => match !== null)
        .map((match) => Number(match[1]));
    };
    const untraced = prefilterLevels(false);
    const traced = prefilterLevels(true);
    const irradianceLevel = Math.max(...untraced);
    expect(untraced.length, 'the control convolved a chain at all').toBeGreaterThan(1);
    expect(traced, 'the roughness chain is still refreshed').toContain(0);
    expect(traced).toEqual(untraced.filter((level) => level !== irradianceLevel));
  });

  it('writes the whole roughness chain of a layer once and its irradiance level after', () => {
    const stub = frames({ indirectLight: true }, 2);
    const blits = stub.encoder.beginRenderPass.mock.calls
      .map((call) => String((call[0] as GPURenderPassDescriptor).label ?? ''))
      .filter((label) => label.startsWith('probe blit'));
    expect(blits.length, 'something was blitted at all').toBeGreaterThan(0);
    /* A first fill writes level 0 as well, which only a first fill does. */
    expect(blits.some((label) => label.endsWith('.0'))).toBe(true);
  });
});

/**
 * **One scene, the same numbers on both backends** — which is what a line named alike on both
 * promises. WebGL2 imposes no ceilings, so it reports each line with a `null` one; what it must
 * report is the same count, so a consumer developing on the fallback reads the number this backend
 * will refuse past. The count is only the same if it is taken after the same guards: a panel with
 * no alpha, a string with no glyphs, a beam with no strength and a calm wind draw nothing on either,
 * and a count taken before one of those checks is a number the other backend never reaches.
 *
 * Run here rather than in a file of its own because this backend's stub surface lives in this file,
 * and a module importing it would re-run every test here.
 */
describe('the frame budget, against WebGL2', () => {
  /** A metrics document with one glyph, which is all a label of one letter lays out against. */
  const ONE_GLYPH_FONT = {
    version: 1,
    family: 'Test',
    atlas: { width: 128, height: 64, distanceRange: 4 },
    metrics: { unitsPerEm: 1000, ascender: 800, descender: -200, lineHeight: 1200 },
    glyphs: {
      A: {
        advance: 640,
        planeLeft: 20,
        planeBottom: 0,
        planeRight: 620,
        planeTop: 700,
        atlasLeft: 4,
        atlasBottom: 4,
        atlasRight: 44,
        atlasTop: 52,
      },
    },
    kerning: {},
  };

  function verbs(renderer: RendererApi): void {
    const { camera, env } = stubScene();
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);

    const rect = { left: 0, top: 0, width: 10, height: 10 };
    renderer.fillPanel(rect, [1, 1, 1], 1);
    renderer.fillPanel(rect, [1, 1, 1], 0.5);
    renderer.fillPanel(rect, [1, 1, 1], 0);

    const text = renderer.createText();
    renderer.setText(text, 'budget');
    renderer.drawText(text, 640, 480, 0, 0, DEFAULT_TEXT_STYLE, 0);
    renderer.drawText(text, 640, 480, 0, 0, { ...DEFAULT_TEXT_STYLE, alpha: 0 }, 0);
    renderer.drawText(renderer.createText(), 640, 480, 0, 0, DEFAULT_TEXT_STYLE, 0);

    /* No font set, which both refuse before anything is drawn; then one with a font, drawn once
       and once at no opacity. */
    renderer.drawSdfText(renderer.createSdfText(), new Float32Array(16), [1, 1, 1], 1);
    const label = renderer.createSdfText();
    const atlas = renderer.createSurfaceTexture(
      { width: 4, height: 4 } as unknown as TexImageSource,
      {},
    );
    renderer.setSdfText(label, parseSdfFont(ONE_GLYPH_FONT), atlas, 'A', DEFAULT_SDF_TEXT_STYLE);
    renderer.drawSdfText(label, new Float32Array(16), [1, 1, 1], 1);
    renderer.drawSdfText(label, new Float32Array(16), [1, 1, 1], 0);

    const lines = renderer.createLines(4);
    const polyline = createLineSegments(4);
    polyline.from.set([0, 0, 0, 1, 0, 0]);
    polyline.to.set([1, 0, 0, 1, 1, 0]);
    polyline.count = 2;
    renderer.drawLines(lines, polyline, mat4.create(), camera, env, [1, 1, 1], 0.1, 1);
    renderer.drawLines(lines, createLineSegments(4), mat4.create(), camera, env, [1, 1, 1], 0.1, 1);
    renderer.drawLines(
      renderer.createLines(0),
      polyline,
      mat4.create(),
      camera,
      env,
      [1, 1, 1],
      0.1,
      1,
    );

    const bolts = renderer.createBolts(4);
    const arc = {
      from: new Float32Array([0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]),
      to: new Float32Array([0, 1, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0]),
      along: new Float32Array([0, 0.5, 0, 0]),
      fade: new Float32Array([1, 1, 0, 0]),
      seed: new Float32Array([1, 1, 0, 0]),
      brightness: new Float32Array([1, 1, 0, 0]),
      count: 2,
      capacity: 4,
    };
    renderer.drawBolts(bolts, arc, camera, env, 0, [1, 1, 1], [1, 1, 1], 0.1, 1);
    renderer.drawBolts(bolts, { ...arc, count: 0 }, camera, env, 0, [1, 1, 1], [1, 1, 1], 0.1, 1);
    /* Segments asked for, and a batch with room for none: the expansion writes nothing. */
    const noRoom = renderer.createBolts(0);
    renderer.drawBolts(noRoom, arc, camera, env, 0, [1, 1, 1], [1, 1, 1], 0.1, 1);

    const water = renderer.createWater();
    const body = { level: 0, deepColor: [0, 0.1, 0.2], shallowColor: [0, 0.3, 0.4] } as never;
    renderer.drawWater(water, camera, 0, body, env);

    const beam = renderer.createMesh({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
      colors: new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]),
      emissive: new Float32Array([0, 0, 0]),
      indices: new Uint32Array([0, 1, 2]),
    } as never);
    renderer.drawLightVolume(beam, mat4.create(), camera, 1, 10, 0.3);
    renderer.drawLightVolume(beam, mat4.create(), camera, 0, 10, 0.3);
    /* Geometry still on its way: the surface's contract is that nothing incomplete is drawn. */
    const arriving = renderer.createMeshIncremental({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
      colors: new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]),
      emissive: new Float32Array([0, 0, 0]),
      indices: new Uint32Array([0, 1, 2]),
    } as never).mesh;
    renderer.drawLightVolume(arriving, mat4.create(), camera, 1, 10, 0.3);

    const streaks = renderer.createWindStreaks();
    const gale = createWindField();
    gale.speed = 30;
    renderer.drawWindStreaks(streaks, camera, gale, 0, [1, 1, 1], env);
    renderer.drawWindStreaks(streaks, camera, createWindField(), 0, [1, 1, 1], env);

    const flock = renderer.createFlock(4);
    const params = { center: [0, 10, 0], radius: 5, height: 1, count: 4, speed: 2, scale: 0.5 };
    renderer.drawFlock(flock, camera, 0, params as never, [1, 1, 1]);

    /* Two cross-sections, which is the least a sheet is built between. */
    const sheet = {
      spans: [
        { x0: -1, z0: -1, x1: 1, z1: -1, y: 0 },
        { x0: -1, z0: 1, x1: 1, z1: 1, y: 0 },
      ],
      waterY: 1,
    };
    renderer.drawCaustics(renderer.createCaustics([sheet]), camera, 0, env);
    renderer.drawCaustics(null, camera, 0, env);
    /* One cross-section, which builds no triangles: a set with nothing in it. */
    const flat = { spans: [{ x0: -1, z0: -1, x1: 1, z1: -1, y: 0 }], waterY: 1 };
    renderer.drawCaustics(renderer.createCaustics([flat]), camera, 0, env);
  }

  const counted = (renderer: RendererApi, names: readonly string[]) =>
    names.map((name) => [name, renderer.frameBudget.lines.find((l) => l.name === name)?.used]);

  const TRIANGLE = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
    colors: new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]),
    emissive: new Float32Array([0, 0, 0]),
    indices: new Uint32Array([0, 1, 2]),
  } as never;

  /**
   * Material changes and a shadow round. A run of draws shares one material; a setter, a pass,
   * or a draw carrying options of its own — which it takes for itself and puts back after —
   * makes the next draw open another. The shadow round casts meshes, instances and a scatter
   * field, and an empty batch and an empty field that cast nothing.
   */
  function meshes(renderer: RendererApi): void {
    const { camera, env } = stubScene();
    const mesh = renderer.createMesh(TRIANGLE);
    const at = mat4.create();
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(mesh, at);
    renderer.drawMesh(mesh, at);
    renderer.drawMesh(mesh, at);
    renderer.setSurfaceReflectivity(0.5);
    renderer.drawMesh(mesh, at);
    renderer.drawTranslucentMesh(mesh, at, 0.5);
    renderer.drawMesh(mesh, at);
    renderer.drawTranslucentMesh(mesh, at, 1, { fog: false });
    renderer.drawTranslucentMesh(mesh, at, 1);
    renderer.drawTranslucentMesh(mesh, at, 1);
    renderer.setMaterial(null);
    renderer.drawMesh(mesh, at);
    /* Every other setter, each followed by the draw that has to open a material for it. */
    renderer.setEmissiveGain(0.5);
    renderer.drawMesh(mesh, at);
    renderer.setEnvironmentGain(0.5);
    renderer.drawMesh(mesh, at);
    renderer.setSurfaceGrain(0.5);
    renderer.drawMesh(mesh, at);
    renderer.setSurfaceRelief(0.5);
    renderer.drawMesh(mesh, at);
    renderer.setSurfaceTextureRelief(0.5);
    renderer.drawMesh(mesh, at);
    const batch = renderer.createInstanced(mesh, 4);
    const placed = createMeshInstances(4);
    placed.count = 2;
    renderer.drawInstanced(batch, placed);
    renderer.drawTranslucentInstanced(batch, placed, 0.5);
    renderer.drawInstanced(batch, placed);

    const scatter = renderer.createScatter(TRIANGLE, createInstanceData(4));
    const blades = createInstanceData(4);
    blades.count = 3;
    renderer.beginShadowPass(at, 'static');
    renderer.drawShadowCasters((sink) => {
      sink.mesh(mesh, at);
      sink.mesh(mesh, at);
      sink.instanced?.(batch, placed);
      sink.instanced?.(batch, createMeshInstances(4));
      sink.scatter?.(scatter, blades, 0, 0, 0, 0);
      sink.scatter?.(scatter, createInstanceData(4), 0, 0, 0, 0);
    });
    renderer.endShadowPass();
  }

  it('COUNTS DRAWS, MATERIAL CHANGES AND SHADOW DRAWS ALIKE ON BOTH, by one rule', () => {
    const quality = resolveRenderQuality({});
    const gpu = new WebGPURenderer(stubSurface().surface, quality);
    const gl = new WebGL2Renderer(recordingGl().canvas, quality);
    meshes(gpu);
    meshes(gl);
    const names = ['draws', 'materials', 'shadow draws', 'scatter shadow draws'];
    expect(counted(gl, names)).toEqual(counted(gpu, names));
    expect(counted(gpu, names)).toEqual([
      ['draws', 18],
      ['materials', 14],
      ['shadow draws', 3],
      ['scatter shadow draws', 1],
    ]);
  });

  /*
   * **Under order-independent transparency a translucent draw is recorded and replayed**, once
   * into each of two buffers, and both backends count it where it is submitted. WebGL2 counted it
   * once more on the way in until 2026-09-19, so the same frame read three draws there and two here.
   */
  it('COUNTS A REPLAYED TRANSLUCENT DRAW ALIKE ON BOTH, where it is submitted', () => {
    const quality = resolveRenderQuality({ screenEffects: true, orderIndependent: true });
    const gpu = new WebGPURenderer(stubSurface().surface, quality);
    const gl = new WebGL2Renderer(
      recordingGl({ extensions: ['EXT_color_buffer_float'] }).canvas,
      quality,
    );
    for (const renderer of [gpu, gl] as RendererApi[]) {
      const { camera, env } = stubScene();
      const mesh = renderer.createMesh(TRIANGLE);
      renderer.beginFrame([0, 0, 0]);
      renderer.bindMeshPass(camera, env);
      renderer.drawMesh(mesh, mat4.create());
      renderer.drawTranslucentMesh(mesh, mat4.create(), 0.5);
      renderer.drawTranslucentMesh(mesh, mat4.create(), 0.5, { lit: false });
      renderer.endFrame();
    }
    const names = ['draws', 'materials'];
    expect(counted(gl, names)).toEqual(counted(gpu, names));
    expect(counted(gpu, names)).toEqual([
      ['draws', 5],
      ['materials', 5],
    ]);
  });

  /** A frame starts with no material open, whether or not it opens a mesh pass before drawing. */
  it('OPENS A MATERIAL IN A NEW FRAME ON BOTH, even one that draws without opening a pass', () => {
    const quality = resolveRenderQuality({});
    const gpu = new WebGPURenderer(stubSurface().surface, quality);
    const gl = new WebGL2Renderer(recordingGl().canvas, quality);
    for (const renderer of [gpu, gl] as RendererApi[]) {
      const { camera, env } = stubScene();
      const mesh = renderer.createMesh(TRIANGLE);
      renderer.beginFrame([0, 0, 0]);
      renderer.bindMeshPass(camera, env);
      renderer.drawMesh(mesh, mat4.create());
      renderer.beginFrame([0, 0, 0]);
      renderer.drawMesh(mesh, mat4.create());
    }
    expect(counted(gl, ['draws', 'materials'])).toEqual(counted(gpu, ['draws', 'materials']));
    expect(counted(gpu, ['draws', 'materials'])).toEqual([
      ['draws', 1],
      ['materials', 1],
    ]);
  });

  it('NAMES THE SAME LINES, IN THE SAME ORDER, on both', () => {
    const gpu = new WebGPURenderer(stubSurface().surface, resolveRenderQuality({}));
    const gl = new WebGL2Renderer(recordingGl().canvas, resolveRenderQuality({}));
    expect(gl.frameBudget.lines.map((l) => l.name)).toEqual(
      gpu.frameBudget.lines.map((l) => l.name),
    );
  });

  it('COUNTS THE ONE-CALL VERBS ALIKE ON BOTH, after the same guards', () => {
    const quality = resolveRenderQuality({ water: true });
    const gpu = new WebGPURenderer(stubSurface().surface, quality);
    const gl = new WebGL2Renderer(recordingGl().canvas, quality);
    verbs(gpu);
    verbs(gl);
    const names = [
      'water bodies',
      'light volumes',
      'wind streak fields',
      'flocks',
      'bolt batches',
      'caustics',
      'text draws',
      'sdf text draws',
      'line draws',
      'panels',
    ];
    expect(counted(gl, names)).toEqual(counted(gpu, names));
    /* And the scene is the one described: each verb drawn once or twice, and every guard held. */
    expect(counted(gpu, names)).toEqual([
      ['water bodies', 1],
      ['light volumes', 1],
      ['wind streak fields', 1],
      ['flocks', 1],
      ['bolt batches', 1],
      ['caustics', 1],
      ['text draws', 1],
      ['sdf text draws', 1],
      ['line draws', 1],
      ['panels', 2],
    ]);
  });
});

/**
 * **A pane refracts under order-independent transparency as it does under sorted blending.**
 * WebGL2 replays a recorded pane's refraction on purpose — its replay says a pane that refracts
 * one way and stands clear the other reads as a bug in the transparency mode — and this backend's
 * replay dropped it, so every refracting pane stood clear here with the effect on. The copy a pane
 * reads is taken when the replay begins, from the finished opaque frame, because the snapshot the
 * immediate path takes works by ending the scene's pass, and by then that pass has ended.
 */
describe('refraction under order-independent transparency', () => {
  function replayOnePane(refraction: number) {
    const stub = stubSurface();
    const quality = resolveRenderQuality({ screenEffects: true, orderIndependent: true });
    const renderer = new WebGPURenderer(stub.surface, quality);
    const { camera, env } = stubScene();
    const mesh = stubMesh(renderer);
    const field =
      /* The strength is the first of the four numbers `uSeeThrough` carries. */
      (flatFragmentBindings(variantFor(quality)).fields['uSeeThrough']?.offset ?? -4) / 4;
    const submitted: number[] = [];
    const ring = (renderer as unknown as { perFrame: { writeBlock: (...a: never[]) => void } })
      .perFrame;
    const write = ring.writeBlock.bind(ring);
    ring.writeBlock = ((slot: number, ints: Int32Array) => {
      submitted.push(new Float32Array(ints.buffer, ints.byteOffset)[field] ?? Number.NaN);
      write(slot as never, ints as never);
    }) as never;

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(mesh, mat4.create());
    renderer.drawTranslucentMesh(mesh, mat4.create(), 0.5, { refraction });
    renderer.endFrame();
    const copies = stub.encoder.copyTextureToTexture.mock.calls.map(([, to]) =>
      String((to.texture as { label?: string }).label ?? ''),
    );
    return { submitted, snapshots: copies.filter((label) => label === 'refract.snapshot').length };
  }

  it('REPLAYS A PANE WITH ITS REFRACTION, into both buffers, against one copy of the frame', () => {
    const { submitted, snapshots } = replayOnePane(0.5);
    /* The opaque draw's material, then the pane's in each of the two replay passes. */
    expect(submitted.filter((strength) => strength === 0.5)).toHaveLength(2);
    expect(snapshots).toBe(1);
  });

  it('TAKES NO COPY WHEN NOTHING IN THE SET REFRACTS', () => {
    const { submitted, snapshots } = replayOnePane(0);
    expect(submitted.every((strength) => strength === 0)).toBe(true);
    expect(snapshots).toBe(0);
  });
});

/**
 * Reconstruction cannot change what the simulation computes.
 *
 * All of it is view-dependent: it reads colour, depth and motion, and it writes colour. None of that
 * is simulation state. So this test ought to pass by construction — which is precisely why it is
 * written, because "ought to by construction" is what every subsequent change will assume without
 * checking.
 *
 * **The run feeds the camera back into the simulation**, as a game's pointer does: every tick a ray
 * through the screen, unprojected through the camera's matrix as the renderer left it, picks a body
 * and shoves it. A renderer that jittered the caller's camera in place — the one way reconstruction
 * could reach the simulation, since the jitter is exactly a change to that matrix — would move the
 * ray, the shove and every body after it. The run moves, because a reconstruction that fed a
 * resolved value back would only diverge once something did.
 *
 * Tier 0 at every ratio reconstruction accepts, against reconstruction off. Tier 1 was withdrawn and
 * tier 2 is not in the frame (`recon/tier.ts`), so there is nothing else to run.
 */
describe('the replay fingerprint, with reconstruction and without', () => {
  const run = (reconstruction: number, nudge = 0): string => {
    const stub = stubSurface();
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({ screenEffects: true, reconstruction }),
    );
    const world = new PhysicsWorld({ allowSleep: false });
    world.addBody({ type: BODY_STATIC, shape: boxShape(30, 1, 30), y: -1 });
    const bodies = [-2, 0, 2].map((x) =>
      world.addBody({ type: BODY_DYNAMIC, shape: boxShape(0.5, 0.5, 0.5), x, y: 1 }),
    );
    const mesh = renderer.createMesh(
      new MeshBuilder().addBox([0, 0, 0], [0.5, 0.5, 0.5], [1, 1, 1]).build(),
    );
    const env = createEnvironment();
    const camera = new Camera();
    camera.position[0] = 0;
    camera.position[1] = 4;
    camera.position[2] = 8;
    camera.lookAt(0, 0, 0);
    camera.updateMatrices(16 / 9);
    const model = mat4.create();
    const inverse = mat4.create();
    const near = vec4.create();
    const far = vec4.create();
    const hit = createRayHit();
    let picks = '';
    for (let tick = 0; tick < 90; tick += 1) {
      /* The pointer: a ray just off the middle of the screen, where the body the camera follows
         stands, unprojected through the matrix the frame before left behind. */
      mat4.invert(inverse, camera.viewProjection);
      vec4.transformMat4(near, [0.02, -0.03, -1, 1], inverse);
      vec4.transformMat4(far, [0.02, -0.03, 1, 1], inverse);
      const ox = (near[0] as number) / (near[3] as number);
      const oy = (near[1] as number) / (near[3] as number);
      const oz = (near[2] as number) / (near[3] as number);
      const dx = (far[0] as number) / (far[3] as number) - ox;
      const dy = (far[1] as number) / (far[3] as number) - oy;
      const dz = (far[2] as number) / (far[3] as number) - oz;
      if (world.raycast(ox, oy, oz, dx, dy, dz, 100, hit) && hit.body !== 0) {
        picks += `${hit.body}:${hit.fraction};`;
        world.applyImpulse(hit.body, 0.2, 0.5, 0, hit.x, hit.y, hit.z);
      }
      /* And a replayed input that does not depend on the camera at all. */
      if (tick % 30 === 0) {
        const body = bodies[(tick / 30) % 3] as number;
        world.applyImpulse(body, 1, 2, -0.5, 0, 1, 0);
      }
      world.step(1 / 60);

      const leader = bodies[1] as number;
      const lx = world.bodies.posX[leader] ?? 0;
      const ly = world.bodies.posY[leader] ?? 0;
      const lz = world.bodies.posZ[leader] ?? 0;
      camera.position[0] = lx;
      camera.position[1] = ly + 4;
      camera.position[2] = lz + 8;
      camera.lookAt(lx, ly, lz);
      camera.updateMatrices(16 / 9);

      renderer.beginFrame([0, 0, 0]);
      renderer.bindMeshPass(camera, env);
      for (const body of bodies) {
        mat4.fromTranslation(model, [
          world.bodies.posX[body] ?? 0,
          world.bodies.posY[body] ?? 0,
          world.bodies.posZ[body] ?? 0,
        ]);
        renderer.drawMesh(mesh, model as Float32Array, 0, [1, 1, 1]);
      }
      renderer.endFrame();
      /* The control's fault, made by hand: the camera's own matrix moved a hundredth of a pixel. */
      if (nudge !== 0) camera.viewProjection[8] = (camera.viewProjection[8] as number) + nudge;
    }
    expect(picks.length, 'a run whose pointer never lands tests nothing').toBeGreaterThan(0);
    return `${fingerprintBodies(world.bodies)} ${picks}`;
  };

  it('A REPLAY IS BYTE-IDENTICAL WITH RECONSTRUCTION OFF AND AT EVERY RATIO IT RUNS AT', () => {
    const off = run(0);
    for (const ratio of [1.3, 1.5, 2]) expect(run(ratio), `at ${ratio}`).toBe(off);
  });

  it('and the fingerprint sees a camera a hundredth of a pixel out, which is what it guards', () => {
    /* 2 / 1280 of the clip square a pixel, and a hundredth of that. Without this, a run whose pick
       never landed would pass above whatever the renderer did to the camera. */
    expect(run(0, 0.02 / 1280)).not.toBe(run(0));
  });
});

/**
 * **A probe bake that binds what the frame binds rebuilds nothing.**
 *
 * `bakeProbe` rebuilt the flat bind group on entering and on leaving, to keep the cube it writes
 * out of the group, and its comment called that two `createBindGroup` calls a bake and not a frame
 * path. Neither held once bakes could be spread over frames: the rebuild empties the whole cache, so
 * every material built its group again inside the bake and again after it, every frame a scene
 * re-baked a face. A courtyard with the sun moving spent 28% of its CPU there on the native host.
 * What a bake changes in the group is only whether the grid is bound, and a bounce bake of a whole
 * grid binds it exactly as the frame does.
 */
describe('the flat bind groups across a probe bake', () => {
  it('A BOUNCE BAKE OF A WHOLE GRID BUILDS NO GROUPS, inside it or after it', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub, resolveRenderQuality({ reflectionProbeSize: 64 }));
    expect(
      renderer.setProbeGrid({ origin: [0, 0, 0], spacing: [1, 1, 1], counts: [2, 1, 1] }),
    ).toBe(true);
    const make = () =>
      renderer.createSurfaceTexture({ width: 4, height: 4 } as unknown as TexImageSource, {});
    const materials = [make(), make(), make()].map((albedo) => ({ albedo }));
    /* Groups built while the materials are drawn, and only then. */
    let built = 0;
    const draw = (): void => {
      stub.device.createBindGroup.mockClear();
      for (const material of materials) renderer.setMaterial(material);
      built += stub.device.createBindGroup.mock.calls.length;
    };

    /* Whole, so the frame reads the grid, and warm, so every material has its group. */
    renderer.bakeProbe(0, [0, 0, 0], draw);
    renderer.bakeProbe(1, [0, 0, 0], draw);
    draw();
    draw();

    built = 0;
    renderer.bakeProbe(0, [0, 0, 0], draw, { bounce: true });
    draw();
    expect(built, 'a bounce bake and the frame after it').toBe(0);

    /* A plain bake does unbind the grid, so it may build; it has to bind something else. */
    built = 0;
    renderer.bakeProbe(1, [0, 0, 0], draw);
    expect(built, 'a plain bake rebuilds, because its group differs').toBeGreaterThan(0);
  });
});

/**
 * **A bake that runs every frame makes nothing every frame.**
 *
 * A probe bake allocated its targets as a one-off would: a depth and a multisampled colour texture
 * created and destroyed per call, a view per face, and for each completed probe a view and a bind
 * group per level and face of its blur and its convolution. That was a load-time cost until bakes
 * could be spread a few faces a frame, and then it was a per-frame one, which the house rules
 * forbid and which the native host, where each object costs most, measured.
 */
describe('the targets a probe bake draws into', () => {
  it('A REPEATED BAKE CREATES NO TEXTURES, VIEWS OR BIND GROUPS FOR ITS TARGETS', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({ reflectionProbeSize: 64, sceneSamples: 4 }),
    );
    expect(
      renderer.setProbeGrid({ origin: [0, 0, 0], spacing: [1, 1, 1], counts: [2, 1, 1] }),
    ).toBe(true);
    const views = (): number =>
      stub.device.createTexture.mock.results.reduce(
        (sum, result) =>
          sum +
          (result.value as { createView: { mock: { calls: unknown[] } } }).createView.mock.calls
            .length,
        0,
      );
    /* Both probes once, so every target either bake needs has been made. */
    renderer.bakeProbe(0, [0, 0, 0], () => {});
    renderer.bakeProbe(1, [0, 0, 0], () => {});

    const textures = stub.device.createTexture.mock.calls.length;
    const viewed = views();
    stub.device.createBindGroup.mockClear();
    renderer.bakeProbe(0, [0, 0, 0], () => {}, { bounce: true, faces: [0, 2] });
    renderer.bakeProbe(0, [0, 0, 0], () => {}, { bounce: true, faces: [2, 4] });
    renderer.bakeProbe(0, [0, 0, 0], () => {}, { bounce: true, faces: [4, 2] });
    expect(stub.device.createTexture.mock.calls.length - textures, 'textures').toBe(0);
    expect(views() - viewed, 'views').toBe(0);
    expect(stub.device.createBindGroup.mock.calls.length, 'bind groups').toBe(0);
  });
});

/**
 * **A lamp draws its glass into its own layers, and the first glass interleaves the array.**
 *
 * Opaque layer L moves to 2L and its glass takes 2L + 1: a shader cannot ask an array its layer
 * count under naga, so the glass sits beside its light rather than above the whole pool. Every map
 * already in the array is carried across, and the tint is an array of its own, a layer a light.
 */
describe('glass in a lamp s shadow', () => {
  const LIGHT = {
    x: 0,
    y: 2,
    z: 0,
    radius: 8,
    shadowNear: 0.25,
    sourceRadius: 0.05,
    castsShadow: true,
  };
  const caster = {
    key: 'flat:s0:u0',
    vertexBuffers: [{ label: 'vertices' }],
    indexBuffer: { label: 'indices' },
    indexCount: 3,
    complete: true,
  };
  const pane = {
    glass: { transmission: 0.9, frost: 0.5, tint: [1, 0.5, 0.25] as [number, number, number] },
  };
  const bake = (renderer: WebGPURenderer, glass: boolean): void => {
    renderer.updatePointShadows(
      [LIGHT],
      new Int32Array([0]),
      1,
      50,
      50,
      50,
      1 / 60,
      (sink) => {
        sink.mesh(caster as never, mat4.create());
        if (glass) sink.mesh(caster as never, mat4.create(), pane);
      },
      () => undefined,
    );
  };

  it('A LAMP DRAWS ITS GLASS INTO ITS OWN LAYERS, and the first glass interleaves the array', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub, resolveRenderQuality({ pointShadowFacesPerFrame: 6 }));
    renderer.prepareStaticPointShadows([LIGHT]);
    const array = (renderer as unknown as { pointShadowArray: { layers: number } })
      .pointShadowArray;
    const n = array.layers;
    stub.device.createTexture.mockClear();
    stub.encoder.beginRenderPass.mockClear();
    bake(renderer, true);

    const arrays = stub.device.createTexture.mock.calls
      .map(([d]) => d)
      .filter((d) => d.label === 'pointShadow.array');
    expect(
      arrays.map((d) => (d.size as number[])[2]),
      'twice the layers, once',
    ).toEqual([2 * n]);
    expect(
      stub.encoder.copyTextureToTexture.mock.calls.map(([from, to]) => [
        (from.origin as GPUOrigin3DDict).z,
        (to.origin as GPUOrigin3DDict).z,
      ]),
      'every opaque layer carried to 2L',
    ).toEqual(Array.from({ length: n }, (_, l) => [l, 2 * l]));
    const tint = stub.device.createTexture.mock.calls
      .map(([d]) => d)
      .find((d) => d.label === 'pointShadow.tint');
    expect(tint?.size).toEqual([1024, 1024, n]);
    expect(tint?.format).toBe('rgba8unorm');
    expect(tint?.mipLevelCount, 'the chain frost reads').toBe(11);

    const labels = stub.encoder.beginRenderPass.mock.calls.map(([d]) => String(d.label ?? ''));
    /* Six static faces, each with the pane, and the live map's six, which offer none. */
    expect(labels.filter((l) => l === 'pointShadow.face').length).toBe(12);
    expect(labels.filter((l) => l === 'pointShadow.glass').length, 'the pane s six').toBe(6);
    expect(labels.filter((l) => l === 'pointShadow.tint').length).toBe(6);
    expect(labels.filter((l) => l === 'pointShadow.tint.resolve').length).toBe(6);
    /* The static light holds layer 0's slot, so its opaque depth lands in 0 and its glass in 1. */
    const views = (renderer as unknown as { pointShadowArray: { layerViews: unknown[] } })
      .pointShadowArray.layerViews;
    const resolved = stub.encoder.beginRenderPass.mock.calls
      .map(([d]) => d)
      .filter((d) => d.label === 'pointShadow.resolve')
      .map((d) => views.indexOf(d.depthStencilAttachment?.view));
    const layer = (renderer as unknown as { resolvedPointShadows: { layers: Int32Array } })
      .resolvedPointShadows.layers[0] as number;
    expect(layer % 2, 'published at the even layer').toBe(0);
    expect(resolved.filter((v) => v === layer).length, 'opaque depth at 2L').toBe(6);
    expect(resolved.filter((v) => v === layer + 1).length, 'its glass at 2L + 1').toBe(6);
    /* The live map offered no glass: its faces landed at its own even layer and nowhere odd. */
    expect(resolved.filter((v) => v !== layer && v !== layer + 1).every((v) => v % 2 === 0)).toBe(
      true,
    );
  });

  it('A LAMP WITH NO GLASS DOES NO GLASS WORK, and allocates nothing for it', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub, resolveRenderQuality({ pointShadowFacesPerFrame: 6 }));
    renderer.prepareStaticPointShadows([LIGHT]);
    stub.device.createTexture.mockClear();
    stub.encoder.beginRenderPass.mockClear();
    bake(renderer, false);
    const labels = stub.encoder.beginRenderPass.mock.calls.map(([d]) => String(d.label ?? ''));
    expect(labels.filter((l) => l.startsWith('pointShadow.glass') || l.includes('tint'))).toEqual(
      [],
    );
    expect(
      stub.device.createTexture.mock.calls.filter(([d]) => d.label === 'pointShadow.tint'),
    ).toHaveLength(0);
  });

  it('HALF GLASS SHADOWS HALVE THE LAMP S TINT and nothing else', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({ pointShadowFacesPerFrame: 6, glassShadows: 'half' }),
    );
    renderer.prepareStaticPointShadows([LIGHT]);
    stub.device.createTexture.mockClear();
    bake(renderer, true);
    const made = stub.device.createTexture.mock.calls.map(([d]) => d);
    expect(
      (made.find((d) => d.label === 'pointShadow.tint')?.size as number[] | undefined)?.[0],
    ).toBe(512);
    expect(
      (made.find((d) => d.label === 'pointShadow.array')?.size as number[] | undefined)?.[0],
    ).toBe(1024);
  });
});

/**
 * **Every pane on a ray counts once, whichever way it faces.** A light crosses a pane from either
 * side, and a closed glass object has two surfaces on a ray — so the tint culls nothing, for the
 * sun as for a lamp. It culled back faces for the sun, which counted one side of a closed pane.
 */
it('EVERY PANE ON A RAY COUNTS, WHICHEVER WAY IT FACES: the sun s tint culls nothing', () => {
  const stub = stubSurface();
  const renderer = freshRenderer(stub);
  const caster = {
    key: 'flat:s0:u0',
    vertexBuffers: [{ label: 'vertices' }],
    indexBuffer: { label: 'indices' },
    indexCount: 3,
    complete: true,
  };
  renderer.beginShadowPass(mat4.create(), 'static');
  renderer.drawShadowCasters((sink) => {
    sink.mesh(caster as never, mat4.create(), { glass: { transmission: 0.9, frost: 0 } });
  });
  renderer.endShadowPass();
  const tinted = stub.device.createRenderPipeline.mock.calls
    .map(([descriptor]) => descriptor)
    .filter((descriptor) => String(descriptor.label ?? '').startsWith('glass-tint'));
  expect(tinted.length).toBeGreaterThan(0);
  expect(tinted.map((d) => d.primitive?.cullMode)).toEqual(tinted.map(() => 'none'));
});

/**
 * **A batch too small to repay a per-instance cull is drawn whole once its box is seen**, on both
 * backends and by one rule (`cullsInstances`).
 *
 * A device cull costs an indirect draw, and Chrome validates each one in its GPU process: measured
 * at 8 µs apiece in a city whose six hundred small prop batches took one each, a third of that frame.
 * WebGL2's twin culls on the CPU and uploads the survivors, which for four instances costs more than
 * drawing the two it would drop. Half of each batch below stands outside the view, so a batch still
 * culled instance by instance draws half and one drawn whole draws all of it.
 */
describe('instance culls, by the size of the batch', () => {
  function placeHalfOutside(count: number) {
    const data = createMeshInstances(count);
    data.count = count;
    for (let i = 0; i < count; i++) {
      const m = i * 16;
      data.models[m] = 1;
      data.models[m + 5] = 1;
      data.models[m + 10] = 1;
      data.models[m + 15] = 1;
      /* The view is the unit cube: the first half at its middle, the second fifty units right. */
      data.models[m + 12] = i < count / 2 ? 0 : 50;
      data.models[m + 14] = 0.5;
    }
    return data;
  }

  /**
   * One triangle, its three indices repeated `times` over: a mesh as heavy as asked, so the size of
   * a batch can come from its mesh rather than from how many instances it holds.
   */
  function triangles(times: number) {
    const indices = new Uint32Array(times * 3);
    for (let i = 0; i < indices.length; i++) indices[i] = i % 3;
    return {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
      colors: new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]),
      emissive: new Float32Array([0, 0, 0]),
      indices,
    } as never;
  }

  /*
   * Four instances of three indices are twelve: drawn whole. Eight of three thousand are
   * twenty-four thousand: culled — and a rule reading only the instances, or only the mesh, would
   * draw that one whole too.
   */
  it('A BATCH TOO SMALL TO REPAY A DEVICE CULL DRAWS WHOLE, and a heavy one is still culled on the device', () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = new WebGPURenderer(stub.surface, resolveRenderQuality({}));
    const light = renderer.createMesh(triangles(1));
    const heavy = renderer.createMesh(triangles(1000));
    const { camera, env } = stubScene();
    const small = placeHalfOutside(4);
    const few = placeHalfOutside(8);
    const smallBatch = renderer.createInstanced(light, 4, { cull: true });
    const heavyBatch = renderer.createInstanced(heavy, 8, { cull: true });
    renderer.uploadInstanced(smallBatch, small);
    renderer.uploadInstanced(heavyBatch, few);
    stub.pass.drawIndexed.mockClear();
    stub.pass.drawIndexedIndirect.mockClear();

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.drawInstanced(smallBatch, small);
    renderer.drawInstanced(heavyBatch, few);
    renderer.endFrame();

    expect(
      stub.pass.drawIndexed.mock.calls.filter((c) => c[0] === 3 && c[1] === 4).length,
      'the small batch is drawn directly, every instance of it',
    ).toBe(1);
    expect(
      stub.pass.drawIndexedIndirect.mock.calls.length,
      'and only the heavy one takes an indirect draw',
    ).toBe(1);
  });

  it('A BATCH TOO SMALL TO REPAY A CPU CULL DRAWS WHOLE ON WEBGL2, and a heavy one keeps its survivors', () => {
    const recording = recordingGl();
    const renderer = new WebGL2Renderer(recording.canvas, resolveRenderQuality({}));
    const light = renderer.createMesh(triangles(1));
    const heavy = renderer.createMesh(triangles(1000));
    const { camera, env } = stubScene();
    const small = placeHalfOutside(4);
    const few = placeHalfOutside(8);
    const smallBatch = renderer.createInstanced(light, 4, { cull: true });
    const heavyBatch = renderer.createInstanced(heavy, 8, { cull: true });
    renderer.uploadInstanced(smallBatch, small);
    renderer.uploadInstanced(heavyBatch, few);
    recording.calls.length = 0;

    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.drawInstanced(smallBatch, small);
    renderer.drawInstanced(heavyBatch, few);
    renderer.endFrame();

    const instances = recording.calls
      .filter((c) => c.name === 'drawElementsInstanced')
      .map((c) => c.args[4]);
    expect(instances, 'the small batch whole, the heavy one halved by its cull').toEqual([4, 4]);
  });
});

/**
 * **A mesh pass bound after the present is the interface's, and the interface is not jittered.**
 *
 * A consumer draws its interface after `endFrame` so it escapes the post chain, and text and insets
 * reach the pass through `bindMeshPass` like everything else. That bind re-decided the frame's
 * sub-pixel jitter: the interface was drawn jittered with no resolve after it, so a map, a marker
 * and every edge of it moved by a fraction of a pixel each frame; and it opened a second temporal
 * frame, so every consumer drawing an interface stepped the jitter sequence twice a frame, the world
 * saw every other position, and the anti-flicker's period — which starts where the index is a whole
 * number of periods — never started at all.
 */
describe('a mesh pass after the present', () => {
  const unjittered = (renderer: object): boolean => {
    const r = renderer as unknown as { viewProj: Float32Array; correctedViewProj: Float32Array };
    return Array.from(r.viewProj).every((v, i) => v === r.correctedViewProj[i]);
  };

  it('A MESH PASS AFTER THE PRESENT IS NOT JITTERED ON WEBGPU, and opens no second temporal frame', () => {
    const stub = stubSurface();
    const renderer = new WebGPURenderer(
      stub.surface,
      resolveRenderQuality({ screenEffects: true, temporalAa: true }),
    );
    const { camera, env } = stubScene();
    for (let frame = 0; frame < 2; frame++) {
      renderer.beginFrame([0, 0, 0]);
      renderer.bindMeshPass(camera, env);
      renderer.endFrame();
      renderer.bindMeshPass(camera, env);
      expect(unjittered(renderer), `the interface of frame ${frame} is drawn unjittered`).toBe(
        true,
      );
    }
    const history = (renderer as unknown as { temporalHistory: { frameIndex: number } })
      .temporalHistory;
    expect(history.frameIndex, 'two frames, two temporal frames').toBe(2);
  });

  it('A MESH PASS AFTER THE PRESENT IS NOT JITTERED UNDER RECONSTRUCTION', () => {
    const stub = stubSurface();
    const renderer = new WebGPURenderer(
      stub.surface,
      resolveRenderQuality({ screenEffects: true, reconstruction: 1.5 }),
    );
    const { camera, env } = stubScene();
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.endFrame();
    renderer.bindMeshPass(camera, env);
    expect(unjittered(renderer)).toBe(true);
  });

  it('A MESH PASS AFTER THE PRESENT IS NOT JITTERED ON WEBGL2, and opens no second temporal frame', () => {
    const renderer = new WebGL2Renderer(
      recordingGl().canvas,
      resolveRenderQuality({ screenEffects: true, temporalAa: true }),
    );
    const { camera, env } = stubScene();
    const r = renderer as unknown as {
      temporalJittering: boolean;
      temporalHistory: { frameIndex: number };
    };
    for (let frame = 0; frame < 2; frame++) {
      renderer.beginFrame([0, 0, 0]);
      renderer.bindMeshPass(camera, env);
      expect(r.temporalJittering, 'the world is jittered').toBe(true);
      renderer.endFrame();
      renderer.bindMeshPass(camera, env);
      expect(r.temporalJittering, `the interface of frame ${frame} is not`).toBe(false);
    }
    expect(r.temporalHistory.frameIndex, 'two frames, two temporal frames').toBe(2);
  });
});

/*
 * **A pass's first material keeps its maps, frame after frame.** `setMaterial` skips the lookup
 * when the maps it is given are the ones held, and opening a pass bound the blank group while
 * holding the last pass's normal, ORM, emissive and model maps — so a pass whose first material
 * was the last of the pass before drew with the stand-ins from the second frame on while its flags
 * said the maps were bound. Any scene of one material: a metal read its roughness off a blank
 * texel, a mirror blurred and a lit side took the sun as a dielectric's. WebGL2 never did.
 */
it('A PASS THAT OPENS ON THE MATERIAL THE LAST ONE CLOSED ON STILL BINDS ITS MAPS', () => {
  const stub = stubSurface();
  const renderer = freshRenderer(stub);
  const { camera, env } = stubScene();
  const mesh = stubMesh(renderer);
  const orm = renderer.createSurfaceTexture(
    { width: 1, height: 1 } as unknown as TexImageSource,
    {},
  );
  const groupsNaming = (view: unknown) =>
    new Set(
      stub.device.createBindGroup.mock.results
        .filter((_, k) =>
          Array.from(stub.device.createBindGroup.mock.calls[k]?.[0].entries ?? []).some(
            (entry) => entry.resource === view,
          ),
        )
        .map((result) => result.value),
    );
  const drawnWith = (): unknown[] => stub.pass.setBindGroup.mock.calls.map(([, group]) => group);
  for (let frame = 0; frame < 3; frame++) {
    stub.pass.setBindGroup.mockClear();
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.setMaterial({ orm });
    renderer.drawMesh(mesh, mat4.create());
    renderer.endFrame();
    const withMap = groupsNaming(orm.view);
    expect(
      drawnWith().some((group) => withMap.has(group)),
      `frame ${frame} draws with a group holding the map`,
    ).toBe(true);
  }
});

/*
 * **A scene capture is a boundary inside somebody else's frame**, and three things leaked across
 * it. Taken after the frame had drawn, the flush that replays the frame's draws opened the frame's
 * pass, and the capture gave back the null it had saved before the flush: the opened pass was left
 * on the frame's encoder and every later one was refused — a black frame. A blended draw inside the
 * capture latched the frame's skin spread, so every face drawn after it went unspread. And a frame
 * binding its camera again after a capture, as any draw after one does, opened a second temporal
 * frame. `scripts/capture-check.mjs` finds all three on a device.
 */
describe('A SCENE CAPTURE INSIDE A FRAME LEAVES THE FRAME ALONE', () => {
  const identity = mat4.create();

  it('A CAPTURE TAKEN AFTER THE FRAME HAS DRAWN HANDS BACK THE PASS ITS FLUSH OPENED', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub);
    const { camera, env } = stubScene();
    const mesh = stubMesh(renderer);
    const capture = renderer.createSceneCapture(64, 32);
    const r = renderer as unknown as { pass: unknown };
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(mesh, identity);
    expect(r.pass, 'the draw is recorded, and no pass is open yet').toBeNull();
    expect(renderer.captureScene(capture, new Camera(), [0, 0, 0], () => {})).toBe(true);
    expect(r.pass, 'the frame continues in the pass the flush opened').not.toBeNull();
    renderer.endFrame();
  });

  it('A BLENDED DRAW INSIDE A CAPTURE DOES NOT END THE FRAME’S SKIN SPREAD', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({ screenEffects: true, skinScattering: 'screen-space' }),
    );
    const { camera, env } = stubScene();
    const mesh = stubMesh(renderer);
    const capture = renderer.createSceneCapture(64, 32);
    const r = renderer as unknown as { skinScattered: boolean };
    renderer.beginFrame([0, 0, 0]);
    renderer.captureScene(capture, new Camera(), [0, 0, 0], (seen) => {
      renderer.bindMeshPass(seen, env);
      renderer.drawTranslucentMesh(mesh, identity, 1, { additive: true });
    });
    expect(r.skinScattered, 'the frame’s skin is still to be spread').toBe(false);
    renderer.bindMeshPass(camera, env);
    renderer.drawTranslucentMesh(mesh, identity, 1, { additive: true });
    expect(r.skinScattered, 'and the frame’s own blended draw is what spreads it').toBe(true);
    renderer.endFrame();
  });

  it('A FRAME THAT BINDS ITS CAMERA TWICE IS ONE TEMPORAL FRAME', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({ screenEffects: true, temporalAa: true }),
    );
    const { camera, env } = stubScene();
    const r = renderer as unknown as { temporalHistory: { frameIndex: number } };
    for (let frame = 0; frame < 3; frame++) {
      renderer.beginFrame([0, 0, 0]);
      renderer.bindMeshPass(camera, env);
      renderer.bindMeshPass(camera, env);
      renderer.endFrame();
    }
    expect(r.temporalHistory.frameIndex, 'three frames, three steps of the sequence').toBe(3);
  });
});

/*
 * **A registered pass that reads the frame's colour is handed a copy of it**, refilled at its own
 * draw with everything drawn before it: a distortion samples the scene behind it, and a full-screen
 * effect drawn last reads the whole frame and writes over it. A pass that does not declare the read
 * costs no copy and is handed no view.
 */
describe('A REGISTERED PASS READS THE FRAME’S COLOUR', () => {
  it('IS HANDED A COPY TAKEN AT ITS DRAW, AND A PASS THAT DOES NOT READ IT IS NOT', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub, resolveRenderQuality({ screenEffects: true }));
    const { camera, env } = stubScene();
    const mesh = stubMesh(renderer);
    const seen: (GPUTextureView | null)[] = [];
    const plain = renderer.registerPass({ label: 'plain', draw: () => {} });
    const reader = renderer.registerPass({
      label: 'reader',
      reads: ['colorSnapshot'],
      prepare: (ctx) => {
        if (ctx.backend === 'webgpu') seen.push(ctx.sceneColor);
      },
      draw: () => {},
    });
    const copies = () =>
      stub.encoder.copyTextureToTexture.mock.calls.filter(
        ([, to]) => (to.texture as { label?: string }).label === 'pass.sceneColor',
      );
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(mesh, mat4.create());
    renderer.drawPass(plain);
    expect(copies(), 'a pass that does not read the colour takes no copy').toHaveLength(0);
    renderer.drawPass(reader);
    renderer.drawPass(reader);
    expect(copies(), 'one copy a reading draw').toHaveLength(2);
    expect(
      copies().every(([from]) => (from.texture as { label?: string }).label === 'post.sceneColor'),
      'of the frame’s own colour',
    ).toBe(true);
    renderer.endFrame();
    expect(seen.length, 'prepare ran').toBeGreaterThan(0);
    expect(
      seen.every((view) => view !== null),
      'and was handed the copy’s view',
    ).toBe(true);
  });

  /*
   * **Under a reconstruction it draws after the blended draws**, which land after the upscale: a
   * full-screen effect drawn among them at the render's size would read a frame without them and
   * be covered by them. So it is queued, handed a copy of the reconstructed picture, and drawn over
   * it at the reconstruction's format, however early it was asked.
   */
  it('UNDER A RECONSTRUCTION, DRAWS AFTER THE UPSCALE OVER A COPY OF THE RECONSTRUCTED PICTURE', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(
      stub,
      resolveRenderQuality({ screenEffects: true, reconstruction: 1.5 }),
    );
    const { camera, env } = stubScene();
    const mesh = stubMesh(renderer);
    const formats: string[] = [];
    const reader = renderer.registerPass({
      label: 'reader',
      reads: ['colorSnapshot'],
      draw: (ctx) => {
        if (ctx.backend === 'webgpu') formats.push(ctx.format);
      },
    });
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.drawPass(reader);
    renderer.drawTranslucentMesh(mesh, mat4.create(), 0.5);
    expect(formats, 'nothing drawn where it was asked').toEqual([]);
    renderer.endFrame();
    expect(formats, 'drawn once, after the upscale, at the picture’s format').toEqual([
      'rgba16float',
    ]);
    const fromShown = stub.encoder.copyTextureToTexture.mock.calls.filter(
      ([from, to]) =>
        (from.texture as { label?: string }).label === 'recon.shown' &&
        (to.texture as { label?: string }).label === 'refract.snapshot',
    );
    expect(fromShown, 'from a copy of the reconstructed picture').toHaveLength(1);
  });
});

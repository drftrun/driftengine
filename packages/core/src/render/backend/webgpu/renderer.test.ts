import { DEPTH_FORMAT, REVERSED_DEPTH } from '../../depthConvention.ts';
import { describe, expect, it, vi } from 'vitest';
import { mat4, vec4 } from 'gl-matrix';

import { maskOf, resourceBit } from '../../frame/index.ts';
import { nodeCount } from '../../frame/arena.ts';
import { DEPTH_VERT_FIELDS } from './depthPass.ts';
import { flatFragmentBindings, flatVariant } from './flatPass.ts';
import { lightVolumeFragmentBindings } from './lightVolumePass.ts';
import { RUSH_FRAG_FIELDS } from './postPass.ts';
import { SCATTER_DEPTH_FIELDS } from './scatterPass.ts';
import { TEXT_VERT_FIELDS } from './textPass.ts';
import { DEFAULT_TEXT_STYLE } from '../../textLayout.ts';
import { bloomLevelSizes } from '../../bloomChain.ts';
import { MAX_POINT_LIGHTS } from '../../lightBudget.ts';
import { resolveRenderQuality, type RenderQuality } from '../../renderQuality.ts';
import type { GpuSurface } from './device.ts';
import type { ParticleInstances } from '../../particlePool.ts';
import { WebGPURenderer } from './renderer.ts';

/**
 * A surface with no GPU behind it, whose loss can be flipped on demand.
 *
 * `limits` overrides what the stub device reports. The default is what a device gets when it
 * asks for nothing, which is what most of these tests want; a test about the environment probe
 * needs the ceiling this project's `select.ts` actually requests and this machine actually
 * grants, which is 48 sampled textures.
 */
function stubSurface(limits: Record<string, number> = {}) {
  const pass = {
    end: vi.fn(),
    setPipeline: vi.fn(),
    setBindGroup: vi.fn(),
    setVertexBuffer: vi.fn(),
    setIndexBuffer: vi.fn(),
    drawIndexed: vi.fn(),
    draw: vi.fn(),
    /* An inset points both of these at its rectangle and `endInset` puts them back. */
    setViewport: vi.fn(),
    setScissorRect: vi.fn(),
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
    createCommandEncoder: vi.fn(() => encoder),
    createBindGroupLayout: vi.fn(() => ({ label: 'layout' })),
    createPipelineLayout: vi.fn(() => ({ label: 'pipelineLayout' })),
    createBindGroup: vi.fn(() => ({ label: 'bindGroup' })),
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
    const [width = 0, height = 0] = scene?.size as number[];
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
      .find((descriptor) => descriptor.label === 'shadow.static');
    expect([...(allocated?.size as number[])]).toEqual([
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

    /* Its own texture, at the profile's map size — not a second name for the static one, which
       would put the movers and the world in one depth buffer and lose whichever is further. */
    const maps = stub.device.createTexture.mock.calls
      .map(([descriptor]) => descriptor)
      .filter((descriptor) => String(descriptor.label ?? '').startsWith('shadow.'));
    expect(maps.map((descriptor) => descriptor.label).sort()).toEqual([
      'shadow.dynamic',
      'shadow.peel',
      'shadow.static',
    ]);
    for (const map of maps) {
      expect(map.size, `${String(map.label)} must match the profile`).toEqual([
        quality.directionalShadowMapSize,
        quality.directionalShadowMapSize,
      ]);
    }
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

    const upload = device.queue.writeBuffer.mock.calls.at(-1);
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
    expect(floats[off('uEmissiveGain')]).toBeCloseTo(0.25);
    expect(floats[off('uNightFactor')]).toBeCloseTo(0.5);
    expect(floats[off('uHighlightGain')]).toBeCloseTo(1.5);
    expect([0, 1, 2].map((k) => floats[off('uHighlightMin') + k])).toEqual([
      expect.closeTo(0.1),
      expect.closeTo(0.2),
      expect.closeTo(0.3),
    ]);

    /* Constants, matching `renderer.ts` — an unwritten uniform is 0 and 0 is wrong for both. */
    expect(floats[off('uGrain')]).toBe(1);
    expect(floats[off('uReliefCycles')]).toBe(60);
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
    const materialSlot = (renderer as unknown as { materialSlot: number }).materialSlot;
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

  it('answers a square inset with a square aspect', () => {
    const stub = stubSurface();
    const renderer = freshRenderer(stub);
    renderer.beginFrame([0, 0, 0]);

    const aspect = renderer.beginInset({ left: 20, top: 20, width: 100, height: 100 }, null);
    renderer.endInset();

    expect(aspect).toBeCloseTo(1, 5);
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

describe('the frame graph', () => {
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
    const renderer = new WebGPURenderer(stub.surface, resolveRenderQuality({ frameGraph: true }));
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
    const renderer = new WebGPURenderer(stub.surface, resolveRenderQuality({ frameGraph: true }));
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
    const renderer = new WebGPURenderer(stub.surface, resolveRenderQuality({ frameGraph: true }));

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
    const renderer = new WebGPURenderer(stub.surface, resolveRenderQuality({ frameGraph: true }));
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
    const renderer = new WebGPURenderer(stub.surface, resolveRenderQuality({ frameGraph: true }));
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
    const renderer = new WebGPURenderer(stub.surface, resolveRenderQuality({ frameGraph: true }));
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
      resolveRenderQuality({ frameGraph: true, planarReflections: true }),
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
    const renderer = new WebGPURenderer(stub.surface, resolveRenderQuality({ frameGraph: true }));
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
    const renderer = new WebGPURenderer(stub.surface, resolveRenderQuality({ frameGraph: true }));
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
      resolveRenderQuality({ frameGraph: true, cameraMotionBlur: 0, ambientOcclusion: 0 }),
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
      resolveRenderQuality({ frameGraph: true, ambientOcclusion: 0.5 }),
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
      resolveRenderQuality({
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
      resolveRenderQuality({
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
    const renderer = new WebGPURenderer(stub.surface, resolveRenderQuality({ frameGraph: true }));
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
      resolveRenderQuality({
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
      resolveRenderQuality({
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
      resolveRenderQuality({
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
    const renderer = new WebGPURenderer(stub.surface, resolveRenderQuality({ frameGraph: true }));
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
      resolveRenderQuality({ frameGraph: true, planarReflections: true }),
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
      resolveRenderQuality({
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
      resolveRenderQuality({ frameGraph: true, planarReflections: true }),
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
    const renderer = new WebGPURenderer(stub.surface, resolveRenderQuality({ frameGraph: true }));
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
      resolveRenderQuality(quality),
    );
    const withoutPass = new WebGPURenderer(
      stubSurface({ maxSampledTexturesPerShaderStage: 48 }).surface,
      resolveRenderQuality(quality),
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
      position: new Float32Array([0, 0, 0]),
    } as never;
  }

  /** The query a consumer uses, which is the half that can save more than a draw. */
  it('says what is on screen and what is behind the camera', () => {
    const stub = stubSurface({ maxSampledTexturesPerShaderStage: 48 });
    const renderer = new WebGPURenderer(stub.surface, resolveRenderQuality({}));
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
      const renderer = new WebGPURenderer(stub.surface, resolveRenderQuality({ cullDraws }));
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
    const renderer = new WebGPURenderer(stub.surface, resolveRenderQuality({ frameGraph: false }));
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
    const quality = resolveRenderQuality({ frameGraph: true });
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
   * entry spends a slot **per draw** out of `MAX_MATERIALS_PER_FRAME`, and past the ring the draws
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

/**
 * The budget, and the message that never described what this code does.
 *
 * **`WebGPU: more than 1024 materials in a frame; the rest reuse the last` was wrong in the commit
 * that wrote it.** `materialSlotForDraw` has returned null and the caller has skipped the draw
 * since `9d90bf7`; nothing has ever reused the last material. The doc comment at
 * `MAX_MATERIALS_PER_FRAME` said the same thing and was the stated argument for raising the ring
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

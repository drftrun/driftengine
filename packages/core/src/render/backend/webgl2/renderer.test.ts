import { expect, test, vi } from 'vitest';
import { mat4 } from 'gl-matrix';

import { Mesh } from '../../mesh.ts';
import { Renderer } from './renderer.ts';
import { recordingGl } from '../../rendererHarness.ts';
import { BloomPass } from '../../bloomPass.ts';
import { createEnvironment } from './renderer.ts';
import { Camera } from '../../camera.ts';
import { LIGHT_RECORD, LIGHT_TEXELS } from '../../clusteredLights.ts';
import { resolveRenderQuality } from '../../renderQuality.ts';
import {
  CLOTH_PARTICLES_TEXTURE_UNIT,
  EMISSIVE_TEXTURE_UNIT,
  NORMAL_TEXTURE_UNIT,
  ORM_TEXTURE_UNIT,
  SURFACE_TEXTURE_UNIT,
} from '../../lightBudget.ts';
import { createMeshInstances } from '../../instances.ts';
import { eyeModel, skinModel } from '../../surfaceModel.ts';

/**
 * Whether order-independent transparency is on, asked the only way a caller can ask it.
 *
 * `oitActive` is private and there is no accessor for it, which is right: what a consumer is
 * exposed to is not the flag but what `drawTranslucentMesh` *does*. With the effect on the draw is
 * recorded and replayed twice at the end of the pass, so nothing reaches `drawElements` at submit
 * time; with it off the pane is blended immediately, in the order this loop submits them. One
 * `drawElements` means sorted and none means accumulated, and that is the difference the whole
 * capability is.
 */
const GEOMETRY = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  colors: new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]),
  emissive: new Float32Array([0, 0, 0]),
  indices: new Uint32Array([0, 1, 2]),
};

function submitOneTranslucentPane(sceneSamples: number): number {
  /*
   * The extension is what makes this pair about the sample count and nothing else. Without it
   * `OitPass` refuses one step earlier, for the float colour buffer the accumulation needs, and
   * both profiles below would come out sorted for a reason neither test is about.
   */
  const { gl, canvas, calls } = recordingGl({ extensions: ['EXT_color_buffer_float'] });
  const renderer = new Renderer(
    canvas,
    resolveRenderQuality({ screenEffects: true, orderIndependent: true, sceneSamples }),
  );
  const mesh = new Mesh(gl, GEOMETRY);

  renderer.beginFrame([0, 0, 0]);
  const before = calls.filter((call) => call.name === 'drawElements').length;
  renderer.drawTranslucentMesh(mesh, mat4.create(), 0.5);
  return calls.filter((call) => call.name === 'drawElements').length - before;
}

/**
 * **The guard the other backend has and this one did not.**
 *
 * `SceneTarget.depthAttachment()` hands back `this.depth`, and with samples above one the frame is
 * not drawn into that texture: `ensureSize` attaches `msaaDepth`, a renderbuffer, and the texture
 * is written only by the depth blit at the end of `resolve` — a blit which itself only runs when
 * something else asked for depth, so with occlusion, motion blur and depth of field all off it
 * never runs at all. The two order-independent passes would then reject a pane against the
 * previous frame's depth, or against a texture the frame has never written.
 *
 * WebGPU excludes multisampling from the same decision and says why. Two backends compositing
 * different pictures from the same profile is the disagreement the parity rule exists to prevent.
 */
test('leaves the translucent set sorted when the scene is multisampled', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(submitOneTranslucentPane(4), 'blended in submission order, immediately').toBe(1);
  vi.restoreAllMocks();
});

/**
 * The control, and without it the test above proves nothing: if a single-sampled profile also
 * drew the pane immediately, the assertion would be reporting an effect that never switches on
 * rather than one excluded by the sample count.
 */
test('records the translucent set for the resolve when the scene is single-sampled', () => {
  expect(submitOneTranslucentPane(1), 'held for the two passes at the end of the frame').toBe(0);
});

/**
 * **Said once and not per frame**, on the terms every other refusal in this file keeps: a profile
 * that asks for the effect and cannot have it is a quality setting that silently does not apply,
 * which is the class of fault `capabilityClamp` and the bloom warning beside it exist to avoid.
 * A graphics screen can put a player either side of this guard with an antialiasing switch.
 */
test('says once that multisampling excludes the effect, rather than only sorting', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { canvas } = recordingGl({ extensions: ['EXT_color_buffer_float'] });
  const renderer = new Renderer(
    canvas,
    resolveRenderQuality({ screenEffects: true, orderIndependent: true, sceneSamples: 4 }),
  );

  renderer.beginFrame([0, 0, 0]);
  renderer.beginFrame([0, 0, 0]);

  const said = warn.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.includes('order-independent transparency'));
  expect(said, 'once for the renderer, not once a frame').toHaveLength(1);
  expect(said[0], 'and it names the reason, so the setting can be found').toMatch(/multisampl/);
  vi.restoreAllMocks();
});

/**
 * **A probe bake no longer reads anything back, and that is the change worth pinning.**
 *
 * A bake used to fill the cube *and* read it back, project it onto spherical harmonics and raise
 * `uEnvIrradianceEnabled` — from that frame on every diffuse surface in the world took its ambient
 * from the projection instead of from the values the consumer wrote into `Environment`. The
 * coupling was known and documented; the choice did not exist, and what it cost the consumer who
 * reported it was the whole scene changing what lights it, once, mid-session, at whatever moment
 * their bake landed. Filed four times over two days as four different bugs.
 *
 * The diffuse term is a level of the probe array now, convolved on the GPU at bake time, so there
 * is nothing to read back on either path. **Six `readPixels` a bake became none**, and with them
 * went the two-backend timing skew that needed a second gate uniform to paper over.
 *
 * `ProbeBakeOptions.irradiance` survives with its meaning intact and is now purely a uniform:
 * `uProbeGridAmbient`, which `flat.test.ts` asserts collapses the whole term at zero, and which
 * the exit page measures against a scene rendered without a grid.
 */
function probeFaceReads(options?: Parameters<Renderer['bakeReflectionProbe']>[3]): number {
  const { canvas, calls } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({ reflectionProbeSize: 64 }));
  const before = calls.length;

  const baked = renderer.bakeReflectionProbe([0, 1, 0], [0, 0, 0], () => {}, options);
  expect(baked, 'the bake must have run, or this asserts nothing').toBe(true);

  return calls.slice(before).filter((call) => call.name === 'readPixels').length;
}

test('a probe bake reads nothing back, whatever the caller asked for', () => {
  expect(probeFaceReads(), 'the default reads no face back').toBe(0);
  expect(probeFaceReads({ irradiance: true }), 'nor does asking for the ambient').toBe(0);
  expect(probeFaceReads({ irradiance: false }), 'nor does declining it').toBe(0);
});

/*
 * **A single baked probe is a grid of one, and that is what makes there be one code path.**
 *
 * `bakeReflectionProbe` is the API every scene that has ever run on this engine calls, and it now
 * declares a lattice of `[1, 1, 1]` and fills layer zero of it. A commit that gave the single probe
 * its own path would pass every other test in this file and fail here.
 */
/*
 * **A bounce bake lights what its probes see by the grid, and an ordinary bake does not.** One sweep
 * of the grid holds one bounce, which left a courtyard's arcades two stops under a reference render.
 * `bounce` keeps the array bound while the faces are drawn. Nothing attaches the array then, since
 * the faces go into their own cube, so the feedback-loop rule is not broken. And never before every
 * probe is filled, when the array is not readable.
 */
test('A BOUNCE BAKE READS THE GRID IT IS REFILLING, ONCE THE GRID IS WHOLE, AND A PLAIN BAKE NEVER DOES', () => {
  const { canvas, calls } = recordingGl({ extensions: ['EXT_color_buffer_float'] });
  const renderer = new Renderer(canvas, resolveRenderQuality({ reflectionProbeSize: 64 }));
  const env = createEnvironment();
  const camera = new Camera();
  expect(renderer.setProbeGrid({ origin: [0, 0, 0], spacing: [1, 1, 1], counts: [2, 1, 1] })).toBe(
    true,
  );
  const draw = (probeCamera: Camera): void => {
    renderer.bindMeshPass(probeCamera, env);
  };
  const TEXTURE_2D_ARRAY = 0x8c1a;

  /** The grid's own texture: whatever was bound to the array target when two layers were stored. */
  const arrayTexture = (): unknown => {
    let bound: unknown = null;
    for (const call of calls) {
      if (call.name === 'bindTexture' && call.args[0] === TEXTURE_2D_ARRAY) bound = call.args[1];
      if (call.name === 'texStorage3D' && call.args[5] === 2) return bound;
    }
    return null;
  };
  /** Whether a bake bound the grid's texture for reading while its faces were drawn. */
  const readsGrid = (bake: () => void): boolean => {
    const from = calls.length;
    bake();
    const grid = arrayTexture();
    expect(grid, 'the grid must have been allocated, or this asserts nothing').not.toBeNull();
    return calls
      .slice(from)
      .some(
        (call) =>
          call.name === 'bindTexture' && call.args[0] === TEXTURE_2D_ARRAY && call.args[1] === grid,
      );
  };

  expect(
    readsGrid(() => renderer.bakeProbe(0, [0, 0, 0], draw, { bounce: true })),
    'the first probe of a grid never baked has nothing to read',
  ).toBe(false);
  renderer.bakeProbe(1, [0, 0, 0], draw);
  expect(
    readsGrid(() => renderer.bakeProbe(0, [0, 0, 0], draw)),
    'a plain bake lights its faces by the ambient, as before',
  ).toBe(false);
  expect(
    readsGrid(() => renderer.bakeProbe(0, [0, 0, 0], draw, { bounce: true })),
    'a bounce bake of a whole grid reads it',
  ).toBe(true);
  /* And the frame after reads it, whichever bake came last. */
  expect(readsGrid(() => renderer.bindMeshPass(camera, env))).toBe(true);
});

test('A PROBE BAKED A FEW FACES AT A TIME IS CONVOLVED ONCE, when its last face lands', () => {
  /*
   * A bake is six scene draws, and a scene of millions of triangles makes that the most expensive
   * thing in a frame. Spread over calls, each draws only the faces it is asked for into the capture,
   * and the convolution into the layer, which reads all six, waits for the sixth. Read off the calls:
   * a face is framebufferTexture2D on the capture, and the convolution is framebufferTextureLayer.
   */
  const { canvas, calls } = recordingGl({ extensions: ['EXT_color_buffer_float'] });
  const renderer = new Renderer(canvas, resolveRenderQuality({ reflectionProbeSize: 64 }));
  expect(renderer.setProbeGrid({ origin: [0, 0, 0], spacing: [1, 1, 1], counts: [2, 1, 1] })).toBe(
    true,
  );
  let drawn = 0;
  const bake = (faces: readonly [number, number]): { faces: number; convolved: boolean } => {
    const from = calls.length;
    drawn = 0;
    renderer.bakeProbe(1, [0, 0, 0], () => drawn++, { faces });
    const made = calls.slice(from);
    return {
      faces: drawn,
      convolved: made.some((call) => call.name === 'framebufferTextureLayer'),
    };
  };
  expect(bake([0, 2]), 'the first two faces, and nothing to convolve yet').toEqual({
    faces: 2,
    convolved: false,
  });
  expect(bake([2, 2])).toEqual({ faces: 2, convolved: false });
  expect(bake([4, 2]), 'the last two, and the layer is written').toEqual({
    faces: 2,
    convolved: true,
  });
  /* A bake that asks for nothing is all six faces, as before. */
  drawn = 0;
  renderer.bakeProbe(0, [0, 0, 0], () => drawn++);
  expect(drawn).toBe(6);
});

test('A CROSSFADING GRID WRITES EACH SWEEP INTO A SET THE SHADING IS NOT READING', () => {
  /*
   * Three sets of layers, the newest sweep written into the one neither end of the blend holds.
   * Read off the convolution: framebufferTextureLayer(target, attachment, texture, level, layer).
   */
  const { canvas, calls } = recordingGl({ extensions: ['EXT_color_buffer_float'] });
  const renderer = new Renderer(canvas, resolveRenderQuality({ reflectionProbeSize: 64 }));
  expect(
    renderer.setProbeGrid({
      origin: [0, 0, 0],
      spacing: [1, 1, 1],
      counts: [2, 1, 1],
      crossfade: true,
    }),
  ).toBe(true);
  const storage = calls.filter((call) => call.name === 'texStorage3D').at(-1);
  expect(storage?.args[5], 'three sets of two').toBe(6);
  const layerOf = (probe: number): unknown => {
    const from = calls.length;
    renderer.bakeProbe(probe, [0, 0, 0], () => {});
    return calls.slice(from).find((call) => call.name === 'framebufferTextureLayer')?.args[4];
  };
  expect([layerOf(0), layerOf(1)], 'the first sweep, the first set').toEqual([0, 1]);
  expect([layerOf(1), layerOf(0)], 'the second, the second').toEqual([3, 2]);
  expect([layerOf(0), layerOf(1)], 'the third, the third').toEqual([4, 5]);
  expect(layerOf(0), 'and round again').toBe(0);
});

test('baking one probe declares a grid of one and fills its only layer', () => {
  const { canvas, calls } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({ reflectionProbeSize: 64 }));
  const before = calls.length;
  expect(renderer.bakeReflectionProbe([2, 1, 3], [0, 0, 0], () => {})).toBe(true);
  const made = calls.slice(before);

  /* texStorage3D(target, levels, internalformat, width, height, depth) */
  const storage = made.find((call) => call.name === 'texStorage3D');
  expect(storage, 'the array is allocated for the grid').toBeDefined();
  expect(storage?.args[5], 'one layer, because the grid is one probe').toBe(1);
  /* An octahedral edge of twice the 64-texel face, per `octahedralEdgeFor`. */
  expect(storage?.args[3]).toBe(128);

  const layers = made
    .filter((call) => call.name === 'framebufferTextureLayer')
    .map((call) => call.args[4]);
  expect(layers.length, 'one attach per level of the chain').toBeGreaterThan(0);
  for (const layer of layers) expect(layer, 'always layer zero').toBe(0);
});

/*
 * Rebaking must not throw the layers away. `bakeReflectionProbe` declares its grid on every call,
 * and `demo/dev/probe.html` bakes every frame — reallocating there would be a texture created and
 * destroyed sixty times a second, which reads as a memory leak rather than as a redundant call.
 */
test('rebaking the same probe does not reallocate the array', () => {
  const { canvas, calls } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({ reflectionProbeSize: 64 }));
  renderer.bakeReflectionProbe([2, 1, 3], [0, 0, 0], () => {});
  const before = calls.length;
  renderer.bakeReflectionProbe([2, 1, 3], [0, 0, 0], () => {});
  const again = calls.slice(before).filter((call) => call.name === 'texStorage3D');
  expect(again, 'the same grid keeps the layers it has').toHaveLength(0);
});

/**
 * The colour replay reaches this backend too, which is the half a WebGPU-only test cannot say.
 *
 * `drawSceneCasters` is the counterpart of `drawShadowCasters`, so one caster enumeration can
 * serve a mirror or a probe face as well as the shadow cascade. What is asserted here is that the
 * enumeration is actually driven on this backend and that a sink arrives with every shape on it —
 * the failure this guards is the one the two-backends rule was written for, a verb added to one
 * renderer and reimplemented differently or not at all on the other.
 */
test('replays a caster enumeration into the colour pass on this backend as well', () => {
  const { canvas } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({}));
  const gl = (renderer as unknown as { gl: WebGL2RenderingContext }).gl;
  const mesh = new Mesh(gl, GEOMETRY);

  let sinkSeen: unknown = null;
  let drewWithMaterial = false;
  renderer.drawSceneCasters((sink) => {
    sinkSeen = sink;
    sink.mesh(mesh, mat4.create(), null);
    drewWithMaterial = true;
  });

  expect(sinkSeen, 'the enumeration ran and was handed a sink').not.toBeNull();
  const sink = sinkSeen as Record<string, unknown>;
  for (const shape of ['mesh', 'skinnedMesh', 'instanced', 'scatter']) {
    expect(typeof sink[shape], `the sink answers ${shape}`).toBe('function');
  }
  expect(drewWithMaterial, 'and a draw carrying a material was accepted').toBe(true);
});

/**
 * A run of entries sharing one material binds it once, which is most of what a replay costs.
 *
 * `ShadowCasterSink`'s material is optional and omitting it means *no material* rather than
 * *unchanged*, so the sink had no way of being told one was still standing and bound per entry. On
 * this backend a bind is a `useProgram` and a whole material write for every flat program; on the
 * other it is a slot out of a ring that skips draws once it runs out. A consumer wrote a sink of
 * its own over the public verbs to get exactly this, which is the shape of report worth closing
 * rather than answering.
 *
 * Counted on `setMaterial` rather than on GL calls because that is the claim: one bind per
 * material, not one per entry. The draw count is asserted beside it so that a sink which skipped
 * the *draw* instead of the bind fails here rather than passing quietly.
 */
test('binds a replayed material once for the run of draws that share it', () => {
  const { canvas, calls } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({}));
  const gl = (renderer as unknown as { gl: WebGL2RenderingContext }).gl;
  const mesh = new Mesh(gl, GEOMETRY);
  const binds = vi.spyOn(renderer, 'setMaterial');
  /* Two references, and structurally different so that a deep compare would agree with them. */
  const stone = { roughnessScale: 0.8 };
  const glass = { roughnessScale: 0.1 };

  renderer.beginFrame([0, 0, 0]);
  const before = calls.filter((call) => call.name === 'drawElements').length;
  renderer.drawSceneCasters((sink) => {
    for (const material of [stone, stone, stone, glass, glass, glass]) {
      sink.mesh(mesh, mat4.create(), material);
    }
  });

  expect(
    calls.filter((call) => call.name === 'drawElements').length - before,
    'every entry in the run drew',
  ).toBe(6);
  expect(binds.mock.calls.length, 'and the six of them bound two materials').toBe(2);
});

/**
 * The replay assumes nothing about what the pass around it left bound.
 *
 * The dedupe holds one reference, and a caller is free to set a material between two replays —
 * the mirror does, since it draws its own water. Carrying the standing material across a call
 * would paint the second replay's first run with whatever the frame set in between, which is a
 * wrong picture rather than a slow one.
 */
test('binds a replayed material again when something else moved it in between', () => {
  const { canvas } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({}));
  const gl = (renderer as unknown as { gl: WebGL2RenderingContext }).gl;
  const mesh = new Mesh(gl, GEOMETRY);
  const stone = { roughnessScale: 0.8 };
  const water = { roughnessScale: 0.05 };

  renderer.beginFrame([0, 0, 0]);
  renderer.drawSceneCasters((sink) => sink.mesh(mesh, mat4.create(), stone));
  renderer.setMaterial(water);
  renderer.drawMesh(mesh, mat4.create());

  const binds = vi.spyOn(renderer, 'setMaterial');
  renderer.drawSceneCasters((sink) => sink.mesh(mesh, mat4.create(), stone));

  expect(binds.mock.calls.length, 'the second replay bound its own material back').toBe(1);
});

/**
 * **The black page this whole budget exists for.**
 *
 * `flat` at the engine's own budget declares 440 rows of the fragment uniform grid and an Adreno
 * 740 offers 256, so the program did not link, `compileProgram` threw out of this constructor, and
 * a game that awaited `createRenderer` got no renderer, no reason and no frame. Reported from
 * outside exactly that way, with the splash covering the first second of it.
 *
 * The device numbers here are the reported ones, and what is asserted is that the renderer is
 * *built* — the fit is not a preference, it is the difference between a frame and a page's
 * background colour.
 */
test('builds on a part whose fragment uniform grid cannot hold the full light budget', () => {
  const { canvas } = recordingGl({ fragmentUniformVectors: 256, refuseLinkAbove: 256 });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  const renderer = new Renderer(canvas, resolveRenderQuality({}));

  expect(renderer.shadedLights, 'shrunk to fit the part rather than refusing it').toBeLessThan(16);
  expect(warn.mock.calls.join(' '), 'and said so').toContain('fragment uniform vectors');
  warn.mockRestore();
});

/**
 * The half of the fix a consumer could not have written: the feature survives the fit.
 *
 * `pointShadows: false` was the only lever there was, and it pays a whole feature on every part
 * under 440 — while still not reaching a conforming 224-vector device, because the lit path
 * without point shadows is 248. Sizing the arrays keeps the shadows and fits the part.
 */
test('keeps point shadows compiled in on the part that could not link the full shader', () => {
  const { canvas } = recordingGl({ fragmentUniformVectors: 256, refuseLinkAbove: 256 });
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  const renderer = new Renderer(canvas, resolveRenderQuality({}));

  expect(renderer.quality.pointShadows, 'the feature was not what got paid').toBe(true);
  expect(renderer.sampledShadowLights, 'and it samples every slot the shader declares').toBe(
    renderer.shadedLights,
  );
  vi.restoreAllMocks();
});

/** A device with room is left alone, so nothing above pays for the device below it. */
test('keeps the full light budget on a part with room for it', () => {
  const { canvas } = recordingGl();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  const renderer = new Renderer(canvas, resolveRenderQuality({}));

  expect(renderer.shadedLights).toBe(16);
  expect(renderer.shadedAreaLights).toBe(4);
  expect(warn.mock.calls.join(' ')).not.toContain('fragment uniform vectors');
  warn.mockRestore();
});

/**
 * **A driver that refuses more than it admits, which the arithmetic alone cannot catch.**
 *
 * `countUniformVectors` is an upper bound over the source — Appendix A lets an implementation pack
 * loose scalars together and it charges a row each — so the plan can pass a build that the driver
 * still refuses. Here the part reports 4096 and enforces 256: the count says the full budget fits,
 * the link says otherwise, and the renderer has to ask for less rather than propagate.
 */
test('steps down and builds when the link is refused by a device that reported room', () => {
  const { canvas } = recordingGl({ fragmentUniformVectors: 4096, refuseLinkAbove: 256 });
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  const renderer = new Renderer(canvas, resolveRenderQuality({}));

  expect(renderer.shadedLights, 'the refusal was answered with a smaller shader').toBeLessThan(16);
  vi.restoreAllMocks();
});

/**
 * And when there is nothing left to give up, it is a sentence rather than a stack.
 *
 * The report's second ask: a link failure that "would turn this class of failure from a black page
 * into a sentence". A device this small is not one anybody ships to — the point is that the
 * message carries the device's own numbers and the driver's own words, both of which a packaged
 * build with no developer tools cannot otherwise report.
 */
test('says what the device offered when no light budget will link at all', () => {
  const { canvas } = recordingGl({ fragmentUniformVectors: 8, refuseLinkAbove: 8 });
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  expect(() => new Renderer(canvas, resolveRenderQuality({}))).toThrow(
    /reports 8 fragment uniform vectors/,
  );
  expect(() => new Renderer(canvas, resolveRenderQuality({}))).toThrow(
    /MAX_FRAGMENT_UNIFORM_VECTORS/,
  );
  vi.restoreAllMocks();
});

/** A consumer that names its own ceiling gets it, on a device that had room for more. */
test('honours a light budget the consumer asked for', () => {
  const { canvas } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({ maxLights: 6, maxAreaLights: 2 }));

  expect(renderer.shadedLights).toBe(6);
  expect(renderer.shadedAreaLights).toBe(2);
});

/**
 * **A froxel record cannot name a shadow slot the shader does not declare.**
 *
 * The clustered arm reads a light's shadow slot out of the table rather than from the loop counter,
 * so a build with fewer slots than the engine's own budget can be handed one past the end of the
 * shadow arrays — undefined in GLSL, and arriving as a picture rather than an error. The shader
 * guards the read; this is the other half, and the cheaper one: the binner is told what the shader
 * was built at, so the record says "no shadow" instead of pointing somewhere it should not.
 *
 * Read off the table the renderer uploads rather than from a spy, so what is asserted is the bytes
 * the GPU would have been given.
 */
function shadowSlotsInUploadedTable(vectors: number): number[] {
  const { canvas, calls } = recordingGl({
    fragmentUniformVectors: vectors,
    refuseLinkAbove: vectors,
  });
  const renderer = new Renderer(canvas, resolveRenderQuality({ clusteredLights: true }));
  const environment = createEnvironment({ lightCount: 12 });
  for (let light = 0; light < 12; light++) {
    /* Spread along x and given a radius, so every one of them is a real light to bin. */
    environment.lightPositions[light * 3] = light * 2;
    environment.lightRadii[light] = 4;
  }

  const camera = new Camera();
  camera.updateMatrices(16 / 9);
  renderer.beginFrame([0, 0, 0]);
  renderer.bindMeshPass(camera, environment);

  const upload = calls.filter((call) => call.name === 'texSubImage2D').at(-1);
  const table = upload?.args.at(-1) as Uint32Array | undefined;
  if (table === undefined) throw new Error('the cluster table was never uploaded');
  const slots: number[] = [];
  const asFloat = new Float32Array(1);
  const asUint = new Uint32Array(asFloat.buffer);
  for (let light = 0; light < 12; light++) {
    asUint[0] = table[light * LIGHT_TEXELS * 4 + LIGHT_RECORD.shadowSlot] ?? 0;
    slots.push(asFloat[0] ?? 0);
  }
  return slots;
}

test('gives a clustered light no shadow slot once the shader has stopped declaring one', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const clamped = shadowSlotsInUploadedTable(256);
  vi.restoreAllMocks();

  expect(clamped.slice(0, 8), 'the slots the shader declares are named').toEqual([
    0, 1, 2, 3, 4, 5, 6, 7,
  ]);
  expect(clamped.slice(8), 'and the ones past them are not').toEqual([-1, -1, -1, -1]);
});

test('names every slot on a part with room for the full budget', () => {
  const roomy = shadowSlotsInUploadedTable(4096);
  expect(roomy).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

/**
 * **A pane refracts under order-independent transparency as it does under sorted blending.**
 *
 * The replay passed a pane's refraction along, and the pane still came out flat paint: the copy it
 * reads was taken at the first refracting draw of the replay, and taking it puts the scene's own
 * framebuffer back as the one being drawn into — so that pane went into the scene rather than the
 * transparency buffer. Measured on the refraction rig, 2026-09-19: the boundary behind a clear pane
 * at 6 with sorted blending and at -1, no bars at all, with the effect on. The copy is taken as the
 * replay begins, from the finished opaque frame, as the other backend takes it.
 */
test('replays a refracting pane into the transparency buffers, never into the scene', () => {
  const { gl, canvas, calls } = recordingGl({ extensions: ['EXT_color_buffer_float'] });
  const renderer = new Renderer(
    canvas,
    resolveRenderQuality({ screenEffects: true, orderIndependent: true }),
  );
  const mesh = new Mesh(gl, GEOMETRY);
  renderer.beginFrame([0, 0, 0]);
  renderer.drawMesh(mesh, mat4.create());
  renderer.drawTranslucentMesh(mesh, mat4.create(), 0.5, { refraction: 0.5 });
  const start = calls.length;
  renderer.endFrame();

  const oit = (renderer as unknown as { oit: { accumFbo: unknown; revealFbo: unknown } }).oit;
  let bound: unknown = null;
  let inside = false;
  let astray = 0;
  let replayed = 0;
  for (const call of calls.slice(start)) {
    if (call.name === 'bindFramebuffer' && call.args[0] !== gl.READ_FRAMEBUFFER) {
      bound = call.args[1];
      if (bound === oit.accumFbo) inside = true;
      if (bound === null) inside = false;
    }
    if (inside && call.name === 'drawElements') {
      replayed += 1;
      if (bound !== oit.accumFbo && bound !== oit.revealFbo) astray += 1;
    }
  }
  expect(replayed, 'the pane is replayed into both buffers').toBe(2);
  expect(astray, 'and never into anything else').toBe(0);
});

/*
 * A threshold is in scene units and exposure is applied after it, so one fixed at construction is a
 * different brightness on screen at every exposure. The twin of the WebGPU test of the same name.
 */
test('A FRAME MAY MOVE THE BLOOM THRESHOLD, AND IT HOLDS UNTIL MOVED AGAIN', () => {
  const { canvas } = recordingGl({ extensions: ['EXT_color_buffer_float'] });
  const renderer = new Renderer(
    canvas,
    resolveRenderQuality({ hdrScene: true, bloom: 1, bloomThreshold: 2 }),
  );
  const run = vi.spyOn(BloomPass.prototype, 'run');
  const frame = (): number | undefined => {
    run.mockClear();
    renderer.beginFrame([0, 0, 0]);
    renderer.endFrame();
    return run.mock.calls[0]?.[3];
  };
  try {
    expect(frame(), "the profile's own, until a frame says otherwise").toBe(2);
    renderer.setBloom(1, 0.25);
    expect(frame()).toBe(0.25);
    renderer.setBloom(0.5);
    expect(frame(), 'a scale alone leaves the threshold where it was').toBe(0.25);
  } finally {
    run.mockRestore();
  }
});

/*
 * **`dispose` deletes every GL object the renderer made.** It was a list written by hand beside a
 * constructor that kept growing, and at the default profile it released three textures of seven,
 * no framebuffer of four, one program short of eleven and no vertex array at all: the scene target
 * and its bloom, three shadow maps, the mirror and the point shadows were never disposed, and a page
 * that swaps renderers leaked every one of them each time. Counted per kind, at two profiles, so
 * the next object added cannot be forgotten the same way.
 */
test('DISPOSE DELETES EVERY GL OBJECT THE RENDERER MADE, at the default profile and a full one', () => {
  const profiles = [
    {},
    {
      reflectionProbeSize: 64,
      hdrScene: true,
      bloom: 0.5,
      ambientOcclusion: 0.5,
      pointShadows: true,
    },
  ];
  for (const profile of profiles) {
    const { canvas, calls } = recordingGl({ extensions: ['EXT_color_buffer_float'] });
    const renderer = new Renderer(canvas, resolveRenderQuality(profile));
    const before = calls.length;
    renderer.dispose();
    for (const kind of [
      'Program',
      'Texture',
      'Framebuffer',
      'Renderbuffer',
      'Buffer',
      'VertexArray',
    ]) {
      const made = calls.slice(0, before).filter((call) => call.name === `create${kind}`).length;
      const gone = calls.slice(before).filter((call) => call.name === `delete${kind}`).length;
      expect(gone, `${kind}s at ${JSON.stringify(profile)}`).toBe(made);
    }
  }
});

/*
 * **A cutout caster casts through the cutout depth program; an opaque one never does.** Found by
 * a leaf card throwing a solid rectangle: the depth pass had no alpha test, so every cutout cast its
 * whole quad. The program is identified by its fragment source, which reads the cutout map.
 */
test('A CUTOUT CASTER DRAWS ITS SHADOW THROUGH THE CUTOUT PROGRAM, AND AN OPAQUE ONE DOES NOT', () => {
  const { canvas, calls } = recordingGl({ extensions: ['EXT_color_buffer_float'] });
  const renderer = new Renderer(canvas, resolveRenderQuality({}));
  const mesh = renderer.createMesh({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
    colors: new Float32Array(9).fill(1),
    emissive: new Float32Array(3),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
  });
  const leaf = renderer.createSurfaceTexture({ width: 4, height: 4 } as unknown as TexImageSource);

  /* Every program's fragment source, from the shaders the recording saw attached to it. */
  const source = new Map<unknown, string>();
  for (const call of calls)
    if (call.name === 'shaderSource') source.set(call.args[0], String(call.args[1]));
  const fragmentOf = new Map<unknown, string>();
  for (const call of calls) {
    if (call.name !== 'attachShader') continue;
    const text = source.get(call.args[1]) ?? '';
    if (
      text.includes('gl_FragCoord') ||
      text.includes('precision highp float;\nin vec4 vLightPosition')
    ) {
      fragmentOf.set(call.args[0], text);
    }
  }
  /** Draws issued while the bound program was a cutout one, and while it was not. */
  const drawsBy = (from: number) => {
    let cutout = false;
    const tally = { cutout: 0, plain: 0 };
    for (const call of calls.slice(from)) {
      if (call.name === 'useProgram')
        cutout = (fragmentOf.get(call.args[0]) ?? '').includes('uCutoutMap');
      if (call.name === 'drawElements' || call.name === 'drawArrays')
        tally[cutout ? 'cutout' : 'plain']++;
    }
    return tally;
  };

  const light = mat4.create();
  const model = mat4.create();
  let before = calls.length;
  renderer.beginShadowPass(light, 'static');
  renderer.drawShadowCasters((sink) => sink.mesh(mesh, model, { albedo: leaf, cutout: 0.5 }));
  renderer.endShadowPass();
  expect(drawsBy(before)).toEqual({ cutout: 1, plain: 0 });

  before = calls.length;
  renderer.beginShadowPass(light, 'static');
  renderer.drawShadowCasters((sink) => sink.mesh(mesh, model, { albedo: leaf, cutout: 0 }));
  renderer.endShadowPass();
  expect(drawsBy(before)).toEqual({ cutout: 0, plain: 1 });
});

/**
 * A two-sided surface culls nothing, in the colour pass and in the shadow pass alike, and hands
 * culling back after its own draw. WebGL2 toggles it around the draw where the other backend bakes
 * it into a pipeline; the next draw is one-sided far more often than not, and inherits the state.
 */
test('A TWO-SIDED DRAW TURNS CULLING OFF AROUND ITSELF, and a one-sided draw leaves it alone', () => {
  const CULL_FACE = 0x0b44;
  const { canvas, calls } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({}));
  const gl = (renderer as unknown as { gl: WebGL2RenderingContext }).gl;
  const mesh = new Mesh(gl, GEOMETRY);
  /* The cull toggles each draw is wrapped in, read back out of the call log. */
  const around = (draw: () => void): string[] => {
    const start = calls.length;
    draw();
    return calls
      .slice(start)
      .filter(
        (call) =>
          call.name === 'drawElements' ||
          ((call.name === 'enable' || call.name === 'disable') && call.args[0] === CULL_FACE),
      )
      .map((call) => call.name);
  };

  renderer.beginFrame([0, 0, 0]);
  renderer.setMaterial({ doubleSided: true });
  expect(around(() => renderer.drawMesh(mesh, mat4.create()))).toEqual([
    'disable',
    'drawElements',
    'enable',
  ]);
  renderer.setMaterial({});
  expect(around(() => renderer.drawMesh(mesh, mat4.create()))).toEqual(['drawElements']);

  renderer.beginShadowPass(mat4.create(), 'static');
  expect(
    around(() =>
      renderer.drawShadowCasters((sink) => sink.mesh(mesh, mat4.create(), { doubleSided: true })),
    ),
  ).toEqual(['disable', 'drawElements', 'enable']);
  expect(
    around(() => renderer.drawShadowCasters((sink) => sink.mesh(mesh, mat4.create(), {}))),
  ).toEqual(['drawElements']);
  renderer.endShadowPass();
});

/**
 * Eye adaptation on this backend: metered in the composite when asked, easing frame to frame, and
 * snapped by a cut. The harness names no uniform, so the blend is read where it is written: the
 * first float uploaded after the adaptation's one-texel viewport.
 */
test('EYE ADAPTATION METERS THE SCENE WHEN ASKED, eases frame to frame, and a cut snaps it', () => {
  const { canvas, calls } = recordingGl({ extensions: ['EXT_color_buffer_float'] });
  const renderer = new Renderer(
    canvas,
    resolveRenderQuality({ screenEffects: true, hdrScene: true }),
  );
  const frame = (): { name: string; args: unknown[] }[] => {
    const start = calls.length;
    renderer.beginFrame([0, 0, 0]);
    renderer.endFrame();
    return calls.slice(start);
  };
  const blendOf = (frameCalls: { name: string; args: unknown[] }[]): unknown => {
    const at = frameCalls.findIndex(
      (call) => call.name === 'viewport' && call.args[2] === 1 && call.args[3] === 1,
    );
    if (at < 0) return undefined;
    return frameCalls.slice(at).find((call) => call.name === 'uniform1f')?.args[1];
  };

  expect(blendOf(frame()), 'nothing is metered until it is asked for').toBeUndefined();
  renderer.setAutoExposure(1, 1 / 60);
  expect(blendOf(frame()), 'nothing held yet: the first frame snaps').toBe(1);
  /* 1 - e^(-1.5 / 60) = 0.024690. */
  expect(blendOf(frame())).toBeCloseTo(0.02469, 5);
  renderer.cameraCut();
  expect(blendOf(frame()), 'a cut is a new shot, metered afresh').toBe(1);
  renderer.setAutoExposure(0, 1 / 60);
  expect(blendOf(frame())).toBeUndefined();
});

/**
 * Local exposure on this backend: its grid is drawn beside the meter when asked, and the eye's held
 * brightness is kept whether or not the frame as a whole adapts, because each region is moved
 * relative to it. The grid is found by its viewport: a block of tiles a band and one of means.
 */
test('LOCAL EXPOSURE DRAWS ITS GRID WHEN ASKED, with or without the eye adapting', () => {
  const { canvas, calls } = recordingGl({ extensions: ['EXT_color_buffer_float'] });
  const renderer = new Renderer(
    canvas,
    resolveRenderQuality({ screenEffects: true, hdrScene: true }),
  );
  const viewports = (): string[] => {
    const start = calls.length;
    renderer.beginFrame([0, 0, 0]);
    renderer.endFrame();
    return calls
      .slice(start)
      .filter((call) => call.name === 'viewport')
      .map((call) => `${String(call.args[2])}x${String(call.args[3])}`);
  };

  expect(viewports(), 'nothing is measured until it is asked for').not.toContain('352x32');
  renderer.setLocalExposure(0.5);
  const on = viewports();
  expect(on, 'the grid, 32 tiles by 11 blocks').toContain('352x32');
  expect(on, 'and the held brightness it is relative to').toContain('1x1');
  renderer.setLocalExposure(0);
  expect(viewports()).not.toContain('352x32');
});

/**
 * **The peel is sampled where a pass filled it, not wherever the map exists**, which is the rule
 * the other backend has held since its peel landed and this one did not.
 *
 * The map existing was taken to be enough because a GL texture was thought to be born reading as
 * the far plane. It is born zeroed, and a zero is an occluder at the light: a scene that allocates a
 * second depth layer and never peels it had no sun at all under ANGLE's GL backend while the other
 * backend, sampling nothing, drew it lit. Both backends now decide the same way, and a scene that
 * stops peeling stops paying for the fetch the same frame.
 */
test('THE PEEL IS SAMPLED ONLY WHERE A PASS FILLED IT, as on the other backend', () => {
  const { canvas, calls } = recordingGl({
    extensions: ['EXT_color_buffer_float'],
    uniforms: ['uPeeledShadowEnabled'],
  });
  const renderer = new Renderer(canvas, resolveRenderQuality({ directionalShadowDepthLayers: 2 }));
  const env = createEnvironment();
  const camera = new Camera();
  camera.updateMatrices(16 / 9);
  const peelFlag = (layers: readonly ('static' | 'static-peel' | 'dynamic')[]): unknown => {
    for (const layer of layers) {
      renderer.beginShadowPass(mat4.create(), layer);
      renderer.endShadowPass();
    }
    const start = calls.length;
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    const uploads = calls
      .slice(start)
      .filter(
        (call) =>
          call.name === 'uniform1i' &&
          (call.args[0] as { name?: string } | null)?.name === 'uPeeledShadowEnabled',
      );
    expect(uploads.length, 'the lit programs are told').toBeGreaterThan(0);
    return uploads.at(-1)?.args[1];
  };

  expect(peelFlag(['static']), 'a frame that drew only the first layer').toBe(0);
  expect(peelFlag(['static', 'static-peel', 'dynamic']), 'the movers draw after the peel').toBe(1);
  expect(peelFlag(['static']), 'and the next frame that does not peel samples none').toBe(0);
});

/**
 * **A fragment stage doing thirty-two-bit integer work says so, because GLSL ES does not.**
 *
 * The fragment language's default precision for `int` and `uint` is mediump, and `precision
 * highp float` says nothing about either. Mediump promises sixteen bits, and a driver that
 * actually computes in sixteen bits is entitled to: Mesa's does, and so ANGLE's GL backend on
 * Linux does, and so do the phones that run mediump at half width. Measured there against ANGLE on
 * Vulkan, which ignores the qualifier: the Hammersley radical inverse came back 0 for every sample,
 * so every cosine sample of a probe's diffuse level collapsed onto its normal; and the clustered
 * lights, decoded from `uintBitsToFloat` of texels that arrive as `uvec4`, lit nothing at all — a
 * courtyard of braziers at night with no firelight on a single stone.
 *
 * So any fragment source using an unsigned type, a shift, a bitwise operator, a bit cast or an
 * integer sampler must declare `precision highp int`, read off every program this backend builds
 * at a profile that builds nearly all of them.
 */
test('EVERY FRAGMENT STAGE DOING BIT ARITHMETIC DECLARES HIGHP INT, or a sixteen-bit driver truncates it', () => {
  const recording = recordingGl({ extensions: ['EXT_color_buffer_float'] });
  const renderer = new Renderer(
    recording.canvas,
    resolveRenderQuality({
      reflectionProbeSize: 64,
      environmentPrefilter: true,
      hdrScene: true,
      screenEffects: true,
      bloom: 0.5,
      ambientOcclusion: 0.5,
      pointShadows: true,
      clusteredLights: true,
      globalMediumSteps: 16,
    }),
  );
  /* The probe prefilter is built with the grid, and the medium with its first frame of air. */
  renderer.setProbeGrid({ origin: [0, 0, 0], spacing: [1, 1, 1], counts: [2, 1, 1] });
  renderer.setGlobalMedium(0.05);
  const camera = new Camera();
  camera.updateMatrices(16 / 9);
  renderer.beginFrame([0, 0, 0]);
  renderer.bindMeshPass(camera, createEnvironment());
  renderer.endFrame();
  /* Without the comments, whose prose is full of carets and bars that are not operators. */
  const fragments = recording.calls
    .filter((call) => call.name === 'shaderSource')
    .map((call) => String(call.args[1]))
    .filter((source) => !/gl_Position\s*=/.test(source))
    .map((source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''));
  const integerWork =
    /\buint\b|\buvec[234]\b|\b[iu]sampler\w*|<<|>>|BitsTo(?:Float|Int|Uint)\b|[^&]&[^&=]|[^|]\|[^|=]|\^/;
  const offenders = fragments
    .filter((source) => integerWork.test(source) && !source.includes('precision highp int;'))
    .map((source) => /void main\(\)[\s\S]{0,120}/.exec(source)?.[0].replace(/\s+/g, ' ') ?? '');
  expect(fragments.length, 'the programs were recorded').toBeGreaterThan(10);
  expect(offenders).toEqual([]);
});

/*
 * **A pane drawn into a probe's face takes no copy of the frame.** The copy is of the frame being
 * drawn to the screen, not of the face, so a pane showing it would show the wrong picture — and
 * taking it rebound the scene's framebuffer in the middle of the bake, which broke the whole frame
 * on the first scene to put glass in front of its probes. WebGPU has refused here since refraction
 * existed (`takeRefractSnapshot`); this backend now makes the same decision.
 */
test('A PANE IN A PROBE FACE TAKES NO COPY OF THE FRAME, and the same pane outside the bake does', () => {
  const { gl, canvas, calls } = recordingGl({ extensions: ['EXT_color_buffer_float'] });
  const renderer = new Renderer(
    canvas,
    resolveRenderQuality({ screenEffects: true, reflectionProbeSize: 64 }),
  );
  const mesh = new Mesh(gl, GEOMETRY);
  const glass = { glass: { transmission: 0.9, frost: 0.5 } };
  const COLOR_BUFFER_BIT = 0x4000;
  const copies = (from: number): number =>
    calls
      .slice(from)
      .filter((call) => call.name === 'blitFramebuffer' && call.args[8] === COLOR_BUFFER_BIT)
      .length;

  renderer.beginFrame([0, 0, 0]);
  const baking = calls.length;
  const baked = renderer.bakeReflectionProbe([0, 1, 0], [0, 0, 0], () => {
    renderer.drawTranslucentMesh(mesh, mat4.create(), 1, glass);
  });
  expect(baked, 'the bake must have run, or this asserts nothing').toBe(true);
  expect(copies(baking), 'no copy inside the bake').toBe(0);

  const framing = calls.length;
  renderer.drawTranslucentMesh(mesh, mat4.create(), 1, glass);
  expect(copies(framing), 'the control: a pane in the frame takes one').toBe(1);
});

/*
 * **A double-sided material is drawn from both sides whichever path draws it.** The mesh paths
 * switched culling off for one and the instanced path did not, so every double-sided part the file
 * places many times — a lantern's panes, one quad drawn four times — lost its far side on this
 * backend alone, since WebGPU's pipeline culls by the same flag for both. The pane behind a
 * lantern's open bottom was simply absent here and drawn there.
 */
test('A DOUBLE-SIDED MATERIAL DRAWS BOTH SIDES OF AN INSTANCED BATCH, as it does of a mesh', () => {
  const { gl, canvas, calls } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({}));
  const mesh = new Mesh(gl, GEOMETRY);
  const batch = renderer.createInstanced(mesh, 4);
  const data = createMeshInstances(4);
  data.count = 4;
  renderer.uploadInstanced(batch, data);
  const CULL_FACE = 0x0b44;
  /** Whether culling was off at the moment the draw named by `name` was issued. */
  const drewUnculled = (from: number, name: string): boolean => {
    let culled = true;
    for (const call of calls.slice(from)) {
      if (call.args[0] === CULL_FACE && call.name === 'disable') culled = false;
      if (call.args[0] === CULL_FACE && call.name === 'enable') culled = true;
      if (call.name === name) return !culled;
    }
    throw new Error(`no ${name} was issued, so this asserts nothing`);
  };

  renderer.beginFrame([0, 0, 0]);
  renderer.setMaterial({ doubleSided: true });
  const meshAt = calls.length;
  renderer.drawMesh(mesh, mat4.create());
  expect(drewUnculled(meshAt, 'drawElements'), 'the control: a mesh').toBe(true);

  const batchAt = calls.length;
  renderer.drawInstanced(batch, data);
  expect(drewUnculled(batchAt, 'drawElementsInstanced'), 'an instanced batch').toBe(true);

  const glassAt = calls.length;
  renderer.drawTranslucentInstanced(batch, data, 1);
  expect(drewUnculled(glassAt, 'drawElementsInstanced'), 'and a blended one').toBe(true);
});

/*
 * **A see-through batch takes a material of its own, as a see-through mesh does.** Both backends
 * count material changes by one rule (`materialChanges.ts`), and a draw that refracts or is glass
 * differs from the pass. The instanced path here still said an instanced draw does not refract after
 * it had learned to, so a batch of panes was one material change on WebGPU and none here.
 */
test('A GLASS BATCH COUNTS ITS MATERIAL CHANGE AS A GLASS MESH DOES', () => {
  const { gl, canvas } = recordingGl({ extensions: ['EXT_color_buffer_float'] });
  const renderer = new Renderer(canvas, resolveRenderQuality({ screenEffects: true }));
  const mesh = new Mesh(gl, GEOMETRY);
  const batch = renderer.createInstanced(mesh, 4);
  const data = createMeshInstances(4);
  data.count = 4;
  renderer.uploadInstanced(batch, data);
  const glass = { glass: { transmission: 0.9, frost: 0.5 } };
  const materials = (): number =>
    renderer.frameBudget.lines.find((line) => line.name === 'materials')?.used ?? -1;

  renderer.beginFrame([0, 0, 0]);
  renderer.drawMesh(mesh, mat4.create());
  const before = materials();
  renderer.drawTranslucentMesh(mesh, mat4.create(), 1, glass);
  const forMesh = materials() - before;
  expect(forMesh, 'the control: a glass mesh takes one').toBeGreaterThan(0);

  /* An ordinary draw first, so the batch starts from an open material as the mesh did: the glass
     mesh leaves the material dirty behind it, and a batch drawn straight after takes one anyway. */
  renderer.drawMesh(mesh, mat4.create());
  const between = materials();
  renderer.drawTranslucentInstanced(batch, data, 1, glass);
  expect(materials() - between, 'and a glass batch takes the same').toBe(forMesh);
});

/*
 * **A glass caster is kept aside, and only when glass shadows are on.** It never reaches the opaque
 * depth — Glass A's rule — and since Glass B it waits in a list for the passes that draw where the
 * nearest pane is and what the panes let through. With the option off it is dropped, exactly as
 * before glass shadows existed.
 */
test('A GLASS CASTER IS KEPT ASIDE FOR ITS OWN PASSES, and dropped when glass shadows are off', () => {
  for (const glassShadows of ['full', 'off'] as const) {
    const { canvas, calls } = recordingGl();
    const renderer = new Renderer(canvas, resolveRenderQuality({ glassShadows }));
    const gl = (renderer as unknown as { gl: WebGL2RenderingContext }).gl;
    const mesh = new Mesh(gl, GEOMETRY);
    renderer.beginShadowPass(mat4.create(), 'static');
    const before = calls.length;
    renderer.drawShadowCasters((sink) => {
      sink.mesh(mesh, mat4.create());
      sink.mesh(mesh, mat4.create(), { glass: { transmission: 0.9, frost: 0.5 } });
    });
    const draws = calls.slice(before).filter((call) => call.name === 'drawElements').length;
    expect(draws, `${glassShadows}: the opaque caster alone reaches the depth`).toBe(1);
    const kept = (renderer as unknown as { glassCasters: { count: number } }).glassCasters;
    expect(kept.count, `${glassShadows}: what is kept aside`).toBe(glassShadows === 'off' ? 0 : 1);
    renderer.endShadowPass();
  }
});

/*
 * **The lit program reads glass once a pane is offered, and not before.** The lookups cost the lit
 * pass its registers on every surface whether or not anything is glass — 0.42 ms at 720p on the
 * courtyard at night — and every scene paid for them from 4.5.0. So the program is built without
 * them, and the frame after a shadow pass is first offered a pane rebuilds it with them. With glass
 * shadows off no pane is kept, and nothing is rebuilt.
 */
test('THE LIT PROGRAM READS GLASS ONCE A PANE IS OFFERED, and never with glass shadows off', () => {
  for (const glassShadows of ['full', 'half', 'off'] as const) {
    const { canvas, calls } = recordingGl();
    const renderer = new Renderer(canvas, resolveRenderQuality({ glassShadows }));
    const litSources = (from: number): string[] =>
      calls
        .slice(from)
        .filter((call) => call.name === 'shaderSource')
        .map((call) => String(call.args[1]))
        .filter((source) => source.includes('vec3 sunGlassTint('));
    const built = litSources(0);
    expect(built.length, `${glassShadows}: the lit program was compiled`).toBeGreaterThan(0);
    for (const source of built) {
      expect(source, `${glassShadows}: before any pane`).toContain(
        'const bool GLASS_SHADOWS = false;',
      );
    }

    const gl = (renderer as unknown as { gl: WebGL2RenderingContext }).gl;
    const mesh = new Mesh(gl, GEOMETRY);
    renderer.beginShadowPass(mat4.create(), 'static');
    renderer.drawShadowCasters((sink) => {
      sink.mesh(mesh, mat4.create(), { glass: { transmission: 0.9, frost: 0.5 } });
    });
    renderer.endShadowPass();
    const before = calls.length;
    renderer.beginFrame([0, 0, 0]);
    const rebuilt = litSources(before);
    if (glassShadows === 'off') {
      expect(rebuilt, 'nothing rebuilt with glass shadows off').toEqual([]);
      continue;
    }
    expect(rebuilt.length, `${glassShadows}: rebuilt at the next frame`).toBe(built.length);
    for (const source of rebuilt) {
      expect(source, glassShadows).toContain('const bool GLASS_SHADOWS = true;');
    }
  }
});

/*
 * **The sun draws its glass twice once its opaque casters are in**: into a glass depth layer, where
 * the nearest pane is, and into a tint layer, what the panes let through, multiplied and with no
 * depth test so every pane on a ray counts. The first glass the sun is offered grows its array by
 * the two glass layers and carries the maps it already holds across, so the static map the consumer
 * baked survives without being baked again.
 */
test('THE SUN DRAWS ITS GLASS TWICE, and the first glass grows its array without losing a map', () => {
  const DST_COLOR = 0x0306;
  const DST_ALPHA = 0x0304;
  const ZERO = 0;
  const DEPTH_TEST = 0x0b71;
  const { canvas, calls } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({ directionalShadowDepthLayers: 2 }));
  const gl = (renderer as unknown as { gl: WebGL2RenderingContext }).gl;
  const mesh = new Mesh(gl, GEOMETRY);
  const pane = {
    glass: { transmission: 0.9, frost: 0.5, tint: [1, 0.5, 0.25] as [number, number, number] },
  };
  const frame = (): ReturnType<typeof calls.slice> => {
    renderer.beginShadowPass(mat4.create(), 'static');
    renderer.drawShadowCasters((sink) => {
      sink.mesh(mesh, mat4.create());
      sink.mesh(mesh, mat4.create(), pane);
    });
    const at = calls.length;
    renderer.endShadowPass();
    return calls.slice(at);
  };

  const first = frame();
  const grown = first.filter(
    (call) => call.name === 'texStorage3D' && call.args[2] === gl.DEPTH_COMPONENT24,
  );
  expect(
    grown.map((call) => call.args[5]),
    'static, moving, peel, then two glass layers',
  ).toEqual([5]);
  const carried = first.filter(
    (call) => call.name === 'blitFramebuffer' && call.args[8] === gl.DEPTH_BUFFER_BIT,
  );
  expect(carried.length, 'every map already held is carried across').toBe(3);
  expect(
    first.filter((call) => call.name === 'drawElements').length,
    'one glass depth draw and one tint draw; the opaque caster is not drawn again',
  ).toBe(2);
  /* The tint's own state: a multiplying blend, no depth test, a white clear. */
  expect(
    first.some(
      (call) =>
        call.name === 'blendFuncSeparate' &&
        call.args[0] === DST_COLOR &&
        call.args[1] === ZERO &&
        call.args[2] === DST_ALPHA &&
        call.args[3] === ZERO,
    ),
  ).toBe(true);
  expect(first.some((call) => call.name === 'disable' && call.args[0] === DEPTH_TEST)).toBe(true);
  expect(first.some((call) => call.name === 'clearBufferfv')).toBe(true);

  const second = frame();
  expect(
    second.filter((call) => call.name === 'texStorage3D').length,
    'a second frame allocates nothing',
  ).toBe(0);
});

/*
 * **A lamp draws its glass into its own layers, and the lit pass is told where they are.** The first
 * face to offer glass interleaves the array — light L's depth at 2L, its glass at 2L + 1 — and every
 * index the lit pass is handed moves with it, or each light would read its neighbour's glass as its
 * own depth.
 */
test('A LAMP DRAWS ITS GLASS INTO ITS OWN LAYERS, and the lit pass reads the interleaved index', () => {
  const DST_COLOR = 0x0306;
  const { canvas, calls } = recordingGl({ uniforms: ['uPointShadowLayer[0]'] });
  const renderer = new Renderer(canvas, resolveRenderQuality({ pointShadowFacesPerFrame: 6 }));
  const gl = (renderer as unknown as { gl: WebGL2RenderingContext }).gl;
  const mesh = new Mesh(gl, GEOMETRY);
  const light = {
    x: 0,
    y: 2,
    z: 0,
    radius: 8,
    shadowNear: 0.25,
    sourceRadius: 0.05,
    castsShadow: true,
  };
  const pane = {
    glass: { transmission: 0.9, frost: 0.5, tint: [1, 0.5, 0.25] as [number, number, number] },
  };
  renderer.prepareStaticPointShadows([light]);
  const n = (renderer as unknown as { pointShadowArray: { layers: number } }).pointShadowArray
    .layers;
  calls.length = 0;
  renderer.updatePointShadows(
    [light],
    new Int32Array([0]),
    1,
    50,
    50,
    50,
    1 / 60,
    (sink) => {
      sink.mesh(mesh, mat4.create());
      sink.mesh(mesh, mat4.create(), pane);
    },
    () => undefined,
  );
  const depth = calls.filter(
    (c) => c.name === 'texStorage3D' && c.args[2] === gl.DEPTH_COMPONENT24,
  );
  expect(
    depth.map((c) => c.args[5]),
    'interleaved, once',
  ).toEqual([2 * n]);
  const tint = calls.filter((c) => c.name === 'texStorage3D' && c.args[2] === gl.RGBA8);
  expect(
    tint.map((c) => c.args.slice(3)),
    'a tint layer a light',
  ).toEqual([[1024, 1024, n]]);
  expect(
    calls.filter((c) => c.name === 'blendFuncSeparate' && c.args[0] === DST_COLOR).length,
    'six faces multiplied their glass',
  ).toBe(6);

  calls.length = 0;
  renderer.beginFrame([0, 0, 0]);
  renderer.bindMeshPass(new Camera(), createEnvironment());
  const upload = calls.find(
    (c) =>
      c.name === 'uniform1iv' &&
      (c.args[0] as { name?: string } | null)?.name === 'uPointShadowLayer[0]',
  );
  const layers = [...((upload?.args[1] ?? []) as Int32Array)];
  const pool = (
    renderer as unknown as { pointShadows: { mapForLight(i: number): { layer: number } } }
  ).pointShadows;
  expect(layers[0], 'the light at twice its own layer').toBe(2 * pool.mapForLight(0).layer);
  expect(
    layers.slice(1).every((l) => l === -1),
    'and nothing else',
  ).toBe(true);
  const live = (renderer as unknown as { resolvedPointShadows: { liveLayers: Int32Array } })
    .resolvedPointShadows.liveLayers;
  expect(
    [...live].every((l) => l === -1 || l % 2 === 0),
    'live maps at even layers too',
  ).toBe(true);
});

/*
 * **Every pane on a ray counts once, whichever way it faces**: the tint culls nothing, for the sun
 * as for a lamp, because a light crosses a pane from either side and a closed glass object has two
 * surfaces on a ray. It culled back faces for the sun, which counted one side of a closed pane.
 */
test('EVERY PANE ON A RAY COUNTS, WHICHEVER WAY IT FACES: the sun s tint culls nothing', () => {
  const CULL_FACE = 0x0b44;
  const DST_COLOR = 0x0306;
  const { canvas, calls } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({}));
  const gl = (renderer as unknown as { gl: WebGL2RenderingContext }).gl;
  const mesh = new Mesh(gl, GEOMETRY);
  renderer.beginShadowPass(mat4.create(), 'static');
  renderer.drawShadowCasters((sink) => {
    sink.mesh(mesh, mat4.create(), { glass: { transmission: 0.9, frost: 0 } });
  });
  calls.length = 0;
  renderer.endShadowPass();
  const tintState = calls.findIndex(
    (c) => c.name === 'blendFuncSeparate' && c.args[0] === DST_COLOR,
  );
  expect(tintState).toBeGreaterThanOrEqual(0);
  const draw = calls.findIndex((c, i) => i > tintState && c.name === 'drawElements');
  const culling = calls
    .slice(0, draw)
    .filter((c) => (c.name === 'enable' || c.name === 'disable') && c.args[0] === CULL_FACE)
    .at(-1);
  expect(culling?.name, 'culling is off when the pane is drawn into the tint').toBe('disable');
});

/**
 * **A material setter reaches every flat program, not only the plain one.**
 *
 * An instanced draw and a skinned one each run a program of their own, and material state has to
 * be in all of them — `setMaterial` has written every flat program since skinning landed, for that
 * reason. The scalar setters beside it wrote the plain program alone, so on this backend an
 * instanced batch drew with the pass defaults whatever the caller set: grain full, no reflection,
 * no relief. The other backend keeps material state in one block every variant reads, so the two
 * disagreed about every batch that asked for any of it, and nothing failed.
 *
 * Counted by which programs each uniform was written into, walked off the recording.
 */
test('A MATERIAL SETTER REACHES EVERY FLAT PROGRAM, so an instanced batch wears what its caller set', () => {
  /* The reflectivity and gain share `uEnvironmentDials`, relief's two numbers `uRelief`, and the
     emissive gain `uEmission`: one row each where each was a row of its own. */
  const names = [
    'uEnvironmentDials',
    'uGrain',
    'uRelief',
    'uTextureRelief',
    'uEmission',
    'uWriteMode',
    'uAmbientSH[0]',
  ];
  const { canvas, calls } = recordingGl({ uniforms: names });
  const renderer = new Renderer(canvas, resolveRenderQuality({}));
  const gl = (renderer as unknown as { gl: WebGL2RenderingContext }).gl;
  /* The instanced program is compiled on first use; a batch is what asks for it. */
  renderer.createInstanced(new Mesh(gl, GEOMETRY), 1);
  calls.length = 0;

  renderer.setSurfaceReflectivity(0.5);
  renderer.setEnvironmentGain(2);
  renderer.setSurfaceGrain(0.25);
  renderer.setSurfaceRelief(0.5, 30);
  renderer.setSurfaceTextureRelief(1.5);
  renderer.setEmissiveGain(3);
  renderer.setDitherFade(0.4);
  renderer.setAmbientSH(new Array(27).fill(0.1));

  const programsBy = new Map<string, Set<unknown>>();
  let current: unknown = null;
  for (const call of calls) {
    if (call.name === 'useProgram') current = call.args[0];
    if (!['uniform1f', 'uniform2f', 'uniform2fv', 'uniform3fv', 'uniform4fv'].includes(call.name)) {
      continue;
    }
    const name = (call.args[0] as { name?: string } | null)?.name ?? '';
    const seen = programsBy.get(name) ?? new Set<unknown>();
    seen.add(current);
    programsBy.set(name, seen);
  }
  for (const name of names) {
    expect(programsBy.get(name)?.size ?? 0, `${name} is written into both flat programs`).toBe(2);
  }
});

/**
 * **A material with no maps leaves an array bound on every surface unit, not nothing.**
 *
 * Every surface map has been a `sampler2DArray` since texture arrays landed, and a sampler reads the
 * unit's *array* target. The stand-ins stayed 2D: a material with no normal, ORM or emissive map
 * bound an empty 2D texture on a unit the shader reads as an array, and one with no albedo bound
 * nothing at all — so those samplers were incomplete, which is the state `emptyTexture.ts` records
 * page-faulting an RDNA4 card when a driver fetched the descriptor ahead of the branch that skips
 * the read.
 */
test('A MATERIAL WITH NO MAPS LEAVES AN ARRAY STAND-IN ON EVERY SURFACE UNIT', () => {
  const { canvas, calls } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({}));
  const gl = (renderer as unknown as { gl: WebGL2RenderingContext }).gl;
  calls.length = 0;
  renderer.setMaterial({ roughnessScale: 0.5 });

  const arrayOn = new Map<number, unknown>();
  let unit = 0;
  for (const call of calls) {
    if (call.name === 'activeTexture') unit = (call.args[0] as number) - gl.TEXTURE0;
    if (call.name === 'bindTexture' && call.args[0] === gl.TEXTURE_2D_ARRAY) {
      arrayOn.set(unit, call.args[1]);
    }
  }
  for (const [name, at] of [
    ['albedo', SURFACE_TEXTURE_UNIT],
    ['normal', NORMAL_TEXTURE_UNIT],
    ['ORM', ORM_TEXTURE_UNIT],
    ['emissive', EMISSIVE_TEXTURE_UNIT],
  ] as const) {
    expect(arrayOn.get(at), `the ${name} unit holds an array`).toBeTruthy();
  }
});

/**
 * **Added light fades in the medium, and this backend says so as the other does.** The shader
 * fades where `uFogEnabled` is 2 (see `drawFog.ts`): a glow mixed toward the medium and then added
 * puts the haze into the frame a second time. Each additive draw, single or instanced, writes 2 and
 * hands the pass's 1 back; an additive draw kept out of the medium writes 0.
 */
test('ADDS LIGHT THAT FADES IN THE MEDIUM, single and instanced, and puts the surface rule back', () => {
  const { gl, canvas, calls } = recordingGl({ uniforms: ['uFogEnabled'] });
  const renderer = new Renderer(canvas, resolveRenderQuality({}));
  const mesh = new Mesh(gl, GEOMETRY);
  const batch = renderer.createInstanced(mesh, 2);
  const placed = createMeshInstances(2);
  placed.count = 1;
  const camera = new Camera();
  camera.updateMatrices(16 / 9);
  renderer.beginFrame([0, 0, 0]);
  renderer.bindMeshPass(camera, createEnvironment());
  const start = calls.length;
  renderer.drawTranslucentMesh(mesh, mat4.create(), 1, { additive: true });
  renderer.drawTranslucentMesh(mesh, mat4.create(), 1, { additive: true, fog: false });
  renderer.drawTranslucentMesh(mesh, mat4.create(), 1);
  renderer.drawTranslucentInstanced(batch, placed, 1, { additive: true });
  const written = calls
    .slice(start)
    .filter(
      (call) =>
        call.name === 'uniform1i' &&
        (call.args[0] as { name?: string } | null)?.name === 'uFogEnabled',
    )
    .map((call) => call.args[1]);
  expect(written, 'faded and back, out and back, nothing, faded and back').toEqual([
    2, 1, 0, 1, 2, 1,
  ]);
});

/**
 * **The occlusion is read where the frame's jitter put it, as on the other backend.** Measured from
 * the jittered depth and applied after the temporal resolve took the jitter out, it moved by the
 * jitter every frame at every crevice. A texel stands at its index plus a half less the jitter, in
 * the drawing buffer the jitter was spread over.
 */
test('READS THE OCCLUSION A JITTER ON under the temporal resolve, and where it is without one', () => {
  const offsetOf = (temporalAa: boolean) => {
    const { gl, canvas, calls } = recordingGl({
      extensions: ['EXT_color_buffer_float'],
      uniforms: ['uAoOffset'],
    });
    const renderer = new Renderer(
      canvas,
      resolveRenderQuality({ screenEffects: true, temporalAa, ambientOcclusion: 0.5 }),
    );
    const mesh = new Mesh(gl, GEOMETRY);
    const camera = new Camera();
    camera.updateMatrices(16 / 9);
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, createEnvironment());
    renderer.drawMesh(mesh, mat4.create());
    const start = calls.length;
    renderer.endFrame();
    const written = calls
      .slice(start)
      .filter(
        (call) =>
          call.name === 'uniform2f' &&
          (call.args[0] as { name?: string } | null)?.name === 'uAoOffset',
      )
      .at(-1);
    const inner = renderer as unknown as { temporalJitterX: number; temporalJitterY: number };
    return {
      offset: [written?.args[1], written?.args[2]],
      jitter: [inner.temporalJitterX, inner.temporalJitterY],
      size: [gl.drawingBufferWidth, gl.drawingBufferHeight],
    };
  };
  const taa = offsetOf(true);
  expect(taa.jitter[0], 'a frame with a jitter to take out').not.toBe(0);
  expect(taa.offset[0]).toBeCloseTo((taa.jitter[0] as number) / (taa.size[0] as number), 9);
  expect(taa.offset[1]).toBeCloseTo((taa.jitter[1] as number) / (taa.size[1] as number), 9);
  expect(offsetOf(false).offset).toEqual([0, 0]);
});

/**
 * **An empty mesh draws nothing, here as on WebGPU.** A draw of zero indices is silent on this
 * backend, which is why it went unseen, but it was still a call and still a counted draw, and the
 * other backend now skips the same meshes: the two count the same frame. See `Mesh.indexCount`.
 */
test('AN EMPTY MESH DRAWS NOTHING, as a mesh, a translucent mesh or a batch', () => {
  const { canvas, calls } = recordingGl({ extensions: ['EXT_color_buffer_float'] });
  const renderer = new Renderer(canvas, resolveRenderQuality({}));
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
  const camera = new Camera();
  camera.updateMatrices(16 / 9);
  renderer.beginFrame([0, 0, 0]);
  renderer.bindMeshPass(camera, createEnvironment());
  const before = calls.length;
  renderer.drawMesh(empty, mat4.create());
  renderer.drawTranslucentMesh(empty, mat4.create(), 0.5);
  renderer.drawInstanced(batch, one);
  const drawn = calls
    .slice(before)
    .filter((call) => call.name === 'drawElements' || call.name === 'drawElementsInstanced');
  expect(drawn.length, 'nothing is drawn').toBe(0);
});

/*
 * **A view model is drawn into the nearest sliver of depth, and the range is handed back.** A first
 * person's arms and weapon must not go into the wall they are pushed against, and clearing depth to
 * draw them over it costs every pass that reads depth afterwards. Reported from a game that squeezed
 * the depth itself through a camera of its own, for want of a pass. Here the context has no
 * `EXT_clip_control`, so it draws conventional depth and the near end is 0.
 */
test('a view model squeezes its depth into the near end of the range, and hands it back', () => {
  const { canvas, calls } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({}));
  const ranges = (): unknown[][] =>
    calls.filter((call) => call.name === 'depthRange').map((call) => call.args);

  renderer.beginViewModel();
  expect(ranges().at(-1)).toEqual([0, 0.01]);
  renderer.endViewModel();
  expect(ranges().at(-1)).toEqual([0, 1]);
});

test('reversed depth puts the view model at the top of the range', () => {
  const { canvas, calls } = recordingGl({ extensions: ['EXT_clip_control'] });
  const renderer = new Renderer(canvas, resolveRenderQuality({}));
  expect(renderer.reversedDepth, 'this context must really be reversed').toBe(true);

  renderer.beginViewModel(0.05);
  const last = calls.filter((call) => call.name === 'depthRange').at(-1)?.args ?? [];
  expect(last[0]).toBeCloseTo(0.95, 6);
  expect(last[1]).toBe(1);
});

/**
 * **A garment's draw is placed by its cloth and reads this frame's particles; the draw after it is
 * skinned alone.** The twin of the WebGPU test of the same name. Two frames, so the swap is watched:
 * the particle unit holds the texture the update just wrote, a different one each frame.
 */
test("A GARMENT DRAW READS THIS FRAME'S PARTICLES, AND THE DRAW AFTER IT NONE", () => {
  const { gl, canvas, calls } = recordingGl();
  const renderer = new Renderer(canvas, resolveRenderQuality({}));
  const mesh = new Mesh(gl, {
    ...GEOMETRY,
    joints: new Float32Array(12),
    weights: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
  });
  const binding = renderer.createClothBinding(mesh, {
    triangles: new Uint32Array([0, 0, 0, 1, 1, 1, 2, 2, 2]),
    coordinates: new Float32Array(6),
    offsets: new Float32Array(3),
    weights: new Float32Array([1, 1, 1]),
    rest: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  });
  const particles = renderer.createClothParticles(3);
  const camera = new Camera();
  camera.updateMatrices(16 / 9);
  const written: unknown[] = [];

  for (let frame = 0; frame < 2; frame++) {
    renderer.updateClothParticles(particles, new Float32Array(9).fill(frame));
    written.push(calls.filter((call) => call.name === 'bindTexture').at(-2)?.args[1]);
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, createEnvironment());
    renderer.setSkinPalette(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
    const start = calls.length;
    renderer.setCloth(binding, particles);
    renderer.drawMesh(mesh, mat4.create());
    renderer.setCloth(null);
    renderer.drawMesh(mesh, mat4.create());

    /* Each draw's program, by the vertex source attached to it, and the particle unit's texture. */
    const vertexOf = new Map<unknown, string>();
    const sourceOf = new Map<unknown, string>();
    let program: unknown = null;
    let unit = 0;
    let particleUnit: unknown = null;
    const draws: { cloth: boolean; particles: unknown }[] = [];
    for (const [k, call] of calls.entries()) {
      if (call.name === 'shaderSource') sourceOf.set(call.args[0], String(call.args[1]));
      if (call.name === 'attachShader') {
        const source = sourceOf.get(call.args[1]) ?? '';
        if (!source.includes('gl_FragColor') && source.includes('gl_Position')) {
          vertexOf.set(call.args[0], source);
        }
      }
      if (k < start) continue;
      if (call.name === 'useProgram') program = call.args[0];
      if (call.name === 'activeTexture') unit = (call.args[0] as number) - gl.TEXTURE0;
      if (call.name === 'bindTexture' && unit === CLOTH_PARTICLES_TEXTURE_UNIT) {
        particleUnit = call.args[1];
      }
      if (call.name === 'drawElements') {
        const vertex = vertexOf.get(program) ?? '';
        draws.push({
          cloth: vertex.includes('const bool CLOTH_BOUND = true;'),
          particles: particleUnit,
        });
      }
    }
    expect(
      draws.map((draw) => draw.cloth),
      `frame ${frame}`,
    ).toEqual([true, false]);
    expect(draws[0]?.particles, `frame ${frame}: the particles just written`).toBe(written[frame]);
    renderer.endFrame();
  }
  expect(written[0], 'the second update writes the other texture').not.toBe(written[1]);
});

/**
 * **A material's model draws through that model's program, and the next material back through the
 * standard one** — the twin of the WebGPU test of the same name. Read off the draw calls in order:
 * each draw's program, by the fragment source attached to it, and the `uModelParams` it was handed.
 */
test("A MATERIAL'S MODEL CHOOSES THE PROGRAM, AND AN EYE'S AXIS IS EACH DRAW'S", () => {
  const { gl, canvas, calls } = recordingGl({ uniforms: ['uModelParams'] });
  const renderer = new Renderer(canvas, resolveRenderQuality({}));
  const mesh = new Mesh(gl, GEOMETRY);
  const camera = new Camera();
  camera.updateMatrices(16 / 9);
  renderer.beginFrame([0, 0, 0]);
  renderer.bindMeshPass(camera, createEnvironment());

  const fragmentOf = new Map<unknown, string>();
  const sourceOf = new Map<unknown, string>();
  let program: unknown = null;
  let read = 0;
  /*
   * The draw's program and the numbers it was last handed, read **straight after the draw**: the
   * renderer uploads from one scratch array, which the recording keeps by reference, so the next
   * material's numbers would overwrite these if they were read at the end.
   */
  const lastDraw = (): { model: string; params: number[] } => {
    let params: number[] = [];
    let drawn = { model: 'none', params };
    for (; read < calls.length; read++) {
      const call = calls[read] as (typeof calls)[number];
      if (call.name === 'shaderSource') sourceOf.set(call.args[0], String(call.args[1]));
      if (call.name === 'attachShader') {
        const source = sourceOf.get(call.args[1]) ?? '';
        if (source.includes('outColor')) fragmentOf.set(call.args[0], source);
      }
      if (call.name === 'useProgram') program = call.args[0];
      if (
        call.name === 'uniform4fv' &&
        (call.args[0] as { name?: string } | null)?.name === 'uModelParams'
      ) {
        params = Array.from(call.args[1] as Float32Array, (v) => Math.round(v * 1e6) / 1e6);
      }
      if (call.name === 'drawElements') {
        const fragment = fragmentOf.get(program) ?? '';
        const on = ['SKIN', 'EYE', 'HAIR', 'ANISOTROPIC'].find((m) =>
          fragment.includes(`const bool MODEL_${m} = true;`),
        );
        drawn = { model: on ?? 'standard', params };
      }
    }
    return drawn;
  };
  lastDraw();
  renderer.setMaterial({ model: skinModel({ radius: 0.02 }) });
  renderer.drawMesh(mesh, mat4.create());
  const skin = lastDraw();
  renderer.setMaterial({ model: eyeModel() });
  renderer.drawMesh(mesh, mat4.fromYRotation(mat4.create(), Math.PI / 2));
  const eye = lastDraw();
  renderer.setMaterial(null);
  renderer.drawMesh(mesh, mat4.create());
  const plain = lastDraw();

  expect([skin.model, eye.model, plain.model]).toEqual(['SKIN', 'EYE', 'standard']);
  expect(skin.params.slice(0, 4)).toEqual([0.85, 0.35, 0.22, 0.02]);
  /* A quarter turn about Y takes the eye's +Z to +X, written for that draw. */
  expect(eye.params.slice(4, 7)).toEqual([1, 0, 0]);
});

/*
 * **Screen-space skin draws in three halves, the second and third each into a target of its own,
 * and is spread once** — the twin of the WebGPU test. Under `skinScattering: 'screen-space'` a skin
 * draw is the frame's half and then at once its diffuse's light and its colour, with other
 * framebuffers bound and the depth compared for equality; the frame's end runs the blur's two axes
 * and adds through the scene's kept share. Where the driver will not render to half floats, or the
 * profile did not ask, skin is one draw, whole.
 */
test('SCREEN-SPACE SKIN DRAWS THREE HALVES INTO THREE TARGETS AND IS SPREAD ONCE, AND ONLY WHERE IT CAN BE', () => {
  const cases = [
    ['screen-space', ['EXT_color_buffer_float'], true],
    ['screen-space', [], false],
    ['pre-integrated', ['EXT_color_buffer_float'], false],
  ] as const;
  for (const [skinScattering, extensions, splits] of cases) {
    const { gl, canvas, calls } = recordingGl({ extensions });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const renderer = new Renderer(canvas, resolveRenderQuality({ skinScattering }));
    const mesh = new Mesh(gl, GEOMETRY);
    const camera = new Camera();
    camera.updateMatrices(16 / 9);
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, createEnvironment());
    const start = calls.length;
    renderer.setMaterial({ model: skinModel() });
    renderer.drawMesh(mesh, mat4.create());
    renderer.setMaterial(null);
    renderer.drawMesh(mesh, mat4.create());
    renderer.endFrame();
    warn.mockRestore();

    const sourceOf = new Map<unknown, string>();
    const fragmentOf = new Map<unknown, string>();
    let program: unknown = null;
    let framebuffer: unknown = null;
    let depthFunc: unknown = null;
    const draws: string[] = [];
    const targets: unknown[] = [];
    let blurs = 0;
    for (const call of calls.slice(0)) {
      if (call.name === 'shaderSource') sourceOf.set(call.args[0], String(call.args[1]));
      if (call.name === 'attachShader') {
        const source = sourceOf.get(call.args[1]) ?? '';
        if (source.includes('out ') && !source.includes('gl_Position')) {
          fragmentOf.set(call.args[0], source);
        }
      }
    }
    for (const call of calls.slice(start)) {
      if (call.name === 'useProgram') program = call.args[0];
      if (call.name === 'bindFramebuffer') framebuffer = call.args[1];
      if (call.name === 'depthFunc') depthFunc = call.args[0];
      const fragment = fragmentOf.get(program) ?? '';
      if (call.name === 'drawElements') {
        const half = fragment.includes('const bool SKIN_DIFFUSE = true;')
          ? 'diffuse'
          : fragment.includes('const bool SKIN_ALBEDO = true;')
            ? 'albedo'
            : fragment.includes('const bool SKIN_SCREEN = true;')
              ? 'scene'
              : fragment.includes('const bool MODEL_SKIN = true;')
                ? 'whole'
                : 'standard';
        draws.push(
          `${half}${half === 'diffuse' || half === 'albedo' ? `:${String(depthFunc)}` : ''}`,
        );
        targets.push(framebuffer);
      }
      if (call.name === 'drawArrays' && fragment.includes('uProfiles')) blurs += 1;
    }
    const halves = draws.map((d) => d.split(':')[0]);
    if (splits) {
      expect(halves, `${skinScattering} ${extensions.join()}`).toEqual([
        'scene',
        'diffuse',
        'albedo',
        'standard',
      ]);
      expect(draws[1]?.split(':')[1], 'the diffuse half finds its depth by equality').toBe(
        String(gl.EQUAL),
      );
      expect(draws[2]?.split(':')[1], 'and so does the colour half').toBe(String(gl.EQUAL));
      expect(targets[1], 'into a target of its own').not.toBe(targets[0]);
      expect(targets[2], 'the colour into another').not.toBe(targets[1]);
      expect(targets[2], 'which is not the frame').not.toBe(targets[0]);
      expect(targets[3], 'and the frame is the frame again after it').toBe(targets[0]);
      expect(blurs, 'across and down, once').toBe(2);
    } else {
      expect(halves, `${skinScattering} ${extensions.join()}`).toEqual(['whole', 'standard']);
      expect(blurs).toBe(0);
    }
  }
  /* A skin drawn after the frame's first blended draw is the whole surface, as on WebGPU. */
  {
    const { gl, canvas, calls } = recordingGl({ extensions: ['EXT_color_buffer_float'] });
    const renderer = new Renderer(canvas, resolveRenderQuality({ skinScattering: 'screen-space' }));
    const mesh = new Mesh(gl, GEOMETRY);
    const camera = new Camera();
    camera.updateMatrices(16 / 9);
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, createEnvironment());
    renderer.drawTranslucentMesh(mesh, mat4.create(), 0.5);
    const start = calls.length;
    renderer.setMaterial({ model: skinModel() });
    renderer.drawMesh(mesh, mat4.create());
    renderer.endFrame();
    const draws = calls.slice(start).filter((call) => call.name === 'drawElements');
    expect(draws, 'one draw, whole').toHaveLength(1);
  }
});

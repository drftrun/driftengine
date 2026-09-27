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

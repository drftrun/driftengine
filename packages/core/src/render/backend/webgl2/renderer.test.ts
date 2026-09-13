import { expect, test, vi } from 'vitest';
import { mat4 } from 'gl-matrix';

import { Mesh } from '../../mesh.ts';
import { Renderer } from './renderer.ts';
import { recordingGl } from '../../rendererHarness.ts';
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

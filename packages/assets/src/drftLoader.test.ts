import { expect, test, vi } from 'vitest';
import { DEFAULT_UPLOAD_MS_PER_FRAME, isDocumentResponse, mayBeginMore } from './uploadBudget.ts';
import { CODEC_JPEG, CODEC_PNG, CODEC_RAW, CODEC_WEBP, SDFV_WHOLE_FILE } from '@driftengine/drft';
import { CODEC_BC, writeBcPayload } from '@driftengine/drft';
import { decodeBc } from './bcDecode.ts';
import { decodeBcImage } from './bcImage.ts';
import { DrftLoader, imageTypeFor, isRawCodec } from './drftLoader.ts';
import type { DrftLoaderOptions } from './drftLoader.ts';
import { writeDrft } from '@driftengine/drft';
import type { DrftMaterial } from '@driftengine/drft';
import type { MeshData, RendererApi } from '@driftengine/core';

/**
 * The frame's stream work is bounded by the clock, and this is why it cannot be a count.
 *
 * **The bug.** `uploadsPerFrame` bounded how many parts one `update` took, on the reasoning
 * written into its own docstring: that a part is a small buffer upload, and that "the bytes
 * are not the problem — a few dozen buffer allocations and a driver sync are". Measured on the
 * shipped Audi, through the demo page, that is the wrong way round. `createMesh` — the buffer
 * allocation the budget was designed around — costs 0.6 to 3.1 ms. The per-part CPU work
 * around it costs 6 to 77 ms: the consumer's `transform`, then the same vertices walked again
 * into the single builder and a third time into the merged group.
 *
 * So counting parts bounded the cheap term and left the expensive one free, and large parts
 * landed three to a frame. Measured on an RX 9070 XT through the demo page, the same load either
 * side of this change: worst `update` **318 ms** by count, **254 ms** by clock, with the stages no
 * longer able to sum into one frame. Time to `ready` was unchanged at 6.0 s against 5.6 s.
 *
 * **The residue is the honest part of this.** 254 ms is one part, on its own, and no budget can
 * divide it — the clock's whole contribution is stopping the other two from joining it. Making
 * that part fit a frame means moving its work off the main thread or splitting a large part
 * across frames, and neither of those is a budget.
 *
 * The consequence was never a visible stutter. driftengine.dev judges a scene on the mean of its
 * recent frame times and gives up permanently, so eight hitch frames in a window of forty-five
 * read as a machine too slow to run the demo at all: measured verdict `too-slow` at 48.6 fps,
 * from a scene drawing at 8 ms a frame either side of them. The reader got a black box.
 */

test('the first piece of work always begins, however long the frame already is', () => {
  /*
   * The guarantee that keeps a load finishing. One part of a heavy model can cost more than
   * the whole budget on its own — 77 ms was measured — and a rule that only ever asks "is
   * there budget left" would then begin nothing, on every frame, for ever. A load that stalls
   * at 40% is worse than one that hitches, so progress wins the tie.
   */
  expect(mayBeginMore(0, 500, DEFAULT_UPLOAD_MS_PER_FRAME)).toBe(true);
  expect(mayBeginMore(0, 0, 0)).toBe(true);
});

test('nothing further begins once the budget is spent', () => {
  // The whole point: the second part of a slow frame waits for the next one.
  expect(mayBeginMore(1, DEFAULT_UPLOAD_MS_PER_FRAME, DEFAULT_UPLOAD_MS_PER_FRAME)).toBe(false);
  expect(mayBeginMore(1, 77, DEFAULT_UPLOAD_MS_PER_FRAME)).toBe(false);
  expect(mayBeginMore(3, 9.4, 6)).toBe(false);
});

test('work keeps flowing while the frame still has room, so a light model still arrives fast', () => {
  /*
   * The other half of the trade. A model of many small parts — the case the count budget was
   * written for — must not be slowed to one part a frame by a fix aimed at large ones.
   */
  expect(mayBeginMore(1, 0.4, DEFAULT_UPLOAD_MS_PER_FRAME)).toBe(true);
  expect(mayBeginMore(12, 5.9, DEFAULT_UPLOAD_MS_PER_FRAME)).toBe(true);
});

test('the budget leaves a 60 Hz frame most of itself', () => {
  /*
   * Stated as an assertion because the number is the whole policy. A frame at 60 Hz is
   * 16.7 ms and the scene has to draw as well as load, so the stream may have a minority of
   * it. It is also under the 8.3 ms a 120 Hz frame allows, which is what the machine this was
   * measured on actually presents at.
   */
  expect(DEFAULT_UPLOAD_MS_PER_FRAME).toBeLessThan(16.7 / 2);
  expect(DEFAULT_UPLOAD_MS_PER_FRAME).toBeLessThan(8.3);
});

/**
 * Telling a model that was never deployed from a model that is broken.
 *
 * The contract worth protecting is the *classification*, not the header parsing. A host that
 * answers an unknown path with its own page under a 200 is the ordinary case rather than a
 * broken one, and every byte of that page passes `response.ok`. Read as a container it fails
 * the magic check, so the reader's honest complaint about the bytes it was handed becomes a
 * wrong statement about the asset: a file nobody ever uploaded gets reported as corrupt.
 *
 * Measured on a real dev server, which is where this came from: `/car.drft` answered
 * `200 text/html`, 2,947 bytes, and the scene showed "the model failed: not a drft file".
 * The deployed site answered a genuine 404 for the same URL at the same moment and was
 * correct, which is why nothing looked wrong to anyone reading production.
 */

test('a page served under 200 is a missing model, not a corrupt one', () => {
  // Exactly what the dev server sends, byte for byte.
  expect(isDocumentResponse('text/html')).toBe(true);
  // Hosts that append the charset, which most do.
  expect(isDocumentResponse('text/html; charset=utf-8')).toBe(true);
  // A header field value is case-insensitive, and some proxies rewrite it.
  expect(isDocumentResponse('Text/HTML; charset=UTF-8')).toBe(true);
  expect(isDocumentResponse('  text/html  ')).toBe(true);
});

test('an actual container is left to the reader, so a corrupt file still fails loudly', () => {
  // What a correctly configured host serves a .drft as.
  expect(isDocumentResponse('application/octet-stream')).toBe(false);
  // A host that declines to say. Silence is not a claim that this is a page, and guessing
  // here would turn a genuinely corrupt file into "no model", which is the opposite mistake.
  expect(isDocumentResponse(null)).toBe(false);
  expect(isDocumentResponse('')).toBe(false);
  // Neighbouring text types are not documents, and must not be swept up by a loose match.
  expect(isDocumentResponse('text/plain')).toBe(false);
  expect(isDocumentResponse('application/xhtml+xml')).toBe(false);
});

/**
 * Every codec is answered deliberately, and raw is not an encoded image.
 *
 * **The bug this stands on.** `decodeImage` chose a MIME with two ternaries that ended in
 * `'image/jpeg'`, so any codec the chain did not name became a JPEG. `CODEC_RAW` is not named
 * there and is not an encoded image at all — the baker writes a 1x1 white one wherever a model
 * named an image that was not beside it, precisely so that every material's `albedo` ordinal keeps
 * meaning what it meant. Four bytes of pixel handed to a JPEG decoder throws
 * `InvalidStateError: The source image could not be decoded`, which is what a consumer saw once
 * per missing map, with the surface it stood in for going untextured — the exact outcome the
 * stand-in exists to prevent. A consumer's own `blankTextures` is written expecting these to
 * arrive as 1x1 white; they never did.
 */
test('a raw texture is decoded from its own pixels, not handed to an image decoder', () => {
  expect(isRawCodec(CODEC_RAW)).toBe(true);
  for (const codec of [CODEC_PNG, CODEC_JPEG, CODEC_WEBP]) expect(isRawCodec(codec)).toBe(false);
});

test('every encoded codec names its own type rather than falling through to one', () => {
  expect(imageTypeFor(CODEC_PNG)).toBe('image/png');
  expect(imageTypeFor(CODEC_WEBP)).toBe('image/webp');
  expect(imageTypeFor(CODEC_JPEG)).toBe('image/jpeg');
});

test('A CODEC WITH NO IMAGE DECODER NAMES NO TYPE, rather than being called a JPEG', () => {
  /*
   * Raw is four bytes a pixel rather than an encoded image, and 99 stands for a codec a later
   * format adds. Either labelled `image/jpeg` reaches a decoder with no chance of reading it, and
   * the failure then names JPEG rather than the codec.
   */
  expect(imageTypeFor(CODEC_RAW)).toBeNull();
  expect(imageTypeFor(99)).toBeNull();
});

/*
 * **The map indices the container carries have to reach the part, and one of them did not.**
 *
 * `MATL` has held four texture indices since stride 72. The baker writes them, `readDrft` reads
 * them, and `SurfaceMaterial` has taken a normal map since normal maps landed — but the loader
 * read `albedo` and `ormMap` and nothing else, so a bought model's normal map arrived at the last
 * step and stopped there. Nothing failed: the model drew, wearing its colour and its ORM, simply
 * smoother than its maker shipped it.
 *
 * The index is what is asserted, because the index is the thing that was lost. A picture would
 * have to be looked at to notice, and this is a value that either arrives or does not.
 */
function fakeRenderer(): RendererApi {
  let next = 1;
  return {
    createMesh: () => ({ id: next++ }),
    disposeMesh: () => {},
    createSurfaceTexture: () => ({ id: next++ }),
    updateSurfaceTexture: () => {},
    disposeSurfaceTexture: () => {},
    createInstanced: (mesh: unknown, capacity: number) => ({ id: next++, mesh, capacity }),
    uploadInstanced: () => {},
    disposeInstanced: () => {},
  } as unknown as RendererApi;
}

/** A material with everything a container needs, so a case states only what it is about. */
function material(fields: Partial<DrftMaterial> & { name: string }): DrftMaterial {
  return {
    color: [1, 1, 1],
    specular: 0,
    roughness: 0.5,
    emissive: 0,
    emissiveColor: [0, 0, 0],
    opacity: 1,
    albedo: -1,
    normalMap: -1,
    ormMap: -1,
    emissiveMap: -1,
    roughnessScale: 1,
    metallicScale: 1,
    occlusionStrength: 0,
    reflectivity: 0,
    cutout: 0,
    ...fields,
  };
}

/** One triangle, which is the least a mesh may be and all this needs to be. */
function triangle(): MeshData {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]),
    emissive: new Float32Array([0, 0, 0]),
    indices: new Uint32Array([0, 1, 2]),
  };
}

async function partsFrom(materials: readonly DrftMaterial[], options: DrftLoaderOptions = {}) {
  const loader = new DrftLoader(fakeRenderer(), options);
  const drft = writeDrft({
    head: { name: 'maps' },
    meshes: materials.map(() => triangle()),
    materials,
  });
  await loader.consume(new Response(drft), { footprint: 1, height: 1, baseY: 0 });
  /* Drained generously: uploads are budgeted per frame and the merge runs one group a frame. */
  for (let frame = 0; frame < 16; frame++) loader.update(1 / 60);
  return loader.parts;
}

test('a part carries the normal map its own material names', async () => {
  const parts = await partsFrom([
    material({ name: 'panel', albedo: 0, ormMap: 1, normalMap: 2 }),
    material({ name: 'glass', albedo: -1, ormMap: -1, normalMap: -1 }),
  ]);

  const panel = parts.find((part) => part.albedo === 0);
  expect(panel?.normal).toBe(2);
  expect(panel?.orm).toBe(1);
  /* And a material naming none says so, rather than inheriting its neighbour's. */
  expect(parts.find((part) => part.albedo === -1)?.normal).toBe(-1);
});

test('a part carries the emissive map its own material names', async () => {
  /*
   * The fourth and last index `MATL` carries, and the layer that dropped the normal one for a
   * whole minor version. It waited here on a renderer that could take an emissive map rather than
   * being forgotten, which is a better reason and the same one-line consequence if it is missed:
   * a model that describes its own glow arriving with nothing lit.
   */
  const parts = await partsFrom([
    material({ name: 'lamp', albedo: 0, ormMap: 1, normalMap: 2, emissiveMap: 3 }),
    material({ name: 'panel', albedo: -1, ormMap: -1, normalMap: -1, emissiveMap: -1 }),
  ]);

  const lamp = parts.find((part) => part.albedo === 0);
  expect(lamp?.emissive).toBe(3);
  /* And a material naming none says so, rather than inheriting its neighbour's. */
  expect(parts.find((part) => part.albedo === -1)?.emissive).toBe(-1);
});

test('two surfaces alike but for their emissive map are not merged into one', async () => {
  const parts = await partsFrom([
    material({ name: 'a', albedo: 0, ormMap: 1, normalMap: 2, emissiveMap: 3 }),
    material({ name: 'b', albedo: 0, ormMap: 1, normalMap: 2, emissiveMap: 4 }),
  ]);

  /* Merging is keyed on the material, and a map left out of that key puts one surface's glow onto
     another's geometry — the defect the ORM scales and the normal map were both added to the key
     to prevent. */
  const emissives = new Set(parts.map((part) => part.emissive));
  expect(emissives.has(3)).toBe(true);
  expect(emissives.has(4)).toBe(true);
});

test('two surfaces alike but for their normal map are not merged into one', async () => {
  const parts = await partsFrom([
    material({ name: 'a', albedo: 0, ormMap: 1, normalMap: 2 }),
    material({ name: 'b', albedo: 0, ormMap: 1, normalMap: 3 }),
  ]);

  /* Merging is keyed on the material. Leaving this map out of that key would put one surface's
     relief onto another's geometry, which is the defect the ORM scales were added to prevent. */
  const normals = new Set(parts.map((part) => part.normal));
  expect(normals.has(2)).toBe(true);
  expect(normals.has(3)).toBe(true);
});

/**
 * The rig survives the loader.
 *
 * **This layer has dropped a field before.** The normal-map texture index was written by the
 * baker, carried by the container and readable by `readDrft` for a whole release, while
 * `DrftLoader` was the single layer that discarded it — invisible to every test of either side,
 * because both sides were correct. So this asserts the loader *hands on* what the file carried
 * rather than that the file carried it.
 */
test('hands on the skin, the clips and the hierarchy the container carried', async () => {
  const identity = new Float32Array(32);
  for (let i = 0; i < 2; i++) {
    identity[i * 16] = 1;
    identity[i * 16 + 5] = 1;
    identity[i * 16 + 10] = 1;
    identity[i * 16 + 15] = 1;
  }

  const loader = new DrftLoader(fakeRenderer(), {});
  const drft = writeDrft({
    head: { name: 'rig' },
    meshes: [triangle()],
    nodes: [
      {
        parent: -1,
        translation: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
        mesh: 0,
        name: 'root',
      },
    ],
    skins: [
      {
        joints: [
          { parent: -1, name: 'root' },
          { parent: 0, name: 'elbow' },
        ],
        inverseBind: identity,
      },
    ],
    clips: [
      {
        name: 'walk',
        durationSec: 1,
        tracks: [
          {
            joint: 1,
            path: 'rotation',
            times: new Float32Array([0, 1]),
            values: new Float32Array([0, 0, 0, 1, 0, 1, 0, 0]),
          },
        ],
      },
    ],
  });

  await loader.consume(new Response(drft), { footprint: 1, height: 1, baseY: 0 });
  for (let frame = 0; frame < 16; frame++) loader.update(1 / 60);

  expect(loader.skins).toHaveLength(1);
  expect(loader.skins[0]?.joints.map((joint) => joint.name)).toEqual(['root', 'elbow']);
  expect(loader.clips.map((clip) => clip.name)).toEqual(['walk']);
  expect(loader.nodes.map((node) => node.name)).toEqual(['root']);
});

/* The same rule for the lamps: a field the container carries and the loader drops is invisible. */
test('HANDS ON THE LIGHTS THE FILE CARRIES, and none for a file that carries none', async () => {
  const loader = new DrftLoader(fakeRenderer(), {});
  const drft = writeDrft({
    head: { name: 'lit' },
    meshes: [triangle()],
    lights: [
      {
        kind: 'point',
        name: 'lamp',
        position: [1, 2, 3],
        direction: [0, 0, -1],
        color: [1, 0.5, 0.25],
        intensity: 40,
        range: 0,
        innerConeRad: 0,
        outerConeRad: 0.5,
      },
    ],
  });
  await loader.consume(new Response(drft), { footprint: 1, height: 1, baseY: 0 });
  expect(loader.lights.map((light) => [light.name, ...light.position])).toEqual([
    ['lamp', 1, 2, 3],
  ]);
  const plain = new DrftLoader(fakeRenderer(), {});
  await plain.consume(new Response(writeDrft({ meshes: [triangle()] })), {
    footprint: 1,
    height: 1,
    baseY: 0,
  });
  expect(plain.lights).toEqual([]);
});

/* A file with no rig answers empty rather than undefined, so a caller needs no branch. */
test('answers empty for a file carrying no rig', async () => {
  const loader = new DrftLoader(fakeRenderer(), {});
  const drft = writeDrft({ head: { name: 'plain' }, meshes: [triangle()] });
  await loader.consume(new Response(drft), { footprint: 1, height: 1, baseY: 0 });
  for (let frame = 0; frame < 16; frame++) loader.update(1 / 60);
  expect(loader.skins).toEqual([]);
  expect(loader.clips).toEqual([]);
  expect(loader.nodes).toEqual([]);
});

/* The same rule as the skin: a field the container carries and the loader drops is invisible. */
test('hands on the morph deltas the container carried', async () => {
  const loader = new DrftLoader(fakeRenderer(), {});
  const drft = writeDrft({
    head: { name: 'morphed' },
    meshes: [
      triangle(),
      { ...triangle(), morphTargets: new Float32Array(3 * 2 * 3).fill(0.5), morphTargetCount: 2 },
    ],
  });
  await loader.consume(new Response(drft), { footprint: 1, height: 1, baseY: 0 });
  for (let frame = 0; frame < 16; frame++) loader.update(1 / 60);

  expect(loader.morphs).toHaveLength(1);
  /* Named by the mesh it deforms, which is the second one — not by its own ordinal, which is 0. */
  expect(loader.morphs[0]?.mesh).toBe(1);
  expect(loader.morphs[0]?.targetCount).toBe(2);
});

/*
 * The end of the streamed path: a mesh reaches `createMesh` carrying its deltas.
 *
 * `loader.morphs` says the chunk was read; this says the *mesh* got them, which is a different
 * claim and the one a consumer depends on. They are separate because the loader is exactly the
 * layer that has read a field and not handed it on before.
 */
test('a streamed mesh reaches the renderer carrying its morph targets', async () => {
  const built: MeshData[] = [];
  const renderer = fakeRenderer();
  const spy = {
    ...renderer,
    createMesh: (data: MeshData) => {
      built.push(data);
      return renderer.createMesh(data);
    },
  } as unknown as RendererApi;

  const loader = new DrftLoader(spy, {});
  const drft = writeDrft({
    head: { name: 'morphed' },
    meshes: [
      { ...triangle(), morphTargets: new Float32Array(3 * 2 * 3).fill(0.5), morphTargetCount: 2 },
    ],
  });
  await loader.consume(new Response(drft), { footprint: 1, height: 1, baseY: 0 });
  for (let frame = 0; frame < 32; frame++) loader.update(1 / 60);

  const morphed = built.find((data) => data.morphTargetCount !== undefined);
  expect(morphed, 'the mesh handed to createMesh carries its deltas').toBeDefined();
  expect(morphed?.morphTargetCount).toBe(2);
});

test('a part carries the cutout its own material states', async () => {
  /*
   * The field `MATL` gained so that an alpha test could reach `SurfaceMaterial.cutout`, which the
   * renderer has taken since decals landed. A part is what a caller builds a `setMaterial` call
   * from, so a cutout that stops here is a cutout the surface never gets.
   */
  const parts = await partsFrom([
    material({ name: 'grille', albedo: 0, cutout: 0.5 }),
    material({ name: 'panel', albedo: 1, cutout: 0 }),
  ]);

  expect(parts.find((part) => part.albedo === 0)?.cutout).toBeCloseTo(0.5, 6);
  expect(parts.find((part) => part.albedo === 1)?.cutout).toBe(0);
});

test('two surfaces alike but for their cutout are not merged into one', async () => {
  /*
   * The merge groups by everything a draw call sets, and a cutout is one of those: merging a
   * masked surface with a solid one would either punch holes in the solid or fill in the mask,
   * depending on which material won.
   */
  const parts = await partsFrom([
    material({ name: 'leaves', albedo: 0, cutout: 0.5 }),
    material({ name: 'trunk', albedo: 0, cutout: 0 }),
  ]);
  expect(parts).toHaveLength(2);
});

test('a fit of none leaves the model in the frame its own importer put it in', async () => {
  /*
   * **The trap this closes was fallen into by a consumer, and it does not look like a trap.** A
   * game whose importer has already placed a model — metres, y = 0 at the road — wants no fit at
   * all, and the only way to ask for none was to hand `load` the numbers it would have computed.
   * The obvious alternative is worse than useless: a footprint of `Number.MAX_SAFE_INTEGER` is not
   * "do not scale", it is a scale of 2.3e15, and a car drawn nine quadrillion metres wide looks
   * from inside exactly like a model that failed to load.
   */
  const loader = new DrftLoader(fakeRenderer(), {});
  const mesh = triangle();
  /* Two metres across and standing off the origin, so a fit would visibly move it. */
  mesh.positions = new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]);
  const drft = writeDrft({ head: { name: 'placed' }, meshes: [mesh] });
  await loader.consume(new Response(drft), { fit: 'none' });

  expect(loader.placement).toEqual({ scale: 1, x: 0, y: 0, z: 0 });
});

test('a fit still fits when it is asked for one', async () => {
  const loader = new DrftLoader(fakeRenderer(), {});
  const mesh = triangle();
  mesh.positions = new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]);
  const drft = writeDrft({ head: { name: 'fitted' }, meshes: [mesh] });
  await loader.consume(new Response(drft), { footprint: 1, height: 1, baseY: 0 });

  /* Two metres across and two tall, into a one metre box: a half scale either way. */
  expect(loader.placement?.scale).toBeCloseTo(0.5, 6);
});

/**
 * **The engine's own container format was the one loader with no way in.**
 *
 * `@driftengine/audio` has taken a `FetchLike` since it was written — `AudioRegistry` and
 * `readManifest` both default one to `fetch` — while the loader for `.drft`, the format this
 * engine defines, reached for the global. A consumer serving models from a service worker, a
 * packed archive, a memory map or a test fixture had no seam and had to shadow a global to get
 * one. Found by the Wave 5A platform audit; `AGENTS.md` has required the seam all along.
 */
test('a model is fetched through the capability rather than the global', async () => {
  const asked: string[] = [];
  const global = vi.fn(() => Promise.reject(new Error('the global must not be reached')));
  vi.stubGlobal('fetch', global);

  try {
    const loader = new DrftLoader(fakeRenderer(), {
      fetchImpl: (url) => {
        asked.push(url);
        /* 404 rather than a container: this is about the route, and `consume` has its own tests. */
        return Promise.resolve(new Response(null, { status: 404 }));
      },
    });
    await loader.load('archive://car.drft', { fit: 'none' });

    expect(asked, 'the supplied implementation carried the request').toEqual([
      'archive://car.drft',
    ]);
    expect(global, 'and the global was never touched').not.toHaveBeenCalled();
    expect(loader.progress.phase, 'a 404 is an absent model, not a failed one').toBe('absent');
  } finally {
    vi.unstubAllGlobals();
  }
});

/**
 * **A model's images reach the GPU premultiplied, and that is a reversal.**
 *
 * This test asserted the opposite, on a real measurement: `createImageBitmap` premultiplies unless
 * told not to, the upload into a straight-alpha texture divides back out, and in Chrome, on a PNG
 * holding every colour at every alpha, **98,463 of 196,608 channel values came back changed** and
 * none did with `premultiplyAlpha: 'none'`. Every one of those numbers is still true.
 *
 * **What they did not measure is content.** An imported material's albedo routinely carries
 * arbitrary bytes under its fully transparent texels, and premultiplying is what kept them out of
 * the frame. Straight alpha let them through, and on an opaque draw nothing discards, so the
 * shader takes `texel.rgb` whatever the alpha beside it says. A reported car came through with its
 * interior, grille, mirrors and lamps as black and white shards; held frames in the showroom
 * reproduced it on both backends, with the old container and the new, and restoring this one
 * option drew it correctly.
 *
 * So the faithful choice per texel was the wrong choice per model, which is the shape worth
 * keeping: a measurement over a synthetic image is not a measurement over the assets that exist.
 *
 * `colorSpaceConversion` is unchanged and stays off — a normal or ORM map holds values that are
 * not colours, and glTF says an image's own colour metadata is ignored.
 */
test('every image decodes premultiplied and with no colour conversion, preview and raw included', async () => {
  const asked: (ImageBitmapOptions | undefined)[] = [];
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn((_source: unknown, options?: ImageBitmapOptions) => {
      asked.push(options);
      return Promise.resolve({ width: 4, height: 4, close: () => {} });
    }),
  );
  /* A raw texture is built into an `ImageData`, which Node does not have. */
  vi.stubGlobal(
    'ImageData',
    class {
      constructor(
        readonly data: Uint8ClampedArray,
        readonly width: number,
        readonly height: number,
      ) {}
    },
  );
  try {
    const loader = new DrftLoader(fakeRenderer(), { texturePreview: 2 });
    const drft = writeDrft({
      head: { name: 'images' },
      meshes: [triangle()],
      materials: [material({ name: 'painted', albedo: 0, normalMap: 1 })],
      textures: [
        { name: 'albedo.png', codec: CODEC_PNG, width: 4, height: 4, bytes: new Uint8Array(8) },
        /* Already no larger than the preview asks, so its preview is a full decode. */
        { name: 'normal.jpg', codec: CODEC_JPEG, width: 2, height: 2, bytes: new Uint8Array(8) },
        { name: 'blank', codec: CODEC_RAW, width: 1, height: 1, bytes: new Uint8Array(4) },
      ],
    });
    await loader.consume(new Response(drft), { footprint: 1, height: 1, baseY: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    /* Three sharp decodes and two previews: a raw texture is at its full size already. */
    /* Each image twice, a preview and the sharp one; a raw texture's preview is the image itself. */
    expect(asked.length).toBe(6);
    for (const options of asked) {
      expect(options?.premultiplyAlpha).toBe('premultiply');
      expect(options?.colorSpaceConversion).toBe('none');
    }
    /* And the one preview that has to shrink still asks to be small. */
    expect(asked.filter((options) => options?.resizeWidth === 2).length).toBe(1);
  } finally {
    vi.unstubAllGlobals();
  }
});

/*
 * **A BC texture goes up as its blocks where the device takes them, and decoded where it does not.**
 * One file, an 8x8 BC1 albedo with its whole chain, through a renderer offering BC1 in sRGB and one
 * offering nothing, which is a phone. The albedo is read sRGB, so the first is handed the blocks,
 * all four levels of them; the second — with no `Worker` here — decodes on the main thread to exactly
 * the texels `decodeBc` gives, and says once that it did.
 */
test('A BC TEXTURE GOES UP AS ITS BLOCKS WHERE THE DEVICE TAKES THEM, AND DECODED WHERE NOT', async () => {
  vi.stubGlobal(
    'ImageData',
    class {
      constructor(
        readonly data: Uint8ClampedArray,
        readonly width: number,
        readonly height: number,
      ) {}
    },
  );
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const level0 = Uint8Array.from({ length: 32 }, (_, i) => (i * 53 + 7) & 0xff);
    const levels = [level0, new Uint8Array(8), new Uint8Array(8), new Uint8Array(8)];
    const drft = writeDrft({
      head: { name: 'blocks' },
      meshes: [triangle()],
      materials: [material({ name: 'painted', albedo: 0 })],
      textures: [
        {
          name: 'paint.dds',
          codec: CODEC_BC,
          width: 8,
          height: 8,
          bytes: writeBcPayload({ format: 'bc1', srgb: true, width: 8, height: 8, levels }),
        },
      ],
    });
    const handed = async (formats: string[]): Promise<[unknown, unknown][]> => {
      const sources: [unknown, unknown][] = [];
      const renderer = {
        ...fakeRenderer(),
        compressedFormats: formats,
        createSurfaceTexture: (source: unknown, options: { colorSpace?: string }) => {
          sources.push([source, options.colorSpace]);
          return { id: sources.length };
        },
      } as unknown as RendererApi;
      const loader = new DrftLoader(renderer);
      await loader.consume(new Response(drft.slice(0)), { footprint: 1, height: 1, baseY: 0 });
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (let frame = 0; frame < 8; frame++) loader.update(1 / 60);
      return sources;
    };

    const desktop = await handed(['bc1-srgb']);
    expect(desktop).toHaveLength(1);
    const [blocks, space] = desktop[0] as [{ format: string; levels: Uint8Array[] }, string];
    expect(space).toBe('srgb');
    expect(blocks.format).toBe('bc1');
    expect(blocks.levels.map((level) => level.length)).toEqual([32, 8, 8, 8]);
    expect(warn, 'nothing to say where the blocks went up').not.toHaveBeenCalled();

    const phone = await handed([]);
    expect(phone).toHaveLength(1);
    const [pixels] = phone[0] as [{ data: Uint8ClampedArray; width: number }, string];
    expect(pixels.width).toBe(8);
    expect(Array.from(pixels.data)).toEqual(Array.from(decodeBc('bc1', 8, 8, level0)));
    /* No worker named, so none in the barrel's graph: the decode is on the main thread, said once
       with the specifier that would move it. See `bcWorkers.ts`. */
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/main thread: no worker was named.*bcWorkers\.ts/),
    );
  } finally {
    warn.mockRestore();
    vi.unstubAllGlobals();
  }
});

/*
 * A consumer taking images through `onImage` builds textures of its own, from bitmaps, so a BC
 * texture reaches it decoded — as an ordinary image, a BC5 normal with its z in blue — and nothing
 * is uploaded, whatever the device could have taken.
 */
test('a consumer taking images gets a BC texture as a decoded bitmap, and nothing is uploaded', async () => {
  vi.stubGlobal(
    'ImageData',
    class {
      constructor(
        readonly data: Uint8ClampedArray,
        readonly width: number,
        readonly height: number,
      ) {}
    },
  );
  const decoded: Uint8ClampedArray[] = [];
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn((source: { data: Uint8ClampedArray }) => {
      decoded.push(source.data);
      return Promise.resolve({ width: 4, height: 4, close: () => {} });
    }),
  );
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    let created = 0;
    const renderer = {
      ...fakeRenderer(),
      compressedFormats: ['bc5'],
      createSurfaceTexture: () => ({ id: ++created }),
    } as unknown as RendererApi;
    const taken: [string, boolean][] = [];
    const loader = new DrftLoader(renderer, {
      onImage: (name, image) => taken.push([name, image !== null]),
    });
    const blocks = Uint8Array.from({ length: 16 }, (_, i) => (i * 29 + 3) & 0xff);
    const drft = writeDrft({
      head: { name: 'arrays' },
      meshes: [triangle()],
      materials: [material({ name: 'painted', normalMap: 0 })],
      textures: [
        {
          name: 'bumps.dds',
          codec: CODEC_BC,
          width: 4,
          height: 4,
          bytes: writeBcPayload({
            format: 'bc5',
            srgb: false,
            width: 4,
            height: 4,
            levels: [blocks],
          }),
        },
      ],
    });
    await loader.consume(new Response(drft), { footprint: 1, height: 1, baseY: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let frame = 0; frame < 8; frame++) loader.update(1 / 60);
    expect(taken).toEqual([['bumps.dds', true]]);
    expect(created).toBe(0);
    expect(Array.from(decoded[0] ?? [])).toEqual(Array.from(decodeBcImage('bc5', 4, 4, blocks)));
  } finally {
    warn.mockRestore();
    vi.unstubAllGlobals();
  }
});

/*
 * **A consumer that builds its own arrays takes the images, and nothing is uploaded twice.** A world
 * whose regions wear texture arrays packs every picture into a layer; a surface texture made of
 * each as well would be the memory spent twice on textures nothing draws.
 */
test('A CONSUMER TAKING THE IMAGES GETS EACH BY NAME, AND THE LOADER UPLOADS NONE', async () => {
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(() => Promise.resolve({ width: 4, height: 4, close: () => {} })),
  );
  try {
    let created = 0;
    const renderer = {
      ...fakeRenderer(),
      createSurfaceTexture: () => {
        created++;
        return { id: created };
      },
    } as unknown as RendererApi;
    const taken: [string, boolean][] = [];
    const loader = new DrftLoader(renderer, {
      onImage: (name, image) => taken.push([name, image !== null]),
    });
    const drft = writeDrft({
      head: { name: 'arrays' },
      meshes: [triangle()],
      materials: [material({ name: 'painted', albedo: 0 })],
      textures: [
        { name: 'facade.webp', codec: CODEC_PNG, width: 4, height: 4, bytes: new Uint8Array(8) },
        { name: 'roof.webp', codec: CODEC_PNG, width: 4, height: 4, bytes: new Uint8Array(8) },
      ],
    });
    await loader.consume(new Response(drft), { footprint: 1, height: 1, baseY: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let frame = 0; frame < 8; frame++) loader.update(1 / 60);
    expect(taken.sort()).toEqual([
      ['facade.webp', true],
      ['roof.webp', true],
    ]);
    expect(created).toBe(0);
    /* Counted as done, as an uploaded image is, so a loading bar still finishes. */
    expect(loader.progress.imagesDone).toBe(2);
  } finally {
    vi.unstubAllGlobals();
  }
});

/*
 * **A consumer that draws some meshes its own way takes them, and they never become parts.** A
 * world's movers — each vehicle and walker kind a mesh the consumer instances per frame — would
 * otherwise be uploaded as parts and then merged into a static group by the image they wear.
 */
test('A CONSUMER TAKING A MESH GETS IT BY ORDINAL, AND IT IS NEITHER A PART NOR MERGED', async () => {
  const taken: number[] = [];
  const loader = new DrftLoader(fakeRenderer(), {
    onMesh: (_mesh, ordinal) => {
      if (ordinal !== 1) return false;
      taken.push(ordinal);
      return true;
    },
  });
  const drft = writeDrft({
    head: { name: 'movers' },
    meshes: [triangle(), triangle(), triangle()],
    /* The one taken is the only translucent one, so a blended part can only be it. */
    materials: [
      material({ name: 'a' }),
      material({ name: 'b', opacity: 0.5 }),
      material({ name: 'c' }),
    ],
  });
  await loader.consume(new Response(drft), { footprint: 1, height: 1, baseY: 0 });
  for (let frame = 0; frame < 16; frame++) loader.update(1 / 60);
  expect(taken).toEqual([1]);
  /* The other two arrived and merged into one group; the one taken is not a part at all. */
  expect(loader.parts.map((p) => p.blend)).toEqual([false]);
  /* Counted as arrived, as an uploaded part is, so a loading bar still finishes. */
  expect(loader.progress.partsDone).toBe(3);
});

/*
 * **A mesh the file draws many times arrives as one part with its placements, never merged.** A
 * merge would bake one copy's geometry into a group and lose the other ten thousand; an instanced
 * part draws them all from one mesh and one upload.
 */
async function instancedParts(fitTo: Parameters<DrftLoader['consume']>[1]) {
  const loader = new DrftLoader(fakeRenderer(), {});
  const at = (x: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];
  const drft = writeDrft({
    head: { name: 'copies' },
    meshes: [triangle(), triangle()],
    materials: [material({ name: 'wall' }), material({ name: 'candle' })],
    instances: [{ mesh: 1, transforms: new Float32Array([...at(0), ...at(10), ...at(20)]) }],
  });
  await loader.consume(new Response(drft), fitTo);
  for (let frame = 0; frame < 16; frame++) loader.update(1 / 60);
  return loader;
}

test('A MESH DRAWN MANY TIMES ARRIVES AS ONE INSTANCED PART, with every placement', async () => {
  const loader = await instancedParts({ fit: 'none' });
  const instanced = loader.parts.filter((part) => part.instances !== null);
  expect(instanced).toHaveLength(1);
  const data = instanced[0]?.instances?.data;
  expect(data?.count).toBe(3);
  /* No fit: the placements are the file's, the third moved 20 along x. */
  expect(data?.models[2 * 16 + 12]).toBeCloseTo(20, 6);
  /* And the other mesh is an ordinary part, as it always was. */
  expect(loader.parts.filter((part) => part.instances === null).length).toBeGreaterThan(0);
});

test('a fitted model moves its copies with its geometry', async () => {
  const loader = await instancedParts({ footprint: 1, height: 1, baseY: 0 });
  const placement = loader.placement;
  expect(placement).not.toBeNull();
  const s = placement?.scale ?? 0;
  const models = loader.parts.find((part) => part.instances !== null)?.instances?.data.models;
  /*
   * The invariant, for the triangle's corner p = (1, 0, 0) of the copy moved u = (20, 0, 0): the
   * fitted prototype puts p at F(p) = s·p + t, and the copy's matrix must carry that to F(p + u),
   * where the fit would have put the copy's own vertex. For a pure move that is F(p) + s·u.
   */
  const fitted = s * 1 + (placement?.x ?? 0);
  const expected = s * (1 + 20) + (placement?.x ?? 0);
  expect(fitted + (models?.[2 * 16 + 12] ?? NaN)).toBeCloseTo(expected, 5);
  expect(models?.[2 * 16 + 13]).toBeCloseTo(0, 5);
  /* And the copy is not scaled a second time: the prototype already carries the fit. */
  expect(models?.[2 * 16 + 0]).toBeCloseTo(1, 6);
});

test('A FILE WHOSE EVERY PART IS INSTANCED STILL LETS ITS OUTLINE GO when the parts are in', async () => {
  /*
   * The outline leaves when the merged groups swap in, and the swap waited on there being a merged
   * group. A file whose every mesh is instanced has none, so its outline stayed on screen over the
   * finished model for ever: a bought candle pack drew a pale hull over ten thousand candles.
   */
  const loader = new DrftLoader(fakeRenderer(), { outline: true });
  const at = (x: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];
  const drft = writeDrft({
    head: { name: 'only copies' },
    meshes: [triangle()],
    lods: [triangle()],
    materials: [material({ name: 'candle' })],
    instances: [{ mesh: 0, transforms: new Float32Array([...at(0), ...at(5)]) }],
  });
  await loader.consume(new Response(drft), { fit: 'none' });
  for (let frame = 0; frame < 16; frame++) loader.update(1 / 60);
  expect(loader.parts).toHaveLength(1);
  expect(loader.parts[0]?.instances).not.toBeNull();
});

/**
 * A part's surface frame reaches the renderer, alone and merged.
 *
 * **The frame was dropped on both paths until 4.4.0, and nothing said so.** Every part went
 * through a `MeshBuilder` to be moved into the fit, and every merge through another, and the
 * builder carries no tangents: so a file that baked a frame per vertex for its normal maps drew
 * with the derived one, and the only place the difference shows is the tilt of a relief under a
 * low light. The copies were also most of a heavy load's main-thread time.
 */
test('A PART KEEPS THE TANGENTS ITS FILE CARRIED, on its own and merged with another', async () => {
  const built: MeshData[] = [];
  const renderer = fakeRenderer();
  const spy = {
    ...renderer,
    createMesh: (data: MeshData) => {
      built.push(data);
      return renderer.createMesh(data);
    },
  } as unknown as RendererApi;
  const framed = (): MeshData => ({
    ...triangle(),
    tangents: new Float32Array([1, 0, 0, -1, 1, 0, 0, -1, 1, 0, 0, -1]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
  });

  const loader = new DrftLoader(spy, {});
  const drft = writeDrft({
    head: { name: 'framed' },
    /* The first two are alike to a draw and merge; the third is alone. */
    meshes: [framed(), framed(), framed()],
    materials: [
      material({ name: 'wall', albedo: 0 }),
      material({ name: 'pier', albedo: 0 }),
      material({ name: 'door', albedo: 1 }),
    ],
  });
  await loader.consume(new Response(drft), { footprint: 1, height: 1, baseY: 0 });
  for (let frame = 0; frame < 32; frame++) loader.update(1 / 60);

  const merged = built.find((data) => data.positions.length === 18);
  const alone = built.find((data) => data.positions.length === 9);
  expect(merged, 'the two walls came through as one mesh').toBeDefined();
  expect(alone, 'and the door on its own').toBeDefined();
  expect([...(merged?.tangents ?? [])].filter((_, i) => i % 4 === 3)).toEqual([
    -1, -1, -1, -1, -1, -1,
  ]);
  expect([...(alone?.tangents ?? [])].filter((_, i) => i % 4 === 3)).toEqual([-1, -1, -1]);
});

/**
 * **`ready` is the picture being right, as its own documentation says it is.** The loader said it
 * once the parts were merged, with images still decoding behind it, so a consumer gating on it
 * judged surfaces that were still untextured. One baked a grid of light probes at that moment and
 * held the hour: white stone bounced into every probe and the courtyard came out overexposed on
 * the runs where the decodes lost the race, and correct on the runs where they won.
 */
test('READY WAITS FOR EVERY IMAGE TO BE ON THE GPU, not only for the parts', async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => {
      await held;
      return { width: 4, height: 4, close: () => {} };
    }),
  );
  try {
    const loader = new DrftLoader(fakeRenderer(), {});
    const drft = writeDrft({
      head: { name: 'painted' },
      meshes: [triangle()],
      materials: [material({ name: 'wall', albedo: 0 })],
      textures: [
        { name: 'albedo.png', codec: CODEC_PNG, width: 4, height: 4, bytes: new Uint8Array(8) },
      ],
    });
    await loader.consume(new Response(drft), { footprint: 1, height: 1, baseY: 0 });
    for (let frame = 0; frame < 16; frame++) loader.update(1 / 60);
    expect(loader.parts, 'the part is in and merged').toHaveLength(1);
    expect(loader.progress.phase, 'while its image is still decoding').not.toBe('ready');

    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let frame = 0; frame < 16; frame++) loader.update(1 / 60);
    expect(loader.progress.phase).toBe('ready');
    expect(loader.progress.imagesDone).toBe(1);
  } finally {
    vi.unstubAllGlobals();
  }
});

/**
 * **Where each field stands, which is the loader's to say.** The fields are in the file's own
 * space and the loader moved the model into its fit, so a field handed on as it was read would
 * trace light through a courtyard somewhere the courtyard is not. A mesh drawn many times is
 * traced once a copy, at that copy's placement.
 */
test('A FIELD STANDS WHERE THE LOADER PUT THE MODEL, once for the file and once a copy for a copied mesh', async () => {
  const loader = new DrftLoader(fakeRenderer(), {});
  const at = (x: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];
  const field = new Float32Array(8).fill(1);
  const bounds = new Float32Array([0, 0, 0, 1, 1, 1]);
  const drft = writeDrft({
    head: { name: 'traced' },
    meshes: [triangle(), triangle()],
    materials: [material({ name: 'wall' }), material({ name: 'pillar' })],
    instances: [{ mesh: 1, transforms: new Float32Array([...at(0), ...at(10)]) }],
    fields: [
      { mesh: SDFV_WHOLE_FILE, dims: [2, 2, 2], bounds, field },
      { mesh: 1, dims: [2, 2, 2], bounds, field },
    ],
  });
  /* A fit of scale 2 about the model's footprint, so the placement is not the identity. */
  await loader.consume(new Response(drft), { footprint: 2, height: 2, baseY: 0 });
  for (let frame = 0; frame < 16; frame++) loader.update(1 / 60);

  const placements = loader.fields;
  const whole = placements.filter((p) => p.mesh === SDFV_WHOLE_FILE);
  const copies = placements.filter((p) => p.mesh === 1);
  expect(whole).toHaveLength(1);
  expect(copies).toHaveLength(2);
  const scale = whole[0]?.model[0] ?? 0;
  expect(scale, 'the fit scales the field with the model').not.toBe(1);
  expect(whole[0]?.model[5]).toBeCloseTo(scale, 6);
  /* The second copy stands ten units along x in the file, so ten times the fit's scale further. */
  const dx = (copies[1]?.model[12] ?? 0) - (copies[0]?.model[12] ?? 0);
  expect(dx).toBeCloseTo(10 * scale, 5);
  expect(Array.from(whole[0]?.source.field ?? [])).toEqual(Array.from(field));
});

test('A PART SAYS WHETHER IT IS GLASS, from its file or from the override', async () => {
  const parts = await partsFrom(
    [
      material({ name: 'bottle', albedo: 0, transmission: 0.8, frost: 0.25 }),
      material({ name: 'pane', albedo: 1 }),
      material({ name: 'wall', albedo: 2 }),
    ],
    {
      surface: (m) =>
        m?.name === 'pane' ? { transmission: 0.9, frost: 0.5, tint: [1, 0.9, 0.8] } : undefined,
    },
  );
  const bottle = parts.find((part) => part.albedo === 0);
  expect(bottle?.glass?.transmission).toBeCloseTo(0.8, 6);
  expect(bottle?.glass?.frost).toBeCloseTo(0.25, 6);
  expect(bottle?.blend).toBe(true);
  const pane = parts.find((part) => part.albedo === 1);
  expect(pane?.glass).toEqual({ transmission: 0.9, frost: 0.5, tint: [1, 0.9, 0.8] });
  expect(parts.find((part) => part.albedo === 2)?.glass, 'a wall is not glass').toBeNull();
});

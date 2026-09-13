import { expect, test } from 'vitest';
import { DEFAULT_UPLOAD_MS_PER_FRAME, isDocumentResponse, mayBeginMore } from './uploadBudget.ts';
import { CODEC_JPEG, CODEC_PNG, CODEC_RAW, CODEC_WEBP } from '@driftengine/drft';
import { DrftLoader, imageTypeFor, isRawCodec } from './drftLoader.ts';
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

async function partsFrom(materials: readonly DrftMaterial[]) {
  const loader = new DrftLoader(fakeRenderer(), {});
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

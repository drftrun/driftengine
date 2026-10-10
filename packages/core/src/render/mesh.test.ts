import { expect, test } from 'vitest';

import { Mesh, createMeshIncremental } from './mesh.ts';
import { recordingGl } from './rendererHarness.ts';
import { ABSENT_ATTRIBUTE } from './vertexDefaults.ts';

/*
 * Whether a mesh carries a tangent frame, exposed rather than recomputed.
 *
 * The renderer has to tell the shader, because the attribute cannot say so itself:
 * `vertexDefaults.ts` gives a mesh without tangents `[1, 0, 0, 1]`, a usable frame rather than a
 * sentinel, "because a zero tangent normalises to a NaN in any shader that eventually reads one,
 * and a NaN in a fragment takes the pixel with it".
 *
 * Read off the same branch `mesh.ts` already takes when it chooses between `attachAttribute` and
 * the absent-attribute constant, so the two cannot come apart.
 */
const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
const indices = new Uint32Array([0, 1, 2]);
const colors = new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]);
const emissive = new Float32Array([0, 0, 0]);
const base = { positions, normals, colors, emissive, indices };

test('a mesh reports that it carries no tangent frame', () => {
  const { gl } = recordingGl();
  expect(new Mesh(gl, base).hasTangents).toBe(false);
});

test('a mesh reports that it carries one', () => {
  const { gl } = recordingGl();
  const tangents = new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]);
  expect(new Mesh(gl, { ...base, tangents }).hasTangents).toBe(true);
});

/*
 * A mesh whose geometry moves.
 *
 * **The gap this closes.** `ClothBody` has been in `@driftengine/physics` since 2.9 and nothing
 * could draw its output: a mesh was immutable, so a deforming surface could only be drawn by
 * recreating it every frame — a GPU buffer allocation per frame, which the frame rules forbid — or
 * by splitting it into rigid quads with a matrix each, which caps the resolution at the number of
 * draw calls a consumer can afford. A consumer found it by trying to hang a banner.
 */

test('a mesh that does not declare itself deforming refuses to be rewritten', () => {
  /*
   * Refused rather than silently allowed, because the flag buys something real on each backend —
   * a buffer hint here, and the retained interleaved array on WebGPU, which cannot patch one
   * position without the rest of the vertex in hand. A mesh that accepted an update on one
   * backend and threw on the other would be worse than one that refuses on both.
   */
  const { gl } = recordingGl();
  const mesh = new Mesh(gl, base);
  expect(() => mesh.update(gl, positions)).toThrow(/dynamic/);
});

test('a deforming mesh takes a dynamic buffer hint', () => {
  const { gl, calls } = recordingGl();
  new Mesh(gl, base, true);
  const hints = calls.filter((c) => c.name === 'bufferData').map((c) => c.args[2]);
  /* Positions and normals move; colour and emissive describe what a surface *is*. */
  expect(hints.filter((h) => h === gl.DYNAMIC_DRAW)).toHaveLength(2);
  expect(hints.filter((h) => h === gl.STATIC_DRAW).length).toBeGreaterThan(0);
});

test('a rewrite uploads the new positions', () => {
  const { gl, calls } = recordingGl();
  const mesh = new Mesh(gl, base, true);
  const moved = new Float32Array([0, 5, 0, 1, 5, 0, 0, 6, 0]);
  mesh.update(gl, moved);

  const uploads = calls.filter((c) => c.name === 'bufferSubData');
  expect(uploads, 'positions only, with no normals supplied').toHaveLength(1);
  expect(uploads[0]?.args[2]).toBe(moved);
});

test('a rewrite moves the bounds with the geometry', () => {
  /*
   * Everything that decides whether this is on screen starts from the bounds, so a cloth that
   * blew sideways out of its original box would be culled while still visible — a bug that only
   * shows up at the edge of the frame, which is the hardest place to notice one.
   */
  const { gl } = recordingGl();
  const mesh = new Mesh(gl, base, true);
  expect(mesh.bounds.max[1]).toBeCloseTo(1, 6);

  mesh.update(gl, new Float32Array([0, 20, 0, 1, 20, 0, 0, 21, 0]));
  expect(mesh.bounds.min[1]).toBeCloseTo(20, 6);
  expect(mesh.bounds.max[1]).toBeCloseTo(21, 6);
  /* And the centre with them, which is what a distance test actually reads. */
  expect(mesh.bounds.centre[1]).toBeCloseTo(20.5, 6);
});

test('a rewrite of the wrong size is refused, naming both', () => {
  /* A mesh's vertex count is fixed at creation: the index buffer, the pipeline and every other
     attribute are sized against it. */
  const { gl } = recordingGl();
  const mesh = new Mesh(gl, base, true);
  expect(() => mesh.update(gl, new Float32Array(6))).toThrow(/3 vertices and the update has 2/);
});

test('normals go up with the positions when the caller has them', () => {
  const { gl, calls } = recordingGl();
  const mesh = new Mesh(gl, base, true);
  mesh.update(gl, positions, normals);
  expect(calls.filter((c) => c.name === 'bufferSubData')).toHaveLength(2);
});

/*
 * A mesh that lands over several frames.
 *
 * **What this exists for, in the words of the consumer who measured it.** A game streaming a
 * world in 500 m squares held a 4 ms frame budget and honoured it exactly, for the half of the
 * work it owned. The other half — one `createMesh` per material group, about two dozen a square —
 * ran in whichever frame the build happened to finish in, outside every budget. Attributed in the
 * browser over a drive into a town, every frame over 50 ms was that and nothing else.
 *
 * This backend is the cheap one, and it is still not free: a 250,000-vertex group is three
 * megabytes of positions in one `bufferData`. What it must not become is the expensive one — the
 * first line of `mesh.ts` records why there is no interleave here, and there is still none.
 */

/** A mesh of `count` vertices, enough to need several steps. `count` must divide by three. */
function slab(count: number) {
  const many = { positions: new Float32Array(count * 3), normals: new Float32Array(count * 3) };
  return {
    positions: many.positions,
    normals: many.normals,
    colors: new Float32Array(count * 3),
    emissive: new Float32Array(count),
    indices: new Uint32Array(count),
  };
}

/** Drive an upload to the end, counting the calls it took. */
function drive(upload: Iterator<void, void>): number {
  let calls = 0;
  for (;;) {
    calls += 1;
    if (upload.next().done === true) return calls;
    if (calls > 10_000) throw new Error('an upload that never finishes');
  }
}

test('a mesh uploaded a step at a time has sent nothing before its first step', () => {
  const { gl, calls } = recordingGl();

  const { mesh } = createMeshIncremental(gl, base);

  expect(mesh.complete).toBe(false);
  expect(calls.filter((c) => c.name === 'bufferSubData')).toHaveLength(0);
  /* Allocated by size, so the vertex array object is valid and points at real buffers from the
     first frame. Every one of them: a `bufferData` carrying an array here would be a whole
     attribute landing at creation, which is the thing being spread. */
  const allocations = calls.filter((c) => c.name === 'bufferData');
  expect(allocations.length).toBeGreaterThan(0);
  for (const one of allocations) expect(typeof one.args[1]).toBe('number');
});

test('a mesh uploaded a step at a time takes one step per attribute', () => {
  const { gl } = recordingGl();

  /* Positions, normals and the indices, none big enough to be split further. Its colour and its
     emissive are each one value for every vertex, so constants with nothing to upload. */
  const { mesh, upload } = createMeshIncremental(gl, base);

  expect(drive(upload)).toBe(3);
  expect(mesh.complete).toBe(true);
});

test('a mesh uploaded a step at a time splits an attribute too big for one step', () => {
  const { gl } = recordingGl();
  /* 40,000 vertices is 480 kB of positions: two steps of that attribute alone, so more steps than
     the three arrays that go up — positions, normals and indices. */
  const { upload } = createMeshIncremental(gl, slab(40_002));

  expect(drive(upload)).toBeGreaterThan(3);
});

/*
 * **The bytes, not the calls.** A spread upload can write a range twice or skip one, and both
 * leave the step count right and the geometry wrong. So every array the mesh was given has to
 * come out covered exactly once, from nothing to its full length, with no gap and no overlap.
 */
test('a mesh uploaded a step at a time writes every array exactly once, end to end', () => {
  const { gl, calls } = recordingGl();
  const data = slab(40_002);

  const { upload } = createMeshIncremental(gl, data);
  drive(upload);

  const ranges = new Map<ArrayBufferView & { length: number }, [number, number][]>();
  for (const call of calls) {
    if (call.name !== 'bufferSubData') continue;
    const source = call.args[2] as ArrayBufferView & { length: number };
    const from = call.args[3] as number;
    const length = call.args[4] as number;
    const found = ranges.get(source) ?? [];
    found.push([from, from + length]);
    ranges.set(source, found);
  }

  /*
   * Three arrays go up: the positions as given, the normals in sixteen-bit fixed point and the
   * indices narrowed to sixteen bits, both copies made at creation; the slab's colour and emissive
   * are one value each and constants. See `vertexPacking.ts` and `indexWidth.ts`.
   */
  const sources = [...ranges.keys()];
  expect(sources).toHaveLength(3);
  expect(sources).toContain(data.positions);
  expect(sources.map((source) => source.constructor.name).sort()).toEqual([
    'Float32Array',
    'Int16Array',
    'Uint16Array',
  ]);
  for (const array of sources) {
    const found = ranges.get(array);
    expect(found).toBeDefined();
    let at = 0;
    for (const [from, to] of (found ?? []).sort((a, b) => a[0] - b[0])) {
      expect(from).toBe(at);
      at = to;
    }
    expect(at).toBe(array.length);
  }
});

test('a mesh uploaded eagerly is complete before the constructor returns', () => {
  const { gl } = recordingGl();
  expect(new Mesh(gl, base).complete).toBe(true);
});

/*
 * The per-vertex channel, and the absent case is the one that matters.
 *
 * A mesh that never heard of this attribute must reach the driver as a *disabled* attribute with a
 * constant behind it, not as a buffer of defaults: that is what lets every existing mesh keep its
 * upload cost and its bytes, and it is the property that ruled out packing the loose material
 * floats into vec4s when this needed a location.
 */
test('a mesh with no channel disables the attribute rather than uploading defaults', () => {
  const { gl, calls } = recordingGl();
  new Mesh(gl, base);
  expect(
    calls.filter((c) => c.name === 'disableVertexAttribArray').map((c) => c.args[0]),
  ).toContain(13);
});

test('a mesh that carries a channel binds a buffer at 13 instead', () => {
  const { gl, calls } = recordingGl();
  const channel = new Float32Array(3 * 4);
  new Mesh(gl, { ...base, channel });
  expect(
    calls.filter((c) => c.name === 'disableVertexAttribArray').map((c) => c.args[0]),
  ).not.toContain(13);
  expect(calls.filter((c) => c.name === 'vertexAttribPointer').map((c) => c.args[0])).toContain(13);
});

/**
 * **And the constant it reads is the whole tuple, which for a while it was not.**
 *
 * `vertexAttrib3f` leaves `w` at its default of 1, so a four-float entry in `ABSENT_ATTRIBUTE`
 * arrived one lane short: `channel`'s `(0, 1, 1, 0)` reached the driver as `(0, 1, 1, 1)`. Nothing
 * in a picture showed it — the fourth lane is the reserved one and nothing reads it — but the
 * table is where an absent attribute's meaning is written down, and `joints` and `weights` are
 * four-wide as well. `vertexDefaults.test.ts` pins the tuples; this pins that they arrive.
 *
 * Asserted through a draw rather than through construction, because the constants are re-applied
 * per draw on purpose: `vertexAttrib*f` is context state and not vertex-array state, so the VAO
 * cannot carry them.
 */
test('an absent attribute reaches the driver with every component the table gave it', () => {
  const { gl, calls } = recordingGl();
  const mesh = new Mesh(gl, base);
  const before = calls.length;

  mesh.draw(gl);

  const channel = calls
    .slice(before)
    .filter((call) => call.name.startsWith('vertexAttrib') && call.args[0] === 13);
  expect(channel.length, 'the channel constant is applied on the draw').toBe(1);
  expect(channel[0]?.name, 'at four components, not three').toBe('vertexAttrib4f');
  expect(channel[0]?.args, 'and it is the tuple ABSENT_ATTRIBUTE names').toEqual([
    13,
    ...(ABSENT_ATTRIBUTE['channel'] as readonly number[]),
  ]);
});

test('A BATCH DRAWS THROUGH A VERTEX ARRAY OF ITS OWN, so a plain draw sees no instance column and two batches never share one', () => {
  /*
   * **The mesh's own array used to carry the instance columns**, and location 13 — the channel —
   * then read the third column of instance zero's matrix on a plain draw: `aChannel.y` was zero,
   * `vSkyDirect` scaled the sun to nothing, and the `drawMesh` rank of `demo/instancing.ts` read
   * (51, 30, 21) against the instanced rank's (218, 110, 59), 51 being the ambient alone. It was
   * patched by disabling the columns around each plain draw, and one array per mesh also meant one
   * batch per mesh. Each batch now builds an array of its own from the mesh's recorded attributes.
   */
  const { gl, calls } = recordingGl();
  const mesh = new Mesh(gl, base);
  const first = gl.createBuffer() as WebGLBuffer;
  const second = gl.createBuffer() as WebGLBuffer;
  const a = mesh.createInstanceArray(gl, first, 80);
  calls.length = 0;
  const b = mesh.createInstanceArray(gl, second, 80);
  expect(b, 'a second batch gets a second array').not.toBe(a);
  /* Its columns point into its own buffer: the last buffer bound before location 11 is set. */
  const at11 = calls.findIndex((c) => c.name === 'vertexAttribPointer' && c.args[0] === 11);
  const bound = calls
    .slice(0, at11)
    .filter((c) => c.name === 'bindBuffer')
    .at(-1);
  expect(bound?.args[1], 'the second batch reads the second buffer').toBe(second);
  expect(
    calls.some((c) => c.name === 'vertexAttribPointer' && c.args[0] === 0),
    'and the geometry is bound into it too',
  ).toBe(true);

  calls.length = 0;
  mesh.draw(gl);
  expect(
    calls.find((c) => c.name === 'bindVertexArray')?.args[0],
    'the plain draw binds the mesh’s array',
  ).not.toBe(a);
  expect(
    calls.some(
      (c) => c.name === 'enableVertexAttribArray' || c.name === 'disableVertexAttribArray',
    ),
    'and touches no instance column',
  ).toBe(false);

  calls.length = 0;
  mesh.drawInstancesThrough(gl, b, 3);
  expect(calls.find((c) => c.name === 'bindVertexArray')?.args[0]).toBe(b);
  expect(calls.find((c) => c.name === 'drawElementsInstanced')?.args[4]).toBe(3);
});

/*
 * **Sixteen-bit indices where every vertex fits, and every draw names the width they are stored
 * at**, eagerly and spread. A draw naming thirty-two bits over a sixteen-bit buffer reads two
 * indices as one, which no driver reports. 65,537 vertices is the first count sixteen bits cannot
 * name, and the narrow copy is padded to whole words as the other backend's has to be.
 */
test('NARROWS A MESH’S INDICES TO SIXTEEN BITS WHERE ITS VERTICES FIT, AND EVERY DRAW SAYS SO', () => {
  const { gl, calls } = recordingGl();
  const vertices = 65537;
  const wideData = {
    positions: new Float32Array(vertices * 3),
    normals: new Float32Array(vertices * 3),
    colors: new Float32Array(vertices * 3),
    emissive: new Float32Array(vertices),
    indices: new Uint32Array([0, 1, vertices - 1]),
  };
  const narrow = new Mesh(gl, base);
  const wide = new Mesh(gl, wideData);
  const spread = createMeshIncremental(gl, base);
  while (spread.upload.next().done !== true);
  const filled = calls
    .filter((c) => c.args[0] === gl.ELEMENT_ARRAY_BUFFER)
    .filter((c) => c.name === 'bufferData' || c.name === 'bufferSubData')
    .map((c) => c.args[c.name === 'bufferSubData' ? 2 : 1])
    .filter((data) => typeof data !== 'number');
  expect(filled).toEqual([
    new Uint16Array([0, 1, 2, 0]),
    new Uint32Array([0, 1, vertices - 1]),
    new Uint16Array([0, 1, 2, 0]),
  ]);

  calls.length = 0;
  for (const mesh of [narrow, spread.mesh, wide]) {
    mesh.draw(gl);
    mesh.drawInstancesThrough(gl, {} as WebGLVertexArrayObject, 2);
  }
  const types = calls
    .filter((c) => c.name === 'drawElements' || c.name === 'drawElementsInstanced')
    .map((c) => c.args[2]);
  const short = gl.UNSIGNED_SHORT;
  const int = gl.UNSIGNED_INT;
  expect(types).toEqual([short, short, short, short, int, int]);
});

/*
 * **Each attribute bound as it travels** (`vertexPacking.ts`): sixteen-bit fixed point read through
 * a normalised `SHORT` or `UNSIGNED_SHORT`, three lanes where three is what the shader reads, and a
 * value every vertex shares as a disabled attribute with that value behind it at every draw. A
 * batch's vertex array is built from the same record, so it reads the same types.
 */
test('BINDS EACH ATTRIBUTE AS IT TRAVELS: FIXED POINT READ NORMALISED, A SHARED VALUE AS A CONSTANT', () => {
  const { gl, calls } = recordingGl();
  const mesh = new Mesh(gl, {
    ...base,
    colors: new Float32Array([1, 0.5, 0.25, 0, 0, 0, 1, 1, 1]),
    emissive: new Float32Array([0.75, 0.75, 0.75]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    tangents: new Float32Array([1, 0, 0, -1, 0, 1, 0, 1, 0, 0, 1, -1]),
  });
  const pointers = (from: number) =>
    new Map(
      calls
        .slice(from)
        .filter((c) => c.name === 'vertexAttribPointer')
        .map((c) => [c.args[0], c.args.slice(1, 4)]),
    );
  const expected = new Map([
    [0, [3, gl.FLOAT, false]],
    [1, [3, gl.SHORT, true]],
    [2, [3, gl.UNSIGNED_SHORT, true]],
    /* Coordinates stay floats even inside [0, 1]: see `vertexPacking.ts`. */
    [5, [2, gl.FLOAT, false]],
    [10, [4, gl.SHORT, true]],
  ]);
  const bound = pointers(0);
  for (const [location, read] of expected) expect(bound.get(location), `${location}`).toEqual(read);
  expect(bound.has(3), 'the shared emissive has no buffer').toBe(false);
  const filled = calls
    .filter((c) => c.name === 'bufferData')
    .map((c) => c.args[1])
    .find((data) => data instanceof Int16Array);
  expect(Array.from(filled as Int16Array)).toEqual([0, 0, 32767, 0, 0, 32767, 0, 0, 32767]);
  expect(calls.some((c) => c.name === 'disableVertexAttribArray' && c.args[0] === 3)).toBe(true);

  calls.length = 0;
  mesh.draw(gl);
  expect(calls.find((c) => c.name === 'vertexAttrib1f' && c.args[0] === 3)?.args[1]).toBe(0.75);
  const at = calls.length;
  mesh.createInstanceArray(gl, {} as WebGLBuffer, 80);
  const batch = pointers(at);
  for (const [location, read] of expected) expect(batch.get(location), `${location}`).toEqual(read);
});

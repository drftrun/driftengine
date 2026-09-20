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

  /* Four supplied attributes and the indices, none big enough to be split further. */
  const { mesh, upload } = createMeshIncremental(gl, base);

  expect(drive(upload)).toBe(5);
  expect(mesh.complete).toBe(true);
});

test('a mesh uploaded a step at a time splits an attribute too big for one step', () => {
  const { gl } = recordingGl();
  /* 40,000 vertices is 480 kB of positions: two steps of that attribute alone. */
  const { upload } = createMeshIncremental(gl, slab(40_002));

  expect(drive(upload)).toBeGreaterThan(5);
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

  const ranges = new Map<object, [number, number][]>();
  for (const call of calls) {
    if (call.name !== 'bufferSubData') continue;
    const source = call.args[2] as object;
    const from = call.args[3] as number;
    const length = call.args[4] as number;
    const found = ranges.get(source) ?? [];
    found.push([from, from + length]);
    ranges.set(source, found);
  }

  const arrays = [data.positions, data.normals, data.colors, data.emissive, data.indices];
  for (const array of arrays) {
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

test('A MESH WITH AN INSTANCED BATCH STILL DRAWS WITH ITS OWN CHANNEL, not the batch’s matrix', () => {
  /*
   * **`attachInstances` claims locations 11 to 14 for the model matrix, and 13 is the channel.**
   * A `Mesh` owns one vertex array, so enabling the instance attributes on it leaves them enabled
   * for the *plain* draw as well — and location 13 then reads the third column of instance zero's
   * matrix instead of the absent-attribute constant `[0, 1, 1, 1]`. For a placement with no
   * rotation that column is `(0, 0, 1, 0)`, so `aChannel.y` is **zero**, and
   * `vSkyDirect = aChannel.y` scales the directional term to nothing: the mesh renders lit by the
   * hemispheric ambient alone, with correct normals, correct albedo and no error anywhere.
   *
   * Measured on `demo/instancing.ts`, which draws two ranks of one box — thirty `drawMesh` calls
   * against one `drawInstanced` — so that the two must match. With a constant tint of
   * (1, 0.5, 0.25) the `drawMesh` rank's top face read (51, 30, 21) against the other rank's
   * (218, 110, 59), and 51 *is* the ambient. WebGPU has no vertex array to share and drew them
   * alike, which is how it was found.
   *
   * The shader already refuses the pair — `flatVert` throws on channel-with-instancing rather than
   * dropping the attribute — and this is the same refusal one layer down, where the vertex array
   * was quietly allowing it.
   */
  const { gl, calls } = recordingGl();
  const mesh = new Mesh(gl, base);
  mesh.attachInstances(gl, gl.createBuffer() as WebGLBuffer, 76);

  calls.length = 0;
  mesh.draw(gl);
  const disabled = calls
    .filter((call) => call.name === 'disableVertexAttribArray')
    .map((call) => call.args[0]);
  expect(disabled, 'the instance columns are left enabled over a plain draw').toContain(13);

  calls.length = 0;
  mesh.drawInstances(gl, 3);
  const enabled = calls
    .filter((call) => call.name === 'enableVertexAttribArray')
    .map((call) => call.args[0]);
  expect(enabled, 'the instance columns are not put back for the instanced draw').toContain(13);
});

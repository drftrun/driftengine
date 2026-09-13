/** Static GPU mesh: interleaving is skipped in favor of three tight buffers. */

import { MorphTexture } from './backend/webgl2/morphTexture.ts';
import { ABSENT_ATTRIBUTE } from './vertexDefaults.ts';
import { UPLOAD_BYTES_PER_STEP } from './uploadStep.ts';

/*
 * `MeshData` and its validator live in `@driftengine/drft`, because the container's whole
 * job is to carry one and the format package must be readable by something that never
 * draws. Re-exported here so every consumer that took them from the renderer still can.
 */
import { boundsOfPositions, createBounds } from '../math/bounds.ts';
import type { Bounds } from '../math/bounds.ts';

export type { MeshData } from '@driftengine/drft';
export { validateMeshData } from '@driftengine/drft';
import type { MeshData } from '@driftengine/drft';
import { validateMeshData } from '@driftengine/drft';

/**
 * The roughness a mesh that never mentions one is shaded with.
 *
 * Solved rather than picked: it is the roughness whose normalised lobe has the same
 * half-power width — 6.88 degrees — as the fixed `pow(ndh, 96)` this engine used before
 * roughness existed. A world built before the attribute therefore keeps the highlight it
 * was authored against, in width as well as in strength.
 *
 * It was 0.28, which claimed to do that and did not: 0.28 is 2.9 degrees, less than half
 * as wide, and against the un-normalised lobe of the time it peaked 52 times higher as
 * well. Both halves are fixed — `flat.ts` normalises the lobe, and this is the width that
 * actually matches.
 */
/* The engine's fixed lobe, stated once in `vertexDefaults.ts` so both backends read one number. */
const DEFAULT_ROUGHNESS = ABSENT_ATTRIBUTE['roughness']?.[0] ?? 0.4277;

/** Attribute locations are fixed engine-wide (`layout(location = n)` in GLSL). */
const ATTR_POSITION = 0;
const ATTR_NORMAL = 1;
const ATTR_COLOR = 2;
const ATTR_EMISSIVE = 3;
const ATTR_SPECULAR = 4;
const ATTR_UV = 5;
const ATTR_EMISSIVE_COLOR = 6;
const ATTR_ROUGHNESS = 7;
const ATTR_GRAIN = 8;
const ATTR_RELIEF = 9;
/** Four components, which makes it the widest attribute the layout carries. See `generateTangents`. */
const ATTR_TANGENT = 10;
/* Skinning. Thirteen of WebGL2's guaranteed sixteen attributes are spoken for with these two. */
const ATTR_JOINTS = 11;
/*
 * The four-lane per-vertex channel, and the fourteenth attribute.
 *
 * **13 is the last location the plain and skinned variants can both spare.** Skinning holds 11 and
 * 12; an instanced draw holds 11 through 15 and therefore cannot carry this at all, which is why
 * `flatVert` throws on the pair rather than dropping the attribute. A silent drop is a consumer
 * setting sway, watching nothing move, and having nothing to read about why.
 */
const ATTR_CHANNEL = 13;
const ATTR_WEIGHTS = 12;

/**
 * One absent attribute's constant, at the width the table gave it.
 *
 * **The four-component arm is the one that was missing**, and it was missing in both draw paths
 * because they held a copy of this each. `vertexAttrib3f` leaves `w` at its default of **1**, so a
 * four-float entry in `ABSENT_ATTRIBUTE` reached the driver with its last lane overwritten:
 * `channel`'s `(0, 1, 1, 0)` arrived as `(0, 1, 1, 1)`. Nothing showed it — that lane is the
 * reserved one and nothing reads it, and `tangents`' `(1, 0, 0, 1)` happens to want the default —
 * but `joints` and `weights` are four-wide too, and the table is meant to be the one place an
 * absent attribute's meaning is written down. A table nothing applies faithfully is not a source
 * of truth. `vertexDefaults.test.ts` pins the tuples; this is what pins that they arrive.
 */
function applyConstant(
  gl: WebGL2RenderingContext,
  location: number,
  value: readonly number[],
): void {
  const [x = 0, y = 0, z = 0, w = 0] = value;
  if (value.length === 1) gl.vertexAttrib1f(location, x);
  else if (value.length === 2) gl.vertexAttrib2f(location, x, y);
  else if (value.length === 3) gl.vertexAttrib3f(location, x, y, z);
  else gl.vertexAttrib4f(location, x, y, z, w);
}

export class Mesh {
  private readonly vao: WebGLVertexArrayObject;
  private readonly buffers: WebGLBuffer[] = [];
  /**
   * The position and normal buffers, kept so `update` can rewrite them.
   *
   * Null unless the mesh was created `dynamic`. A mesh that never deforms pays nothing for
   * this — two references, and only where a consumer asked.
   */
  private readonly deformable: { positions: WebGLBuffer; normals: WebGLBuffer } | null = null;
  /** How many floats the position buffer holds, so an update of the wrong size is refused. */
  private readonly positionFloats: number;
  private readonly indexCount: number;
  /**
   * The constant values this mesh's *absent* attributes are shaded with, re-applied on
   * every draw.
   *
   * **`vertexAttrib*f` is context state, not vertex-array state.** `enableVertexAttribArray`
   * and the pointers belong to the VAO and are restored when it is bound; the constant a
   * *disabled* attribute reads is global and is not. So setting these once in the
   * constructor and trusting the VAO to carry them is wrong: it makes a mesh's appearance
   * depend on which mesh was constructed last, which is a property of unrelated code
   * somewhere else in the frame.
   *
   * It survived because every mesh here happens to want the same constants, so the global
   * values are correct by coincidence. The first mesh to want a different roughness would
   * have silently changed the shading of every mesh that never mentioned one — a defect
   * with no error, no warning and no plausible connection to its cause.
   *
   * Re-applying per draw costs four calls on a mesh that omits everything and none on a
   * mesh that supplies it all, and makes a draw depend on nothing but itself.
   */
  private readonly constants: { readonly location: number; readonly value: readonly number[] }[] =
    [];

  /**
   * How big this mesh is, in its own space.
   *
   * Measured here because the positions are already in hand: the upload walks them anyway, so a
   * caller gets bounds for nothing and no `MeshData` producer has to supply them. Everything that
   * wants to know whether this is on screen starts from this object.
   */
  readonly bounds: Bounds = createBounds();
  /** Whether this mesh carries a rig, which decides which flat program draws it. */
  readonly isSkinned: boolean;

  /**
   * This mesh's morph deltas, or null for geometry that does not deform.
   *
   * **Owned by the mesh rather than set per draw**, which is the difference between this and the
   * joint palette: a palette belongs to a *pose* and changes every frame, where deltas are
   * geometry and never change. Uploaded once with the vertex buffers; only the weights are
   * per-draw state.
   */
  readonly morph: MorphTexture | null;

  /**
   * Whether this mesh carries a tangent frame, for the shader that has to be told.
   *
   * The attribute cannot say so itself: `vertexDefaults.ts` supplies `[1, 0, 0, 1]` when it is
   * absent — a usable frame rather than a sentinel, because a zero tangent normalises to a NaN.
   * Read off the same branch below that chooses between the buffer and that constant.
   */
  readonly hasTangents: boolean;

  /**
   * Buffers allocated but not yet filled, in the order the constructor made them.
   *
   * Empty except between the steps of an incremental upload; `uploads` drains it and nothing
   * else touches it. Held as the source arrays rather than as copies, so spreading an upload
   * costs no memory — the caller's `MeshData` is alive until the last step either way.
   */
  private readonly pending: { target: number; buffer: WebGLBuffer; data: ArrayBufferView }[] = [];

  /** Set by the constructor before it allocates anything. See the `spread` parameter. */
  private readonly spread: boolean;

  /**
   * Whether all of this mesh's geometry has reached the device.
   *
   * False only between the steps of an incremental upload. **`drawMesh` refuses to draw an
   * incomplete mesh**, and that refusal is the contract: the buffers are allocated and zeroed
   * from the first frame, so drawing one would be a fan of degenerate triangles through the
   * origin. Drawing *what has landed* was the other option and is worse — a mesh whose triangle
   * count grows over several frames is a stranger artefact than a square that is briefly absent.
   */
  get complete(): boolean {
    return this.pending.length === 0;
  }

  /**
   * @param spread Allocate the buffers now and fill them from `uploads` later. Off by default,
   * and the default is the fast path: filling a buffer with `bufferData` in one call skips the
   * zero-fill that `bufferData(size)` then `bufferSubData` pays for, and every mesh in the
   * engine that does not need to be spread should keep skipping it.
   */
  constructor(gl: WebGL2RenderingContext, data: MeshData, dynamic = false, spread = false) {
    validateMeshData(data);
    this.spread = spread;
    boundsOfPositions(data.positions, this.bounds);
    this.positionFloats = data.positions.length;
    const vao = gl.createVertexArray();
    if (vao === null) throw new Error('createVertexArray failed');
    this.vao = vao;
    this.indexCount = data.indices.length;

    gl.bindVertexArray(vao);
    /*
     * `DYNAMIC_DRAW` where a consumer said the geometry moves, and only there. The hint is
     * advisory — a `STATIC_DRAW` buffer accepts `bufferSubData` perfectly well — but a driver
     * that has been told the truth can place the buffer where a rewrite is cheap, and a driver
     * that has been told a lie every frame is the shape of a stall nobody can find.
     */
    const usage = dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW;
    const positions = this.attachAttribute(gl, ATTR_POSITION, data.positions, 3, usage);
    const normals = this.attachAttribute(gl, ATTR_NORMAL, data.normals, 3, usage);
    if (dynamic) this.deformable = { positions, normals };
    this.attachAttribute(gl, ATTR_COLOR, data.colors, 3);
    this.attachAttribute(gl, ATTR_EMISSIVE, data.emissive, 1);
    /*
     * Absent means "not shiny", supplied as a constant rather than as a buffer of
     * zeroes. `vertexAttrib1f` sets the value a *disabled* attribute reads, so this
     * costs no buffer, no upload and no per-vertex fetch — which is what lets the
     * seventeen other places that build a mesh stay exactly as they are.
     */
    if (data.specular === undefined) {
      gl.disableVertexAttribArray(ATTR_SPECULAR);
      this.constants.push({ location: ATTR_SPECULAR, value: ABSENT_ATTRIBUTE['specular'] });
    } else {
      this.attachAttribute(gl, ATTR_SPECULAR, data.specular, 1);
    }
    /* Absent means "no surface texture", by the same constant-attribute trick. */
    if (data.uvs === undefined) {
      gl.disableVertexAttribArray(ATTR_UV);
      this.constants.push({ location: ATTR_UV, value: ABSENT_ATTRIBUTE['uvs'] });
    } else {
      this.attachAttribute(gl, ATTR_UV, data.uvs, 2);
    }

    /* Absent means "inherit albedo", supplied as the constant the shader tests for. */
    if (data.emissiveColor === undefined) {
      gl.disableVertexAttribArray(ATTR_EMISSIVE_COLOR);
      this.constants.push({
        location: ATTR_EMISSIVE_COLOR,
        value: ABSENT_ATTRIBUTE['emissiveColor'],
      });
    } else {
      this.attachAttribute(gl, ATTR_EMISSIVE_COLOR, data.emissiveColor, 3);
    }

    /* Absent means the engine's long-standing fixed lobe. See `roughness`. */
    if (data.roughness === undefined) {
      gl.disableVertexAttribArray(ATTR_ROUGHNESS);
      this.constants.push({ location: ATTR_ROUGHNESS, value: ABSENT_ATTRIBUTE['roughness'] });
    } else {
      this.attachAttribute(gl, ATTR_ROUGHNESS, data.roughness, 1);
    }

    /*
     * Absent means no grain at all, and that is the whole point of the attribute rather
     * than a default chosen for convenience: a surface that never says it is mineral is
     * not mineral. The two previous versions inferred it, and both inferences were wrong.
     */
    if (data.relief === undefined) {
      gl.disableVertexAttribArray(ATTR_RELIEF);
      this.constants.push({ location: ATTR_RELIEF, value: ABSENT_ATTRIBUTE['relief'] });
    } else {
      this.attachAttribute(gl, ATTR_RELIEF, data.relief, 1);
    }

    /*
     * Both or neither — `validateMeshData` refuses one without the other, so a mesh reaching here
     * with joints has weights. `isSkinned` is what decides which of the two flat programs a draw
     * takes; see `WebGL2Renderer.drawMesh`.
     */
    this.isSkinned = data.joints !== undefined;
    this.morph =
      data.morphTargets === undefined || data.morphTargetCount === undefined
        ? null
        : new MorphTexture(gl, data.morphTargets, data.positions.length / 3, data.morphTargetCount);
    if (data.joints === undefined || data.weights === undefined) {
      this.constants.push({ location: ATTR_JOINTS, value: ABSENT_ATTRIBUTE['joints'] });
      this.constants.push({ location: ATTR_WEIGHTS, value: ABSENT_ATTRIBUTE['weights'] });
    } else {
      this.attachAttribute(gl, ATTR_JOINTS, data.joints, 4);
      this.attachAttribute(gl, ATTR_WEIGHTS, data.weights, 4);
    }

    this.hasTangents = data.tangents !== undefined;
    if (data.tangents === undefined) {
      gl.disableVertexAttribArray(ATTR_TANGENT);
      this.constants.push({ location: ATTR_TANGENT, value: ABSENT_ATTRIBUTE['tangents'] });
    } else {
      this.attachAttribute(gl, ATTR_TANGENT, data.tangents, 4);
    }

    if (data.grain === undefined) {
      gl.disableVertexAttribArray(ATTR_GRAIN);
      this.constants.push({ location: ATTR_GRAIN, value: ABSENT_ATTRIBUTE['grain'] });
    } else {
      this.attachAttribute(gl, ATTR_GRAIN, data.grain, 1);
    }

    /*
     * Absent means planted, fully sunlit and opaque, by the same constant-attribute trick every
     * optional attribute above uses — no buffer, no upload, no per-vertex fetch. That is what
     * lets a mesh which never heard of this attribute cost exactly what it cost before, and it
     * is the property that ruled out folding the loose material floats into vec4s to buy the
     * location this spends.
     */
    if (data.channel === undefined) {
      gl.disableVertexAttribArray(ATTR_CHANNEL);
      this.constants.push({ location: ATTR_CHANNEL, value: ABSENT_ATTRIBUTE['channel'] });
    } else {
      this.attachAttribute(gl, ATTR_CHANNEL, data.channel, 4);
    }

    const indexBuffer = gl.createBuffer();
    if (indexBuffer === null) throw new Error('createBuffer failed');
    this.buffers.push(indexBuffer);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    this.allocate(gl, gl.ELEMENT_ARRAY_BUFFER, indexBuffer, data.indices, gl.STATIC_DRAW);

    gl.bindVertexArray(null);
  }

  /** Caller is responsible for having the flat program + uniforms bound. */
  draw(gl: WebGL2RenderingContext): void {
    gl.bindVertexArray(this.vao);
    // The VAO restores the arrays; these it cannot. See `constants`.
    for (const constant of this.constants) {
      const value = constant.value;
      applyConstant(gl, constant.location, value);
    }
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
  }

  /**
   * Bind one buffer's per-instance attributes to this mesh's vertex array.
   *
   * **One batch per mesh, and the vertex array is why.** A `Mesh` owns exactly one, so a second
   * batch would rebind locations 11 to 15 on the array the first still draws through — and what
   * comes out is one batch's instances placed by the other's matrices, which reads as a transform
   * bug in the consumer's own code rather than as a misuse of this.
   *
   * **What would make it wrong** is a consumer legitimately wanting two batches of one mesh,
   * which wants a vertex array per batch rather than a flag here.
   */
  attachInstances(gl: WebGL2RenderingContext, buffer: WebGLBuffer, stride: number): void {
    if (this.instanced) {
      throw new Error(
        'Mesh: this mesh already has an instanced batch — a Mesh owns one vertex array, so a ' +
          'second batch would rebind the attributes the first draws through.',
      );
    }
    this.instanced = true;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    /* Four vec4 columns then a vec3 tint: a mat4 is not a vertex attribute in GLSL ES 300. */
    for (let column = 0; column < 4; column += 1) {
      const location = 11 + column;
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 4, gl.FLOAT, false, stride, column * 16);
      gl.vertexAttribDivisor(location, 1);
    }
    gl.enableVertexAttribArray(15);
    gl.vertexAttribPointer(15, 3, gl.FLOAT, false, stride, 64);
    gl.vertexAttribDivisor(15, 1);
    gl.bindVertexArray(null);
  }

  /** Whether `attachInstances` has already claimed locations 11 to 15 on this mesh's array. */
  private instanced = false;

  /**
   * Draw `count` instances through the attributes `attachInstances` bound.
   *
   * The constants are re-applied exactly as `draw` does — a vertex array restores the arrays and
   * not the constant attributes, and an absent optional attribute is a constant here.
   */
  drawInstances(gl: WebGL2RenderingContext, count: number): void {
    gl.bindVertexArray(this.vao);
    for (const constant of this.constants) {
      const value = constant.value;
      applyConstant(gl, constant.location, value);
    }
    gl.drawElementsInstanced(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0, count);
  }

  dispose(gl: WebGL2RenderingContext): void {
    this.morph?.dispose(gl);
    for (const buffer of this.buffers) gl.deleteBuffer(buffer);
    gl.deleteVertexArray(this.vao);
  }

  /**
   * Rewrite this mesh's positions, and its normals where the caller has them.
   *
   * **Only the two attributes that move.** Colour, emissive and the rest describe what a surface
   * *is* and do not change because it bent; rewriting them would be uploading unchanged bytes
   * every frame. A caller with genuinely changing colour wants a second mesh or a tint.
   *
   * **The bounds are recomputed**, because everything that decides whether this is on screen
   * starts from them — a cloth that blew sideways out of its original box would be culled while
   * still visible, which is the kind of bug that only shows up at the edge of the frame.
   */
  update(gl: WebGL2RenderingContext, positions: Float32Array, normals?: Float32Array): void {
    if (this.deformable === null) {
      throw new Error(
        'this mesh was not created with { dynamic: true }, so its buffers are not set up to be ' +
          'rewritten. Say so at `createMesh` — the flag is what decides the buffer hint and ' +
          'what is kept to make an update possible.',
      );
    }
    if (positions.length !== this.positionFloats) {
      throw new Error(
        `this mesh has ${this.positionFloats / 3} vertices and the update has ` +
          `${positions.length / 3}. A mesh's vertex count is fixed at creation: the index buffer, ` +
          'the pipeline and every other attribute are sized against it.',
      );
    }
    boundsOfPositions(positions, this.bounds);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.deformable.positions);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, positions);
    if (normals !== undefined) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.deformable.normals);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, normals);
    }
  }

  private attachAttribute(
    gl: WebGL2RenderingContext,
    location: number,
    data: Float32Array,
    size: number,
    usage: number = gl.STATIC_DRAW,
  ): WebGLBuffer {
    const buffer = gl.createBuffer();
    if (buffer === null) throw new Error('createBuffer failed');
    this.buffers.push(buffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    this.allocate(gl, gl.ARRAY_BUFFER, buffer, data, usage);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    return buffer;
  }

  /**
   * Give a bound buffer its storage, and its contents now or later.
   *
   * The one place the two paths differ, and they differ in exactly one call: eagerly, the data
   * goes in with the allocation; spread, the allocation is sized and the array is queued. Both
   * hand the same bytes to the same buffer, which is what keeps a mesh that lands over six
   * frames identical to one that lands in a single call.
   */
  private allocate(
    gl: WebGL2RenderingContext,
    target: number,
    buffer: WebGLBuffer,
    data: ArrayBufferView,
    usage: number,
  ): void {
    if (!this.spread) {
      gl.bufferData(target, data as ArrayBufferView & { byteLength: number }, usage);
      return;
    }
    gl.bufferData(target, data.byteLength, usage);
    this.pending.push({ target, buffer, data });
  }

  /**
   * Fill the buffers, a bounded step at a time. Done when it returns `done`.
   *
   * A step is one attribute, or a slice of one where the attribute is bigger than
   * `UPLOAD_BYTES_PER_STEP`. **There is still no interleave here** — this backend's three tight
   * buffers are the reason a consumer measured the same drive as smooth on WebGL2 and hitching
   * on the other one, and dividing an upload is not a reason to give that up.
   *
   * The call that returns `done` is the one that does the last step's work, so a mesh of *n*
   * chunks takes exactly *n* calls.
   *
   * The vertex array object is bound around each step because one of these writes an index
   * buffer, and an `ELEMENT_ARRAY_BUFFER` binding belongs to whichever array object is current —
   * writing it with somebody else's bound would quietly repoint their indices at this mesh.
   */
  *uploads(gl: WebGL2RenderingContext): Generator<void, void, void> {
    const chunks: {
      target: number;
      buffer: WebGLBuffer;
      data: ArrayBufferView;
      from: number;
      to: number;
    }[] = [];
    for (const one of this.pending) {
      const width = (one.data as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1;
      const length = one.data.byteLength / width;
      const per = Math.max(1, Math.floor(UPLOAD_BYTES_PER_STEP / width));
      for (let from = 0; from < length; from += per) {
        chunks.push({ ...one, from, to: Math.min(from + per, length) });
      }
    }

    for (let at = 0; at < chunks.length; at++) {
      const chunk = chunks[at] as (typeof chunks)[number];
      const width = (chunk.data as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1;
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(chunk.target, chunk.buffer);
      gl.bufferSubData(
        chunk.target,
        chunk.from * width,
        chunk.data as ArrayBufferView & { byteLength: number },
        chunk.from,
        chunk.to - chunk.from,
      );
      gl.bindVertexArray(null);
      if (at < chunks.length - 1) yield;
    }

    this.pending.length = 0;
  }
}

/** A mesh on its way to the device, and the iterator that gets it there. */
export interface IncrementalMesh {
  /**
   * Usable at once — it can be held, measured and disposed — but not drawable until the upload
   * finishes. See `Mesh.complete`.
   */
  readonly mesh: Mesh;
  /** Advance the upload by one bounded step. Done when it returns `done`. */
  readonly upload: Iterator<void, void>;
}

/**
 * Upload a mesh over as many frames as the caller gives it.
 *
 * The twin of `createGpuMeshIncremental` on the other backend, and the cheaper of the two: there
 * is no interleave to divide here, so a step is an attribute or a slice of one.
 *
 * What is paid at creation and not spread: validation, the bounds, the vertex array object and
 * the allocations. The bounds are the deliberate one — a streamer places and culls a region from
 * them before a byte of it has landed.
 */
export function createMeshIncremental(
  gl: WebGL2RenderingContext,
  data: MeshData,
  dynamic = false,
): IncrementalMesh {
  const mesh = new Mesh(gl, data, dynamic, true);
  return { mesh, upload: mesh.uploads(gl) };
}

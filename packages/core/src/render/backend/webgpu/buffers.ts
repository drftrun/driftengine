import { boundsOfPositions, createBounds } from '../../../math/bounds.ts';
import type { Bounds } from '../../../math/bounds.ts';
import { MorphTexture } from './morphTexture.ts';
import { validateMeshData } from '../../mesh.ts';
import type { MeshData } from '../../mesh.ts';
import { ABSENT_ATTRIBUTE } from '../../vertexDefaults.ts';
import { UPLOAD_BYTES_PER_STEP } from '../../uploadStep.ts';
import { INSTANCE_STRIDE } from '../../instances.ts';

/**
 * Mesh geometry as WebGPU buffers.
 *
 * The vertex layout mirrors `mesh.ts` exactly, locations included, because both backends
 * draw from shaders generated out of the same GLSL. Renumbering an attribute here would
 * bind normals into the colour slot and produce a picture that is lit, plausible and wrong.
 */

/**
 * Buffer usage flags, named here rather than read off the `GPUBufferUsage` global.
 *
 * The values are normative in the WebGPU specification, so nothing is being guessed. The
 * global does not exist outside a browser, and depending on it would mean the buffer code
 * could only ever be exercised on a device — which is precisely the code most worth testing
 * without one.
 */
const USAGE = {
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  INDEX: 0x0010,
  VERTEX: 0x0020,
  UNIFORM: 0x0040,
} as const;

/**
 * Bytes reserved per absent attribute in the constants buffer.
 *
 * Sixteen so a `float32x3` starts aligned, and one slot each rather than all sharing offset
 * zero so a reader can see which zero belongs to which attribute.
 */
const CONSTANT_SLOT = 16;

/** One attribute of the flat vertex format, in the order and at the locations the shaders use. */
export interface VertexAttribute {
  readonly name: keyof MeshData | 'positions';
  readonly shaderLocation: number;
  readonly format: GPUVertexFormat;
  /** Floats per vertex. */
  readonly components: number;
  /** Whether a mesh may omit it, in which case a constant stands in. */
  readonly optional: boolean;
}

/**
 * Locations 0–9, matching `ATTR_POSITION` … `ATTR_RELIEF` in `mesh.ts`.
 *
 * **All ten, not the four that a simple mesh supplies.** WebGL2 lets the pipeline ignore an
 * attribute the shader declares but the mesh omits; WebGPU validates the whole vertex state
 * against the shader module and rejects the pipeline outright:
 *
 *     Vertex attribute slot 9 used in [flat.vert] is not present in the VertexState
 *
 * Six were listed here first, because six is what `Mesh` names in the obvious place. The
 * shader declares ten, and the four extra are exactly the ones added late enough to be easy
 * to miss: emissive colour, roughness, grain and relief.
 */
export const VERTEX_LAYOUT: readonly VertexAttribute[] = [
  { name: 'positions', shaderLocation: 0, format: 'float32x3', components: 3, optional: false },
  { name: 'normals', shaderLocation: 1, format: 'float32x3', components: 3, optional: false },
  { name: 'colors', shaderLocation: 2, format: 'float32x3', components: 3, optional: false },
  { name: 'emissive', shaderLocation: 3, format: 'float32', components: 1, optional: false },
  { name: 'specular', shaderLocation: 4, format: 'float32', components: 1, optional: true },
  { name: 'uvs', shaderLocation: 5, format: 'float32x2', components: 2, optional: true },
  { name: 'emissiveColor', shaderLocation: 6, format: 'float32x3', components: 3, optional: true },
  { name: 'roughness', shaderLocation: 7, format: 'float32', components: 1, optional: true },
  { name: 'grain', shaderLocation: 8, format: 'float32', components: 1, optional: true },
  { name: 'relief', shaderLocation: 9, format: 'float32', components: 1, optional: true },
  /* Four components, which makes it the widest the layout carries. See `generateTangents`. */
  { name: 'tangents', shaderLocation: 10, format: 'float32x4', components: 4, optional: true },
  /*
   * Skinning, at the two locations after the tangent. Thirteen of WebGL2's guaranteed sixteen are
   * now spoken for, which is the budget worth knowing before a fourteenth is proposed.
   *
   * **An instanced pipeline takes these two back**, and the channel below with them, because it
   * cannot skin and cannot bend — see `INSTANCE_ATTRIBUTES`, which is the list of what it reclaims.
   * That is the whole of the remaining budget: eleven base attributes plus five per-instance is
   * exactly sixteen, and there is no room for a fourteenth base attribute and instancing at the
   * same time. The channel below is that fourteenth attribute, and it is refused on an instanced
   * draw for exactly this arithmetic.
   */
  { name: 'joints', shaderLocation: 11, format: 'float32x4', components: 4, optional: true },
  { name: 'weights', shaderLocation: 12, format: 'float32x4', components: 4, optional: true },
  /*
   * The four-lane per-vertex channel: sway, skyDirect, alpha, and one reserved.
   *
   * **Fourteen of WebGL2's guaranteed sixteen are now spoken for, and this is the attribute that
   * made the budget bite.** Eleven base attributes plus five per-instance is exactly sixteen, so
   * an instanced draw has nothing to spare and a mesh carrying this cannot be drawn through that
   * path — `flatVert` refuses the pair rather than dropping the attribute silently.
   *
   * Four components for the price of the one location a `float` would have cost, which is why
   * three lanes and a spare live here instead of three attributes that do not fit.
   */
  { name: 'channel', shaderLocation: 13, format: 'float32x4', components: 4, optional: true },
  /*
   * The fifth to eighth influences, at the last two locations. Only a skinned variant reads them,
   * and only with `SKIN_EIGHT` on; every other mesh is fed zeros by the constants buffer. An
   * instanced pipeline reclaims 14 and 15 with the rest of 11 to 15, as `INSTANCE_LOCATIONS` says.
   */
  { name: 'joints2', shaderLocation: 14, format: 'float32x4', components: 4, optional: true },
  { name: 'weights2', shaderLocation: 15, format: 'float32x4', components: 4, optional: true },
];

/** Geometry on the device, with the buffers bound in layout order. */
/**
 * The texture coordinates of a mesh that names texture-array layers: (u, v, layer), three floats.
 *
 * **Three only where layers exist.** Every location is spent, so the layer rides in this attribute,
 * and widening it for every textured mesh would add four bytes to each of its vertices for nothing.
 * A mesh without layers keeps two, and the shader's `vec3` input reads z as 0 — WebGPU fills a
 * component the format does not carry with 0 (and w with 1) — which is layer 0. The pipeline key
 * carries `:layers`, so the two vertex layouts never share a pipeline.
 */
export const LAYERED_UVS: VertexAttribute = {
  name: 'uvs',
  shaderLocation: 5,
  format: 'float32x3',
  components: 3,
  optional: true,
};

/** The attribute as this mesh lays it out: the UV field widens where the mesh names layers. */
function laidOut(attribute: VertexAttribute, layered: boolean): VertexAttribute {
  return layered && attribute.name === 'uvs' ? LAYERED_UVS : attribute;
}

export interface GpuMesh {
  /**
   * The buffers a draw binds, in the order `vertexBufferLayouts` describes them.
   *
   * **Two, and the first is interleaved** — every attribute this mesh actually supplied, woven
   * into one stride — while the second holds one value per *absent* optional attribute at a stride
   * of zero. **A dynamic mesh has four**: its positions and its normals, each a buffer of its own so
   * `update` writes them alone, then the interleaved rest and the constants. It is emphatically not one buffer per attribute, which this comment said until
   * 2026-09-17 and which cost the motion pass an afternoon: a pipeline built to that description
   * reads a position out of every twelve bytes of an interleaved vertex, draws geometry that is
   * not the mesh, and fails no validation at all.
   */
  readonly vertexBuffers: readonly GPUBuffer[];
  /**
   * Bytes a vertex takes in the first of those buffers: the interleaved stride, or twelve for a
   * dynamic mesh, whose first buffer is its positions.
   *
   * Kept because it is a function of which *optional* attributes this mesh supplied, so it differs
   * between two meshes drawn by the same pipeline — and a pass that reads only the position still
   * has to step by the whole of it. `submitMesh` never needs it, the generated pipelines being
   * keyed by the same `present` map that decides it; anything drawing a mesh through a shader of
   * its own does.
   */
  readonly vertexStride: number;
  /**
   * Byte offsets of the joint indices and weights in the interleaved vertex, or null for a mesh
   * that supplied neither. For a pass that skins through a shader of its own — the motion pass —
   * which has to find them without the `present` map the generated pipelines are keyed by.
   *
   * **Null on a dynamic mesh too**, whose first buffer holds positions alone: the motion pass reads
   * joints from that buffer, so a dynamic skinned mesh's motion between rewrites is its model's
   * rather than its pose's. A rewrite carries its own motion, from last frame's positions.
   */
  readonly skinOffsets: {
    readonly joints: number;
    readonly weights: number;
    /** The second four influences' offsets, or -1 for a mesh with four. */
    readonly joints2: number;
    readonly weights2: number;
  } | null;
  readonly indexBuffer: GPUBuffer;
  /**
   * How many indices the mesh draws. **Zero is a mesh with nothing to draw, and no pass draws it**:
   * a level can hold none of some kind of geometry, and a draw of zero indices does nothing but
   * earn a warning from the device in every pass that issues it. Every place a mesh enters a pass
   * checks this beside `complete` or its vertex buffers, and WebGL2 skips the same meshes, so the
   * two backends count the same draws.
   */
  readonly indexCount: number;
  /**
   * How big this mesh is, in its own space.
   *
   * Measured here because the positions are already in hand: an upload walks them anyway, so a
   * caller gets bounds for nothing and no `MeshData` producer has to supply them. Everything
   * that wants to know whether this is on screen starts from this object.
   */
  readonly bounds: Bounds;
  /**
   * Whether all of this mesh's geometry has reached the device.
   *
   * False only between the steps of an incremental upload; a mesh made by `createGpuMesh` is
   * complete before the call returns. **`submitMesh` refuses to draw an incomplete one**, and
   * that refusal is the contract: the alternative — drawing what has landed — is a mesh whose
   * triangle count grows over several frames, which is a worse artefact than a square that is
   * briefly not there. A consumer that never drives the iterator therefore sees nothing rather
   * than a fan of triangles through the origin.
   *
   * It is also how an abandoned upload is told from a finished one: a lost device ends the
   * iterator, and a mesh that is done but not complete is one whose geometry never arrived.
   */
  readonly complete: boolean;
  /**
   * Whether this mesh carries a tangent frame.
   *
   * WebGPU has no disabled attribute, so location 10 is always backed — by the caller's data or by
   * the constant buffer. That makes the binding indistinguishable from a real frame, exactly as it
   * is on WebGL2, so the fact travels beside the mesh rather than being read off the GPU.
   */
  readonly hasTangents: boolean;
  /**
   * Whether this mesh carries a rig, which decides the vertex variant a draw takes.
   *
   * The twin of `Mesh.isSkinned` on the other backend. Recorded at upload rather than derived at
   * draw time from the `present` map, because the draw needs it to build its pipeline *key* — and
   * the key is built before the present map is consulted.
   */
  readonly isSkinned: boolean;
  /** Whether its rig moves a vertex by eight influences, which keys a pipeline with `SKIN_EIGHT`. */
  readonly isSkinnedEight: boolean;
  /** How many vertices it has, which a cloth binding is checked against. */
  readonly vertexCount: number;
  /** Whether it has texture coordinates, without which a material's maps read one texel. */
  readonly hasUvs: boolean;
  /**
   * Whether this mesh carries the per-vertex channel, which an instanced draw cannot.
   *
   * The twin of `MeshData.channel !== undefined` on the other backend, where `InstancedMesh`
   * refuses it at construction. Recorded rather than derived at draw time for the same reason
   * `isSkinned` is: the refusal happens at `createInstanced`, which holds the mesh and not the
   * data it was built from.
   */
  readonly hasChannel: boolean;
  /**
   * This mesh's morph deltas, or null for geometry that does not deform.
   *
   * Owned by the mesh for the reason the WebGL2 twin gives: deltas are geometry and never change,
   * where a palette belongs to a pose. Only the weights are per-draw state.
   */
  readonly morph: MorphTexture | null;
  /**
   * Rewrite this mesh's positions, and its normals where the caller has them.
   *
   * Absent unless the mesh was created `dynamic`. **A dynamic mesh's positions and normals are
   * buffers of their own**, so this is one `writeBuffer` of the caller's positions and one of its
   * normals, and nothing else moves. Until 4.8.4 every attribute was interleaved into one buffer,
   * and a dynamic mesh kept a CPU copy of it to patch and upload whole — a garment's colours,
   * coordinates, tangents and joints re-sent every frame for the twenty-four bytes a vertex that
   * changed, reported at 2.8 MB a frame for one character. What the split costs is a pipeline per
   * layout, keyed by `:dynamic`, and two more buffers bound per draw of such a mesh.
   */
  readonly update:
    | ((
        device: GPUDevice,
        positions: Float32Array,
        normals?: Float32Array,
        previous?: GPUBuffer | null,
      ) => void)
    | null;
  /**
   * A dynamic mesh's motion state, which the renderer owns: a buffer for last frame's positions,
   * made the first time a reconstructing renderer rewrites the mesh, and the frame of the last
   * rewrite. Null on a mesh created without `{ dynamic: true }`, which never moves a vertex.
   */
  readonly motion: { previous: GPUBuffer | null; changed: number } | null;
  dispose(): void;
}

/** A mesh on its way to the device, and the iterator that gets it there. */
export interface IncrementalGpuMesh {
  /**
   * Usable at once — it can be held, measured and disposed — but not drawable until the upload
   * finishes. See `GpuMesh.complete`.
   */
  readonly mesh: GpuMesh;
  /**
   * Advance the upload by one bounded step. Done when it returns `done`.
   *
   * The call that returns `done` is the one that does the last step's work, not an empty call
   * after it, so a mesh of *n* chunks takes exactly *n* calls and a caller counting stops counts
   * the right number.
   */
  readonly upload: Iterator<void, void>;
}

/**
 * Upload a mesh, all of it, now.
 *
 * The whole of `createGpuMeshIncremental` driven to the end in one call — deliberately, so the
 * two paths cannot write different bytes. The one that spreads the work is the one with the
 * interesting decisions in it; read that.
 */
export function createGpuMesh(device: GPUDevice, data: MeshData, dynamic = false): GpuMesh {
  const { mesh, upload } = createGpuMeshIncremental(device, data, dynamic);
  while (upload.next().done !== true);
  return mesh;
}

/**
 * Upload a mesh over as many frames as the caller gives it.
 *
 * **The absent-attribute trick is the interesting part.** WebGL2 lets an attribute be
 * *disabled* and read a constant the driver supplies, which is why `mesh.ts` can leave
 * `specular` and `uvs` off entirely and a world with no shiny or textured geometry uploads
 * nothing for them. WebGPU has no disabled attribute: every location in a vertex layout must
 * be backed by a buffer.
 *
 * `arrayStride: 0` is the equivalent and it is exact. A stride of zero means every vertex
 * reads element zero, so a one-element buffer of zeroes serves a mesh of any size. Eight
 * bytes, allocated per mesh that omits the attribute, and **no shader variant** — which is
 * what keeps both backends drawing from one generated set of WGSL instead of two.
 *
 * **Why the work is divisible here and not on the other backend.** This one interleaves every
 * vertex on the CPU into a new array before it writes anything, where `mesh.ts` skips the
 * interleave in favour of three tight buffers and says so in its first line. So the cost is
 * WebGPU's alone and proportional to geometry, which is why a consumer measured the same drive
 * as smooth on WebGL2 and hitching here.
 *
 * **What is paid at creation and not spread:** validation, the bounds, the allocation of the
 * interleave array, the three buffers, and the constants. The bounds are the deliberate one — a
 * streamer places and culls a region from them before a byte of it has landed, so a handle whose
 * bounds were not yet known would not be usable at once, which is the whole promise here.
 */
export function createGpuMeshIncremental(
  device: GPUDevice,
  data: MeshData,
  dynamic = false,
): IncrementalGpuMesh {
  /*
   * The other backend's refusal, and the premise of the interleave below: every attribute holds
   * exactly a vertex's worth for every vertex, so nothing reads past the end of its array.
   */
  validateMeshData(data);
  const bounds = boundsOfPositions(data.positions, createBounds());
  const vertexCount = data.positions.length / 3;
  const layered = data.layers !== undefined;
  const supplied = VERTEX_LAYOUT.filter(
    (attribute) =>
      (!attribute.optional || data[attribute.name as keyof MeshData] !== undefined) &&
      !(dynamic && isStreamed(attribute)),
  ).map((attribute) => laidOut(attribute, layered));

  /* Interleaved: one stride holding every attribute the mesh actually supplied — less a dynamic
     mesh's positions and normals, which are buffers of their own. */
  const stride = supplied.reduce((sum, attribute) => sum + attribute.components * 4, 0);
  const step = stride / 4;
  const interleaved = new Float32Array(step * vertexCount);

  /*
   * **Refused here, in one sentence, rather than by the driver a hundred times.**
   *
   * A buffer past `maxBufferSize` is not created; what comes back is an invalid buffer, and
   * every command encoder that so much as binds it is invalidated too. The result is the
   * console reported from outside: one line naming the real cause, then a hundred and
   * twenty-five repeats of *"is invalid due to a previous error"* from the shadow pass and the
   * frame, with the actual number buried at the top and the model simply missing.
   *
   * `select.ts` asks for the adapter's own ceiling, which is 4 GiB on the part this was measured
   * on against a 256 MiB default, so the models that hit this now load. What is left is the part
   * whose adapter caps at the default, and it deserves a sentence naming the model's size and
   * the device's rather than a wall of validation.
   */
  const byteLength = align4(interleaved.byteLength);
  const ceiling = device.limits.maxBufferSize;
  if (typeof ceiling === 'number' && byteLength > ceiling) {
    throw new Error(
      `this mesh needs a ${Math.round(byteLength / 1024 / 1024)} MB vertex buffer and this GPU ` +
        `allows ${Math.round(ceiling / 1024 / 1024)} MB, so it cannot be drawn. A model this ` +
        'large has to be split or simplified before it is baked.',
    );
  }
  const vertices = device.createBuffer({
    label: 'mesh.vertices',
    size: byteLength,
    usage: USAGE.VERTEX | USAGE.COPY_DST,
  });

  /*
   * One buffer holding what each omitted attribute reads as, at its own offset and read with a
   * stride of zero. Ninety-six bytes at most, whatever the mesh's size, so it is written now
   * rather than spread.
   *
   * **The values come from `vertexDefaults.ts` and are not all zero.** They were zeroes here,
   * against the constants `mesh.ts` hands WebGL2, and `emissiveColor` is the one that bit:
   * `flat.ts` treats a negative red as "inherit the albedo", so a zero meant *glow black* and
   * every emissive surface whose mesh omitted the attribute stopped emitting on this backend.
   */
  const constants = device.createBuffer({
    label: 'mesh.constants',
    size: CONSTANT_SLOT * VERTEX_LAYOUT.length,
    usage: USAGE.VERTEX | USAGE.COPY_DST,
  });
  const absent = new Float32Array((CONSTANT_SLOT / 4) * VERTEX_LAYOUT.length);
  for (let slot = 0; slot < VERTEX_LAYOUT.length; slot++) {
    const attribute = VERTEX_LAYOUT[slot] as VertexAttribute;
    const value = ABSENT_ATTRIBUTE[attribute.name];
    if (value === undefined) continue;
    absent.set(value, slot * (CONSTANT_SLOT / 4));
  }
  device.queue.writeBuffer(constants, 0, absent);

  const indexBuffer = device.createBuffer({
    label: 'mesh.indices',
    size: align4(data.indices.byteLength),
    usage: USAGE.INDEX | USAGE.COPY_DST,
  });

  /* A dynamic mesh's two moving streams: copied from as well as written, for last frame's positions. */
  const streamBytes = align4(vertexCount * 12);
  const streams = dynamic
    ? {
        positions: device.createBuffer({
          label: 'mesh.positions',
          size: streamBytes,
          usage: USAGE.VERTEX | USAGE.COPY_DST | USAGE.COPY_SRC,
        }),
        normals: device.createBuffer({
          label: 'mesh.normals',
          size: streamBytes,
          usage: USAGE.VERTEX | USAGE.COPY_DST,
        }),
      }
    : null;

  /*
   * The chunks, in whole vertices and whole indices: a step never writes half of either, so the
   * buffer never holds a torn one even for the frame between two steps.
   */
  const verticesPerStep = Math.max(
    1,
    Math.floor(UPLOAD_BYTES_PER_STEP / (stride + (dynamic ? 24 : 0))),
  );
  const indexWidth = data.indices.BYTES_PER_ELEMENT;
  const indicesPerStep = Math.max(1, Math.floor(UPLOAD_BYTES_PER_STEP / indexWidth));
  const totalSteps =
    Math.max(1, Math.ceil(vertexCount / verticesPerStep)) +
    Math.max(1, Math.ceil(data.indices.length / indicesPerStep));

  /*
   * **The mesh is assembled out here, by functions of its own, and that is the fix for a copy
   * nobody named.** It was an object literal in this scope, and its `complete` getter shared this
   * scope's context with the upload generator and the `filter` above, which both read `data` — V8
   * gives every closure in a scope one context — so a getter returning a boolean held the whole
   * `MeshData` and the interleaved rows for as long as the mesh lived. The voxel sandbox's forward
   * path held 2,058 MB of ArrayBuffers at radius 32 against the second pipeline's 368.
   * `meshRetention.test.ts` holds it: a mesh keeps its buffers, and a dynamic one its rows.
   */
  const progress = { uploaded: false };
  const mesh = gpuMeshOf({
    vertices,
    constants,
    streams,
    indexBuffer,
    stride: streams === null ? stride : 12,
    indexCount: data.indices.length,
    bounds,
    progress,
    hasTangents: data.tangents !== undefined,
    isSkinned: data.joints !== undefined,
    isSkinnedEight: data.joints !== undefined && data.joints2 !== undefined,
    vertexCount,
    hasUvs: data.uvs !== undefined,
    skinOffsets: streams === null ? skinOffsetsOf(supplied) : null,
    hasChannel: data.channel !== undefined,
    morph:
      data.morphTargets === undefined || data.morphTargetCount === undefined
        ? null
        : new MorphTexture(
            device,
            data.morphTargets,
            data.positions.length / 3,
            data.morphTargetCount,
          ),
    update:
      streams === null
        ? null
        : streamUpdate(streams.positions, streams.normals, streamBytes, bounds, vertexCount),
  });

  const job: UploadJob = {
    data,
    interleaved,
    device,
    supplied,
    streams,
    vertices,
    indexBuffer,
    vertexCount,
    step,
    stride,
    verticesPerStep,
    indicesPerStep,
    totalSteps,
    progress,
  };
  return { mesh, upload: uploadSteps(job) };
}

/**
 * What an upload reads, held by the upload alone and let go when it finishes — so a caller that
 * keeps its iterator, as a streamer keeps the handle it was given, keeps nothing through it.
 */
interface UploadJob {
  data: MeshData | null;
  interleaved: Float32Array | null;
  readonly device: GPUDevice;
  readonly supplied: readonly VertexAttribute[];
  readonly streams: { readonly positions: GPUBuffer; readonly normals: GPUBuffer } | null;
  readonly vertices: GPUBuffer;
  readonly indexBuffer: GPUBuffer;
  readonly vertexCount: number;
  readonly step: number;
  readonly stride: number;
  readonly verticesPerStep: number;
  readonly indicesPerStep: number;
  readonly totalSteps: number;
  readonly progress: { uploaded: boolean };
}

function* uploadSteps(job: UploadJob): Generator<void, void, void> {
  const { device, supplied, vertices, indexBuffer, vertexCount, step, stride } = job;
  let taken = 0;
  for (let from = 0; from < vertexCount; from += job.verticesPerStep) {
    const data = job.data as MeshData;
    const interleaved = job.interleaved as Float32Array;
    const to = Math.min(from + job.verticesPerStep, vertexCount);
    let fieldOffset = 0;
    for (const attribute of supplied) {
      const source = data[attribute.name as keyof MeshData] as Float32Array;
      if (attribute === LAYERED_UVS) {
        /* (u, v) from the coordinates and the layer after them, one field of three. */
        interleaveField(interleaved, source, 2, step, fieldOffset, from, to);
        interleaveField(
          interleaved,
          data.layers as Float32Array,
          1,
          step,
          fieldOffset + 2,
          from,
          to,
        );
      } else {
        interleaveField(interleaved, source, attribute.components, step, fieldOffset, from, to);
      }
      fieldOffset += attribute.components;
    }
    device.queue.writeBuffer(vertices, from * stride, interleaved, from * step, (to - from) * step);
    if (job.streams !== null) {
      const count = (to - from) * 3;
      device.queue.writeBuffer(job.streams.positions, from * 12, data.positions, from * 3, count);
      device.queue.writeBuffer(job.streams.normals, from * 12, data.normals, from * 3, count);
    }
    taken += 1;
    if (taken < job.totalSteps) yield;
  }

  const indices = (job.data as MeshData).indices;
  const indexWidth = indices.BYTES_PER_ELEMENT;
  for (let from = 0; from < indices.length; from += job.indicesPerStep) {
    const to = Math.min(from + job.indicesPerStep, indices.length);
    device.queue.writeBuffer(indexBuffer, from * indexWidth, indices, from, to - from);
    taken += 1;
    if (taken < job.totalSteps) yield;
  }

  job.data = null;
  job.interleaved = null;
  job.progress.uploaded = true;
}

/**
 * One attribute of vertices `from` to `to` into its field of the interleaved rows.
 *
 * **Unrolled by width, because the general loop was most of a heavy load's upload.** A loop over
 * components inside a loop over vertices, with the index recomputed from both, cost 1.5 s of main
 * thread on a courtyard of five packs; a loop per width walking two cursors does the same writes in
 * about a third of the time, measured on four million vertices in Node. Every width the layout
 * carries is one, two, three or four, so the last arm is the one-float case and nothing else.
 */
function interleaveField(
  rows: Float32Array,
  source: Float32Array,
  width: number,
  step: number,
  fieldOffset: number,
  from: number,
  to: number,
): void {
  let write = from * step + fieldOffset;
  const end = to * width;
  if (width === 3) {
    for (let read = from * 3; read < end; read += 3, write += step) {
      rows[write] = source[read] as number;
      rows[write + 1] = source[read + 1] as number;
      rows[write + 2] = source[read + 2] as number;
    }
  } else if (width === 4) {
    for (let read = from * 4; read < end; read += 4, write += step) {
      rows[write] = source[read] as number;
      rows[write + 1] = source[read + 1] as number;
      rows[write + 2] = source[read + 2] as number;
      rows[write + 3] = source[read + 3] as number;
    }
  } else if (width === 2) {
    for (let read = from * 2; read < end; read += 2, write += step) {
      rows[write] = source[read] as number;
      rows[write + 1] = source[read + 1] as number;
    }
  } else {
    for (let read = from; read < end; read++, write += step) rows[write] = source[read] as number;
  }
}

/**
 * Where the joints and weights sit in a vertex of `supplied`, the attributes a mesh interleaves in
 * layout order; null unless it supplied both.
 */
function skinOffsetsOf(supplied: readonly VertexAttribute[]): GpuMesh['skinOffsets'] {
  let floats = 0;
  let joints = -1;
  let weights = -1;
  let joints2 = -1;
  let weights2 = -1;
  for (const attribute of supplied) {
    if (attribute.name === 'joints') joints = floats * 4;
    if (attribute.name === 'weights') weights = floats * 4;
    if (attribute.name === 'joints2') joints2 = floats * 4;
    if (attribute.name === 'weights2') weights2 = floats * 4;
    floats += attribute.components;
  }
  if (joints < 0 || weights < 0) return null;
  return joints2 >= 0 && weights2 >= 0
    ? { joints, weights, joints2, weights2 }
    : { joints, weights, joints2: -1, weights2: -1 };
}

/** The handle, made where it can see only what it hands out. */
function gpuMeshOf(parts: {
  readonly vertices: GPUBuffer;
  readonly constants: GPUBuffer;
  readonly streams: { readonly positions: GPUBuffer; readonly normals: GPUBuffer } | null;
  readonly indexBuffer: GPUBuffer;
  readonly stride: number;
  readonly indexCount: number;
  readonly bounds: Bounds;
  readonly progress: { readonly uploaded: boolean };
  readonly hasTangents: boolean;
  readonly isSkinned: boolean;
  readonly isSkinnedEight: boolean;
  readonly vertexCount: number;
  readonly hasUvs: boolean;
  readonly skinOffsets: GpuMesh['skinOffsets'];
  readonly hasChannel: boolean;
  readonly morph: MorphTexture | null;
  readonly update: GpuMesh['update'];
}): GpuMesh {
  const motion = parts.update === null ? null : { previous: null as GPUBuffer | null, changed: -1 };
  const { vertices, constants, streams, indexBuffer, progress } = parts;
  return {
    vertexBuffers:
      streams === null
        ? [vertices, constants]
        : [streams.positions, streams.normals, vertices, constants],
    vertexStride: parts.stride,
    skinOffsets: parts.skinOffsets,
    indexBuffer,
    indexCount: parts.indexCount,
    bounds: parts.bounds,
    get complete(): boolean {
      return progress.uploaded;
    },
    hasTangents: parts.hasTangents,
    isSkinned: parts.isSkinned,
    isSkinnedEight: parts.isSkinnedEight,
    vertexCount: parts.vertexCount,
    hasUvs: parts.hasUvs,
    hasChannel: parts.hasChannel,
    morph: parts.morph,
    update: parts.update,
    motion,
    dispose(): void {
      motion?.previous?.destroy();
      streams?.positions.destroy();
      streams?.normals.destroy();
      vertices.destroy();
      constants.destroy();
      indexBuffer.destroy();
    },
  };
}

/** Whether an attribute is one a dynamic mesh keeps in a buffer of its own. */
function isStreamed(attribute: VertexAttribute): boolean {
  return attribute.name === 'positions' || attribute.name === 'normals';
}

/**
 * A dynamic mesh's `update`: the caller's positions, and its normals where it has them, each
 * written to its own buffer as it came. Last frame's positions, where a reconstruction wants them,
 * are copied on the device before the write — a copy submitted ahead of a `writeBuffer` runs ahead
 * of it on the queue — so no CPU copy of anything is kept.
 */
function streamUpdate(
  positionsBuffer: GPUBuffer,
  normalsBuffer: GPUBuffer,
  streamBytes: number,
  bounds: Bounds,
  vertexCount: number,
): NonNullable<GpuMesh['update']> {
  return (
    target: GPUDevice,
    positions: Float32Array,
    normals?: Float32Array,
    previous: GPUBuffer | null = null,
  ): void => {
    for (const [name, values] of [
      ['update', positions],
      ['normals', normals],
    ] as const) {
      if (values === undefined || values.length === vertexCount * 3) continue;
      throw new Error(
        `this mesh has ${vertexCount} vertices and the ${name} has ${values.length / 3}. ` +
          "A mesh's vertex count is fixed at creation: the index buffer, the pipeline and " +
          'every other attribute are sized against it.',
      );
    }
    if (previous !== null) {
      const encoder = target.createCommandEncoder({ label: 'mesh.previousPositions' });
      encoder.copyBufferToBuffer(positionsBuffer, 0, previous, 0, streamBytes);
      target.queue.submit([encoder.finish()]);
    }
    /* Everything that decides whether this is on screen starts from the bounds, so a cloth
       that blew sideways out of its original box would be culled while still visible. */
    boundsOfPositions(positions, bounds);
    target.queue.writeBuffer(positionsBuffer, 0, positions);
    if (normals !== undefined) target.queue.writeBuffer(normalsBuffer, 0, normals);
  };
}

/**
 * The buffer layouts a pipeline is built with, matching what `createGpuMesh` uploaded.
 *
 * `present` says which optional attributes came from real data. An absent one gets a stride
 * of zero so every vertex reads the single element written for it.
 */
/**
 * The per-instance buffer's five attributes: four matrix columns and a tint.
 *
 * **One list, because it answers two questions that must not disagree** — which locations the
 * instance buffer declares, and therefore which locations a base attribute may not also declare.
 * They were two lists: this one, and a `shaderLocation === 11 || shaderLocation === 12` test a few
 * lines below it. That is what shipped a duplicate location 13 the day the per-vertex channel took
 * it — every instanced pipeline, in the colour pass and the shadow pass alike, rejected with
 * *"attribute shader location (13) is used more than once"*, which surfaces as an invalid command
 * buffer two calls later rather than as anything about attributes.
 *
 * `INSTANCE_STRIDE` and the offsets are shared with the other backend through `instances.ts`,
 * because which floats go where is a decision rather than a binding.
 */
const INSTANCE_ATTRIBUTES: GPUVertexAttribute[] = [
  { shaderLocation: 11, offset: 0, format: 'float32x4' },
  { shaderLocation: 12, offset: 16, format: 'float32x4' },
  { shaderLocation: 13, offset: 32, format: 'float32x4' },
  { shaderLocation: 14, offset: 48, format: 'float32x4' },
  /* The tint and, in w, the opacity. See `INSTANCE_FLOATS`. */
  { shaderLocation: 15, offset: 64, format: 'float32x4' },
];

/** The locations above, as the set the base layout must stand clear of on an instanced draw. */
const INSTANCE_LOCATIONS: ReadonlySet<number> = new Set(
  INSTANCE_ATTRIBUTES.map((attribute) => attribute.shaderLocation),
);

export function vertexBufferLayouts(
  present: Readonly<Record<string, boolean>>,
  /**
   * Whether a third buffer carries one placement and colour per instance.
   *
   * Appended rather than woven in, at `stepMode: 'instance'`, so an instanced pipeline binds the
   * mesh's own two buffers unchanged and its batch's third. The flat pipeline binds two of a
   * limit of eight, so there is room, and a mesh needs no second upload to be instanced.
   */
  instanced = false,
): GPUVertexBufferLayout[] {
  const interleaved: GPUVertexAttribute[] = [];
  const constants: GPUVertexAttribute[] = [];
  let offset = 0;

  const layered = present['layers'] === true;
  /* A dynamic mesh's positions and normals: buffers of their own, ahead of the rest. */
  const dynamic = present['dynamic'] === true;
  const layouts: GPUVertexBufferLayout[] = [];
  VERTEX_LAYOUT.forEach((declared, index) => {
    const attribute = laidOut(declared, layered);
    if (dynamic && isStreamed(attribute)) {
      layouts.push({
        arrayStride: attribute.components * 4,
        attributes: [
          { shaderLocation: attribute.shaderLocation, offset: 0, format: attribute.format },
        ],
      });
      return;
    }
    /*
     * **The instanced pipeline reclaims the two skinning locations, and it is allowed to because
     * it cannot skin.** Locations 11 and 12 are the joint indices and weights; the INSTANCED
     * shader variant declares neither, and the flat pass refuses a variant that is both. Leaving
     * them declared here is what the device rejected — *"attribute shader location (11) is used
     * more than once"*, reported at pipeline creation and surfacing as an invalid command buffer
     * two calls later.
     *
     * Free for any mesh that may legitimately be instanced: an unskinned mesh supplies neither,
     * so both sit in the constants buffer at `arrayStride: 0` and dropping them moves no offset
     * in the interleaved one. A *skinned* mesh interleaves them, so removing them would shift
     * the stride under every other attribute — which is why `createInstanced` refuses one.
     */
    const supplied = !attribute.optional || present[String(attribute.name)] === true;
    if (instanced && INSTANCE_LOCATIONS.has(attribute.shaderLocation)) {
      /*
       * **Free to drop only because the mesh does not supply it.** An absent optional attribute
       * sits in the constants buffer at `arrayStride: 0`, so removing it moves no offset in the
       * interleaved one. A *supplied* one is interleaved, and dropping that would shift the stride
       * under every attribute after it and draw scrambled geometry — which is why `createInstanced`
       * refuses a skinned mesh and a channelled one. This is the same refusal one level down,
       * where it cannot be reached around: a caller that finds another way to an instanced layout
       * gets an error rather than a picture.
       */
      if (supplied) {
        throw new Error(
          `vertexBufferLayouts: an instanced pipeline claims attribute location ` +
            `${attribute.shaderLocation} for its per-instance buffer, and this mesh supplies ` +
            `"${String(attribute.name)}" there. Dropping a supplied attribute would shift the ` +
            `stride under every attribute after it — draw this mesh without instancing instead.`,
        );
      }
      return;
    }
    if (supplied) {
      interleaved.push({
        shaderLocation: attribute.shaderLocation,
        offset,
        format: attribute.format,
      });
      offset += attribute.components * 4;
      return;
    }
    constants.push({
      shaderLocation: attribute.shaderLocation,
      offset: index * CONSTANT_SLOT,
      format: attribute.format,
    });
  });

  layouts.push({ arrayStride: offset, attributes: interleaved });
  /*
   * The constants buffer is always bound, even with nothing in it: the pipeline layout has
   * to match the buffers a draw sets, and a mesh supplying every attribute would otherwise
   * need a different layout from one that does not.
   */
  layouts.push({ arrayStride: 0, attributes: constants });
  /*
   * The four matrix columns and the tint — the five the flat shader's INSTANCED variant declares
   * and exactly the five left once the base mesh has spent eleven of WebGL2's guaranteed sixteen.
   * See `INSTANCE_ATTRIBUTES`, which the filter above reads too.
   */
  if (instanced) {
    layouts.push({
      arrayStride: INSTANCE_STRIDE,
      stepMode: 'instance',
      attributes: INSTANCE_ATTRIBUTES,
    });
  }
  return layouts;
}

/** WebGPU requires a buffer size that is a multiple of four. */
function align4(bytes: number): number {
  return Math.max(4, Math.ceil(bytes / 4) * 4);
}

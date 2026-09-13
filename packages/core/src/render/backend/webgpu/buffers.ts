import { boundsOfPositions, createBounds } from '../../../math/bounds.ts';
import type { Bounds } from '../../../math/bounds.ts';
import { MorphTexture } from './morphTexture.ts';
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
];

/** Geometry on the device, with the buffers bound in layout order. */
export interface GpuMesh {
  /** One buffer per attribute, indexed by position in `VERTEX_LAYOUT`. */
  readonly vertexBuffers: readonly GPUBuffer[];
  readonly indexBuffer: GPUBuffer;
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
   * Absent unless the mesh was created `dynamic`. **This backend interleaves every attribute into
   * one buffer**, so a position is not contiguous with the next one — writing them individually
   * would be one `writeBuffer` per vertex. So a dynamic mesh keeps the interleaved array it was
   * built from, patches the two fields that move, and uploads the lot in one call. The cost is
   * one CPU-side copy of the vertex data per dynamic mesh, which is why the flag exists rather
   * than every mesh paying it.
   */
  readonly update:
    ((device: GPUDevice, positions: Float32Array, normals?: Float32Array) => void) | null;
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
  const bounds = boundsOfPositions(data.positions, createBounds());
  const vertexCount = data.positions.length / 3;
  const supplied = VERTEX_LAYOUT.filter(
    (attribute) => !attribute.optional || data[attribute.name as keyof MeshData] !== undefined,
  );

  /* Interleaved: one stride holding every attribute the mesh actually supplied. */
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

  /*
   * Where the position and normal fields sit inside one vertex, in floats. Found from the same
   * `supplied` list the interleave walks, so the two cannot disagree — reading them off
   * `VERTEX_LAYOUT` instead would be right until a mesh omits an optional attribute before them,
   * which is the bug `present` already records once in this file.
   */
  let positionField = -1;
  let normalField = -1;
  let walked = 0;
  for (const attribute of supplied) {
    if (attribute.name === 'positions') positionField = walked;
    if (attribute.name === 'normals') normalField = walked;
    walked += attribute.components;
  }

  /*
   * The chunks, in whole vertices and whole indices: a step never writes half of either, so the
   * buffer never holds a torn one even for the frame between two steps.
   */
  const verticesPerStep = Math.max(1, Math.floor(UPLOAD_BYTES_PER_STEP / stride));
  const indexWidth = data.indices.BYTES_PER_ELEMENT;
  const indicesPerStep = Math.max(1, Math.floor(UPLOAD_BYTES_PER_STEP / indexWidth));
  const totalSteps =
    Math.max(1, Math.ceil(vertexCount / verticesPerStep)) +
    Math.max(1, Math.ceil(data.indices.length / indicesPerStep));

  let uploaded = false;

  function* uploadSteps(): Generator<void, void, void> {
    let taken = 0;
    for (let from = 0; from < vertexCount; from += verticesPerStep) {
      const to = Math.min(from + verticesPerStep, vertexCount);
      let fieldOffset = 0;
      for (const attribute of supplied) {
        const source = data[attribute.name as keyof MeshData] as Float32Array;
        const width = attribute.components;
        for (let vertex = from; vertex < to; vertex++) {
          for (let component = 0; component < width; component++) {
            interleaved[vertex * step + fieldOffset + component] =
              source[vertex * width + component] ?? 0;
          }
        }
        fieldOffset += width;
      }
      device.queue.writeBuffer(
        vertices,
        from * stride,
        interleaved,
        from * step,
        (to - from) * step,
      );
      taken += 1;
      if (taken < totalSteps) yield;
    }

    for (let from = 0; from < data.indices.length; from += indicesPerStep) {
      const to = Math.min(from + indicesPerStep, data.indices.length);
      device.queue.writeBuffer(indexBuffer, from * indexWidth, data.indices, from, to - from);
      taken += 1;
      if (taken < totalSteps) yield;
    }

    uploaded = true;
  }

  const mesh: GpuMesh = {
    vertexBuffers: [vertices, constants],
    indexBuffer,
    indexCount: data.indices.length,
    bounds,
    get complete(): boolean {
      return uploaded;
    },
    hasTangents: data.tangents !== undefined,
    isSkinned: data.joints !== undefined,
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
    update: !dynamic
      ? null
      : (target: GPUDevice, positions: Float32Array, normals?: Float32Array): void => {
          if (positions.length !== vertexCount * 3) {
            throw new Error(
              `this mesh has ${vertexCount} vertices and the update has ${positions.length / 3}. ` +
                "A mesh's vertex count is fixed at creation: the index buffer, the pipeline and " +
                'every other attribute are sized against it.',
            );
          }
          /* Everything that decides whether this is on screen starts from the bounds, so a cloth
             that blew sideways out of its original box would be culled while still visible. */
          boundsOfPositions(positions, bounds);
          for (let vertex = 0; vertex < vertexCount; vertex++) {
            const at = vertex * step;
            interleaved[at + positionField] = positions[vertex * 3] ?? 0;
            interleaved[at + positionField + 1] = positions[vertex * 3 + 1] ?? 0;
            interleaved[at + positionField + 2] = positions[vertex * 3 + 2] ?? 0;
            if (normals === undefined) continue;
            interleaved[at + normalField] = normals[vertex * 3] ?? 0;
            interleaved[at + normalField + 1] = normals[vertex * 3 + 1] ?? 0;
            interleaved[at + normalField + 2] = normals[vertex * 3 + 2] ?? 0;
          }
          target.queue.writeBuffer(vertices, 0, interleaved);
        },
    dispose(): void {
      vertices.destroy();
      constants.destroy();
      indexBuffer.destroy();
    },
  };

  return { mesh, upload: uploadSteps() };
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
  { shaderLocation: 15, offset: 64, format: 'float32x3' },
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

  VERTEX_LAYOUT.forEach((attribute, index) => {
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

  const layouts: GPUVertexBufferLayout[] = [{ arrayStride: offset, attributes: interleaved }];
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

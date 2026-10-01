/**
 * `KITS` and `MSHC`: a mesh carried as painted copies of a few pieces, rather than as its vertices.
 *
 * **What it is for is a world built from a kit.** A city of boxes, columns and cornices is a few
 * thousand distinct shapes placed half a million times, each at its own size and in its own paint.
 * Merged, its vertices are most of a gigabyte even quantised; as placements of the kit they are a
 * few tens of megabytes. So a mesh may arrive as `MSHC` — a table of surfaces and, per copy, which
 * piece, which surface, a 3×4 matrix and how its texture stretches — and is expanded by arithmetic
 * into exactly the `MeshData` a `MESH` would have carried (`assemble.ts`). It stands in place of a
 * `MESH` and counts as one in every ordinal, as `MSHQ` does, so materials and regions name it
 * like any other.
 *
 * **`KITS` names the pieces, and is written ahead of the geometry.** A piece is an ordinary mesh
 * that is drawn only inside the meshes assembled from it; without the declaration a streaming
 * reader would upload every piece as a part and draw the whole kit at the origin. Both chunks are
 * **required**, for the `INST` reason: a reader that skipped `KITS` would draw that kit, and one
 * that skipped `MSHC` would draw nothing where a district stands. A refusal naming them is the
 * honest answer, and what it gives up is opening such a file in a reader before 1.23.
 *
 * **A piece is shape; a copy is shape placed and painted.** A piece's colours, emissive and every
 * other per-vertex constant are ignored — the copy's surface supplies them. A piece carries
 * positions, normals, and texture coordinates with tangents where the mesh is textured, since the
 * tangent is what says which way a coordinate runs, and so how a copy's stretch applies to it.
 * **Its sway is shape too**: where the assembly carries `channel`, each copy takes its piece's, as
 * a tree's rises from its root to its leaves however it is placed.
 *
 * Layout, little-endian:
 * - `KITS`: u32 count, then that many u32 mesh ordinals, ascending;
 * - `MSHC`: u32 attribute bits (a `MESH`'s, less skinning), u32 surface count, then
 *   `SURFACE_FLOATS` f32 a surface; u32 copy count, then per copy u32 piece ordinal, u32 surface,
 *   12 f32 of matrix (three columns, then the translation), 3 f32 of u stretch, 3 f32 of v stretch
 *   and 2 f32 of offset: 88 bytes a copy.
 */
import {
  ATTR_EMISSIVE_COLOR,
  ATTR_GRAIN,
  ATTR_LAYERS,
  ATTR_RELIEF,
  ATTR_ROUGHNESS,
  ATTR_SPECULAR,
  ATTR_TANGENT,
  ATTR_UVS,
  ATTR_CHANNEL,
  DrftError,
  align,
} from './drftFormat.ts';
import type { MeshData } from './meshData.ts';

/** Where each value sits in a surface, whichever of them the mesh carries. */
export const SURFACE = {
  color: 0,
  emissive: 3,
  specular: 4,
  emissiveColor: 5,
  roughness: 8,
  grain: 9,
  relief: 10,
  layer: 11,
} as const;
export const SURFACE_FLOATS = 12;
/** A copy's matrix: three columns of the linear part, then the translation. */
export const COPY_MATRIX_FLOATS = 12;
/** A copy's texture stretch: u along each piece axis, v along each, then the offset. */
export const COPY_UV_FLOATS = 8;
const COPY_BYTES = 8 + (COPY_MATRIX_FLOATS + COPY_UV_FLOATS) * 4;

/** The optional arrays an assembled mesh may carry. Skinning is a piece of a character, not a kit. */
export const ASSEMBLY_ATTRIBUTES =
  ATTR_SPECULAR |
  ATTR_UVS |
  ATTR_EMISSIVE_COLOR |
  ATTR_ROUGHNESS |
  ATTR_GRAIN |
  ATTR_RELIEF |
  ATTR_TANGENT |
  ATTR_LAYERS |
  ATTR_CHANNEL;

export interface DrftAssembly {
  /** Which optional arrays the expanded mesh carries, as a `MESH`'s attribute bits. */
  readonly attributes: number;
  /** `SURFACE_FLOATS` a surface, laid out as `SURFACE` says. */
  readonly surfaces: Float32Array;
  /** One kit piece a copy, by mesh ordinal. */
  readonly pieces: Uint32Array;
  /** One surface a copy. */
  readonly surfaceOf: Uint32Array;
  /** `COPY_MATRIX_FLOATS` a copy, taking the piece to where the copy stands. */
  readonly transforms: Float32Array;
  /**
   * `COPY_UV_FLOATS` a copy. A coordinate is multiplied by how far the copy stretches the piece's
   * own direction for it — `|stretch ⊙ t|` for the unit tangent `t`, the bitangent for v — so a
   * unit box copied at 13 × 4 m with stretches of size over tile repeats its texture in metres,
   * face by face. `(1, 1, 1)` twice and no offset leave a piece's coordinates as they are.
   */
  readonly uv: Float32Array;
}

/** Whether a mesh slot holds an assembly rather than vertices. */
export function isAssembly(mesh: object): mesh is DrftAssembly {
  return 'pieces' in mesh && 'surfaceOf' in mesh;
}

export function buildKit(ordinals: readonly number[]): Uint8Array {
  const out = new Uint8Array(align(4 + ordinals.length * 4));
  const view = new DataView(out.buffer);
  view.setUint32(0, ordinals.length, true);
  ordinals.forEach((o, i) => view.setUint32(4 + i * 4, o, true));
  return out;
}

/** The kit's pieces, ascending and each a mesh the file carries. */
export function readKit(
  buffer: ArrayBufferLike,
  offset: number,
  byteLength: number,
  meshCount: number,
): number[] {
  const view = new DataView(buffer, offset, byteLength);
  if (byteLength < 4) throw new DrftError('KITS ends inside its count');
  const count = view.getUint32(0, true);
  if (4 + count * 4 > byteLength) throw new DrftError('KITS ends inside its pieces');
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(view.getUint32(4 + i * 4, true));
  checkKit(out, meshCount);
  return out;
}

export function checkKit(ordinals: readonly number[], meshCount: number): void {
  let previous = -1;
  for (const o of ordinals) {
    if (o >= meshCount)
      throw new DrftError(`KITS names mesh ${o}, and the file carries ${meshCount}`);
    if (o <= previous) throw new DrftError('KITS names its pieces out of order or twice');
    previous = o;
  }
}

export function buildAssembly(assembly: DrftAssembly): Uint8Array {
  const copies = assembly.pieces.length;
  const bytes = 12 + assembly.surfaces.length * 4 + copies * COPY_BYTES;
  const out = new Uint8Array(align(bytes));
  const view = new DataView(out.buffer);
  let at = 0;
  const u32 = (v: number): void => {
    view.setUint32(at, v, true);
    at += 4;
  };
  const f32 = (v: number): void => {
    view.setFloat32(at, v, true);
    at += 4;
  };
  u32(assembly.attributes);
  u32(assembly.surfaces.length / SURFACE_FLOATS);
  for (let i = 0; i < assembly.surfaces.length; i++) f32(assembly.surfaces[i] as number);
  u32(copies);
  for (let c = 0; c < copies; c++) {
    u32(assembly.pieces[c] as number);
    u32(assembly.surfaceOf[c] as number);
    for (let i = 0; i < COPY_MATRIX_FLOATS; i++)
      f32(assembly.transforms[c * COPY_MATRIX_FLOATS + i] as number);
    for (let i = 0; i < COPY_UV_FLOATS; i++) f32(assembly.uv[c * COPY_UV_FLOATS + i] as number);
  }
  if (at !== bytes) throw new DrftError(`internal: MSHC wrote ${at} of ${bytes} bytes`);
  return out;
}

/** One `MSHC` payload, checked on its own; its pieces are the caller's to check. */
export function readAssembly(
  buffer: ArrayBufferLike,
  offset: number,
  byteLength: number,
): DrftAssembly {
  const view = new DataView(buffer, offset, byteLength);
  let at = 0;
  const need = (bytes: number, what: string): void => {
    if (at + bytes > byteLength) throw new DrftError(`MSHC ends inside ${what}`);
  };
  need(8, 'its header');
  const attributes = view.getUint32(0, true);
  const surfaceCount = view.getUint32(4, true);
  at = 8;
  need(surfaceCount * SURFACE_FLOATS * 4 + 4, 'its surfaces');
  const surfaces = new Float32Array(surfaceCount * SURFACE_FLOATS);
  for (let i = 0; i < surfaces.length; i++) surfaces[i] = view.getFloat32(at + i * 4, true);
  at += surfaces.length * 4;
  const copies = view.getUint32(at, true);
  at += 4;
  need(copies * COPY_BYTES, 'its copies');
  const pieces = new Uint32Array(copies);
  const surfaceOf = new Uint32Array(copies);
  const transforms = new Float32Array(copies * COPY_MATRIX_FLOATS);
  const uv = new Float32Array(copies * COPY_UV_FLOATS);
  for (let c = 0; c < copies; c++) {
    pieces[c] = view.getUint32(at, true);
    surfaceOf[c] = view.getUint32(at + 4, true);
    at += 8;
    for (let i = 0; i < COPY_MATRIX_FLOATS; i++, at += 4)
      transforms[c * COPY_MATRIX_FLOATS + i] = view.getFloat32(at, true);
    for (let i = 0; i < COPY_UV_FLOATS; i++, at += 4)
      uv[c * COPY_UV_FLOATS + i] = view.getFloat32(at, true);
  }
  const assembly = { attributes, surfaces, pieces, surfaceOf, transforms, uv };
  checkAssembly(assembly, 'MSHC');
  return assembly;
}

/**
 * What an assembly must be on its own: known bits, whole records, surfaces it names, finite
 * numbers, whole layers, and no copy flattened to nothing — whose normals would be a division by
 * zero rather than a direction.
 */
export function checkAssembly(assembly: DrftAssembly, name: string): void {
  const { attributes, surfaces, pieces, surfaceOf, transforms, uv } = assembly;
  if ((attributes & ~ASSEMBLY_ATTRIBUTES) !== 0) {
    throw new DrftError(`${name} carries attribute bits ${attributes} an assembly cannot`);
  }
  if ((attributes & ATTR_LAYERS) !== 0 && (attributes & ATTR_UVS) === 0) {
    throw new DrftError(`${name} names layers without texture coordinates for them to ride with`);
  }
  if ((attributes & ATTR_UVS) !== 0 && (attributes & ATTR_TANGENT) === 0) {
    throw new DrftError(
      `${name} is textured without tangents; a copy's stretch follows the piece's tangent`,
    );
  }
  const copies = pieces.length;
  if (
    surfaces.length % SURFACE_FLOATS !== 0 ||
    surfaceOf.length !== copies ||
    transforms.length !== copies * COPY_MATRIX_FLOATS ||
    uv.length !== copies * COPY_UV_FLOATS
  ) {
    throw new DrftError(`${name}'s surfaces and copies are not whole records`);
  }
  const surfaceCount = surfaces.length / SURFACE_FLOATS;
  for (let s = 0; s < surfaceCount; s++) {
    for (let i = 0; i < SURFACE_FLOATS; i++) {
      if (!Number.isFinite(surfaces[s * SURFACE_FLOATS + i] as number)) {
        throw new DrftError(`${name}'s surface ${s} is not finite`);
      }
    }
    const layer = surfaces[s * SURFACE_FLOATS + SURFACE.layer] as number;
    if (!(layer >= 0) || Math.floor(layer) !== layer) {
      throw new DrftError(`${name}'s surface ${s} names layer ${layer}, not a whole number`);
    }
  }
  for (let c = 0; c < copies; c++) {
    if ((surfaceOf[c] as number) >= surfaceCount) {
      throw new DrftError(`${name}'s copy ${c} wears surface ${surfaceOf[c]} of ${surfaceCount}`);
    }
    const m = c * COPY_MATRIX_FLOATS;
    for (let i = 0; i < COPY_MATRIX_FLOATS; i++) {
      if (!Number.isFinite(transforms[m + i] as number)) {
        throw new DrftError(`${name}'s copy ${c} has a matrix that is not finite`);
      }
    }
    for (let i = 0; i < COPY_UV_FLOATS; i++) {
      if (!Number.isFinite(uv[c * COPY_UV_FLOATS + i] as number)) {
        throw new DrftError(`${name}'s copy ${c} has a texture stretch that is not finite`);
      }
    }
    if (Math.abs(determinant(transforms, m)) < 1e-12) {
      throw new DrftError(`${name}'s copy ${c} is flattened to nothing by its matrix`);
    }
  }
}

/** The determinant of the linear part of the copy matrix at `m`. */
export function determinant(t: ArrayLike<number>, m: number): number {
  const a = t[m] as number;
  const b = t[m + 1] as number;
  const c = t[m + 2] as number;
  const d = t[m + 3] as number;
  const e = t[m + 4] as number;
  const f = t[m + 5] as number;
  const g = t[m + 6] as number;
  const h = t[m + 7] as number;
  const i = t[m + 8] as number;
  return a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e);
}

/**
 * What an assembly must be to the kit around it: every copy a declared piece that comes before it
 * in the file — so a streaming reader holds the piece when the copy lands — and every piece
 * carrying what the assembly asks of it. Shared by the writer and both readers, so a file one
 * refuses the others refuse too.
 */
export function checkCopies(
  assembly: DrftAssembly,
  ordinal: number,
  kit: ReadonlySet<number>,
  piece: (ordinal: number) => MeshData | undefined,
): void {
  const textured = (assembly.attributes & ATTR_UVS) !== 0;
  const tangents = textured || (assembly.attributes & ATTR_TANGENT) !== 0;
  const seen = new Set<number>();
  for (let c = 0; c < assembly.pieces.length; c++) {
    const o = assembly.pieces[c] as number;
    if (seen.has(o)) continue;
    seen.add(o);
    if (!kit.has(o)) {
      throw new DrftError(`mesh ${ordinal} copies mesh ${o}, which KITS does not name a piece`);
    }
    if (o >= ordinal) {
      throw new DrftError(
        `mesh ${ordinal} copies piece ${o}, which comes after it; a piece is written before the meshes assembled from it`,
      );
    }
    const mesh = piece(o);
    if (mesh === undefined)
      throw new DrftError(`mesh ${ordinal} copies piece ${o}, which has not arrived`);
    if (textured && mesh.uvs === undefined) {
      throw new DrftError(`mesh ${ordinal} is textured and piece ${o} has no texture coordinates`);
    }
    if (tangents && mesh.tangents === undefined) {
      throw new DrftError(`mesh ${ordinal} needs tangents and piece ${o} has none`);
    }
    if ((assembly.attributes & ATTR_CHANNEL) !== 0 && mesh.channel === undefined) {
      throw new DrftError(`mesh ${ordinal} sways and piece ${o} carries no channel to sway by`);
    }
  }
}

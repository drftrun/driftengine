import { DrftError, align } from './drftFormat.ts';

/**
 * `NAVM`: a polygon mesh a character can walk, with the placement it was built at.
 *
 * ```
 * u32  vertexCount
 * u32  polyCount
 * u32  maxVertsPerPoly    slots per polygon; unused ones hold -1
 * f32  originX
 * f32  originZ
 * f32  cellSize
 * i32  vertices[vertexCount * 2]            x, z in cell units
 * i32  polys[polyCount * maxVertsPerPoly]
 * i32  neighbours[polyCount * maxVertsPerPoly]   the polygon across edge i, or -1
 * i32  polyRegion[polyCount]
 * ```
 *
 * **The placement is in the chunk, and that is the whole reason this is not just two tables.** The
 * vertices are cell indices; the origin and the cell size are what turn them into metres. A mesh
 * that travels without them arrives in the wrong units at the wrong place, and every test built at
 * the origin with one-unit cells passes anyway, because there the two are the same number.
 *
 * **Containment is checked here; walkability is not.** Whether these polygons describe a surface
 * anybody can cross is `@driftengine/nav`'s question, in the package that knows what a region is.
 * Whether an index points inside the tables is this one's, because an index past the end is a
 * consumer reading whatever followed.
 *
 * The types are plain arrays that `@driftengine/nav`'s `PolyMesh` satisfies structurally — the same
 * arrangement `DTEX` has with `@driftengine/texture`, and for the same reason: this package has no
 * dependencies and cannot name a type it does not import.
 *
 * Additive on the same terms as `DTEX`: a reader that does not know this code skips it by its
 * length and loses only the navigation, which it had nothing to walk with anyway.
 */

/** A polygon mesh and where it stands. `@driftengine/nav`'s `PolyMesh` is one of these. */
export interface NavPolyMesh {
  /** x, z per vertex, in cell units. */
  readonly vertices: Int32Array;
  readonly vertexCount: number;
  /** `maxVertsPerPoly` slots per polygon, padded with −1. */
  readonly polys: Int32Array;
  /** The polygon across each edge, or −1. Same layout as `polys`. */
  readonly neighbours: Int32Array;
  readonly polyCount: number;
  readonly maxVertsPerPoly: number;
  /** Which region each polygon came from. */
  readonly polyRegion: Int32Array;
  readonly originX: number;
  readonly originZ: number;
  readonly cellSize: number;
}

/** Six: the three counts and the three numbers that place the mesh in the world. */
const HEADER_WORDS = 6;
const HEADER = HEADER_WORDS * 4;

/** Where each table starts, and the size of the whole. */
function layoutOf(
  vertexCount: number,
  polyCount: number,
  slots: number,
): [number, number, number, number, number] {
  let at = HEADER;
  const vertices = at;
  at += vertexCount * 2 * 4;
  const polys = at;
  at += polyCount * slots * 4;
  const neighbours = at;
  at += polyCount * slots * 4;
  const region = at;
  at += polyCount * 4;
  return [vertices, polys, neighbours, region, at];
}

export function buildNavm(mesh: NavPolyMesh): Uint8Array {
  const { vertexCount, polyCount, maxVertsPerPoly: slots } = mesh;
  if (!Number.isInteger(vertexCount) || vertexCount < 0) {
    throw new DrftError(`NAVM declares ${vertexCount} vertices, which is not a count`);
  }
  if (!Number.isInteger(polyCount) || polyCount < 0) {
    throw new DrftError(`NAVM declares ${polyCount} polygons, which is not a count`);
  }
  if (!Number.isInteger(slots) || slots < 3) {
    throw new DrftError(`NAVM gives each polygon ${slots} slots, and a polygon has three corners`);
  }
  if (mesh.vertices.length !== vertexCount * 2) {
    throw new DrftError(
      `NAVM has ${mesh.vertices.length} vertex words for ${vertexCount} vertices of two`,
    );
  }
  if (mesh.polys.length !== polyCount * slots || mesh.neighbours.length !== polyCount * slots) {
    throw new DrftError(`NAVM's polygon and neighbour tables are not ${polyCount} × ${slots}`);
  }
  if (mesh.polyRegion.length !== polyCount) {
    throw new DrftError(`NAVM has ${mesh.polyRegion.length} regions for ${polyCount} polygons`);
  }
  refuseStrayIndices(mesh.polys, vertexCount, 'polygon', 'vertex');
  refuseStrayIndices(mesh.neighbours, polyCount, 'neighbour', 'polygon');

  const [vertices, polys, neighbours, region, size] = layoutOf(vertexCount, polyCount, slots);
  const bytes = new Uint8Array(align(size));
  const view = new DataView(bytes.buffer);
  view.setUint32(0, vertexCount, true);
  view.setUint32(4, polyCount, true);
  view.setUint32(8, slots, true);
  view.setFloat32(12, mesh.originX, true);
  view.setFloat32(16, mesh.originZ, true);
  view.setFloat32(20, mesh.cellSize, true);
  new Int32Array(bytes.buffer, vertices, vertexCount * 2).set(mesh.vertices);
  new Int32Array(bytes.buffer, polys, polyCount * slots).set(mesh.polys);
  new Int32Array(bytes.buffer, neighbours, polyCount * slots).set(mesh.neighbours);
  new Int32Array(bytes.buffer, region, polyCount).set(mesh.polyRegion);
  return bytes;
}

/**
 * The mesh a `NAVM` chunk carries, as views over the fetched buffer.
 *
 * Views rather than copies, like every other chunk here, so a load allocates nothing beyond the
 * object holding them.
 */
export function readNavm(buffer: ArrayBuffer, offset: number, byteLength: number): NavPolyMesh {
  if (byteLength < HEADER) throw new DrftError('NAVM is too short to hold its header');
  const view = new DataView(buffer, offset, byteLength);
  const vertexCount = view.getUint32(0, true);
  const polyCount = view.getUint32(4, true);
  const slots = view.getUint32(8, true);
  if (slots < 3) {
    throw new DrftError(`NAVM gives each polygon ${slots} slots, and a polygon has three corners`);
  }

  const [vertices, polys, neighbours, region, size] = layoutOf(vertexCount, polyCount, slots);
  if (size > byteLength) {
    throw new DrftError(
      `NAVM declares ${String(size)} bytes of tables in a ${String(byteLength)}-byte chunk`,
    );
  }

  const mesh: NavPolyMesh = {
    vertices: new Int32Array(buffer, offset + vertices, vertexCount * 2),
    vertexCount,
    polys: new Int32Array(buffer, offset + polys, polyCount * slots),
    neighbours: new Int32Array(buffer, offset + neighbours, polyCount * slots),
    polyCount,
    maxVertsPerPoly: slots,
    polyRegion: new Int32Array(buffer, offset + region, polyCount),
    originX: view.getFloat32(12, true),
    originZ: view.getFloat32(16, true),
    cellSize: view.getFloat32(20, true),
  };
  /*
   * **Checked again on the way in**, and not because the writer is untrusted: a file arrives from
   * a network, a disk and a bake this reader did not run. An index past the end of a table is the
   * one defect that costs a consumer rather than the file — it walks off the mesh.
   */
  refuseStrayIndices(mesh.polys, vertexCount, 'polygon', 'vertex');
  refuseStrayIndices(mesh.neighbours, polyCount, 'neighbour', 'polygon');
  return mesh;
}

function refuseStrayIndices(table: Int32Array, count: number, what: string, of: string): void {
  for (let at = 0; at < table.length; at += 1) {
    const index = table[at] as number;
    if (index === -1) continue;
    if (index < 0 || index >= count) {
      throw new DrftError(`NAVM's ${what} table names ${of} ${index}, and there are ${count}`);
    }
  }
}

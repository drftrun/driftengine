/**
 * World-space meshes plus their graph, as parts each expressed about its own node.
 *
 * **Why this exists at all.** `MESH` holds world-space positions, deliberately: `docs/FORMAT.md`
 * §4.4 rule 4 forbids a minor version from changing what an existing byte means, so geometry
 * could not move into node-local space without breaking every reader that predates the
 * hierarchy. The consequence is that a consumer holding a vehicle and its graph still cannot
 * turn a wheel, because the wheel's vertices are expressed around the model's origin and not
 * around the hub's. Turning one into the other is exact and mechanical, so the engine does it
 * once here instead of every consumer deriving it slightly differently.
 *
 * **`DrftLoader` deliberately does not call this.** Its own note says placing parts under a graph
 * is a scene decision, and that is still true — this is the arithmetic that decision needs,
 * offered to whoever makes it.
 *
 * **What it costs.** One 4x4 inversion per node and one transform per vertex: 221k vertices for
 * the largest asset this was measured against, once, at load. Not per frame. A caller loading a
 * large model should run it behind a frame budget instead of in one block.
 */

import type { DrftNode, MeshData } from '@driftengine/drft';

/** Column-major 4x4 from a node's TRS, matching what a caller hands a renderer. */
function compose(node: DrftNode): Float32Array {
  const [x, y, z, w] = node.rotation;
  const [sx, sy, sz] = node.scale;
  const out = new Float32Array(16);
  out[0] = (1 - 2 * (y * y + z * z)) * sx;
  out[1] = 2 * (x * y + z * w) * sx;
  out[2] = 2 * (x * z - y * w) * sx;
  out[4] = 2 * (x * y - z * w) * sy;
  out[5] = (1 - 2 * (x * x + z * z)) * sy;
  out[6] = 2 * (y * z + x * w) * sy;
  out[8] = 2 * (x * z + y * w) * sz;
  out[9] = 2 * (y * z - x * w) * sz;
  out[10] = (1 - 2 * (x * x + y * y)) * sz;
  out[12] = node.translation[0];
  out[13] = node.translation[1];
  out[14] = node.translation[2];
  out[15] = 1;
  return out;
}

/** `out = a * b`, column-major. */
function multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += (a[k * 4 + row] as number) * (b[column * 4 + k] as number);
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

/** A full 4x4 inverse, or null where the matrix is singular. */
function invert(m: Float32Array): Float32Array | null {
  const a = (i: number): number => m[i] as number;
  const inv = new Float32Array(16);
  inv[0] =
    a(5) * a(10) * a(15) -
    a(5) * a(11) * a(14) -
    a(9) * a(6) * a(15) +
    a(9) * a(7) * a(14) +
    a(13) * a(6) * a(11) -
    a(13) * a(7) * a(10);
  inv[4] =
    -a(4) * a(10) * a(15) +
    a(4) * a(11) * a(14) +
    a(8) * a(6) * a(15) -
    a(8) * a(7) * a(14) -
    a(12) * a(6) * a(11) +
    a(12) * a(7) * a(10);
  inv[8] =
    a(4) * a(9) * a(15) -
    a(4) * a(11) * a(13) -
    a(8) * a(5) * a(15) +
    a(8) * a(7) * a(13) +
    a(12) * a(5) * a(11) -
    a(12) * a(7) * a(9);
  inv[12] =
    -a(4) * a(9) * a(14) +
    a(4) * a(10) * a(13) +
    a(8) * a(5) * a(14) -
    a(8) * a(6) * a(13) -
    a(12) * a(5) * a(10) +
    a(12) * a(6) * a(9);
  inv[1] =
    -a(1) * a(10) * a(15) +
    a(1) * a(11) * a(14) +
    a(9) * a(2) * a(15) -
    a(9) * a(3) * a(14) -
    a(13) * a(2) * a(11) +
    a(13) * a(3) * a(10);
  inv[5] =
    a(0) * a(10) * a(15) -
    a(0) * a(11) * a(14) -
    a(8) * a(2) * a(15) +
    a(8) * a(3) * a(14) +
    a(12) * a(2) * a(11) -
    a(12) * a(3) * a(10);
  inv[9] =
    -a(0) * a(9) * a(15) +
    a(0) * a(11) * a(13) +
    a(8) * a(1) * a(15) -
    a(8) * a(3) * a(13) -
    a(12) * a(1) * a(11) +
    a(12) * a(3) * a(9);
  inv[13] =
    a(0) * a(9) * a(14) -
    a(0) * a(10) * a(13) -
    a(8) * a(1) * a(14) +
    a(8) * a(2) * a(13) +
    a(12) * a(1) * a(10) -
    a(12) * a(2) * a(9);
  inv[2] =
    a(1) * a(6) * a(15) -
    a(1) * a(7) * a(14) -
    a(5) * a(2) * a(15) +
    a(5) * a(3) * a(14) +
    a(13) * a(2) * a(7) -
    a(13) * a(3) * a(6);
  inv[6] =
    -a(0) * a(6) * a(15) +
    a(0) * a(7) * a(14) +
    a(4) * a(2) * a(15) -
    a(4) * a(3) * a(14) -
    a(12) * a(2) * a(7) +
    a(12) * a(3) * a(6);
  inv[10] =
    a(0) * a(5) * a(15) -
    a(0) * a(7) * a(13) -
    a(4) * a(1) * a(15) +
    a(4) * a(3) * a(13) +
    a(12) * a(1) * a(7) -
    a(12) * a(3) * a(5);
  inv[14] =
    -a(0) * a(5) * a(14) +
    a(0) * a(6) * a(13) +
    a(4) * a(1) * a(14) -
    a(4) * a(2) * a(13) -
    a(12) * a(1) * a(6) +
    a(12) * a(2) * a(5);
  inv[3] =
    -a(1) * a(6) * a(11) +
    a(1) * a(7) * a(10) +
    a(5) * a(2) * a(11) -
    a(5) * a(3) * a(10) -
    a(9) * a(2) * a(7) +
    a(9) * a(3) * a(6);
  inv[7] =
    a(0) * a(6) * a(11) -
    a(0) * a(7) * a(10) -
    a(4) * a(2) * a(11) +
    a(4) * a(3) * a(10) +
    a(8) * a(2) * a(7) -
    a(8) * a(3) * a(6);
  inv[11] =
    -a(0) * a(5) * a(11) +
    a(0) * a(7) * a(9) +
    a(4) * a(1) * a(11) -
    a(4) * a(3) * a(9) -
    a(8) * a(1) * a(7) +
    a(8) * a(3) * a(5);
  inv[15] =
    a(0) * a(5) * a(10) -
    a(0) * a(6) * a(9) -
    a(4) * a(1) * a(10) +
    a(4) * a(2) * a(9) +
    a(8) * a(1) * a(6) -
    a(8) * a(2) * a(5);

  const determinant =
    a(0) * (inv[0] as number) +
    a(1) * (inv[4] as number) +
    a(2) * (inv[8] as number) +
    a(3) * (inv[12] as number);
  if (determinant === 0 || !Number.isFinite(determinant)) return null;
  for (let i = 0; i < 16; i++) inv[i] = (inv[i] as number) / determinant;
  return inv;
}

export interface Localised {
  /** Parallel to the meshes given, each about the origin of the node that placed it. */
  parts: MeshData[];
  /** Parallel to the nodes given: the accumulated world matrix, column-major. */
  world: Float32Array[];
  /** Nodes whose geometry could not be localised, named so a person can look at them. */
  warnings: string[];
}

/**
 * Move each mesh into the frame of the node that placed it, and report every node's world matrix.
 *
 * A mesh no node claims is passed through untouched, which is what a format carrying no hierarchy
 * yields and is the correct no-op.
 */
export function localiseNodes(meshes: readonly MeshData[], nodes: readonly DrftNode[]): Localised {
  const world: Float32Array[] = [];
  for (const node of nodes) {
    const local = compose(node);
    world.push(node.parent < 0 ? local : multiply(world[node.parent] as Float32Array, local));
  }

  const warnings: string[] = [];
  const parts: MeshData[] = meshes.map((mesh) => mesh);
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index] as DrftNode;
    if (node.mesh < 0) continue;
    const mesh = meshes[node.mesh];
    if (mesh === undefined) continue;
    const inverse = invert(world[index] as Float32Array);
    if (inverse === null) {
      /*
       * A singular basis has no inverse and no rotation worth recovering, so the mesh stays where
       * it is. Named, because a part that cannot be animated is something a person needs told
       * rather than left to discover when it will not turn.
       */
      warnings.push(
        `node "${node.name}" has a singular transform, so its mesh is left in world space and ` +
          'cannot be animated about its own origin.',
      );
      continue;
    }

    const positions = new Float32Array(mesh.positions.length);
    for (let at = 0; at < mesh.positions.length; at += 3) {
      const x = mesh.positions[at] as number;
      const y = mesh.positions[at + 1] as number;
      const z = mesh.positions[at + 2] as number;
      positions[at] =
        x * (inverse[0] as number) +
        y * (inverse[4] as number) +
        z * (inverse[8] as number) +
        (inverse[12] as number);
      positions[at + 1] =
        x * (inverse[1] as number) +
        y * (inverse[5] as number) +
        z * (inverse[9] as number) +
        (inverse[13] as number);
      positions[at + 2] =
        x * (inverse[2] as number) +
        y * (inverse[6] as number) +
        z * (inverse[10] as number) +
        (inverse[14] as number);
    }

    /*
     * Normals take the inverse transpose, which for the inverse already in hand is the transpose
     * of that inverse — the same correction `gltf.ts` applies when it flattens, in the opposite
     * direction. Renormalised, because a node carrying a scale would otherwise leave them short.
     */
    const normals = new Float32Array(mesh.normals.length);
    for (let at = 0; at < mesh.normals.length; at += 3) {
      const x = mesh.normals[at] as number;
      const y = mesh.normals[at + 1] as number;
      const z = mesh.normals[at + 2] as number;
      const nx =
        x * (inverse[0] as number) + y * (inverse[1] as number) + z * (inverse[2] as number);
      const ny =
        x * (inverse[4] as number) + y * (inverse[5] as number) + z * (inverse[6] as number);
      const nz =
        x * (inverse[8] as number) + y * (inverse[9] as number) + z * (inverse[10] as number);
      const length = Math.hypot(nx, ny, nz) || 1;
      normals[at] = nx / length;
      normals[at + 1] = ny / length;
      normals[at + 2] = nz / length;
    }

    parts[node.mesh] = { ...mesh, positions, normals };
  }

  return { parts, world, warnings };
}

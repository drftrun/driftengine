/**
 * A captured mesh as something to stand on and to put in a file.
 *
 * **The mesh a capture draws and the mesh it collides against are the same triangles and not the
 * same array.** What comes out of `marchVolume` and `decimate` is built for a picture: it carries
 * normals and colours a collision test never reads, and it carries the occasional triangle with no
 * area, which is harmless in a render and is not harmless in a contact — a plane needs a normal,
 * and a triangle with no area has none. So the collision mesh is the drawn one with the arealess
 * triangles taken out and the vertices nothing uses any more taken with them.
 *
 * **A room is a static mesh body and a prop is a set of hulls, and the difference is not size.** A
 * mesh body is exact and cannot move: every triangle is tested as it stands, which is what a floor
 * and a wall want. A convex decomposition is approximate and can be thrown: a hull has a centre of
 * mass, an inertia and a cheap support function, which is what a crate wants. Giving a room hulls
 * would round off its corners; giving a crate a mesh body would leave it unable to be picked up.
 *
 * **The container's caps are the decomposition's brief.** `COLL` holds at most thirty-two hulls of
 * at most sixty-four points, so a decomposition that ignored them would produce a prop that cannot
 * be written — found at the writer, after the expensive part. It is asked for inside them instead.
 */
import { MAX_COLLIDER_HULLS, type MeshData } from '@driftengine/drft';
import { decomposeConvex, type DecomposeOptions } from '@driftengine/physics';

/** A mesh as `meshShape` takes it, and what had to go for it to be one. */
export interface CollisionSource {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  /** Triangles dropped for having no area to have a plane from. */
  readonly dropped: number;
}

export interface CollisionOptions {
  /**
   * The smallest triangle kept, in square metres.
   *
   * **Not zero**, because a triangle of a square micrometre has a plane in the arithmetic and none
   * in any useful sense: its normal is the direction of its own rounding error, and a contact
   * against it points somewhere arbitrary. A square millimetre is far below anything a capture
   * resolves and far above where a cross product stops meaning anything.
   */
  readonly minimumArea?: number;
}

const DEFAULT_MINIMUM_AREA = 1e-6;

/** `mesh`'s triangles, less the ones with no area, renumbered onto the vertices that remain. */
export function collisionMesh(mesh: MeshData, options: CollisionOptions = {}): CollisionSource {
  const minimumArea = options.minimumArea ?? DEFAULT_MINIMUM_AREA;
  const triangles = mesh.indices.length / 3;
  const renumbered = new Map<number, number>();
  const positions: number[] = [];
  const indices: number[] = [];
  let dropped = 0;

  for (let face = 0; face < triangles; face += 1) {
    const a = mesh.indices[face * 3] as number;
    const b = mesh.indices[face * 3 + 1] as number;
    const c = mesh.indices[face * 3 + 2] as number;
    if (areaOf(mesh.positions, a, b, c) < minimumArea) {
      dropped += 1;
      continue;
    }
    for (const vertex of [a, b, c]) {
      let at = renumbered.get(vertex);
      if (at === undefined) {
        at = positions.length / 3;
        renumbered.set(vertex, at);
        for (let k = 0; k < 3; k += 1) positions.push(mesh.positions[vertex * 3 + k] as number);
      }
      indices.push(at);
    }
  }

  return {
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(indices),
    dropped,
  };
}

/** Twice the area of a triangle, halved: the length of the cross product of two of its edges. */
function areaOf(positions: Float32Array, a: number, b: number, c: number): number {
  const ux = (positions[b * 3] as number) - (positions[a * 3] as number);
  const uy = (positions[b * 3 + 1] as number) - (positions[a * 3 + 1] as number);
  const uz = (positions[b * 3 + 2] as number) - (positions[a * 3 + 2] as number);
  const vx = (positions[c * 3] as number) - (positions[a * 3] as number);
  const vy = (positions[c * 3 + 1] as number) - (positions[a * 3 + 1] as number);
  const vz = (positions[c * 3 + 2] as number) - (positions[a * 3 + 2] as number);
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  return Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
}

/** A prop's hulls, and how much empty space they added. */
export interface PropHulls {
  /** xyz-packed points per hull, as `COLL` writes them and `hullShape` takes them. */
  readonly hulls: readonly Float32Array[];
  /** `(hullVolume − sourceVolume) / sourceVolume`, from the decomposition itself. */
  readonly bloat: number;
}

/**
 * `mesh` decomposed into convex hulls the container can hold.
 *
 * **Asked for inside the caps rather than checked against them afterwards.** A decomposition is the
 * expensive part of baking a prop, and one that comes back with thirty-three hulls is one that has
 * to be thrown away and asked for again — so the cap is what it is asked for. A hull that still
 * arrives with more points than a record can hold is refused by name, because silently dropping its
 * points changes the shape a game collides against without telling anybody.
 */
export function propHulls(
  mesh: MeshData | CollisionSource,
  options: DecomposeOptions = {},
): PropHulls {
  const decomposition = decomposeConvex(mesh.positions, mesh.indices, {
    ...options,
    maxHulls: Math.min(options.maxHulls ?? MAX_COLLIDER_HULLS, MAX_COLLIDER_HULLS),
  });
  /*
   * **The points need no cap of their own**, and it is worth saying why rather than checking for
   * something that cannot happen. A part carries at most one point per support direction, which is
   * fifty, and a collider record holds sixty-four — so the decomposition is already inside the
   * container by construction. `collide.test.ts` asserts that relationship rather than this file
   * testing each hull against a limit it can never reach.
   */
  return { hulls: decomposition.parts.map((part) => part.points), bloat: decomposition.bloat };
}

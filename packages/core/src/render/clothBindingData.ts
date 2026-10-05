/**
 * A mesh's cloth binding as data, and the texel layouts both backends upload it in.
 *
 * **What a consumer hands over** is per render vertex: the simulation triangle it follows (three
 * particle indices — the same index three times for a vertex that follows one particle), where on
 * it (barycentric u and v for the second and third particle), how far along the triangle's normal,
 * and how much it follows at all (0 skinned, 1 cloth — commonly painted into a vertex colour); and
 * the particles' rest positions in the mesh's model space. A garment's port decodes all of this
 * from the cooked data; the engine owns placing the vertices, in `shaders/clothBinding.ts`.
 *
 * **Textures wrap onto rows of at most 2048 texels**, the width WebGL2 guarantees, padded to whole
 * rows: a garment of 40,000 vertices is 80,000 binding texels, 40 rows. Validated by name before a
 * byte goes to a device, because an index past the particles reads the padding — a vertex pinned
 * to the origin, which looks like a broken rig rather than a bad binding.
 */

/** A mesh's cloth binding, one entry a render vertex unless said otherwise. */
export interface ClothBindingData {
  /** Three particle indices a vertex. */
  readonly triangles: Uint32Array;
  /** Barycentric u and v a vertex, for the second and third particle; the first takes the rest. */
  readonly coordinates: Float32Array;
  /** Metres along the triangle's normal. */
  readonly offsets: Float32Array;
  /** How much of the cloth's place a vertex takes: 0 skinned, 1 cloth. */
  readonly weights: Float32Array;
  /** The particles at rest, three floats each, in the mesh's model space. */
  readonly rest: Float32Array;
}

/** The widest row a texture is wrapped onto. */
export const CLOTH_TEXTURE_WIDTH = 2048;

/** A texture of `texels`, wrapped onto rows. */
export function clothTextureSize(texels: number): { width: number; height: number } {
  const width = Math.max(1, Math.min(CLOTH_TEXTURE_WIDTH, texels));
  return { width, height: Math.max(1, Math.ceil(texels / width)) };
}

/** Refuse a binding whose arrays disagree with a mesh of `vertices`, or that names a missing particle. */
export function validateClothBinding(data: ClothBindingData, vertices: number): void {
  const count = data.weights.length;
  const fail = (what: string): never => {
    throw new Error(`cloth binding: ${what}`);
  };
  if (count !== vertices) fail(`binds ${count} vertices and the mesh has ${vertices}`);
  if (data.triangles.length !== count * 3)
    fail(`${data.triangles.length / 3} triangles for ${count} vertices`);
  if (data.coordinates.length !== count * 2)
    fail(`${data.coordinates.length / 2} coordinates for ${count} vertices`);
  if (data.offsets.length !== count) fail(`${data.offsets.length} offsets for ${count} vertices`);
  const particles = data.rest.length / 3;
  if (!Number.isInteger(particles) || particles === 0)
    fail(`rest holds ${data.rest.length} floats`);
  for (let i = 0; i < data.triangles.length; i++) {
    if ((data.triangles[i] as number) >= particles) {
      fail(`vertex ${Math.floor(i / 3)} names particle ${data.triangles[i]} of ${particles}`);
    }
  }
}

/** The binding as RGBA float texels, two a vertex, padded to whole rows. */
export function packClothBinding(data: ClothBindingData): Float32Array {
  const vertices = data.weights.length;
  const { width, height } = clothTextureSize(vertices * 2);
  const out = new Float32Array(width * height * 4);
  for (let v = 0; v < vertices; v++) {
    const at = v * 8;
    out[at] = data.triangles[v * 3] as number;
    out[at + 1] = data.triangles[v * 3 + 1] as number;
    out[at + 2] = data.triangles[v * 3 + 2] as number;
    out[at + 3] = data.weights[v] as number;
    out[at + 4] = data.coordinates[v * 2] as number;
    out[at + 5] = data.coordinates[v * 2 + 1] as number;
    out[at + 6] = data.offsets[v] as number;
  }
  return out;
}

/** Particles, three floats each, into RGBA texels in `out`. Allocation-free, for every frame. */
export function packClothParticles(positions: Float32Array, out: Float32Array): void {
  const count = positions.length / 3;
  for (let i = 0; i < count; i++) {
    out[i * 4] = positions[i * 3] as number;
    out[i * 4 + 1] = positions[i * 3 + 1] as number;
    out[i * 4 + 2] = positions[i * 3 + 2] as number;
    out[i * 4 + 3] = 0;
  }
}

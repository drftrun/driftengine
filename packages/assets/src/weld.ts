/**
 * Collapse a triangle soup into shared vertices.
 *
 * Importers produce one vertex per triangle *corner*, because that is how the source
 * formats index their attributes: FBX and OBJ address positions, normals and UVs through
 * separate index lists, and the only way to flatten that into one array per attribute is
 * to give every corner its own vertex. A real model comes out five to eight times larger
 * than it is — a BMW measured 4.57M corners for perhaps 600k distinct vertices.
 *
 * **Corners are only merged when everything about them matches**, not just the position.
 * Two corners at the same point with different normals are a hard edge, and welding them
 * would round it off — the seam down a car's bonnet would soften into a dent. That is a
 * change to the model, made silently, which is exactly what a reader must not do.
 *
 * Offline work, so it may allocate. Nothing here runs per frame.
 */

import type { MeshData } from '@driftengine/drft';

/**
 * How finely positions are compared, in units of the model.
 *
 * Exact bit equality is the wrong test: two corners meant to be the same point routinely
 * differ in the last place after a transform, so exact matching welds almost nothing on
 * exactly the files that need it most. Quantising to a millionth is far below anything a
 * model expresses and far above float noise.
 */
const QUANTUM = 1e-6;

function quantise(value: number): number {
  return Math.round(value / QUANTUM);
}

/**
 * Every optional attribute, and how many floats each spends on a vertex.
 *
 * **One table, read by both halves of the weld** — the key that decides whether two corners are
 * the same vertex, and the copy that writes the survivors. They were two lists written out by
 * hand, and what that cost is the reason this exists: `MeshData` gained a tangent frame, relief,
 * a rig and morph deltas over four days in August and neither list was told about any of them,
 * so for five releases a merged mesh came back **without** its rig, its tangents and its morph
 * targets, and with corners merged across the bones they were weighted to. Nothing raised: an
 * unskinned mesh is a valid mesh, and it draws at its bind pose.
 *
 * **The `satisfies` is the load-bearing part and not decoration.** It names every optional
 * per-vertex attribute the format has, so the day a new one is added to `MeshData` this file
 * stops compiling until it is listed here. A table that can be forgotten is exactly the thing
 * that was already forgotten twice.
 */
const ATTRIBUTES = {
  uvs: 2,
  specular: 1,
  roughness: 1,
  grain: 1,
  relief: 1,
  emissiveColor: 3,
  tangents: 4,
  joints: 4,
  weights: 4,
  /*
   * The four-lane per-vertex channel. It joins the key above as well as the copy below, which is
   * the behaviour that matters: two vertices at one position whose sway or sky exposure differ
   * are not the same vertex, and welding them would silently keep whichever came first. A leaf
   * tip merged into the trunk it grows from would stop moving.
   */
  channel: 4,
} as const satisfies Record<PerVertexAttribute, number>;

/**
 * Every optional `Float32Array` on `MeshData`, except the morph deltas.
 *
 * Morph targets are excluded because they are the one attribute whose stride is not fixed by the
 * format — it is three floats times the mesh's own `morphTargetCount` — so they are keyed and
 * copied a few lines below instead of through the table. `morphTargetCount` itself is a number
 * and drops out of this type on its own.
 */
type PerVertexAttribute = Exclude<
  {
    [K in keyof MeshData]-?: undefined extends MeshData[K]
      ? MeshData[K] extends Float32Array | undefined
        ? K
        : never
      : never;
  }[keyof MeshData],
  'morphTargets'
>;

const NAMES = Object.keys(ATTRIBUTES) as readonly PerVertexAttribute[];

/**
 * Weld one mesh. Returns the same mesh when nothing can be merged.
 *
 * **Every attribute decides identity, and that is a cost as well as a correctness rule.** Two
 * corners alike in position, normal and UV but weighted to different bones are two vertices, and
 * merging them moves geometry with the wrong limb; two alike in everything including their UV but
 * opposite in the bitangent's sign are a mirrored UV shell, and merging them lights one side of
 * the model inside out. Neither is visible in any count a bake prints.
 *
 * What it costs is a file whose tangent frame was *derived* per corner instead of authored: a
 * corner soup gets one triangle's frame per corner, so no two corners agree and the weld that
 * would have merged them cannot. **The way out is not a looser key — it is to derive the frame
 * from the welded mesh**, which is what the baker does as of 3.30.0: it passes
 * `deriveTangents: false` to the reader and calls `deriveTangentsFor` here, afterwards.
 *
 * **How much it costs depends on the unwrap, and two figures in this repository disagreed about
 * it.** The frame is normalised, so two triangles produce different frames only where the
 * *direction* u increases in differs between them. On a separable unwrap — u from x, v from y —
 * every triangle on a flat surface agrees and a derived frame costs almost nothing; a 253-mesh CAD
 * export measured 728,168 vertices against 728,161 with no frame, seven vertices, and that file is
 * not on this machine. On a rotational unwrap the direction turns with position and almost nothing
 * merges: 9,600 corners to 9,482 vertices against 1,681, six different frames at one point at
 * worst, measured in `tangentOrder.test.ts` and reproducible. The order is fixed for the second
 * case; the first is why it went unnoticed.
 */
export function weldMesh(mesh: MeshData): MeshData {
  const vertices = mesh.positions.length / 3;
  if (vertices === 0) return mesh;

  const map = new Map<string, number>();
  const remap = new Uint32Array(vertices);
  let unique = 0;

  /* The attributes this mesh actually carries, resolved once and not per vertex. */
  const present = NAMES.filter((name) => mesh[name] !== undefined);
  /* Three floats per target per vertex, interleaved by vertex: `MeshData.morphTargets`' layout. */
  const morphStride = mesh.morphTargets === undefined ? 0 : (mesh.morphTargetCount ?? 0) * 3;

  for (let i = 0; i < vertices; i++) {
    /*
     * The key names every attribute, because two corners differing in any of them are
     * genuinely different vertices — a shared position with a different normal is a hard
     * edge, and with a different colour is a material boundary.
     */
    let key =
      `${quantise(mesh.positions[i * 3] as number)},` +
      `${quantise(mesh.positions[i * 3 + 1] as number)},` +
      `${quantise(mesh.positions[i * 3 + 2] as number)}|` +
      `${quantise(mesh.normals[i * 3] as number)},` +
      `${quantise(mesh.normals[i * 3 + 1] as number)},` +
      `${quantise(mesh.normals[i * 3 + 2] as number)}|` +
      `${quantise(mesh.colors[i * 3] as number)},` +
      `${quantise(mesh.colors[i * 3 + 1] as number)},` +
      `${quantise(mesh.colors[i * 3 + 2] as number)}|` +
      `${quantise(mesh.emissive[i] as number)}`;
    for (const name of present) {
      const array = mesh[name] as Float32Array;
      const stride = ATTRIBUTES[name];
      key += '|';
      for (let c = 0; c < stride; c++) key += `${quantise(array[i * stride + c] as number)},`;
    }
    for (let c = 0; c < morphStride; c++) {
      key += `${quantise(mesh.morphTargets?.[i * morphStride + c] as number)},`;
    }

    const found = map.get(key);
    if (found === undefined) {
      map.set(key, unique);
      remap[i] = unique;
      unique++;
    } else {
      remap[i] = found;
    }
  }

  if (unique === vertices) return mesh;

  const positions = new Float32Array(unique * 3);
  const normals = new Float32Array(unique * 3);
  const colors = new Float32Array(unique * 3);
  const emissive = new Float32Array(unique);
  const copies: Partial<Record<PerVertexAttribute, Float32Array>> = {};
  for (const name of present) copies[name] = new Float32Array(unique * ATTRIBUTES[name]);
  const morphTargets = morphStride === 0 ? undefined : new Float32Array(unique * morphStride);

  const written = new Uint8Array(unique);
  for (let i = 0; i < vertices; i++) {
    const to = remap[i] as number;
    if (written[to] === 1) continue;
    written[to] = 1;
    for (let c = 0; c < 3; c++) {
      positions[to * 3 + c] = mesh.positions[i * 3 + c] as number;
      normals[to * 3 + c] = mesh.normals[i * 3 + c] as number;
      colors[to * 3 + c] = mesh.colors[i * 3 + c] as number;
    }
    emissive[to] = mesh.emissive[i] as number;
    for (const name of present) {
      const from = mesh[name] as Float32Array;
      const into = copies[name] as Float32Array;
      const stride = ATTRIBUTES[name];
      for (let c = 0; c < stride; c++) into[to * stride + c] = from[i * stride + c] as number;
    }
    if (morphTargets !== undefined) {
      for (let c = 0; c < morphStride; c++) {
        morphTargets[to * morphStride + c] = mesh.morphTargets?.[i * morphStride + c] as number;
      }
    }
  }

  const indices = new Uint32Array(mesh.indices.length);
  for (let i = 0; i < mesh.indices.length; i++) {
    indices[i] = remap[mesh.indices[i] as number] as number;
  }

  return {
    positions,
    normals,
    colors,
    emissive,
    indices,
    ...copies,
    /* Both or neither: an array of deltas with no count moves nothing, and a count with no
       array is a promise about a buffer that is not there. */
    ...(morphTargets === undefined
      ? {}
      : { morphTargets, morphTargetCount: mesh.morphTargetCount }),
  };
}

/**
 * Drop optional attributes that never vary from the engine's own default.
 *
 * An importer that has no material information should not invent one, and a writer should
 * not spend a megabyte storing the same number four million times. `Mesh` already reads an
 * absent attribute as a constant, so leaving it out is not a loss — it is the same shading
 * through a cheaper path, with no buffer, no upload and no per-vertex fetch.
 *
 * The defaults are `Mesh`'s, and they are duplicated here on purpose rather than imported:
 * this is a *bake-time* judgement about what is worth storing, and tying it to a rendering
 * constant would make a change to one silently rewrite files produced by the other.
 */
const DEFAULT_SPECULAR = 0;
const DEFAULT_ROUGHNESS = 0.4277;
const DEFAULT_EMISSIVE_COLOR = -1;
/** Absent grain means none, so an asset that is nowhere mineral stores nothing about it. */
const DEFAULT_GRAIN = 0;
/**
 * Absent relief means a perfectly smooth surface, which is what every reader produces.
 *
 * Listed late and for the same reason the weld's table exists: relief landed on `MeshData` on
 * 2026-08-21 and this function was not told, so a producer filling an array of zeroes stored four
 * bytes a vertex saying "no relief" — the one thing an absent attribute already says.
 */
const DEFAULT_RELIEF = 0;

export function dropDefaultAttributes(mesh: MeshData): MeshData {
  const constant = (array: Float32Array | undefined, value: number): boolean => {
    if (array === undefined) return false;
    for (let i = 0; i < array.length; i++) {
      if (Math.abs((array[i] as number) - value) > 1e-6) return false;
    }
    return true;
  };

  const out: MeshData = { ...mesh };
  if (constant(mesh.specular, DEFAULT_SPECULAR)) delete (out as { specular?: unknown }).specular;
  if (constant(mesh.roughness, DEFAULT_ROUGHNESS))
    delete (out as { roughness?: unknown }).roughness;
  if (constant(mesh.grain, DEFAULT_GRAIN)) delete (out as { grain?: unknown }).grain;
  if (constant(mesh.relief, DEFAULT_RELIEF)) delete (out as { relief?: unknown }).relief;
  if (constant(mesh.emissiveColor, DEFAULT_EMISSIVE_COLOR)) {
    delete (out as { emissiveColor?: unknown }).emissiveColor;
  }
  return out;
}

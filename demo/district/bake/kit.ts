/**
 * Each distinct mesh of the district as engine geometry, once: its primitives as `MeshData` in its
 * own space, Y up, each with the material it wears.
 *
 * **Through the glTF route, as `readModel` reads a `.blend`.** `blendToGltf` turns one object at the
 * origin into a document and `gltfToMeshes` reads it, so a prototype's vertices, its material's
 * factors and which per-vertex lanes it fills are decided exactly where they are for any other
 * `.blend` this engine reads. Images are named rather than carried (`#image/<offset>`): the bake
 * reads each once, in `textures.ts`, rather than once a document.
 *
 * **Simplified where it is heavier than it looks.** The source's props were modelled for an offline
 * renderer — a fire hydrant of 86,000 triangles, a scooter of 95,000 — and are copied hundreds of
 * times. Each is brought down to the triangles its shape needs within `PROP_ERROR`, a few
 * millimetres, which is under a pixel at walking distance; a piece the size of a building to
 * `LARGE_ERROR`. What it gives up is detail finer than the bound, which a normal map carries anyway.
 */
import type { BlendData, BlendStruct } from '@driftengine/assets';
import { blendToGltf, gltfToMeshes, readBlendMesh, simplifyMesh } from '@driftengine/assets';
import type { DrftMaterial, MeshData } from '@driftengine/drft';

/** A primitive of a piece, with what it wears. */
export interface KitPart {
  readonly mesh: MeshData;
  readonly material: DrftMaterial;
  /** The Blender material, for what glTF cannot carry: a second image, emission past one. */
  readonly source: BlendStruct | null;
  /** The images its four maps name, by datablock offset; -1 for none. */
  readonly images: { albedo: number; normal: number; orm: number; emissive: number };
  /** What it wears whatever slot a copy gives it: a part cut out of another, as `panes.ts` cuts. */
  readonly wears?: BlendStruct | null;
}

export interface KitPiece {
  readonly key: string;
  readonly parts: KitPart[];
  /** Which material slot each part was cut from, so a copy can wear its own slot's material. */
  readonly slotOf: readonly number[];
  readonly triangles: number;
  /** Triangles before simplification, for the report. */
  readonly sourceTriangles: number;
  /** Min xyz then max xyz, in the piece's own space. */
  readonly bounds: Float32Array;
}

/** Below this many triangles a piece is left as modelled. */
const SIMPLIFY_FROM = 4000;
/** The bound a prop is simplified to, and a piece larger than `LARGE_SIZE` metres. */
const PROP_ERROR = 0.004;
const LARGE_ERROR = 0.02;
const LARGE_SIZE = 12;

export const imageUri = (image: BlendStruct): string => `#image/${image.offset}`;
const imageOf = (name: string | undefined): number =>
  name?.startsWith('#image/') === true ? Number(name.slice(7)) : -1;

function boundsOf(meshes: readonly MeshData[]): Float32Array {
  const b = new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  for (const mesh of meshes) {
    const p = mesh.positions;
    for (let i = 0; i < p.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = p[i + k] as number;
        if (v < (b[k] as number)) b[k] = v;
        if (v > (b[k + 3] as number)) b[k + 3] = v;
      }
    }
  }
  return b;
}

/** Convert one object's mesh into a piece. Null where it draws nothing. */
export function buildPiece(
  blend: BlendData,
  key: string,
  object: BlendStruct,
  simplify = true,
): KitPiece | null {
  const gltf = blendToGltf(blend, { only: object, imageUri });
  if (gltf.refusals.length > 0) return null;
  /* A mesh of loose edges or points has no primitive at all, and draws nothing. */
  const primitives = (gltf.doc.meshes ?? []).reduce(
    (n, m) => n + m.primitives.filter((p) => p.indices !== undefined).length,
    0,
  );
  if (primitives === 0) return null;
  const read = gltfToMeshes(gltf.doc, [gltf.binary], { deriveTangents: false });
  const byName = new Map<string, BlendStruct>();
  for (const material of blend.idsOf('MA')) byName.set(material.idName(), material);
  const sourceTriangles = read.meshes.reduce((n, m) => n + m.indices.length / 3, 0);
  const bounds = boundsOf(read.meshes);
  const size = Math.max(
    (bounds[3] as number) - (bounds[0] as number),
    (bounds[4] as number) - (bounds[1] as number),
    (bounds[5] as number) - (bounds[2] as number),
  );
  const parts: KitPart[] = read.meshes.map((raw, i) => {
    const material = read.materials[i] as DrftMaterial;
    let mesh = raw;
    if (simplify && sourceTriangles > SIMPLIFY_FROM) {
      mesh = simplifyMesh(mesh, { maxError: size > LARGE_SIZE ? LARGE_ERROR : PROP_ERROR });
    }
    /*
     * No tangents are stored: the shader derives a normal map's frame from the screen-space
     * derivatives of position and UV, which on a city of flat quads is the same frame, and a
     * tangent is a fifth of every vertex's bytes.
     */
    if (mesh.tangents !== undefined) mesh = { ...mesh, tangents: undefined };
    const texture = (index: number): number =>
      index < 0 ? -1 : imageOf(read.textures[index]?.name);
    return {
      mesh,
      material,
      source: byName.get(material.name) ?? null,
      images: {
        albedo: texture(material.albedo),
        normal: texture(material.normalMap),
        orm: texture(material.ormMap),
        emissive: texture(material.emissiveMap),
      },
    };
  });
  if (parts.length === 0) return null;
  /* The slots the faces use, ascending, which is the order the primitives were cut in. */
  const data = object.deref('data');
  const used = new Set<number>();
  if (data !== null) {
    const mesh = readBlendMesh(blend, data);
    const slots = Math.max(object.int('totcol'), data.int('totcol'));
    for (let f = 0; f < mesh.faceOffsets.length - 1; f++) {
      used.add(slots === 0 ? -1 : Math.max(0, Math.min(slots - 1, mesh.materialIndex?.[f] ?? 0)));
    }
  }
  const slotOf = [...used].sort((a, b) => a - b);
  return {
    key,
    parts,
    slotOf,
    triangles: parts.reduce((n, p) => n + p.mesh.indices.length / 3, 0),
    sourceTriangles,
    bounds,
  };
}

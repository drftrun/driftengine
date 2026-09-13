/**
 * Wavefront OBJ, with its `.mtl` companion.
 *
 * Tier 1, and the cheapest thing on the list to put there: the format was specified in the
 * eighties, has not changed since, and is plain text. There is no version to track and no
 * vendor to follow, so a complete reader written once stays correct — which is worth more
 * than a partial reader for a format that moves.
 *
 * One `MeshData` per material group, matching the glTF path: a group is the unit carrying
 * a single material, and `MeshData` holds one material's worth of vertex attributes.
 */

import type { MeshData } from '@driftengine/drft';
import { DrftError } from '@driftengine/drft';
import type { DrftMaterial } from '@driftengine/drft';
import type { AssetReference } from './assetPath.ts';

interface ObjMaterial {
  diffuse: [number, number, number];
  emissive: [number, number, number];
  /** Highlight strength, from `Ks`/`Ns` or the PBR `Pm` extension. */
  specular: number;
  /** Highlight width, from the PBR `Pr` extension, or derived from `Ns`. */
  roughness: number;
  /** The colour map this material names, as declared, or null. */
  albedo: string | null;
  /** 1 is opaque. `d` states it directly and `Tr` states its inverse. */
  opacity: number;
}

const DEFAULT_MATERIAL: ObjMaterial = {
  diffuse: [0.8, 0.8, 0.8],
  emissive: [0, 0, 0],
  specular: 0,
  roughness: 0.5,
  albedo: null,
  opacity: 1,
};

const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;

/**
 * The filename out of a `map_*` line, past whatever options precede it.
 *
 * A map line is not just a path: `map_Kd -s 1 1 1 -bm 0.2 brick.png` is legal and common,
 * and taking `parts[1]` gets `-s`. The options are skipped by shape rather than by a table
 * of every flag, since the flags differ per exporter and their arity is not consistent:
 * anything that begins with a dash, parses as a number, or is `on`/`off` is an option or an
 * option's argument, and the first token that is none of those begins the name.
 *
 * The rest is joined rather than taken as one token, because a texture path may contain
 * spaces and the line has already been split on them.
 */
function mapPath(parts: readonly string[]): string {
  let at = 1;
  while (at < parts.length) {
    const token = parts[at] as string;
    if (
      token.startsWith('-') ||
      token === 'on' ||
      token === 'off' ||
      !Number.isNaN(Number(token))
    ) {
      at++;
      continue;
    }
    break;
  }
  const name = parts.slice(at).join(' ').trim();
  return name;
}

/**
 * Parse a `.mtl`.
 *
 * `Pr` and `Pm` are the widely used PBR extension rather than the original specification,
 * and they are preferred where present because they say directly what this engine shades
 * with. Where they are absent, `Ns` — a Phong exponent — is converted, since an exponent
 * and a roughness describe the same thing from opposite ends.
 *
 * `d` and `Tr` are the same quantity written in opposite directions: `d` is how much of the
 * surface is *there* and `Tr` is how much of it is not. Reading either as the other inverts
 * every transparent material in a file, turning solid geometry invisible and glass solid,
 * so both are read explicitly rather than one being assumed.
 */
export function parseMtl(text: string): Map<string, ObjMaterial> {
  const materials = new Map<string, ObjMaterial>();
  let current: ObjMaterial | null = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const keyword = parts[0] as string;
    const numbers = parts.slice(1).map(Number);

    if (keyword === 'newmtl') {
      current = { ...DEFAULT_MATERIAL, diffuse: [0.8, 0.8, 0.8], emissive: [0, 0, 0] };
      materials.set(parts.slice(1).join(' '), current);
      continue;
    }
    if (current === null) continue;

    if (keyword === 'Kd') current.diffuse = [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0];
    else if (keyword === 'Ke')
      current.emissive = [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0];
    else if (keyword === 'Pr') current.roughness = numbers[0] ?? 0.5;
    else if (keyword === 'Pm') current.specular = numbers[0] ?? 0;
    else if (keyword === 'Ns') {
      /*
       * A Phong exponent is a width expressed backwards: 0 is a mirror-flat surface with a
       * broad lobe and 1000 is a pinpoint. Mapped rather than ignored, so a file with no
       * PBR extension still arrives with its highlights roughly the right size.
       */
      const exponent = Math.max(numbers[0] ?? 0, 0);
      current.roughness = Math.min(1, Math.max(0.02, Math.sqrt(2 / (exponent + 2))));
    } else if (keyword === 'map_Kd') current.albedo = mapPath(parts);
    else if (keyword === 'd') current.opacity = clamp01(numbers[0] ?? 1);
    else if (keyword === 'Tr') current.opacity = clamp01(1 - (numbers[0] ?? 0));
    else if (keyword === 'Ks' && current.specular === 0) {
      current.specular = Math.max(numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0);
    }
  }
  return materials;
}

/** A face vertex: indices into the three pools, already resolved to zero-based. */
interface FaceVertex {
  position: number;
  uv: number;
  normal: number;
}

function resolveIndex(raw: string, poolLength: number): number {
  if (raw === '') return -1;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) return -1;
  /* Negative indices count back from the end, which the format allows and exporters use. */
  return value < 0 ? poolLength + value : value - 1;
}

/**
 * Parse an OBJ. `materials` is the parsed `.mtl`, if the caller resolved one.
 *
 * Faces with more than three vertices are triangulated as a fan. That is correct for the
 * convex polygons OBJ files actually contain, and the format offers nothing that would let
 * a reader do better for a concave one.
 */
export function parseObj(
  text: string,
  materials: Map<string, ObjMaterial> = new Map(),
): {
  meshes: MeshData[];
  warnings: string[];
  materials: DrftMaterial[];
  textures: AssetReference[];
} {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const warnings: string[] = [];

  /* Faces accumulate per material, so each group becomes one mesh. */
  const groups = new Map<string, FaceVertex[]>();
  let currentMaterial = '';
  const faceFor = (name: string): FaceVertex[] => {
    let list = groups.get(name);
    if (list === undefined) {
      list = [];
      groups.set(name, list);
    }
    return list;
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const keyword = parts[0] as string;

    if (keyword === 'v') {
      positions.push(Number(parts[1]), Number(parts[2]), Number(parts[3]));
    } else if (keyword === 'vn') {
      normals.push(Number(parts[1]), Number(parts[2]), Number(parts[3]));
    } else if (keyword === 'vt') {
      uvs.push(Number(parts[1]), Number(parts[2] ?? 0));
    } else if (keyword === 'usemtl') {
      currentMaterial = parts.slice(1).join(' ');
    } else if (keyword === 'f') {
      const corners: FaceVertex[] = [];
      for (let i = 1; i < parts.length; i++) {
        const [p = '', t = '', n = ''] = (parts[i] as string).split('/');
        corners.push({
          position: resolveIndex(p, positions.length / 3),
          uv: resolveIndex(t, uvs.length / 2),
          normal: resolveIndex(n, normals.length / 3),
        });
      }
      if (corners.length < 3) {
        warnings.push(`skipped a face with ${corners.length} vertices`);
        continue;
      }
      const list = faceFor(currentMaterial);
      for (let i = 1; i + 1 < corners.length; i++) {
        list.push(corners[0] as FaceVertex, corners[i] as FaceVertex, corners[i + 1] as FaceVertex);
      }
    }
  }

  if (positions.length === 0) throw new DrftError('obj: no vertices');

  const meshes: MeshData[] = [];
  const perMesh: DrftMaterial[] = [];
  /* Deduplicated: several materials commonly share one map, and embedding it twice would
     put the same megabytes in the file twice and give a consumer two names for one image. */
  const textures: AssetReference[] = [];
  const textureIndex = new Map<string, number>();

  for (const [name, corners] of groups) {
    if (corners.length === 0) continue;
    const material = materials.get(name) ?? DEFAULT_MATERIAL;
    let albedo = -1;
    if (material.albedo !== null && material.albedo !== '') {
      const existing = textureIndex.get(material.albedo);
      if (existing === undefined) {
        albedo = textures.length;
        textureIndex.set(material.albedo, albedo);
        textures.push({ name: material.albedo });
      } else {
        albedo = existing;
      }
    }
    meshes.push(buildGroup(corners, positions, normals, uvs, material, warnings, name));
    perMesh.push({
      name,
      color: material.diffuse,
      specular: material.specular,
      roughness: material.roughness,
      emissive: Math.min(
        1,
        Math.max(material.emissive[0], material.emissive[1], material.emissive[2]),
      ),
      emissiveColor:
        Math.max(material.emissive[0], material.emissive[1], material.emissive[2]) > 0
          ? material.emissive
          : [-1, -1, -1],
      opacity: material.opacity,
      /* `Pm` is the PBR extension's metalness and the only thing an mtl says about
         reflection, so it feeds this as well as the highlight. */
      reflectivity: Math.min(1, Math.max(0, material.specular)),
      normalMap: -1,
      ormMap: -1,
      emissiveMap: -1,
      roughnessScale: 1,
      metallicScale: 1,
      occlusionStrength: 0,
      cutout: 0,
      albedo,
    });
  }
  if (meshes.length === 0) throw new DrftError('obj: no faces');
  return { meshes, warnings, materials: perMesh, textures };
}

function buildGroup(
  corners: readonly FaceVertex[],
  positions: readonly number[],
  normals: readonly number[],
  uvs: readonly number[],
  material: ObjMaterial,
  warnings: string[],
  name: string,
): MeshData {
  const count = corners.length;
  const outPositions = new Float32Array(count * 3);
  const outNormals = new Float32Array(count * 3);
  const outColors = new Float32Array(count * 3);
  const outUvs = new Float32Array(count * 2);
  const indices = new Uint32Array(count);
  let hasUvs = false;
  let missingNormals = false;

  for (let i = 0; i < count; i++) {
    const corner = corners[i] as FaceVertex;
    const p = corner.position * 3;
    outPositions[i * 3] = positions[p] ?? 0;
    outPositions[i * 3 + 1] = positions[p + 1] ?? 0;
    outPositions[i * 3 + 2] = positions[p + 2] ?? 0;

    if (corner.normal >= 0) {
      const n = corner.normal * 3;
      outNormals[i * 3] = normals[n] ?? 0;
      outNormals[i * 3 + 1] = normals[n + 1] ?? 0;
      outNormals[i * 3 + 2] = normals[n + 2] ?? 0;
    } else {
      missingNormals = true;
    }

    if (corner.uv >= 0) {
      hasUvs = true;
      const t = corner.uv * 2;
      outUvs[i * 2] = uvs[t] ?? 0;
      /*
       * V is flipped, once, here.
       *
       * **OBJ puts the texture origin at the bottom left by specification** and this engine
       * uploads with it at the top left (`surfaceTexture.ts` sets `UNPACK_FLIP_Y_WEBGL`), which
       * is the same single correction `fbx.ts` and `usd.ts` both make and document. This reader
       * was the one of the four that did not, so every textured `.obj` imported upside down on
       * its maps while the same asset's `.fbx` sibling was correct, which is exactly what made
       * it read as a model fault rather than a reader one.
       *
       * Found from outside on a bought Formula 1 bundle, whose airbox lettering was inverted.
       * glTF needs no flip and has none: its origin is top left already.
       */
      outUvs[i * 2 + 1] = 1 - (uvs[t + 1] ?? 0);
    }

    outColors[i * 3] = material.diffuse[0];
    outColors[i * 3 + 1] = material.diffuse[1];
    outColors[i * 3 + 2] = material.diffuse[2];
    indices[i] = i;
  }

  /*
   * A file with no `vn` gets face normals computed here rather than a buffer of zeroes.
   * A zero normal is not a neutral value — every lighting term multiplies by it, so the
   * geometry would arrive black and look like a shading bug rather than a missing
   * attribute.
   */
  if (missingNormals) {
    warnings.push(`${name === '' ? 'obj' : name}: no vertex normals, so faces are shaded flat`);
    for (let i = 0; i + 2 < count; i += 3) {
      const ax = outPositions[i * 3] as number;
      const ay = outPositions[i * 3 + 1] as number;
      const az = outPositions[i * 3 + 2] as number;
      const ux = (outPositions[(i + 1) * 3] as number) - ax;
      const uy = (outPositions[(i + 1) * 3 + 1] as number) - ay;
      const uz = (outPositions[(i + 1) * 3 + 2] as number) - az;
      const vx = (outPositions[(i + 2) * 3] as number) - ax;
      const vy = (outPositions[(i + 2) * 3 + 1] as number) - ay;
      const vz = (outPositions[(i + 2) * 3 + 2] as number) - az;
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const length = Math.hypot(nx, ny, nz) || 1;
      nx /= length;
      ny /= length;
      nz /= length;
      for (let c = 0; c < 3; c++) {
        if (
          outNormals[(i + c) * 3] === 0 &&
          outNormals[(i + c) * 3 + 1] === 0 &&
          outNormals[(i + c) * 3 + 2] === 0
        ) {
          outNormals[(i + c) * 3] = nx;
          outNormals[(i + c) * 3 + 1] = ny;
          outNormals[(i + c) * 3 + 2] = nz;
        }
      }
    }
  }

  const emissiveStrength = Math.max(...material.emissive);
  const emissive = new Float32Array(count).fill(emissiveStrength);
  const emissiveColor = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const named = emissiveStrength > 0;
    emissiveColor[i * 3] = named ? material.emissive[0] : -1;
    emissiveColor[i * 3 + 1] = named ? material.emissive[1] : -1;
    emissiveColor[i * 3 + 2] = named ? material.emissive[2] : -1;
  }

  return {
    positions: outPositions,
    normals: outNormals,
    colors: outColors,
    emissive,
    specular: new Float32Array(count).fill(material.specular),
    roughness: new Float32Array(count).fill(material.roughness),
    emissiveColor,
    indices,
    ...(hasUvs ? { uvs: outUvs } : {}),
  };
}

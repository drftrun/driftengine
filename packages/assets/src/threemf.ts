/**
 * 3MF, the 3D Manufacturing Format: a zip of XML from the 3MF Consortium.
 *
 * Tier 1. The specification is published and the core is small — a mesh is a vertex list and
 * a triangle list, and that has not changed since the format was introduced.
 *
 * **The same zip reader as `.usdz`, and the reason the two were built together.** The
 * difference is one parameter: USD requires its entries *stored* so a runtime can memory
 * map them, and 3MF uses ordinary deflate, so this one needs the injected inflate and that
 * one does not. Injected rather than imported for the same reason as `fbx.ts`: this module
 * is part of an engine that runs in a browser and must not reach for Node's `zlib`.
 *
 * **A printing format, so what it does not carry matters as much as what it does.** There
 * are no normals: a 3MF mesh is a closed manifold and a slicer derives what it needs, so
 * they are computed here from the triangles. There are no texture coordinates in the core
 * specification either — the materials extension adds them, and until an asset turns up
 * that uses it, claiming support would be claiming something untested.
 */

import type { MeshData } from '@driftengine/drft';
import { DrftError } from '@driftengine/drft';
import type { DrftMaterial } from '@driftengine/drft';
import type { Inflate } from './fbx.ts';
import type { UpAxis } from './orient.ts';
import { readZip } from './zip.ts';

/** What a `.3mf` yields, in the shape every other reader in this directory returns. */
export interface ThreeMfResult {
  readonly meshes: MeshData[];
  /** One per mesh, by ordinal. */
  readonly materials: DrftMaterial[];
  readonly warnings: string[];
  /**
   * 3MF is Z-up and says so in its specification rather than per file, so this is a fact
   * about the format rather than something read out of the document.
   */
  readonly declaredUp: UpAxis;
  /** Metres per unit, from the model's `unit` attribute. Millimetres is the default. */
  readonly unitScale: number;
}

/** `unit` values the specification defines, in metres. */
const UNITS: Readonly<Record<string, number>> = {
  micron: 1e-6,
  millimeter: 1e-3,
  centimeter: 1e-2,
  inch: 0.0254,
  foot: 0.3048,
  meter: 1,
};

const DEFAULT_MATERIAL: DrftMaterial = {
  name: '',
  color: [0.8, 0.8, 0.8],
  specular: 0,
  roughness: 0.6,
  emissive: 0,
  emissiveColor: [-1, -1, -1],
  opacity: 1,
  albedo: -1,
  reflectivity: 0,
  normalMap: -1,
  ormMap: -1,
  emissiveMap: -1,
  roughnessScale: 1,
  metallicScale: 1,
  occlusionStrength: 0,
  cutout: 0,
};

/** Every attribute of one XML tag, as a map. Values are always quoted in 3MF. */
function attributes(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  const pattern = /([\w:]+)\s*=\s*"([^"]*)"/g;
  let match = pattern.exec(tag);
  while (match !== null) {
    out.set(match[1] as string, match[2] as string);
    match = pattern.exec(tag);
  }
  return out;
}

/**
 * `#RRGGBB` or `#RRGGBBAA` to linear colour and opacity.
 *
 * **sRGB to linear, rather than the byte value straight through.** 3MF states its colours
 * as sRGB, which is what a colour picker shows and not what a renderer multiplies: taking
 * the bytes as-is makes every surface too bright, most visibly in the midtones, and it is
 * the kind of wrong that looks like a lighting problem.
 */
function parseColor(value: string): { color: [number, number, number]; opacity: number } | null {
  const hex = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(value.trim());
  if (hex === null) return null;
  const rgb = hex[1] as string;
  const toLinear = (byte: number): number => {
    const s = byte / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return {
    color: [
      toLinear(parseInt(rgb.slice(0, 2), 16)),
      toLinear(parseInt(rgb.slice(2, 4), 16)),
      toLinear(parseInt(rgb.slice(4, 6), 16)),
    ],
    opacity: hex[2] === undefined ? 1 : parseInt(hex[2], 16) / 255,
  };
}

/**
 * Flat normals, derived per triangle and accumulated per vertex.
 *
 * 3MF carries none, so they are computed rather than invented: a printing format describes a
 * solid and leaves shading to whoever displays it. Accumulating and normalising gives smooth
 * shading across a curved surface, and `weld.ts` keeps a hard edge hard afterwards because
 * two corners with different normals do not merge.
 */
function deriveNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let at = 0; at + 2 < indices.length; at += 3) {
    const a = (indices[at] as number) * 3;
    const b = (indices[at + 1] as number) * 3;
    const c = (indices[at + 2] as number) * 3;
    const ux = (positions[b] as number) - (positions[a] as number);
    const uy = (positions[b + 1] as number) - (positions[a + 1] as number);
    const uz = (positions[b + 2] as number) - (positions[a + 2] as number);
    const vx = (positions[c] as number) - (positions[a] as number);
    const vy = (positions[c + 1] as number) - (positions[a + 1] as number);
    const vz = (positions[c + 2] as number) - (positions[a + 2] as number);
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const corner of [a, b, c]) {
      normals[corner] = (normals[corner] as number) + nx;
      normals[corner + 1] = (normals[corner + 1] as number) + ny;
      normals[corner + 2] = (normals[corner + 2] as number) + nz;
    }
  }
  for (let at = 0; at + 2 < normals.length; at += 3) {
    const length = Math.hypot(
      normals[at] as number,
      normals[at + 1] as number,
      normals[at + 2] as number,
    );
    if (length === 0) {
      normals[at + 1] = 1;
      continue;
    }
    normals[at] = (normals[at] as number) / length;
    normals[at + 1] = (normals[at + 1] as number) / length;
    normals[at + 2] = (normals[at + 2] as number) / length;
  }
  return normals;
}

/** Read the `3dmodel.model` XML out of a 3MF archive. */
export function parseThreeMfModel(xml: string): ThreeMfResult {
  const warnings: string[] = [];

  const modelTag = /<model\b[^>]*>/.exec(xml)?.[0] ?? '';
  const unit = attributes(modelTag).get('unit') ?? 'millimeter';
  const unitScale = UNITS[unit];
  if (unitScale === undefined) {
    warnings.push(`unknown unit "${unit}"; treating the model as millimetres`);
  }

  /*
   * The colour groups a triangle may point at. `basematerials` is the core specification's
   * own; `colorgroup` comes from the materials extension and is what most exporters write.
   * Both are flat lists indexed by the `pid`/`pindex` pair on an object or a triangle.
   */
  const palettes = new Map<string, DrftMaterial[]>();
  const groupPattern = /<(basematerials|m:colorgroup|colorgroup)\b([^>]*)>([\s\S]*?)<\/\1>/g;
  let group = groupPattern.exec(xml);
  while (group !== null) {
    const id = attributes(group[2] as string).get('id');
    if (id !== undefined) {
      const entries: DrftMaterial[] = [];
      const itemPattern = /<(?:base|m:color|color)\b([^>]*)\/?>/g;
      let item = itemPattern.exec(group[3] as string);
      while (item !== null) {
        const fields = attributes(item[1] as string);
        const parsed = parseColor(fields.get('displaycolor') ?? fields.get('color') ?? '');
        entries.push({
          ...DEFAULT_MATERIAL,
          name: fields.get('name') ?? `material ${entries.length}`,
          ...(parsed === null ? {} : { color: parsed.color, opacity: parsed.opacity }),
        });
        item = itemPattern.exec(group[3] as string);
      }
      palettes.set(id, entries);
    }
    group = groupPattern.exec(xml);
  }

  const meshes: MeshData[] = [];
  const materials: DrftMaterial[] = [];

  const objectPattern = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
  let object = objectPattern.exec(xml);
  while (object !== null) {
    const objectFields = attributes(object[1] as string);
    const body = object[2] as string;
    const name = objectFields.get('name') ?? `object ${objectFields.get('id') ?? meshes.length}`;

    const vertices: number[] = [];
    const vertexPattern = /<vertex\b([^>]*)\/?>/g;
    let vertex = vertexPattern.exec(body);
    while (vertex !== null) {
      const fields = attributes(vertex[1] as string);
      vertices.push(
        Number(fields.get('x') ?? 0),
        Number(fields.get('y') ?? 0),
        Number(fields.get('z') ?? 0),
      );
      vertex = vertexPattern.exec(body);
    }

    const indices: number[] = [];
    const trianglePattern = /<triangle\b([^>]*)\/?>/g;
    let triangle = trianglePattern.exec(body);
    while (triangle !== null) {
      const fields = attributes(triangle[1] as string);
      const v1 = Number(fields.get('v1'));
      const v2 = Number(fields.get('v2'));
      const v3 = Number(fields.get('v3'));
      const count = vertices.length / 3;
      if (![v1, v2, v3].every((index) => Number.isInteger(index) && index >= 0 && index < count)) {
        throw new DrftError(
          `3mf: object "${name}" has a triangle indexing ${v1}, ${v2}, ${v3} of ${count} vertices`,
        );
      }
      indices.push(v1, v2, v3);
      triangle = trianglePattern.exec(body);
    }

    if (vertices.length >= 9 && indices.length >= 3) {
      const positions = Float32Array.from(vertices);
      const indexArray = Uint32Array.from(indices);
      const count = positions.length / 3;
      meshes.push({
        positions,
        normals: deriveNormals(positions, indexArray),
        colors: new Float32Array(count * 3).fill(1),
        emissive: new Float32Array(count),
        indices: indexArray,
      });

      const pid = objectFields.get('pid');
      const pindex = Number(objectFields.get('pindex') ?? 0);
      const palette = pid === undefined ? undefined : palettes.get(pid);
      const chosen = palette?.[Number.isFinite(pindex) ? pindex : 0];
      materials.push(chosen === undefined ? { ...DEFAULT_MATERIAL, name } : { ...chosen, name });
    } else if (vertices.length > 0 || indices.length > 0) {
      warnings.push(`object "${name}" carries no usable geometry and was skipped`);
    }
    object = objectPattern.exec(xml);
  }

  if (meshes.length === 0) throw new DrftError('3mf: the model carries no readable object');

  return {
    meshes,
    materials,
    warnings,
    /*
     * Stated, never applied. 3MF's specification fixes Z as up, which in a Y-up engine means
     * every print lands on its side — so it is reported here and turned once, format
     * agnostically, in `orient.ts`, exactly as the STL note and the FBX fix established.
     */
    declaredUp: '+z',
    unitScale: unitScale ?? 1e-3,
  };
}

/**
 * Read a `.3mf` archive.
 *
 * The model part is named by the OPC relationships, and is `3D/3dmodel.model` in practice.
 * Both are tried, the relationship first, because "in practice" is how a reader acquires a
 * file it cannot open two years later.
 */
export function threeMfToMeshes(buffer: ArrayBuffer, inflate: Inflate): ThreeMfResult {
  const entries = readZip(buffer, inflate);
  const decoder = new TextDecoder();

  const relationships = entries.find((entry) => entry.name.toLowerCase() === '_rels/.rels');
  let target: string | null = null;
  if (relationships !== undefined) {
    const declared = /Target\s*=\s*"([^"]+)"/i.exec(decoder.decode(relationships.bytes))?.[1];
    if (declared !== undefined) target = declared.replace(/^\//, '').toLowerCase();
  }

  const model =
    (target === null ? undefined : entries.find((entry) => entry.name.toLowerCase() === target)) ??
    entries.find((entry) => entry.name.toLowerCase().endsWith('.model'));
  if (model === undefined) {
    throw new DrftError(
      `3mf: the archive holds no .model part (it holds ${entries.map((entry) => entry.name).join(', ')})`,
    );
  }

  return parseThreeMfModel(decoder.decode(model.bytes));
}

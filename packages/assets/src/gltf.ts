/**
 * glTF 2.0 → `MeshData`, with no dependencies and no filesystem.
 *
 * glTF is the only third-party format this engine reads at tier 1, and it earns that by
 * being an open Khronos standard with a published specification and a conformance suite.
 * Everything the baker guarantees rests here; nothing guaranteed rests on a vendor's
 * internal layout. See docs/FORMAT.md §2.
 *
 * **Buffers arrive as bytes, never as paths.** The parser takes the JSON and the binary
 * blobs it refers to, so it runs identically in the CLI, in a test, and in a browser, and
 * so a test can build a document by hand instead of shipping fixture files for cases that
 * are three lines of JSON.
 *
 * **Transforms are baked.** `MeshData` has no node and no matrix — a mesh is geometry in
 * world space, which is what makes drawing it one call with no per-object state. So the
 * scene graph is flattened here: each primitive's vertices are transformed by its node's
 * world matrix on the way through, and the graph does not survive into the engine.
 */

import type { DrftNode, MeshData } from '@driftengine/drft';
import { DrftError } from '@driftengine/drft';
import type { DrftMaterial } from '@driftengine/drft';
import { generateTangents } from '@driftengine/core';
import type { AssetReference } from './assetPath.ts';
import { MAX_MORPH_TARGETS } from '@driftengine/core';
import { accessorFloats } from './gltfAccessor.ts';
import type { GltfSkin } from './gltfSkin.ts';
import { readGltfSkins } from './gltfSkin.ts';

/* The subset of the schema this reads. Everything else is ignored or refused by name. */
interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  normalized?: boolean;
  sparse?: unknown;
}
interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
}
interface GltfPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
  /** Morph targets: one entry per target, each naming its own delta accessors. */
  targets?: Record<string, number>[];
}
interface GltfPbrMetallicRoughness {
  baseColorFactor?: number[];
  metallicFactor?: number;
  roughnessFactor?: number;
  baseColorTexture?: { index: number; texCoord?: number };
  metallicRoughnessTexture?: { index: number; texCoord?: number };
}
/**
 * `KHR_materials_pbrSpecularGlossiness`: Khronos' first PBR material model, archived in 2020.
 *
 * A material stating it carries **no `pbrMetallicRoughness` object at all** — the colour map is
 * `diffuseTexture` here, and reflection is a specular colour and a glossiness rather than a
 * metalness and a roughness. It is still what an asset store serves for anything exported from a
 * specular workflow, and a reader that knows only the core model reads such a file's images, binds
 * none of them, and paints the result in one flat fallback colour.
 */
interface GltfSpecularGlossiness {
  /** RGB the diffuse colour, A the opacity. Multiplies `diffuseTexture` where there is one. */
  diffuseFactor?: number[];
  diffuseTexture?: { index: number; texCoord?: number };
  /** The specular *colour*, which is what carries a metal's tint in this model. */
  specularFactor?: number[];
  glossinessFactor?: number;
  /** RGB the specular colour, A the glossiness. Both multiply the factors above. */
  specularGlossinessTexture?: { index: number; texCoord?: number };
}
interface GltfMaterial {
  pbrMetallicRoughness?: GltfPbrMetallicRoughness;
  /**
   * The material extensions this reader knows. One, and everything else is ignored.
   *
   * Read as an optional field rather than as `Record<string, unknown>` so that adding a second
   * costs a name here and a branch in `pbrOf`, and so that a typo in either is a compile error.
   */
  extensions?: { KHR_materials_pbrSpecularGlossiness?: GltfSpecularGlossiness };
  normalTexture?: { index: number; texCoord?: number; scale?: number };
  /** `strength` is a mix from 1, not a multiply: 0 means unoccluded. */
  occlusionTexture?: { index: number; texCoord?: number; strength?: number };
  emissiveTexture?: { index: number; texCoord?: number };
  emissiveFactor?: number[];
  /** `OPAQUE`, `MASK` or `BLEND`. Absent means opaque, which the specification states. */
  alphaMode?: string;
  alphaCutoff?: number;
  name?: string;
  /**
   * Whatever the authoring tool put here, and this reader wants exactly one field of it.
   *
   * `extras.substance` is a substance id — `oak`, `gypsum-board` — which the baker writes into the
   * `SUBS` chunk so a consumer can hand it to `installChemistry().match`. **An artist labels the oak
   * in Blender and the log burns like oak**, with no code in between; `§16` of the chemistry design
   * is the argument, and glTF's `extras` is the standard place for exactly this.
   *
   * Read as `unknown` and checked, because `extras` is whatever somebody's exporter wrote.
   */
  extras?: Record<string, unknown>;
}
/** An image, either inside the binary chunk or beside the document. */
interface GltfImage {
  uri?: string;
  bufferView?: number;
  mimeType?: string;
  name?: string;
}
/** A sampler paired with an image. Only the image is used; sampler state is the engine's. */
interface GltfTexture {
  source?: number;
  sampler?: number;
}
interface GltfNode {
  mesh?: number;
  /** The skin this node's mesh is deformed by. Its presence is what stops the bake. */
  skin?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  name?: string;
}
export interface GltfDocument {
  asset?: { version?: string; generator?: string };
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: GltfNode[];
  meshes?: { primitives: GltfPrimitive[]; name?: string }[];
  accessors?: GltfAccessor[];
  bufferViews?: GltfBufferView[];
  buffers?: { byteLength: number; uri?: string }[];
  materials?: GltfMaterial[];
  images?: GltfImage[];
  textures?: GltfTexture[];
  /* Read by `gltfSkin.ts`; ignored entirely by the mesh path, which flattens. */
  skins?: GltfSkinDef[];
  animations?: GltfAnimationDef[];
}

/** A skin, as glTF declares one. `skeleton` is a hint this reader does not need and ignores. */
export interface GltfSkinDef {
  joints: number[];
  inverseBindMatrices?: number;
  skeleton?: number;
  name?: string;
}

export interface GltfAnimationDef {
  name?: string;
  samplers: { input: number; output: number; interpolation?: string }[];
  channels: { sampler: number; target: { node?: number; path?: string } }[];
}

/** The engine's own roughness, for a material whose stated one cannot be believed. */
const DEFAULT_ROUGHNESS = 0.4277;

/** `TRIANGLES`. The only primitive mode a `MeshData` can express. */
const MODE_TRIANGLES = 4;

/**
 * Split a `.glb` into its JSON and its binary chunk.
 *
 * A `.glb` is the same document as a `.gltf` with the JSON and the buffer packed into one
 * file, which is why an asset store hands you both — and why preferring it costs nothing.
 */
export function readGlb(buffer: ArrayBuffer): { json: GltfDocument; binary: Uint8Array | null } {
  const view = new DataView(buffer);
  if (buffer.byteLength < 12) throw new DrftError('glb: shorter than its own header');
  if (view.getUint32(0, true) !== 0x46546c67) throw new DrftError('glb: bad magic, not a glb file');
  const version = view.getUint32(4, true);
  if (version !== 2) throw new DrftError(`glb: version ${version}, and only 2 is defined`);

  let json: GltfDocument | null = null;
  let binary: Uint8Array | null = null;
  let at = 12;
  while (at + 8 <= buffer.byteLength) {
    const length = view.getUint32(at, true);
    const kind = view.getUint32(at + 4, true);
    const start = at + 8;
    if (start + length > buffer.byteLength) {
      throw new DrftError(`glb: a chunk at ${at} claims ${length} bytes and runs past the file`);
    }
    if (kind === 0x4e4f534a) {
      json = JSON.parse(
        new TextDecoder().decode(new Uint8Array(buffer, start, length)),
      ) as GltfDocument;
    } else if (kind === 0x004e4942) {
      binary = new Uint8Array(buffer, start, length);
    }
    // Any other chunk kind is ignored, which the specification requires.
    at = start + length + ((4 - (length % 4)) % 4);
  }
  if (json === null) throw new DrftError('glb: no JSON chunk');
  return { json, binary };
}

/** Everything a document needs to be read: its buffers, in `buffers` order. */
export type BufferResolver = (index: number, uri: string | undefined) => Uint8Array;

/**
 * The matrix a skinned primitive is built with: none.
 *
 * A palette entry already carries its joint's inverse bind, so it takes a vertex from model space
 * to where the joint moved it — and `uModel` then places the character. Baking the node's world
 * matrix in as well applies that placement twice and throws the rig across the scene.
 */
const IDENTITY: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/* --- Node transforms, composed to world space --- */

function identity(): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function multiply(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(16);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += (a[k * 4 + row] as number) * (b[col * 4 + k] as number);
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

/** A node's local matrix, from either the explicit matrix or its TRS. */
function localMatrix(node: GltfNode): number[] {
  if (node.matrix !== undefined) return node.matrix.slice();
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];

  const x2 = (qx as number) + (qx as number);
  const y2 = (qy as number) + (qy as number);
  const z2 = (qz as number) + (qz as number);
  const xx = (qx as number) * x2;
  const xy = (qx as number) * y2;
  const xz = (qx as number) * z2;
  const yy = (qy as number) * y2;
  const yz = (qy as number) * z2;
  const zz = (qz as number) * z2;
  const wx = (qw as number) * x2;
  const wy = (qw as number) * y2;
  const wz = (qw as number) * z2;

  return [
    (1 - (yy + zz)) * (sx as number),
    (xy + wz) * (sx as number),
    (xz - wy) * (sx as number),
    0,
    (xy - wz) * (sy as number),
    (1 - (xx + zz)) * (sy as number),
    (yz + wx) * (sy as number),
    0,
    (xz + wy) * (sz as number),
    (yz - wx) * (sz as number),
    (1 - (xx + yy)) * (sz as number),
    0,
    tx as number,
    ty as number,
    tz as number,
    1,
  ];
}

/**
 * The matrix a normal must be transformed by: the inverse transpose of the upper 3×3.
 *
 * Not the same matrix the positions use, and the difference is visible the moment an
 * asset is scaled unevenly — a surface stretched on one axis has normals that lean the
 * *other* way, and using the position matrix tilts every one of them wrongly. That reads
 * as lighting sliding across a face, which is exactly the kind of fault that gets blamed
 * on a renderer.
 */
function normalMatrix(m: readonly number[]): number[] {
  const a = m[0] as number;
  const b = m[1] as number;
  const c = m[2] as number;
  const d = m[4] as number;
  const e = m[5] as number;
  const f = m[6] as number;
  const g = m[8] as number;
  const h = m[9] as number;
  const i = m[10] as number;

  const det = a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e);
  if (Math.abs(det) < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const inv = 1 / det;
  /* Inverse, then transposed — written out, because the two steps cancel into this. */
  return [
    (e * i - f * h) * inv,
    (g * f - d * i) * inv,
    (d * h - g * e) * inv,
    (h * c - b * i) * inv,
    (a * i - g * c) * inv,
    (g * b - a * h) * inv,
    (b * f - e * c) * inv,
    (d * c - a * f) * inv,
    (a * e - d * b) * inv,
  ];
}

/**
 * The images a document carries, in `textures` order, as references the baker can act on.
 *
 * glTF states an image three ways and all three appear in the wild: inside the binary chunk
 * as a buffer view, inline as a `data:` URI, and as a file beside the document. The first two
 * arrive with their bytes and need nothing resolved; only the third is a lookup, and it is
 * the same lookup FBX's relative paths go through.
 *
 * Indexed by *texture* rather than by image, because a material names a texture and two
 * textures may share one image with different samplers. Following the indirection here keeps
 * the material's index meaning what the file said it meant.
 */
function readImages(
  doc: GltfDocument,
  buffers: readonly Uint8Array[],
  warnings: string[],
): AssetReference[] {
  const out: AssetReference[] = [];
  for (let i = 0; i < (doc.textures ?? []).length; i++) {
    const source = doc.textures?.[i]?.source;
    const image = source === undefined ? undefined : doc.images?.[source];
    if (image === undefined) {
      warnings.push(`texture ${i} names no image this reader can find; it will draw untextured`);
      out.push({ name: `texture-${i}` });
      continue;
    }
    const name = image.name ?? image.uri ?? `image-${source}`;

    if (image.bufferView !== undefined) {
      const view = doc.bufferViews?.[image.bufferView];
      const buffer = view === undefined ? undefined : buffers[view.buffer];
      if (view === undefined || buffer === undefined) {
        warnings.push(`image ${source} names a bufferView that is absent`);
        out.push({ name });
        continue;
      }
      const at = view.byteOffset ?? 0;
      /* Copied rather than viewed: the caller embeds this and the source buffer is the
         whole binary chunk, which would otherwise be kept alive by one texture. */
      out.push({ name, bytes: buffer.slice(at, at + view.byteLength) });
      continue;
    }

    if (image.uri !== undefined && image.uri.startsWith('data:')) {
      const comma = image.uri.indexOf(',');
      const base64 = image.uri.slice(comma + 1);
      /* `atob` rather than a Node Buffer: this module runs in a browser too. */
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let b = 0; b < binary.length; b++) bytes[b] = binary.charCodeAt(b);
      out.push({ name: image.name ?? `image-${source}`, bytes });
      continue;
    }

    /* A plain URI: a path relative to the document, which the caller resolves. */
    out.push({ name: image.uri === undefined ? name : decodeURIComponent(image.uri) });
  }
  return out;
}

/**
 * The reflectance of a dielectric at normal incidence: 4%. Both material models are built on it.
 */
const DIELECTRIC_SPECULAR = 0.04;

/** Guards the two divisions in the base-colour derivation; Khronos' own conversion uses this value. */
const CONVERSION_EPSILON = 1e-6;

/**
 * Rec. 601 perceived brightness, which is the measure Khronos' conversion is written in.
 *
 * Not Rec. 709 luminance, which is what the renderer measures brightness with elsewhere. The
 * difference is small and the reason to keep this one is that the quadratic below was derived
 * against it: substituting a different weighting changes which surfaces solve to metal.
 */
function perceivedBrightness(c: readonly number[]): number {
  const r = c[0] ?? 0;
  const g = c[1] ?? 0;
  const b = c[2] ?? 0;
  return Math.sqrt(0.299 * r * r + 0.587 * g * g + 0.114 * b * b);
}

/**
 * The metalness a diffuse and a specular brightness imply, as the roots of Khronos' quadratic.
 *
 * Specular-glossiness and metallic-roughness describe the same surface with different unknowns, so
 * one is not a rename of the other: the pair has to be **solved for jointly**. A dielectric's
 * reflectance is fixed at 4% and its colour lives in the diffuse; a metal has no diffuse at all and
 * its colour lives in the specular. The quadratic is the statement that a given diffuse and
 * specular can be produced by exactly one metalness between those two ends.
 *
 * This is Appendix B of the extension, unchanged. It is stated in *brightnesses* rather than in
 * colours because there is one metalness for the surface and three channels arguing about it.
 */
function solveMetallic(
  diffuse: number,
  specular: number,
  oneMinusSpecularStrength: number,
): number {
  if (specular < DIELECTRIC_SPECULAR) return 0;
  const a = DIELECTRIC_SPECULAR;
  const b =
    (diffuse * oneMinusSpecularStrength) / (1 - DIELECTRIC_SPECULAR) +
    specular -
    2 * DIELECTRIC_SPECULAR;
  const c = DIELECTRIC_SPECULAR - specular;
  return Math.min(1, Math.max(0, (-b + Math.sqrt(Math.max(b * b - 4 * a * c, 0))) / (2 * a)));
}

/**
 * A specular-glossiness material, restated as the metallic-roughness one the rest of this file reads.
 *
 * **What this gives up.** The specular colour and the glossiness are a pair, and where they live in
 * a `specularGlossinessTexture` — RGB the colour, A the gloss — no rearrangement of numbers can
 * reach them: glTF's ORM packing wants roughness in G and metallic in B, so producing one would
 * mean decoding every image and re-encoding it with its channels moved. That is a baker's job and
 * not a reader's, and binding the map unconverted would be worse than binding nothing, because the
 * renderer would read a specular colour's green as a roughness. So the pair is left **absent** in
 * that case rather than guessed: metallic 0 and the engine's own `DEFAULT_ROUGHNESS`, which is the
 * same rule `materialOf` already applies where a map supplies values a scalar cannot express. The
 * diffuse map still binds, which is the whole of what was missing before.
 *
 * **What would make this wrong**: a reader that decoded images. It would have the texels and could
 * repack them, and then this function should produce an `ormMap` instead of declining to.
 *
 * With no `specularGlossinessTexture` the conversion is exact and is Appendix B of the extension,
 * including its base-colour derivation — which is what makes a chrome surface, whose diffuse is
 * black and whose colour is entirely in its specular, arrive as chrome rather than as a black
 * mirror.
 */
function specularGlossinessAsPbr(sg: GltfSpecularGlossiness): GltfPbrMetallicRoughness {
  const diffuse = sg.diffuseFactor ?? [1, 1, 1, 1];
  const alpha = diffuse[3] ?? 1;
  const map = sg.diffuseTexture === undefined ? {} : { baseColorTexture: sg.diffuseTexture };

  if (sg.specularGlossinessTexture !== undefined) {
    return {
      ...map,
      baseColorFactor: [diffuse[0] ?? 1, diffuse[1] ?? 1, diffuse[2] ?? 1, alpha],
      metallicFactor: 0,
      roughnessFactor: DEFAULT_ROUGHNESS,
    };
  }

  const specular = sg.specularFactor ?? [1, 1, 1];
  const oneMinusSpecularStrength =
    1 - Math.max(specular[0] ?? 1, specular[1] ?? 1, specular[2] ?? 1);
  const metallic = solveMetallic(
    perceivedBrightness(diffuse),
    perceivedBrightness(specular),
    oneMinusSpecularStrength,
  );
  /* Two readings of the same colour — the one a dielectric implies and the one a metal implies —
     blended by `metallic²`, which is Appendix B's own weighting. The epsilons stop a division by
     zero at either end; at both ends the term they guard is multiplied out by the blend. */
  const fromDielectric =
    oneMinusSpecularStrength /
    (1 - DIELECTRIC_SPECULAR) /
    Math.max(1 - metallic, CONVERSION_EPSILON);
  const fromMetal = 1 / Math.max(metallic, CONVERSION_EPSILON);
  const blend = metallic * metallic;
  const colour: number[] = [];
  for (let i = 0; i < 3; i++) {
    const dielectric = (diffuse[i] ?? 1) * fromDielectric;
    const metal = ((specular[i] ?? 1) - DIELECTRIC_SPECULAR * (1 - metallic)) * fromMetal;
    colour.push(Math.min(1, Math.max(0, dielectric + (metal - dielectric) * blend)));
  }

  return {
    ...map,
    baseColorFactor: [colour[0] as number, colour[1] as number, colour[2] as number, alpha],
    metallicFactor: metallic,
    /* Glossiness is roughness counted from the other end, and that half of the pair is exact. */
    roughnessFactor: Math.min(1, Math.max(0, 1 - (sg.glossinessFactor ?? 1))),
  };
}

/**
 * The metallic-roughness block this reader reads, whichever of the two models the file states.
 *
 * **The core object wins where a file carries both.** The extension's own text says the opposite —
 * a renderer that supports it should prefer it — and that rule is written for a renderer that
 * supports it *completely*. This one cannot repack a `specularGlossinessTexture`, while an exporter
 * that wrote both blocks did the conversion with the texels in hand and put a real
 * `metallicRoughnessTexture` in the core one. Preferring the extension there would throw away a
 * better answer than this function can compute.
 *
 * **What would make this wrong**: an exporter that writes a token `pbrMetallicRoughness` — factors
 * and no maps — purely so a non-supporting reader gets something. Such a file would take the token
 * block and lose its diffuse map, and the fix is to prefer whichever block names more textures.
 * Nothing in the corpus this was built against writes one, so the simpler rule stands until one
 * appears.
 */
function pbrOf(material: GltfMaterial | undefined): GltfPbrMetallicRoughness | undefined {
  if (material === undefined) return undefined;
  if (material.pbrMetallicRoughness !== undefined) return material.pbrMetallicRoughness;
  const sg = material.extensions?.KHR_materials_pbrSpecularGlossiness;
  return sg === undefined ? undefined : specularGlossinessAsPbr(sg);
}

/**
 * A primitive's material, in the terms `.drft` stores.
 *
 * `alphaMode` decides whether the alpha channel means anything at all, and it has **three**
 * settings rather than two. `OPAQUE`, which is the default the specification states, means a base
 * colour's fourth component is to be *ignored* rather than honoured — so reading it
 * unconditionally would make every material that happens to carry a non-one alpha in an opaque
 * file turn see-through. `BLEND` is the one that becomes an opacity.
 *
 * **`MASK` is neither, and was dropped for as long as this reader has existed.** It means the
 * alpha is a *test*: a fragment below `alphaCutoff` is discarded and everything above it is fully
 * opaque. Read as an opacity it would be wrong in both directions, and ignored — which is what
 * happened — a masked surface arrives as the solid rectangle its geometry is, with the shape that
 * was supposed to be cut out of it painted over. `cutout` is where it goes, and the 0.5 default is
 * the specification's own.
 */
function materialOf(material: GltfMaterial | undefined): DrftMaterial {
  const pbr = pbrOf(material);
  const base = pbr?.baseColorFactor ?? [1, 1, 1, 1];
  const emissiveFactor = material?.emissiveFactor ?? [0, 0, 0];
  const emissive = Math.min(
    1,
    Math.max(emissiveFactor[0] ?? 0, emissiveFactor[1] ?? 0, emissiveFactor[2] ?? 0),
  );
  const blends = material?.alphaMode === 'BLEND';
  const masked = material?.alphaMode === 'MASK';

  /*
   * **A factor that multiplies a texture is not a value, and now it does not have to be thrown
   * away.**
   *
   * glTF's `metallicFactor` and `roughnessFactor` default to 1, and where a
   * `metallicRoughnessTexture` is present they *scale* it per texel rather than standing in for
   * it. This reader had no metallic term and did not sample that map, so taking the scalars at
   * face value asserted "maximally metallic, maximally rough" over every surface that meant
   * "whatever the map says".
   *
   * It was not a subtle error. A test character whose base colour averages RGB 26, 27, 27 —
   * nearly black — arrived blown to white, because the albedo contributed almost nothing and a
   * specular of 1 contributed everything. So the map's scalars were treated as unknown and the
   * engine's defaults used instead, which was the only safe reading available.
   *
   * There is somewhere to put them now. The map carries the per-texel values and the factors
   * become `roughnessScale` and `metallicScale`, which is what glTF says they are. The scalar
   * `specular`, `roughness` and `reflectivity` readings stay for the untextured case and keep the
   * engine's defaults where a map supplies them, because a vertex attribute cannot express a
   * value that varies per texel and a wrong constant is worse than a neutral one.
   */
  const ormMap = pbr?.metallicRoughnessTexture?.index ?? -1;
  const modulated = ormMap >= 0;
  const metallic = modulated ? 0 : (pbr?.metallicFactor ?? 1);
  const roughness = modulated ? DEFAULT_ROUGHNESS : (pbr?.roughnessFactor ?? 1);

  /*
   * **glTF leaves `metallicRoughnessTexture`'s R channel undefined.** The specification assigns G
   * to roughness and B to metallic and says nothing at all about R, so occlusion lives there only
   * when `occlusionTexture` names the *same image* — which is exactly what the ORM convention is.
   * Anywhere else, reading R is reading whatever the exporter happened to leave, and the symptom
   * is a model arriving blotchy with nothing in the file to point at.
   *
   * A separate occlusion image is dropped rather than loaded into a second unit. One map, one
   * unit, and `textureUnitBudget.test.ts` says the next unit belongs to emissive.
   */
  const occlusion = material?.occlusionTexture;
  const occlusionStrength =
    modulated && occlusion !== undefined && occlusion.index === ormMap
      ? (occlusion.strength ?? 1)
      : 0;

  return {
    name: material?.name ?? '',
    color: [base[0] ?? 1, base[1] ?? 1, base[2] ?? 1],
    specular: metallic,
    roughness,
    emissive,
    emissiveColor:
      emissive > 0
        ? [emissiveFactor[0] ?? 0, emissiveFactor[1] ?? 0, emissiveFactor[2] ?? 0]
        : [-1, -1, -1],
    opacity: blends ? Math.min(1, Math.max(0, base[3] ?? 1)) : 1,
    /* Only in MASK mode: the specification says `alphaCutoff` has no meaning in the other two. */
    cutout: masked ? Math.min(1, Math.max(0, material?.alphaCutoff ?? 0.5)) : 0,
    /* Metalness is glTF's statement about reflection: a metal mirrors its surroundings and
       a dielectric mostly does not. It also feeds `specular`, which is not double counting,
       because the two describe different halves of the same fact. */
    reflectivity: Math.min(1, Math.max(0, modulated ? 0 : (pbr?.metallicFactor ?? 0))),
    normalMap: material?.normalTexture?.index ?? -1,
    ormMap,
    emissiveMap: material?.emissiveTexture?.index ?? -1,
    roughnessScale: modulated ? (pbr?.roughnessFactor ?? 1) : 1,
    metallicScale: modulated ? (pbr?.metallicFactor ?? 1) : 1,
    occlusionStrength,
    albedo: pbr?.baseColorTexture?.index ?? -1,
  };
}

/** What a caller can tell the reader about what it is going to do with the result. */
export interface GltfReadOptions {
  /**
   * Derive a tangent frame where a material declares a normal map and the file supplies none.
   *
   * **On by default, and the baker turns it off.** The derivation accumulates per index, so run
   * on a mesh stored as one vertex per triangle corner it gives every corner its own frame and
   * leaves a following weld nothing to merge — measured at 9,600 corners welding to 9,482 rather
   * than 1,681. A caller that welds should decline here and call `deriveTangentsFor` afterwards,
   * which is both a smaller mesh and a better frame, since that is the sharing the derivation
   * exists to average over.
   *
   * A caller that does *not* weld — anything reading a model straight into a renderer — wants the
   * default, or a normal-mapped model draws with no frame to sample the map along.
   *
   * A frame the file supplies is kept either way. This gates inventing one, never believing one.
   */
  readonly deriveTangents?: boolean;
}

/**
 * Turn a document into meshes in world space, one per primitive.
 *
 * One `MeshData` per primitive rather than per glTF mesh, because a primitive is the unit
 * that carries a single material — and a `MeshData` has one material's worth of vertex
 * attributes. Merging them would mean losing the distinction the file was drawing.
 */
export function gltfToMeshes(
  doc: GltfDocument,
  buffers: readonly Uint8Array[],
  options?: GltfReadOptions,
): {
  meshes: MeshData[];
  warnings: string[];
  materials: DrftMaterial[];
  textures: AssetReference[];
  nodes: DrftNode[];
} {
  const version = doc.asset?.version ?? '';
  if (!version.startsWith('2')) {
    throw new DrftError(`gltf: asset version "${version}", and this reader implements 2.0`);
  }

  const meshes: MeshData[] = [];
  const materials: DrftMaterial[] = [];
  /* One per labelled material, by the ordinal `materials` is about to give it. */
  const substances: { material: number; substance: string }[] = [];
  const warnings: string[] = [];
  const textures = readImages(doc, buffers, warnings);
  /*
   * Said once per material rather than once per primitive that uses it.
   *
   * A specular-glossiness file imports now, and half of what it states still cannot be carried:
   * `specularGlossinessAsPbr` says why, and this is where a person doing a bake finds out. On a car
   * whose 144 primitives share four materials the per-primitive spelling would be 144 lines of the
   * same sentence, which is how a real warning stops being read.
   */
  for (let i = 0; i < (doc.materials ?? []).length; i++) {
    const material = doc.materials?.[i];
    if (material === undefined || material.pbrMetallicRoughness !== undefined) continue;
    const sg = material.extensions?.KHR_materials_pbrSpecularGlossiness;
    if (sg?.specularGlossinessTexture === undefined) continue;
    warnings.push(
      `material ${i}${material.name === undefined ? '' : ` "${material.name}"`}: its specular and ` +
        'glossiness are in a map whose channels no rearrangement fits into an ORM one, so it draws ' +
        'as a dielectric at the default roughness. Its diffuse map is bound.',
    );
  }
  /*
   * Read once for the whole document, because a skin's sort is what every joint index in it has to
   * agree with — a primitive resolving its own would be a second sort and the two would drift.
   */
  const { skins } = readGltfSkins(doc, buffers);

  const sceneIndex = doc.scene ?? 0;
  const roots = doc.scenes?.[sceneIndex]?.nodes ?? doc.nodes?.map((_, at) => at) ?? [];
  const seen = new Set<number>();
  /*
   * The graph, reported beside the flattened geometry and never instead of it.
   *
   * **Flattening is unchanged and that is the point.** `MESH` stays world-space under §4.4 rule 4,
   * so every file this reader has ever produced still means exactly what it meant; this is an
   * additional, optional statement about how the parts relate. A consumer that wants parts it can
   * move calls `localiseNodes`, and one that does not is untouched.
   *
   * The walk already computes a world matrix per node, so this is bookkeeping and not a second
   * traversal.
   */
  const nodes: DrftNode[] = [];

  const walk = (nodeIndex: number, parent: readonly number[], parentNode: number): void => {
    if (seen.has(nodeIndex)) {
      // A cycle would otherwise recurse until the stack gave out, with no useful message.
      throw new DrftError(`gltf: node ${nodeIndex} is reachable twice — the graph has a cycle`);
    }
    seen.add(nodeIndex);

    const node = doc.nodes?.[nodeIndex];
    if (node === undefined)
      throw new DrftError(`gltf: a scene names node ${nodeIndex}, which is absent`);
    const world = multiply(parent, localMatrix(node));

    const entry = nodes.length;
    nodes.push({
      parent: parentNode,
      translation: [
        node.translation?.[0] ?? 0,
        node.translation?.[1] ?? 0,
        node.translation?.[2] ?? 0,
      ],
      rotation: [
        node.rotation?.[0] ?? 0,
        node.rotation?.[1] ?? 0,
        node.rotation?.[2] ?? 0,
        node.rotation?.[3] ?? 1,
      ],
      scale: [node.scale?.[0] ?? 1, node.scale?.[1] ?? 1, node.scale?.[2] ?? 1],
      mesh: -1,
      name: node.name ?? `node ${nodeIndex}`,
    });

    if (node.mesh !== undefined) {
      const mesh = doc.meshes?.[node.mesh];
      if (mesh === undefined) throw new DrftError(`gltf: node ${nodeIndex} names an absent mesh`);
      /*
       * **Flattening stays the default and a skin is the one exception.** `gltf.ts`'s header says
       * the graph does not survive into the engine, which is right for static geometry and
       * destroys exactly what a skin points at. A document with no `skins` takes the identical
       * path it took before this existed, so no existing import changes by a byte.
       */
      const skin = node.skin !== undefined ? skins[node.skin] : undefined;
      const placement = skin === undefined ? world : IDENTITY;
      for (const primitive of mesh.primitives) {
        const built = buildPrimitive(
          doc,
          buffers,
          primitive,
          placement,
          mesh.name ?? `mesh ${node.mesh}`,
          warnings,
          skin,
          options?.deriveTangents ?? true,
        );
        if (built !== null) {
          if (built.substance !== undefined) {
            substances.push({ material: materials.length, substance: built.substance });
          }
          const at = meshes.length;
          meshes.push(built.mesh);
          materials.push(built.material);
          /*
           * Name the mesh on the graph, but **only where the geometry is actually this node's**.
           * A skinned primitive was placed at `IDENTITY` above and its vertices live in the skin's
           * space, so claiming it here would invite `localiseNodes` to transform it a second time.
           *
           * A glTF node may hold several primitives while `DrftNode.mesh` names one, so extras
           * become identity children: inventing a node is better than leaving a mesh that nothing
           * in the graph points at, which is a part a game cannot find by name.
           */
          if (skin === undefined) {
            if ((nodes[entry] as DrftNode).mesh < 0) {
              nodes[entry] = { ...(nodes[entry] as DrftNode), mesh: at };
            } else {
              nodes.push({
                parent: entry,
                translation: [0, 0, 0],
                rotation: [0, 0, 0, 1],
                scale: [1, 1, 1],
                mesh: at,
                name: `${(nodes[entry] as DrftNode).name}#${at}`,
              });
            }
          }
        }
      }
    }
    for (const child of node.children ?? []) walk(child, world, entry);
    seen.delete(nodeIndex);
  };

  for (const root of roots) walk(root, identity(), -1);
  if (meshes.length === 0) throw new DrftError('gltf: the scene contains no triangle geometry');
  return {
    meshes,
    warnings,
    materials,
    textures,
    nodes,
    ...(substances.length === 0 ? {} : { substances }),
  };
}

function buildPrimitive(
  doc: GltfDocument,
  buffers: readonly Uint8Array[],
  primitive: GltfPrimitive,
  world: readonly number[],
  label: string,
  warnings: string[],
  /** The skin this primitive is deformed by, or undefined for static geometry. */
  skin?: GltfSkin,
  /** See `GltfReadOptions.deriveTangents`. A caller that welds afterwards passes false. */
  deriveTangents = true,
): { mesh: MeshData; material: DrftMaterial; substance?: string } | null {
  const mode = primitive.mode ?? MODE_TRIANGLES;
  if (mode !== MODE_TRIANGLES) {
    /*
     * Skipped with a warning rather than refused. Points and lines are legitimate glTF
     * and legitimately not geometry this engine draws, so a model carrying a debug line
     * set should still import — but silently dropping part of a file is how somebody ends
     * up wondering where their model went.
     */
    warnings.push(`${label}: skipped a primitive with mode ${mode}; only triangles are drawn`);
    return null;
  }

  const positionIndex = primitive.attributes['POSITION'];
  if (positionIndex === undefined)
    throw new DrftError(`gltf: ${label} has a primitive with no POSITION`);
  const positions = accessorFloats(doc, buffers, positionIndex, `${label} POSITION`);
  const vertices = positions.length / 3;

  const normalIndex = primitive.attributes['NORMAL'];
  const normals =
    normalIndex === undefined
      ? new Float32Array(vertices * 3)
      : accessorFloats(doc, buffers, normalIndex, `${label} NORMAL`);
  if (normalIndex === undefined) warnings.push(`${label}: no NORMAL, so it will shade flat`);

  /* Transform into world space, positions by the matrix and normals by its inverse transpose. */
  const nm = normalMatrix(world);
  for (let i = 0; i < vertices; i++) {
    const x = positions[i * 3] as number;
    const y = positions[i * 3 + 1] as number;
    const z = positions[i * 3 + 2] as number;
    positions[i * 3] =
      (world[0] as number) * x +
      (world[4] as number) * y +
      (world[8] as number) * z +
      (world[12] as number);
    positions[i * 3 + 1] =
      (world[1] as number) * x +
      (world[5] as number) * y +
      (world[9] as number) * z +
      (world[13] as number);
    positions[i * 3 + 2] =
      (world[2] as number) * x +
      (world[6] as number) * y +
      (world[10] as number) * z +
      (world[14] as number);

    const nx = normals[i * 3] as number;
    const ny = normals[i * 3 + 1] as number;
    const nz = normals[i * 3 + 2] as number;
    const tx = (nm[0] as number) * nx + (nm[3] as number) * ny + (nm[6] as number) * nz;
    const ty = (nm[1] as number) * nx + (nm[4] as number) * ny + (nm[7] as number) * nz;
    const tz = (nm[2] as number) * nx + (nm[5] as number) * ny + (nm[8] as number) * nz;
    const length = Math.hypot(tx, ty, tz);
    if (length > 1e-8) {
      normals[i * 3] = tx / length;
      normals[i * 3 + 1] = ty / length;
      normals[i * 3 + 2] = tz / length;
    }
  }

  /* Material, folded into vertex attributes, because that is where this engine keeps it. */
  const material =
    primitive.material === undefined ? undefined : doc.materials?.[primitive.material];
  const emissiveFactor = material?.emissiveFactor ?? [0, 0, 0];
  const emissiveStrength = Math.max(
    emissiveFactor[0] ?? 0,
    emissiveFactor[1] ?? 0,
    emissiveFactor[2] ?? 0,
  );
  /*
   * Derived once, from the same place the MATL record comes from.
   *
   * These were computed here a second time and drifted the moment the material rules got
   * more careful: MATL said specular 0 while every vertex said 1, and the shader reads the
   * vertices, so the fix looked applied and changed nothing on screen.
   *
   * **The base colour is read off `surface` for the same reason**, rather than off the document a
   * second time. Which of the two material models a file states is now a decision `pbrOf` makes,
   * and a specular-glossiness document reading its own `pbrMetallicRoughness.baseColorFactor` here
   * would find nothing and paint every vertex white while MATL said otherwise.
   */
  const surface = materialOf(material);
  const base = surface.color;
  /*
   * Metalness becomes highlight strength. They are not the same quantity — this renderer
   * has no metallic term — but a metal is the thing in a glTF scene that takes a sharp
   * highlight, and mapping it to `specular` is what makes an imported gold prop read as
   * gold rather than as beige plastic. It is an approximation, and stated as one.
   */

  const colorIndex = primitive.attributes['COLOR_0'];
  const colors = new Float32Array(vertices * 3);
  if (colorIndex === undefined) {
    for (let i = 0; i < vertices; i++) {
      colors[i * 3] = base[0] ?? 1;
      colors[i * 3 + 1] = base[1] ?? 1;
      colors[i * 3 + 2] = base[2] ?? 1;
    }
  } else {
    const vertexColors = accessorFloats(doc, buffers, colorIndex, `${label} COLOR_0`);
    const stride = vertexColors.length / vertices >= 4 ? 4 : 3;
    for (let i = 0; i < vertices; i++) {
      colors[i * 3] = (vertexColors[i * stride] ?? 1) * (base[0] ?? 1);
      colors[i * 3 + 1] = (vertexColors[i * stride + 1] ?? 1) * (base[1] ?? 1);
      colors[i * 3 + 2] = (vertexColors[i * stride + 2] ?? 1) * (base[2] ?? 1);
    }
  }

  const emissive = new Float32Array(vertices).fill(emissiveStrength);
  const roughness = new Float32Array(vertices).fill(surface.roughness);
  const specular = new Float32Array(vertices).fill(surface.specular);
  const emissiveColor = new Float32Array(vertices * 3);
  for (let i = 0; i < vertices; i++) {
    /* A negative component means "inherit the albedo", which is the engine's own default. */
    const named = emissiveStrength > 0;
    emissiveColor[i * 3] = named ? (emissiveFactor[0] ?? 0) : -1;
    emissiveColor[i * 3 + 1] = named ? (emissiveFactor[1] ?? 0) : -1;
    emissiveColor[i * 3 + 2] = named ? (emissiveFactor[2] ?? 0) : -1;
  }

  const uvIndex = primitive.attributes['TEXCOORD_0'];
  const uvs =
    uvIndex === undefined
      ? undefined
      : accessorFloats(doc, buffers, uvIndex, `${label} TEXCOORD_0`);

  /*
   * A tangent frame, read where the source has one and derived where it does not.
   *
   * **Read rather than always derived, and the difference is not academic.** A tangent baked by
   * the tool that authored a normal map agrees with that map exactly; one derived here agrees
   * only where the derivation matches the tool's, and the two differ at UV seams and mirrored
   * shells. glTF says to use the supplied frame where it exists, and this does.
   *
   * Only where there are texture coordinates at all: with no UVs there is no direction along a
   * texture to point at, and a derived frame would be an arbitrary one dressed as a measurement.
   * And only where a material declares a normal map, which is the other half of the same
   * sentence and is argued where the derivation happens, below.
   */
  const tangentIndex = primitive.attributes['TANGENT'];
  let tangents: Float32Array | undefined;
  if (tangentIndex !== undefined) {
    tangents = accessorFloats(doc, buffers, tangentIndex, `${label} TANGENT`);
    /*
     * Rotated into world space by the same normal matrix the normals took, and `w` left alone:
     * it is a handedness rather than a direction, and a matrix that mirrors flips the frame
     * itself, which the sign already describes.
     */
    for (let i = 0; i < vertices; i++) {
      const x = tangents[i * 4] as number;
      const y = tangents[i * 4 + 1] as number;
      const z = tangents[i * 4 + 2] as number;
      const tx = (nm[0] as number) * x + (nm[3] as number) * y + (nm[6] as number) * z;
      const ty = (nm[1] as number) * x + (nm[4] as number) * y + (nm[7] as number) * z;
      const tz = (nm[2] as number) * x + (nm[5] as number) * y + (nm[8] as number) * z;
      const length = Math.hypot(tx, ty, tz);
      if (length > 1e-8) {
        tangents[i * 4] = tx / length;
        tangents[i * 4 + 1] = ty / length;
        tangents[i * 4 + 2] = tz / length;
      }
    }
  }

  /* Indices, widened to u32, or generated for a non-indexed primitive. */
  let indices: Uint32Array;
  if (primitive.indices === undefined) {
    indices = new Uint32Array(vertices);
    for (let i = 0; i < vertices; i++) indices[i] = i;
  } else {
    const raw = accessorFloats(doc, buffers, primitive.indices, `${label} indices`);
    indices = new Uint32Array(raw.length);
    for (let i = 0; i < raw.length; i++) indices[i] = raw[i] as number;
  }

  /*
   * Derived only now, because it needs the indices and they are widened above — and only for a
   * material that declares a normal map.
   *
   * **A tangent frame exists to sample a normal map, and there is exactly one place in this
   * engine that reads one**: `tangentFrame` in the flat shader's `main`, inside
   * `if (uNormalStrength > 0.0)`. So a frame derived for a material with no map is four floats a
   * vertex that no draw can ever fetch. Measured on a 253-mesh CAD export whose eight materials
   * declare no `normalTexture` at all: **8.3 MB of a 51.5 MB model**, and a shard on the wire
   * with it. It is not a frame cost — the buffer uploads once and the vertex stride is the same
   * either way — which is why it survived this long.
   *
   * **A supplied `TANGENT` is still read**, above, whatever the material says. That is authored
   * data and the file is entitled to be believed; this is only about not *inventing* one.
   *
   * The other half is that deriving before a weld is the wrong order: a corner soup gets one
   * triangle's frame per corner, no two corners agree, and `weldMesh` — which now keys on the
   * frame, because a mirrored shell differs in nothing else — cannot merge them. **That half is
   * closed as of 3.30.0 by `deriveTangents`**, which the baker sets false so it can derive on the
   * welded mesh instead. It stays on by default here, because a consumer reading a model straight
   * into a renderer never welds and would otherwise lose its normal mapping silently.
   *
   * **What would make this wrong** is a second consumer of the frame that does not need a map:
   * anisotropic specular, hair or cloth. There is none today; the day one lands, it wants
   * `deriveTangentsFor` after the weld and not a wider gate here.
   */
  if (deriveTangents && tangents === undefined && uvs !== undefined && surface.normalMap >= 0) {
    tangents = generateTangents(positions, normals, uvs, indices);
  }

  /*
   * The rig's two attributes, read only when a skin says there is one.
   *
   * **The indices are remapped onto the sorted joint order.** `gltfSkin.ts` sorts parents-first
   * because a palette is resolved in index order, so a mesh left naming the document's own indices
   * weights its vertices to the wrong joints — which reads as a bad rig rather than a bad
   * importer, and moves the wrong limb.
   */
  /*
   * Morph targets, interleaved by vertex so every target of one vertex is adjacent — which is the
   * layout `MeshData.morphTargets` specifies and the shader reads, because it fetches all of a
   * vertex's targets together. glTF stores them the other way round, one accessor per target, so
   * this transposes on the way in rather than making the shader stride across the whole mesh.
   *
   * **Positions only, and a `NORMAL` target is dropped rather than refused.** The engine morphs
   * positions and not normals, so a file carrying both is a file this reader can serve most of.
   */
  let morphTargets: Float32Array | undefined;
  let morphTargetCount: number | undefined;
  const targets = primitive.targets ?? [];
  if (targets.length > 0) {
    const used = Math.min(targets.length, MAX_MORPH_TARGETS);
    if (targets.length > used) {
      /*
       * Taken rather than refused, and said out loud. A facial rig routinely carries dozens of
       * targets and refusing the file outright would serve nobody; taking the first few silently
       * would ship a face that cannot make most of its expressions with nothing to point at.
       */
      warnings.push(
        `${label}: ${targets.length} morph targets, and this engine carries ${MAX_MORPH_TARGETS}. ` +
          `The first ${used} are kept and the rest are dropped.`,
      );
    }
    morphTargets = new Float32Array(vertices * used * 3);
    morphTargetCount = used;
    for (let t = 0; t < used; t++) {
      const positionAt = targets[t]?.['POSITION'];
      if (positionAt === undefined) continue;
      const deltas = accessorFloats(
        doc,
        buffers,
        positionAt,
        `${label} morph target ${t} POSITION`,
      );
      for (let v = 0; v < vertices; v++) {
        const to = (v * used + t) * 3;
        morphTargets[to] = deltas[v * 3] ?? 0;
        morphTargets[to + 1] = deltas[v * 3 + 1] ?? 0;
        morphTargets[to + 2] = deltas[v * 3 + 2] ?? 0;
      }
    }
  }

  let joints: Float32Array | undefined;
  let weights: Float32Array | undefined;
  const jointIndex = primitive.attributes['JOINTS_0'];
  const weightIndex = primitive.attributes['WEIGHTS_0'];
  if (skin !== undefined && jointIndex !== undefined && weightIndex !== undefined) {
    joints = accessorFloats(doc, buffers, jointIndex, `${label} JOINTS_0`);
    weights = accessorFloats(doc, buffers, weightIndex, `${label} WEIGHTS_0`);
    for (let i = 0; i < joints.length; i++) {
      const old = joints[i] as number;
      const moved = skin.remap[old];
      if (moved === undefined) {
        throw new DrftError(
          `gltf: ${label} weights a vertex to joint ${old}, and its skin has ${skin.remap.length}`,
        );
      }
      joints[i] = moved;
    }
    normaliseWeights(weights, label, warnings);
  }

  return {
    mesh: {
      positions,
      normals,
      colors,
      emissive,
      specular,
      roughness,
      emissiveColor,
      indices,
      ...(uvs === undefined ? {} : { uvs }),
      ...(tangents === undefined ? {} : { tangents }),
      ...(joints === undefined || weights === undefined ? {} : { joints, weights }),
      ...(morphTargets === undefined || morphTargetCount === undefined
        ? {}
        : { morphTargets, morphTargetCount }),
    },
    /*
     * The colour map's *texture* index, not its image index. A material names a texture and
     * two textures may share one image, so following the indirection anywhere but here would
     * make the material point at whichever of them was read first.
     */
    material: surface,
    /* The label an artist put on it, where they put one. A non-string is not a label. */
    ...(typeof material?.extras?.substance === 'string' && material.extras.substance.length > 0
      ? { substance: material.extras.substance }
      : {}),
  };
}

/**
 * Make every weight set sum to one, warning once per mesh when any did not.
 *
 * **Here rather than in the shader**, because normalising per vertex per frame costs a divide on
 * every vertex to correct data that should have been fixed once. A set summing to less shrinks the
 * surface toward the origin and a set summing to more inflates it; both read as a deforming mesh
 * rather than as bad data, which is why this warns rather than passing it on silently.
 *
 * A set summing to zero is left alone and reported: it is a vertex nobody weighted, and inventing
 * an influence for it would move geometry the author never rigged. The absent-attribute default is
 * what such a mesh gets if it has no attribute at all; a present-but-zero set is a different fact.
 */
function normaliseWeights(weights: Float32Array, label: string, warnings: string[]): void {
  let corrected = 0;
  let unweighted = 0;
  for (let i = 0; i < weights.length; i += 4) {
    const sum =
      (weights[i] as number) +
      (weights[i + 1] as number) +
      (weights[i + 2] as number) +
      (weights[i + 3] as number);
    if (sum <= 0) {
      unweighted += 1;
      continue;
    }
    if (Math.abs(sum - 1) < 1e-3) continue;
    corrected += 1;
    weights[i] = (weights[i] as number) / sum;
    weights[i + 1] = (weights[i + 1] as number) / sum;
    weights[i + 2] = (weights[i + 2] as number) / sum;
    weights[i + 3] = (weights[i + 3] as number) / sum;
  }
  if (corrected > 0) {
    warnings.push(`${label}: ${corrected} vertex weight sets did not sum to one and were rescaled`);
  }
  if (unweighted > 0) {
    warnings.push(`${label}: ${unweighted} vertices carry no weight at all and will not deform`);
  }
}

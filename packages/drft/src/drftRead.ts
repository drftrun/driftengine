/**
 * Reading a `.drft`.
 *
 * Two rules govern everything here, and they pull in opposite directions on purpose:
 *
 * 1. **Never misread.** Every offset and length is checked against the buffer before it
 *    is used. A file that is wrong is refused with the byte that failed, never
 *    approximated and never half-returned. A partial asset shows up later as a rendering
 *    artefact with no route back to its cause, which is the failure mode this whole
 *    format was designed after.
 * 2. **Never copy.** Vertex data is viewed in place — `new Float32Array(buffer, offset,
 *    count)` — so loading a mesh costs the bounds checks and nothing else.
 *
 * Compatibility lives here too. See docs/FORMAT.md §4.4: old files open forever, unknown
 * optional chunks are skipped in silence, unknown *required* chunks are a refusal.
 */

import type { AnimationClip, DrftSkin } from './animationData.ts';
import type { DrftNode } from './drftSkin.ts';
import type { DrftMorph } from './drftSkin.ts';
import { readClip, readMorph, readNodes, readSkin } from './drftSkin.ts';
import type { MeshData } from './meshData.ts';
import { validateMeshData } from './meshData.ts';
import {
  ATTR_EMISSIVE_COLOR,
  ATTR_GRAIN,
  ATTR_JOINTS,
  ATTR_RELIEF,
  ATTR_TANGENT,
  ATTR_ROUGHNESS,
  ATTR_SPECULAR,
  ATTR_UVS,
  ATTR_WEIGHTS,
  CHUNK_ENTRY_BYTES,
  CHUNK_HEAD,
  CHUNK_LODM,
  CHUNK_LODF,
  CHUNK_DTEX,
  CHUNK_ENTS,
  CHUNK_NAVM,
  CHUNK_SPLT,
  SPLAT_BLOCK_PREFIX,
  CHUNK_MESH,
  CHUNK_REQUIRED,
  DRFT_MAGIC,
  DRFT_VERSION_MAJOR,
  DrftError,
  HEADER_BYTES,
  CHUNK_MATL,
  CHUNK_TEXS,
  KNOWN_CHUNKS,
  MATERIAL_ENTRY_BYTES,
  align,
  fourCCName,
  CHUNK_ANIM,
  CHUNK_NODE,
  CHUNK_SKIN,
  CHUNK_MORP,
  CHUNK_NNET,
  CHUNK_NGRF,
  CHUNK_SDFV,
  CHUNK_SUBS,
  CHUNK_COLL,
} from './drftFormat.ts';
import type { DrftChunk, DrftHead, DrftMaterial, DrftSplatBlock } from './drftFormat.ts';
import { type DrftSubs, readSubs } from './drftSubs.ts';
import { type DrftSdfv, type DrftSdfvEntry, readSdfv } from './sdfv.ts';
import { type DtexEntry, readDtex } from './dtex.ts';
import { type EntsScene, readEnts } from './ents.ts';
import { type NavPolyMesh, readNavm } from './navm.ts';
import { type DrftNetwork, type DrftNnet, readNnet } from './nnet.ts';
import { type DrftGraph, readNgrf } from './ngrf.ts';
import { readColliders } from './drftColliders.ts';

/** An embedded image, still compressed. Decoding is the consumer's, through `createImageBitmap`. */
export interface DrftTexture {
  /** What the source called this image. Empty for a file written before names existed. */
  readonly name: string;
  readonly codec: number;
  readonly width: number;
  readonly height: number;
  /**
   * A view over the fetched buffer, not a copy, exactly like the vertex arrays.
   *
   * It therefore keeps the whole file alive for as long as it is held. That is the intended
   * trade for a load that allocates nothing, and it is why a consumer decoding these should
   * drop its reference to the asset afterwards rather than keep it beside the GPU textures.
   */
  readonly bytes: Uint8Array;
}

/** A decoded asset. See docs/FORMAT.md for what each chunk carries. */
export interface DrftAsset {
  readonly head: DrftHead;
  readonly meshes: readonly MeshData[];
  /**
   * Coarse whole-asset levels of detail, coarsest first, or empty for a file carrying none.
   *
   * Separate from `meshes` because they are not parts of the model: each one *is* the model,
   * at a resolution that arrives sooner. A consumer reading a whole file at once has no use
   * for them and ignores them; the streaming loader draws the best one it has until the real
   * geometry is complete. See `DrftLoader` and docs/FORMAT.md §4.6.
   */
  readonly lods: readonly MeshData[];
  /**
   * Discrete levels of detail, finest first, each a complete `.drft` still in its bytes.
   *
   * **Handed over unparsed on purpose.** A level is a whole model, and a consumer that picks one
   * by distance wants exactly one of them — parsing all four to hand back three that will not be
   * drawn is work nobody asked for. Pass the one you want to `readDrft` again.
   */
  readonly levels: readonly Uint8Array[];
  /**
   * The whole capture, assembled from every `SPLT` block in ordinal order, or null for a file
   * carrying none.
   *
   * **Assembled rather than handed over as blocks**, because a caller reading a whole file at
   * once has no use for the split: it exists so a *stream* can put a sparse capture on screen
   * early, and `DrftStream.onSplats` is where that matters. The records still arrive in the
   * file's coarse-first order, so a consumer that draws a prefix of them draws a sparse whole.
   */
  readonly splats: DrftSplatBlock | null;
  /**
   * A decode program per material, or empty for a file that carries none.
   *
   * Each says which `MATL` entry it belongs to. **A reader that does not know this chunk skips it
   * by its length** and loses only the material it could not have decoded, which is what keeps the
   * format's freeze intact.
   */
  readonly dtex: readonly DtexEntry[];
  /**
   * A way across the scene, or `null` for a file that carries none.
   *
   * **`null` rather than an empty mesh**, because *nobody built one* and *there is nowhere to walk*
   * are different facts, and a consumer that cannot tell them apart cannot decide whether to build
   * one itself.
   */
  readonly navigation: NavPolyMesh | null;
  /** The things in the scene, or `null` for a file that is an asset rather than a scene. */
  readonly entities: EntsScene | null;
  /**
   * The asset's own hierarchy, or empty for a file carrying no `NODE`.
   *
   * Empty means what it always meant — one mesh at the origin — so a caller written before 1.6
   * behaves identically against a file with a hierarchy it ignores.
   */
  readonly nodes: readonly DrftNode[];
  /** Skins, in the order their chunks appear. Empty for a file that deforms nothing. */
  readonly skins: readonly DrftSkin[];
  /** Clips, in the order their chunks appear. Empty for a file that animates nothing. */
  readonly clips: readonly AnimationClip[];
  /** One per mesh by ordinal, or empty when the file names no materials. */
  readonly materials: readonly DrftMaterial[];
  readonly textures: readonly DrftTexture[];
  /**
   * Which substance each material is made of, or empty where the file labels none.
   *
   * The `SUBS` chunk, added at 1.8. Hand these to `installChemistry().match` — which matches
   * **exactly** and reports what it could not, rather than guessing.
   */
  readonly substances: readonly { readonly material: number; readonly substance: string }[];
  /**
   * The signed distance field of each mesh that carries one, or empty for a file with none.
   *
   * The `SDFV` chunk, added at 1.13. Views over the fetched buffer, so a file that carries fields
   * for geometry a consumer never traces through costs one view apiece and no copy. Hand them to
   * `composeGlobalField`, which is what turns per-object fields into a world around the camera.
   */
  readonly fields: readonly DrftSdfvEntry[];
  /**
   * The networks the file carries, each with the role a consumer asks for it by, or empty.
   *
   * The `NNET` chunk, added at 1.14. Weights are views over the fetched buffer, in the precision
   * they were written in — half-precision bits stay bits, because the device uploads them as such.
   */
  readonly networks: readonly DrftNetwork[];
  /**
   * The graphs the file carries — networks built from operators — each with its role, or empty.
   *
   * The `NGRF` chunk, added at 1.15. Tensors are views over the fetched buffer where its alignment
   * allows, in the precision they were written in. `@driftengine/texture` validates one before it
   * runs, naming any operator it lacks.
   */
  readonly graphs: readonly DrftGraph[];
  /**
   * The convex hulls this asset collides as, or empty for a file carrying no `COLL`.
   *
   * Views over the fetched buffer, xyz-packed, in the asset's own space. Turning them into shapes is
   * one line and belongs to whoever has a physics package:
   *
   * ```ts
   * const shapes = asset.colliders.map((points) => hullShape(points));
   * ```
   */
  readonly colliders: readonly Float32Array[];
  /** Optional chunks this reader did not understand, in file order. Diagnostics only. */
  readonly skipped: readonly string[];
  readonly versionMajor: number;
  readonly versionMinor: number;
}

const decoder = new TextDecoder();

function readString(
  view: DataView,
  buffer: ArrayBuffer,
  at: number,
  limit: number,
): [string, number] {
  if (at + 4 > limit) throw new DrftError(`string length runs past its chunk at ${at}`);
  const length = view.getUint32(at, true);
  if (at + 4 + length > limit)
    throw new DrftError(`string of ${length} bytes runs past its chunk at ${at}`);
  const text = decoder.decode(new Uint8Array(buffer, at + 4, length));
  return [text, align(at + 4 + length)];
}

export function readHead(buffer: ArrayBuffer, chunk: DrftChunk): DrftHead {
  const view = new DataView(buffer);
  const limit = chunk.offset + chunk.byteLength;
  if (chunk.byteLength < 28) throw new DrftError('HEAD is too short to hold its numbers');
  const numbers = new Float32Array(buffer, chunk.offset, 7);
  const [name, afterName] = readString(view, buffer, chunk.offset + 28, limit);
  const [generator] = readString(view, buffer, afterName, limit);
  return {
    name,
    generator,
    unitScale: numbers[0] as number,
    bounds: [
      numbers[1] as number,
      numbers[2] as number,
      numbers[3] as number,
      numbers[4] as number,
      numbers[5] as number,
      numbers[6] as number,
    ],
  };
}

export function readMesh(buffer: ArrayBuffer, chunk: DrftChunk): MeshData {
  const view = new DataView(buffer);
  if (chunk.byteLength < 16) throw new DrftError('MESH is too short to hold its header');
  const vertices = view.getUint32(chunk.offset, true);
  const indexCount = view.getUint32(chunk.offset + 4, true);
  const attributes = view.getUint32(chunk.offset + 8, true);
  const limit = chunk.offset + chunk.byteLength;

  let at = chunk.offset + 16;
  /** A float view over the next `count` floats, checked before it is built. */
  const floats = (count: number, what: string): Float32Array => {
    const bytes = count * 4;
    if (at + bytes > limit) {
      throw new DrftError(`${what} needs ${bytes} bytes but only ${limit - at} remain at ${at}`);
    }
    const array = new Float32Array(buffer, at, count);
    at += bytes;
    return array;
  };

  const positions = floats(vertices * 3, 'positions');
  const normals = floats(vertices * 3, 'normals');
  const colors = floats(vertices * 3, 'colors');
  const emissive = floats(vertices, 'emissive');
  const specular = (attributes & ATTR_SPECULAR) !== 0 ? floats(vertices, 'specular') : undefined;
  const uvs = (attributes & ATTR_UVS) !== 0 ? floats(vertices * 2, 'uvs') : undefined;
  const emissiveColor =
    (attributes & ATTR_EMISSIVE_COLOR) !== 0 ? floats(vertices * 3, 'emissiveColor') : undefined;
  const roughness = (attributes & ATTR_ROUGHNESS) !== 0 ? floats(vertices, 'roughness') : undefined;
  const grain = (attributes & ATTR_GRAIN) !== 0 ? floats(vertices, 'grain') : undefined;
  const relief = (attributes & ATTR_RELIEF) !== 0 ? floats(vertices, 'relief') : undefined;
  /* Four floats a vertex, which is what makes it the widest optional array in the format. */
  const tangents = (attributes & ATTR_TANGENT) !== 0 ? floats(vertices * 4, 'tangents') : undefined;
  /* A skin's per-vertex half, four floats each and read in that order because that is the order
     the bits are in. `validateMeshData` below refuses one without the other, so a file whose
     writer set only one bit is rejected rather than half-skinned. See ATTR_JOINTS. */
  const joints = (attributes & ATTR_JOINTS) !== 0 ? floats(vertices * 4, 'joints') : undefined;
  const weights = (attributes & ATTR_WEIGHTS) !== 0 ? floats(vertices * 4, 'weights') : undefined;

  const indexBytes = indexCount * 4;
  if (at + indexBytes > limit) {
    throw new DrftError(`indices need ${indexBytes} bytes but only ${limit - at} remain at ${at}`);
  }
  const indices = new Uint32Array(buffer, at, indexCount);

  const mesh: MeshData = {
    positions,
    normals,
    colors,
    emissive,
    indices,
    ...(specular === undefined ? {} : { specular }),
    ...(uvs === undefined ? {} : { uvs }),
    ...(emissiveColor === undefined ? {} : { emissiveColor }),
    ...(roughness === undefined ? {} : { roughness }),
    ...(grain === undefined ? {} : { grain }),
    ...(relief === undefined ? {} : { relief }),
    ...(tangents === undefined ? {} : { tangents }),
    ...(joints === undefined ? {} : { joints }),
    ...(weights === undefined ? {} : { weights }),
  };

  /*
   * Checked again on the way in, even though the writer checked on the way out. The file
   * may not have come from this writer, and the cost of trusting it is a mesh that draws
   * on one GPU and vanishes on another.
   */
  validateMeshData(mesh);
  return mesh;
}

/** Decode a `.drft` from a buffer. Throws `DrftError` on anything it cannot read. */
export function readDrft(buffer: ArrayBuffer): DrftAsset {
  if (buffer.byteLength < HEADER_BYTES) {
    throw new DrftError(`a file is at least ${HEADER_BYTES} bytes, got ${buffer.byteLength}`);
  }
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== DRFT_MAGIC) {
    throw new DrftError('not a drft file — the magic does not match');
  }

  const versionMajor = view.getUint16(4, true);
  const versionMinor = view.getUint16(6, true);
  const minReaderMajor = view.getUint16(8, true);

  /*
   * The one direction compatibility may fail, and it fails by saying so. A file needing a
   * newer generation is refused; a file from an older one always opens, which is the
   * promise the format is built around.
   */
  if (minReaderMajor > DRFT_VERSION_MAJOR) {
    throw new DrftError(
      `this file needs a reader of version ${minReaderMajor} or newer and this one is ` +
        `${DRFT_VERSION_MAJOR}. Its own version is ${versionMajor}.${versionMinor}.`,
    );
  }

  const chunkCount = view.getUint32(12, true);
  const totalBytes = view.getUint32(16, true);
  if (totalBytes > buffer.byteLength) {
    throw new DrftError(
      `the header claims ${totalBytes} bytes and the buffer holds ${buffer.byteLength}`,
    );
  }
  const tableEnd = HEADER_BYTES + chunkCount * CHUNK_ENTRY_BYTES;
  if (tableEnd > buffer.byteLength) {
    throw new DrftError(`a table of ${chunkCount} chunks runs past the end of the file`);
  }

  const meshes: MeshData[] = [];
  /** Held with their level ordinals, because the table's order is a bake-time choice. */
  const levels: { level: number; mesh: MeshData }[] = [];
  const discreteLevels: Uint8Array[] = [];
  const textures: DrftTexture[] = [];
  let materials: DrftMaterial[] = [];
  const splatBlocks: { block: DrftSplatBlock; at: number }[] = [];
  const dtex: DtexEntry[] = [];
  let navigation: NavPolyMesh | null = null;
  let entities: EntsScene | null = null;
  let nodes: DrftNode[] = [];
  const skins: DrftSkin[] = [];
  const clips: AnimationClip[] = [];
  const morphs: DrftMorph[] = [];
  let subs: DrftSubs | null = null;
  let fields: DrftSdfv | null = null;
  let nnet: DrftNnet | null = null;
  let graphs: DrftGraph[] = [];
  let colliders: readonly Float32Array[] = [];
  const skipped: string[] = [];
  let head: DrftHead | null = null;

  for (let i = 0; i < chunkCount; i++) {
    const entry = HEADER_BYTES + i * CHUNK_ENTRY_BYTES;
    const chunk: DrftChunk = {
      code: view.getUint32(entry, true),
      offset: view.getUint32(entry + 4, true),
      byteLength: view.getUint32(entry + 8, true),
      flags: view.getUint16(entry + 12, true),
      index: view.getUint16(entry + 14, true),
    };

    if (chunk.offset + chunk.byteLength > buffer.byteLength) {
      throw new DrftError(
        `chunk ${i} (${fourCCName(chunk.code)}) spans ${chunk.offset}..` +
          `${chunk.offset + chunk.byteLength} past the end of a ${buffer.byteLength} byte file`,
      );
    }
    if (chunk.offset % 4 !== 0) {
      throw new DrftError(`chunk ${i} (${fourCCName(chunk.code)}) is not 4-byte aligned`);
    }

    if (!KNOWN_CHUNKS.has(chunk.code)) {
      /*
       * Rule 2 and rule 3 of §4.4, and the whole of forward compatibility. A writer that
       * marks a chunk required is saying the asset is wrong without it, so a reader that
       * does not know it must refuse rather than quietly produce something else.
       */
      if ((chunk.flags & CHUNK_REQUIRED) !== 0) {
        throw new DrftError(
          `this file requires chunk "${fourCCName(chunk.code)}", which this reader does not ` +
            `understand. It was written by version ${versionMajor}.${versionMinor}.`,
        );
      }
      skipped.push(fourCCName(chunk.code));
      continue;
    }

    if (chunk.code === CHUNK_HEAD) head = readHead(buffer, chunk);
    else if (chunk.code === CHUNK_MESH) meshes.push(readMesh(buffer, chunk));
    /* A level of detail is a mesh payload under another code, so it takes the same reader. */
    else if (chunk.code === CHUNK_LODM)
      levels.push({ level: chunk.index, mesh: readMesh(buffer, chunk) });
    else if (chunk.code === CHUNK_LODF) {
      /* A whole nested file, copied out and left unparsed. See `DrftAsset.levels`. */
      discreteLevels.push(new Uint8Array(buffer, chunk.offset, chunk.byteLength).slice());
    } else if (chunk.code === CHUNK_TEXS) textures.push(readTexture(buffer, chunk));
    else if (chunk.code === CHUNK_MATL) materials = readMaterials(buffer, chunk);
    else if (chunk.code === CHUNK_SPLT)
      splatBlocks.push({ block: readSplatBlock(buffer, chunk), at: chunk.index });
    else if (chunk.code === CHUNK_DTEX) dtex.push(readDtex(buffer, chunk.offset, chunk.byteLength));
    else if (chunk.code === CHUNK_NAVM)
      navigation = readNavm(buffer, chunk.offset, chunk.byteLength);
    else if (chunk.code === CHUNK_ENTS) entities = readEnts(buffer, chunk.offset, chunk.byteLength);
    else if (chunk.code === CHUNK_NODE) nodes = readNodes(buffer, chunk.offset, chunk.byteLength);
    else if (chunk.code === CHUNK_SKIN)
      skins.push(readSkin(buffer, chunk.offset, chunk.byteLength));
    else if (chunk.code === CHUNK_ANIM)
      clips.push(readClip(buffer, chunk.offset, chunk.byteLength));
    else if (chunk.code === CHUNK_MORP)
      morphs.push(readMorph(buffer, chunk.offset, chunk.byteLength));
    else if (chunk.code === CHUNK_SUBS) subs = readSubs(buffer, chunk.offset, chunk.byteLength);
    else if (chunk.code === CHUNK_SDFV) fields = readSdfv(buffer, chunk.offset, chunk.byteLength);
    else if (chunk.code === CHUNK_NNET) nnet = readNnet(buffer, chunk.offset, chunk.byteLength);
    else if (chunk.code === CHUNK_NGRF) graphs = readNgrf(buffer, chunk.offset, chunk.byteLength);
    else if (chunk.code === CHUNK_COLL)
      colliders = readColliders(buffer, chunk.offset, chunk.byteLength);
    /* Every other known chunk is defined but not yet carried; see docs/FORMAT.md phase table. */
  }

  if (head === null) throw new DrftError('no HEAD chunk — every asset must describe itself');
  /*
   * **A capture counts as content, which is why this is not simply a `MESH` check any more.** A
   * file holding one Gaussian splat capture and no geometry is an ordinary asset, and refusing it
   * for the absence of a chunk kind it never needed would be the format telling a consumer what
   * its scene may be made of.
   */
  /* And networks, since 1.15: a converted model is weights and nothing else. */
  if (
    meshes.length === 0 &&
    splatBlocks.length === 0 &&
    (nnet?.networks.length ?? 0) === 0 &&
    graphs.length === 0
  ) {
    throw new DrftError(
      'no MESH, SPLT, NNET or NGRF chunk — an asset with no geometry, capture or network',
    );
  }

  /*
   * Checked here rather than trusted, because the pairing is by ordinal and a mismatch is
   * silent: every material would describe the wrong mesh, and the asset would draw as a
   * scene whose surfaces had been shuffled. That reads as a baker bug anywhere but here.
   */
  if (materials.length > 0 && materials.length !== meshes.length) {
    throw new DrftError(
      `MATL carries ${materials.length} materials for ${meshes.length} meshes; they pair by ordinal`,
    );
  }
  /*
   * **All four map indices, not just the albedo.** The check existed for one of them because one
   * was all there was; a material naming texture 5 in a file carrying two is a corrupt file
   * whichever field names it, and the reason to catch it here rather than at the draw is the same
   * reason `drftTextures.ts` refuses an unknown name: an index that resolves to the wrong thing
   * fails silently at some later frame, and one that resolves to nothing fails at none.
   */
  for (const material of materials) {
    for (const [field, index] of [
      ['albedo', material.albedo],
      ['normal', material.normalMap],
      ['ORM', material.ormMap],
      ['emissive', material.emissiveMap],
    ] as const) {
      if (index >= textures.length) {
        throw new DrftError(
          `a material names ${field} texture ${index} and the file carries ${textures.length}`,
        );
      }
    }
  }

  /*
   * Deltas onto the meshes they name, once every chunk is in hand.
   *
   * Attached here rather than as they arrive, because a `MORP` chunk can precede the `MESH` it
   * belongs to — a caller writing them in another order, or a range-fetching reader, both make
   * that possible, and the mesh ordinal in the payload is what makes the pairing independent of
   * arrival order.
   */
  for (const morph of morphs) {
    const mesh = meshes[morph.mesh];
    if (mesh === undefined) {
      throw new DrftError(`MORP names mesh ${morph.mesh}, and this file has ${meshes.length}`);
    }
    meshes[morph.mesh] = {
      ...mesh,
      morphTargets: morph.deltas,
      morphTargetCount: morph.targetCount,
    };
  }

  /* By the ordinal the file gave them rather than by where they sat, coarsest first. */
  levels.sort((a, b) => a.level - b.level);
  const lods = levels.map((entry) => entry.mesh);

  return {
    head,
    meshes,
    lods,
    levels: discreteLevels,
    nodes,
    skins,
    clips,
    materials,
    textures,
    substances: subs?.entries ?? [],
    fields: fields?.entries ?? [],
    networks: nnet?.networks ?? [],
    graphs,
    colliders,
    dtex,
    navigation,
    entities,
    splats: joinSplatBlocks(splatBlocks),
    skipped,
    versionMajor,
    versionMinor,
  };
}

/**
 * One `SPLT` block, viewed in place.
 *
 * **Zero-copy, like every other payload here.** The records are a `Uint32Array` over the file's
 * own bytes, which is what the format's four-byte alignment exists for and what lets a capture of
 * tens of megabytes reach the GPU without being duplicated on the way.
 */
export function readSplatBlock(buffer: ArrayBuffer, chunk: DrftChunk): DrftSplatBlock {
  if (chunk.byteLength < SPLAT_BLOCK_PREFIX) {
    throw new DrftError('SPLT is too short to hold its header');
  }
  const view = new DataView(buffer, chunk.offset, chunk.byteLength);
  const count = view.getUint32(0, true);
  const totalCount = view.getUint32(4, true);
  const wordsPerSplat = view.getUint32(8, true);
  const sphericalHarmonics = view.getUint32(12, true);
  if (wordsPerSplat === 0) {
    throw new DrftError('a SPLT block says its records are zero words, which stores nothing');
  }
  const words = count * wordsPerSplat;
  if (SPLAT_BLOCK_PREFIX + words * 4 > chunk.byteLength) {
    throw new DrftError(
      `a SPLT block of ${count} splats at ${wordsPerSplat} words runs past its own chunk`,
    );
  }
  if (count > totalCount) {
    throw new DrftError(
      `a SPLT block holds ${count} splats of a capture that says it has ${totalCount}`,
    );
  }
  const bounds = new Float32Array(buffer, chunk.offset + 16, 6);
  return {
    count,
    totalCount,
    wordsPerSplat,
    sphericalHarmonics,
    boundsMin: bounds.subarray(0, 3),
    boundsMax: bounds.subarray(3, 6),
    records: new Uint32Array(buffer, chunk.offset + SPLAT_BLOCK_PREFIX, words),
  };
}

/**
 * Join every block of a capture into one, in the ordinal order the file gave them.
 *
 * The records are copied here and nowhere else in this reader, because joining is the one thing
 * that cannot be a view: the blocks are separate chunks at separate offsets. A consumer that
 * wants to avoid the copy takes the blocks as they arrive, through `DrftStream.onSplats`.
 */
function joinSplatBlocks(blocks: { block: DrftSplatBlock; at: number }[]): DrftSplatBlock | null {
  const first = blocks[0]?.block;
  if (first === undefined) return null;
  blocks.sort((a, b) => a.at - b.at);

  let words = 0;
  for (const entry of blocks) {
    if (entry.block.wordsPerSplat !== first.wordsPerSplat) {
      throw new DrftError(
        `one SPLT block records ${entry.block.wordsPerSplat} words a splat and another records ` +
          `${first.wordsPerSplat}; a capture has one record layout`,
      );
    }
    words += entry.block.records.length;
  }
  const records = new Uint32Array(words);
  let at = 0;
  let count = 0;
  for (const entry of blocks) {
    records.set(entry.block.records, at);
    at += entry.block.records.length;
    count += entry.block.count;
  }
  return {
    count,
    totalCount: first.totalCount,
    wordsPerSplat: first.wordsPerSplat,
    sphericalHarmonics: first.sphericalHarmonics,
    boundsMin: first.boundsMin,
    boundsMax: first.boundsMax,
    records,
  };
}

export function readTexture(buffer: ArrayBuffer, chunk: DrftChunk): DrftTexture {
  if (chunk.byteLength < 16) throw new DrftError('TEXS is too short to hold its header');
  const view = new DataView(buffer, chunk.offset, chunk.byteLength);
  const byteLength = view.getUint32(12, true);
  if (16 + byteLength > chunk.byteLength) {
    throw new DrftError(`a TEXS payload of ${byteLength} bytes runs past its own chunk`);
  }
  /* Absent in a file written before the name existed, which reads as empty rather than as
     a malformed chunk. That is rule 4 of the compatibility contract in practice. */
  const nameAt = chunk.offset + align(16 + byteLength);
  const limit = chunk.offset + chunk.byteLength;
  const name =
    nameAt + 4 <= limit ? readString(new DataView(buffer), buffer, nameAt, limit)[0] : '';
  return {
    name,
    codec: view.getUint32(0, true),
    width: view.getUint32(4, true),
    height: view.getUint32(8, true),
    bytes: new Uint8Array(buffer, chunk.offset + 16, byteLength),
  };
}

export function readMaterials(buffer: ArrayBuffer, chunk: DrftChunk): DrftMaterial[] {
  if (chunk.byteLength < 8) throw new DrftError('MATL is too short to hold its header');
  const view = new DataView(buffer, chunk.offset, chunk.byteLength);
  const count = view.getUint32(0, true);
  /*
   * The writer's stride, which may exceed this reader's if the file is newer. Stepping by it
   * rather than by our own is the whole of forward compatibility for this chunk: a later
   * field is skipped instead of shifting every entry after the first.
   */
  const stride = view.getUint32(4, true);
  /*
   * A stride *shorter* than this version's is an older file, not a broken one, and it must
   * open. This threw at first, which had the rule exactly half right: stepping by the file's
   * stride handles a newer writer, and defaulting the fields that predate it handles an
   * older one. Refusing the second direction breaks the promise in §4.4 rule 1 that a file
   * written today opens in every future reader, which is the whole point of the field.
   */
  if (stride < 4)
    throw new DrftError(`MATL declares a ${stride} byte entry, which cannot hold a material`);
  /** Whether a field at this offset is present in the stride the file actually used. */
  const has = (offset: number, bytes: number): boolean => offset + bytes <= stride;
  if (8 + count * stride > chunk.byteLength) {
    throw new DrftError(`MATL claims ${count} materials and its chunk cannot hold them`);
  }

  const out: DrftMaterial[] = [];
  let namesAt = chunk.offset + 8 + count * stride;
  const limit = chunk.offset + chunk.byteLength;
  for (let i = 0; i < count; i++) {
    const at = 8 + i * stride;
    /*
     * A name that cannot be read costs the name and nothing else.
     *
     * Every other field in this chunk is load-bearing and a wrong one draws a wrong picture,
     * so those are checked and refused. A material's name is how a *consumer* addresses the
     * surface, and losing it degrades a lookup rather than the render — so a truncated or
     * misaligned name block leaves the remaining names empty instead of taking a whole asset
     * down. Geometry that draws correctly must not be lost to metadata that does not.
     */
    let name = '';
    if (namesAt + 4 <= limit) {
      try {
        const [text, next] = readString(new DataView(buffer), buffer, namesAt, limit);
        name = text;
        namesAt = next;
      } catch {
        namesAt = limit;
      }
    }
    out.push({
      name,
      color: has(8, 4)
        ? [view.getFloat32(at, true), view.getFloat32(at + 4, true), view.getFloat32(at + 8, true)]
        : [0.8, 0.8, 0.8],
      specular: has(12, 4) ? view.getFloat32(at + 12, true) : 0,
      roughness: has(16, 4) ? view.getFloat32(at + 16, true) : 0.4277,
      emissive: has(20, 4) ? view.getFloat32(at + 20, true) : 0,
      emissiveColor: has(32, 4)
        ? [
            view.getFloat32(at + 24, true),
            view.getFloat32(at + 28, true),
            view.getFloat32(at + 32, true),
          ]
        : [-1, -1, -1],
      /* Each default is what the engine assumes for a material that never stated it: opaque,
         untextured, and not mirroring anything. */
      opacity: has(36, 4) ? view.getFloat32(at + 36, true) : 1,
      albedo: has(40, 4) ? view.getInt32(at + 40, true) : -1,
      reflectivity: has(44, 4) ? view.getFloat32(at + 44, true) : 0,
      /* Each defaults to "no map", which is exactly what a file written before these meant. */
      normalMap: has(48, 4) ? view.getInt32(at + 48, true) : -1,
      ormMap: has(52, 4) ? view.getInt32(at + 52, true) : -1,
      emissiveMap: has(56, 4) ? view.getInt32(at + 56, true) : -1,
      /*
       * 1 and 1 and **0**. The two scales default to the identity, because a file that never
       * stated them meant its map as authored. The strength defaults to zero for the opposite
       * reason: nothing in an older file establishes that its ORM map carries occlusion in R at
       * all, and glTF leaves that channel undefined unless an occlusionTexture names the same
       * image. Defaulting it to 1 would read whatever the exporter left as a shadow.
       */
      roughnessScale: has(60, 4) ? view.getFloat32(at + 60, true) : 1,
      metallicScale: has(64, 4) ? view.getFloat32(at + 64, true) : 1,
      occlusionStrength: has(68, 4) ? view.getFloat32(at + 68, true) : 0,
      /* Discard nothing, which is exactly what a file written before this field meant. */
      cutout: has(72, 4) ? view.getFloat32(at + 72, true) : 0,
    });
  }
  return out;
}

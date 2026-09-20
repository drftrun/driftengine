/**
 * Writing a `.drft`.
 *
 * The writer is the smaller half and the stricter one: it validates what it is given
 * before anything reaches a file, because a malformed asset caught here costs a failed
 * bake, and the same asset caught later costs somebody a night on a device they cannot
 * attach a debugger to. That is not hypothetical — see `validateMeshData`.
 *
 * Runs offline in the baker, so it may allocate freely. Nothing here is on a frame path.
 */

import type { AnimationClip, DrftSkin } from './animationData.ts';
import type { DrftNode } from './drftSkin.ts';
import { buildClip, buildMorph, buildNodes, buildSkin } from './drftSkin.ts';
import type { MeshData } from './meshData.ts';
import { validateMeshData } from './meshData.ts';
import {
  ALIGNMENT,
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
  CHUNK_ANIM,
  CHUNK_DTEX,
  CHUNK_ENTS,
  CHUNK_NAVM,
  CHUNK_LODM,
  CHUNK_LODF,
  CHUNK_MORP,
  CHUNK_NODE,
  CHUNK_SKIN,
  CHUNK_SPLT,
  SPLAT_BLOCK_PREFIX,
  CHUNK_MATL,
  CHUNK_MESH,
  CHUNK_REQUIRED,
  CHUNK_COLL,
  CHUNK_NNET,
  CHUNK_NGRF,
  CHUNK_SDFV,
  CHUNK_SUBS,
  CHUNK_TEXS,
  MATERIAL_ENTRY_BYTES,
  DRFT_MAGIC,
  DRFT_VERSION_MAJOR,
  DRFT_VERSION_MINOR,
  DrftError,
  FLAG_LITTLE_ENDIAN,
  HEADER_BYTES,
  align,
} from './drftFormat.ts';
import type { DrftHead, DrftMaterial, DrftSplats } from './drftFormat.ts';
import { coarseFirstOrder } from './coarseFirst.ts';
import { type DrftSubstanceEntry, buildSubs } from './drftSubs.ts';
import { type DrftSdfvEntry, buildSdfv } from './sdfv.ts';
import { type DrftNetwork, buildNnet } from './nnet.ts';
import { type DtexEntry, buildDtex } from './dtex.ts';
import { type EntsScene, buildEnts } from './ents.ts';
import { type NavPolyMesh, buildNavm } from './navm.ts';
import { type DrftGraph, buildNgrf } from './ngrf.ts';
import { buildColliders } from './drftColliders.ts';

/** An image to embed, already compressed, with what its own header said about it. */
export interface DrftTextureSource {
  /**
   * What the source model called this image, normally its declared relative path.
   *
   * Carried so a texture can be addressed by name instead of by an ordinal. An ordinal is a
   * position in whatever order a reader happened to meet its records, which is not something
   * a consumer should have to know or a format should ask it to depend on.
   */
  readonly name: string;
  readonly codec: number;
  readonly width: number;
  readonly height: number;
  readonly bytes: Uint8Array;
}

/** What a caller hands over to be baked. */
export interface DrftSource {
  readonly head?: Partial<DrftHead>;
  readonly meshes: readonly MeshData[];
  /**
   * One material per mesh, by ordinal, or absent for an asset that names none.
   *
   * All or nothing: a partial list would make material *n* mean a different mesh depending
   * on how many came before it, which is the kind of off-by-one that shows up as one wrong
   * surface in a scene and is looked for everywhere except here.
   */
  readonly materials?: readonly DrftMaterial[];
  readonly textures?: readonly DrftTextureSource[];
  /**
   * Which substance each material is made of, or absent for a file that labels none.
   *
   * Written as one `SUBS` chunk at 1.8. It pairs by the material ordinal carried per entry rather
   * than by position, so a file labelling only its fourth material says so.
   */
  readonly substances?: readonly DrftSubstanceEntry[];
  /**
   * The signed distance field of each mesh that has one, or absent for a file carrying none.
   *
   * Written as one `SDFV` chunk at 1.13. It pairs by the mesh ordinal carried per entry rather
   * than by position, so a file with a field for only its fourth mesh says so — `SUBS`'s rule,
   * and `MORP` is the chunk that found out why it is a rule.
   */
  readonly fields?: readonly DrftSdfvEntry[];
  /**
   * The networks this file carries, or absent for a file carrying none.
   *
   * Written as one `NNET` chunk at 1.14, each network found by its role rather than by position.
   */
  readonly networks?: readonly DrftNetwork[];
  /**
   * The graphs this file carries — networks built from operators rather than dense layers — or
   * absent for a file carrying none. Written as one `NGRF` chunk at 1.15, each found by its role.
   */
  readonly graphs?: readonly DrftGraph[];
  /**
   * The convex hulls this asset collides as, or absent for a file that carries none.
   *
   * Each entry is xyz-packed points in the asset's own space, at most 64 of them, which is what
   * `hullShape` takes. Written as one `COLL` chunk at 1.12. See `drftColliders.ts` for why the
   * format carries points rather than shapes.
   */
  readonly colliders?: readonly Float32Array[];
  /**
   * Coarse whole-asset levels of detail, **coarsest first**, or absent for a file with none.
   *
   * Each one stands in for the entire model rather than for one part of it, which is the
   * argument docs/FORMAT.md §4.6 makes: a single decimated body reads as a car, and 187 coarse
   * fragments read as a mess. They are written first so a sequential fetch has an outline on
   * screen within the first few kilobytes, and they carry no material entry because they carry
   * their colour per vertex — `MATL` pairs with `MESH` by ordinal and nothing else.
   */
  readonly lods?: readonly MeshData[];
  /**
   * Discrete levels of detail, **finest first**, each a complete `.drft` of its own.
   *
   * Distinct from `lods` above in every way that matters: those are one merged outline per level
   * for a progressive load, these are whole alternative models a source authored by hand, each
   * with its own materials and hierarchy. See `CHUNK_LODF`.
   */
  readonly levels?: readonly Uint8Array[];
  /**
   * The asset's own hierarchy, or absent for one mesh at the origin.
   *
   * What `NODE` carries, and what rigid TRS animation drives. A reader that skips the chunk gets
   * the meshes exactly as it always did, which is why this is additive.
   */
  readonly nodes?: readonly DrftNode[];
  /** Skins, one `SKIN` chunk each, or absent for an asset that deforms nothing. */
  readonly skins?: readonly DrftSkin[];
  /** Clips, one `ANIM` chunk each, or absent for an asset that animates nothing. */
  readonly clips?: readonly AnimationClip[];
  /**
   * A Gaussian splat capture, or absent for a file carrying none.
   *
   * Written as several `SPLT` blocks, interleaved across the whole capture so any prefix of the
   * file is a complete sparse version of it. See `coarseFirst.ts` for the ordering and
   * `CHUNK_SPLT` for why it is several chunks rather than one.
   */
  readonly splats?: DrftSplats;
  /**
   * A decode program per material, or absent for a file whose materials are ordinary.
   *
   * One `DTEX` chunk each, **paired to a `MATL` entry by the index inside the chunk** rather than
   * by the order they appear. A file may carry one for some of its materials and not others — a
   * scene where one surface came from a capture and the rest were authored — and a reader pairing
   * by position would hand the wrong material the wrong texture with nothing to fail on.
   */
  readonly dtex?: readonly DtexEntry[];
  /**
   * A way across the scene, or absent for a file nobody navigates.
   *
   * The mesh carries the origin and cell size it was built at, because the numbers in it are cell
   * indices and a reader without those has a mesh in the wrong units at the wrong place.
   */
  readonly navigation?: NavPolyMesh;
  /**
   * The things in the scene, as `serializeWorld` wrote them.
   *
   * A *scene*, not an asset: this is what a capture proposes or an editor saves, and a file may
   * carry geometry with no scene at all — which is every baked model this format has ever held.
   */
  readonly entities?: EntsScene;
}

/**
 * The most blocks a capture is split into, and the fewest splats worth having in one.
 *
 * **A ceiling and a floor rather than a fixed count**, because both ends have a real cost. Every
 * block is a sixteen-byte table entry and a forty-byte payload header, so a thousand blocks of
 * two hundred splats is a table nobody wants; one block of a million splats is a capture that
 * arrives all at once and does not stream at all. Sixteen blocks puts the first sixteenth of a
 * capture on screen, which is what `coarseFirst.ts` is built to make worth looking at.
 *
 * **What would make these wrong** is a measurement on a real connection: a capture that reads as
 * finished after two blocks wants fewer and larger, and one that stutters visibly between blocks
 * wants more and smaller. `DrftSplats.blocks` is how a baker that has taken that measurement says
 * so without waiting for these numbers to move.
 */
const SPLAT_MAX_BLOCKS = 16;
const SPLAT_MIN_BLOCK = 4096;

/**
 * Split a capture into blocks, each a sparse sample of the whole thing.
 *
 * The records are re-ordered on the way out — the file's order is `coarseFirstOrder`'s and not the
 * caller's, which is why nothing here preserves an index. A consumer that needed the original
 * ordering would need it stored, and `CHUNK_SPLT` says so.
 */
function buildSplats(splats: DrftSplats): PendingChunk[] {
  const { count, wordsPerSplat } = splats;
  if (count <= 0) return [];
  if (wordsPerSplat <= 0) {
    throw new DrftError(`drft: a splat record is ${wordsPerSplat} words, which stores nothing`);
  }
  if (splats.records.length < count * wordsPerSplat) {
    throw new DrftError(
      `drft: ${count} splats of ${wordsPerSplat} words need ${count * wordsPerSplat} entries and ` +
        `the records array has ${splats.records.length}`,
    );
  }
  if (splats.positions.length < count * 3) {
    throw new DrftError(
      `drft: ${count} splats need ${count * 3} position entries and the array has ` +
        `${splats.positions.length}`,
    );
  }

  const asked = splats.blocks;
  const blocks =
    asked !== undefined && asked > 0
      ? Math.min(asked, count)
      : Math.max(1, Math.min(SPLAT_MAX_BLOCKS, Math.ceil(count / SPLAT_MIN_BLOCK)));
  const order = coarseFirstOrder(splats.positions, count);
  /* Ceiling, so the last block is the short one and every earlier one is full. A reader takes
     each block's own count from its header rather than deriving it, so a short block is ordinary. */
  const perBlock = Math.ceil(count / blocks);

  const out: PendingChunk[] = [];
  for (let block = 0; block < blocks; block++) {
    const from = block * perBlock;
    if (from >= count) break;
    const howMany = Math.min(perBlock, count - from);
    const bytes = new Uint8Array(SPLAT_BLOCK_PREFIX + howMany * wordsPerSplat * 4);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, howMany, true);
    view.setUint32(4, count, true);
    view.setUint32(8, wordsPerSplat, true);
    view.setUint32(12, splats.sphericalHarmonics ?? 0, true);
    for (let axis = 0; axis < 3; axis++) {
      view.setFloat32(16 + axis * 4, splats.boundsMin[axis] ?? 0, true);
      view.setFloat32(28 + axis * 4, splats.boundsMax[axis] ?? 0, true);
    }
    const records = new Uint32Array(bytes.buffer, SPLAT_BLOCK_PREFIX, howMany * wordsPerSplat);
    for (let slot = 0; slot < howMany; slot++) {
      const splat = order[from + slot] ?? 0;
      records.set(
        splats.records.subarray(splat * wordsPerSplat, (splat + 1) * wordsPerSplat),
        slot * wordsPerSplat,
      );
    }
    /* Optional, so a reader that predates 1.5 skips every one of these in silence. */
    out.push({ code: CHUNK_SPLT, flags: 0, bytes });
  }
  return out;
}

/** A chunk built in memory, before the table is laid out. */
interface PendingChunk {
  readonly code: number;
  readonly flags: number;
  readonly bytes: Uint8Array;
}

const encoder = new TextEncoder();

/** A length-prefixed UTF-8 string, padded so what follows it stays aligned. */
function encodeString(value: string): Uint8Array {
  const text = encoder.encode(value);
  const bytes = new Uint8Array(align(4 + text.length));
  new DataView(bytes.buffer).setUint32(0, text.length, true);
  bytes.set(text, 4);
  return bytes;
}

function buildHead(head: Partial<DrftHead> | undefined, meshes: readonly MeshData[]): PendingChunk {
  /*
   * Bounds are computed rather than taken on trust. A caller that gets them wrong would
   * produce an asset that culls itself out of frame, which looks like a rendering bug and
   * is not one — and the writer is holding every vertex anyway.
   */
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const mesh of meshes) {
    for (let at = 0; at + 2 < mesh.positions.length; at += 3) {
      const x = mesh.positions[at] as number;
      const y = mesh.positions[at + 1] as number;
      const z = mesh.positions[at + 2] as number;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    minZ = 0;
    maxX = 0;
    maxY = 0;
    maxZ = 0;
  }

  const name = encodeString(head?.name ?? '');
  const generator = encodeString(head?.generator ?? 'drft');
  const numbers = new Float32Array([head?.unitScale ?? 1, minX, minY, minZ, maxX, maxY, maxZ]);
  const bytes = new Uint8Array(numbers.byteLength + name.length + generator.length);
  bytes.set(new Uint8Array(numbers.buffer), 0);
  bytes.set(name, numbers.byteLength);
  bytes.set(generator, numbers.byteLength + name.length);
  return { code: CHUNK_HEAD, flags: CHUNK_REQUIRED, bytes };
}

/**
 * One mesh payload, under whichever FourCC is carrying it.
 *
 * `MESH` and `LODM` are the same bytes on purpose: a coarse level *is* a mesh, and giving it
 * its own layout would be a second thing to keep in step with the frozen attribute order for
 * no gain. What differs is the code and the flag — a level of detail is optional, so a reader
 * that has never heard of one skips it and draws the model, per rule 2 of §4.4.
 */
function buildMesh(mesh: MeshData, code = CHUNK_MESH, flags = CHUNK_REQUIRED): PendingChunk {
  /*
   * The check that this whole format exists downstream of. An attribute array not
   * covering every vertex is drawn by some drivers and causes others to drop the draw
   * outright, with no GL error on either path — so it is caught here, where the message
   * can name the array, rather than on somebody's phone where it cannot.
   */
  validateMeshData(mesh);

  const vertices = mesh.positions.length / 3;
  let attributes = 0;
  if (mesh.specular !== undefined) attributes |= ATTR_SPECULAR;
  if (mesh.uvs !== undefined) attributes |= ATTR_UVS;
  if (mesh.emissiveColor !== undefined) attributes |= ATTR_EMISSIVE_COLOR;
  if (mesh.roughness !== undefined) attributes |= ATTR_ROUGHNESS;
  if (mesh.grain !== undefined) attributes |= ATTR_GRAIN;
  if (mesh.relief !== undefined) attributes |= ATTR_RELIEF;
  if (mesh.tangents !== undefined) attributes |= ATTR_TANGENT;
  /* Both or neither: `validateMeshData` above has already refused one without the other, so
     these two bits are always set together and the reader may rely on it. */
  if (mesh.joints !== undefined) attributes |= ATTR_JOINTS;
  if (mesh.weights !== undefined) attributes |= ATTR_WEIGHTS;

  /* Order is frozen: mandatory arrays, then optional ones by ascending bit. */
  const arrays: (Float32Array | Uint32Array)[] = [
    mesh.positions,
    mesh.normals,
    mesh.colors,
    mesh.emissive,
  ];
  if (mesh.specular !== undefined) arrays.push(mesh.specular);
  if (mesh.uvs !== undefined) arrays.push(mesh.uvs);
  if (mesh.emissiveColor !== undefined) arrays.push(mesh.emissiveColor);
  if (mesh.roughness !== undefined) arrays.push(mesh.roughness);
  if (mesh.grain !== undefined) arrays.push(mesh.grain);
  if (mesh.relief !== undefined) arrays.push(mesh.relief);
  if (mesh.tangents !== undefined) arrays.push(mesh.tangents);
  /* Last, because the order is frozen and these are the newest bits. See ATTR_JOINTS: the
     container validated this pair for four minor versions while writing neither of them. */
  if (mesh.joints !== undefined) arrays.push(mesh.joints);
  if (mesh.weights !== undefined) arrays.push(mesh.weights);
  arrays.push(mesh.indices);

  const PREFIX = 16;
  let total = PREFIX;
  for (const array of arrays) total += array.byteLength;

  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, vertices, true);
  view.setUint32(4, mesh.indices.length, true);
  view.setUint32(8, attributes, true);
  view.setUint32(12, 0, true);

  let at = PREFIX;
  for (const array of arrays) {
    bytes.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), at);
    at += array.byteLength;
  }
  return { code, flags, bytes };
}

/**
 * One embedded image: its codec and size, then the compressed bytes untouched.
 *
 * The payload is not re-encoded. A JPEG the artist exported is already the size it is going
 * to be, and decoding it here to compress it again would cost quality for nothing.
 */
function buildTexture(texture: DrftTextureSource): PendingChunk {
  const PREFIX = 16;
  /* The name follows the payload rather than preceding it, so the image still starts at a
     fixed offset and a reader that predates the name simply stops before it. */
  const name = encodeString(texture.name);
  const nameAt = align(PREFIX + texture.bytes.length);
  const bytes = new Uint8Array(nameAt + name.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, texture.codec, true);
  view.setUint32(4, texture.width, true);
  view.setUint32(8, texture.height, true);
  view.setUint32(12, texture.bytes.length, true);
  bytes.set(texture.bytes, PREFIX);
  bytes.set(name, nameAt);
  return { code: CHUNK_TEXS, flags: 0, bytes };
}

/**
 * Every material in one chunk: they are small, and the loader wants them all before it uploads.
 *
 * **The entry stride is written down rather than implied**, which is what makes a new material
 * field additive instead of a break. A reader takes the fields it knows and steps by the
 * stride it was told, so a file carrying an eleventh float opens in a reader that knows ten.
 * Without it, appending one field changes the meaning of every byte after the first entry,
 * which is precisely what rule 4 of §4.4 forbids, and the failure is silent: every material
 * after the first would describe the wrong surface.
 *
 * Names follow the entries as a length-prefixed block, because they are the one variable
 * length thing here and putting them inline would cost the fixed stride that buys the above.
 */
function buildMaterials(materials: readonly DrftMaterial[]): PendingChunk {
  const names = materials.map((material) => encodeString(material.name));
  let nameBytes = 0;
  for (const name of names) nameBytes += name.length;

  const bytes = new Uint8Array(align(8 + materials.length * MATERIAL_ENTRY_BYTES + nameBytes));
  const view = new DataView(bytes.buffer);
  view.setUint32(0, materials.length, true);
  view.setUint32(4, MATERIAL_ENTRY_BYTES, true);
  let namesAt = 8 + materials.length * MATERIAL_ENTRY_BYTES;
  for (const name of names) {
    bytes.set(name, namesAt);
    namesAt += name.length;
  }

  let at = 8;
  for (const material of materials) {
    view.setFloat32(at, material.color[0], true);
    view.setFloat32(at + 4, material.color[1], true);
    view.setFloat32(at + 8, material.color[2], true);
    view.setFloat32(at + 12, material.specular, true);
    view.setFloat32(at + 16, material.roughness, true);
    view.setFloat32(at + 20, material.emissive, true);
    view.setFloat32(at + 24, material.emissiveColor[0], true);
    view.setFloat32(at + 28, material.emissiveColor[1], true);
    view.setFloat32(at + 32, material.emissiveColor[2], true);
    view.setFloat32(at + 36, material.opacity, true);
    view.setInt32(at + 40, material.albedo, true);
    view.setFloat32(at + 44, material.reflectivity, true);
    view.setInt32(at + 48, material.normalMap, true);
    view.setInt32(at + 52, material.ormMap, true);
    view.setInt32(at + 56, material.emissiveMap, true);
    view.setFloat32(at + 60, material.roughnessScale, true);
    view.setFloat32(at + 64, material.metallicScale, true);
    view.setFloat32(at + 68, material.occlusionStrength, true);
    view.setFloat32(at + 72, material.cutout, true);
    at += MATERIAL_ENTRY_BYTES;
  }
  return { code: CHUNK_MATL, flags: 0, bytes };
}

/**
 * Bake a `.drft` into one `ArrayBuffer`.
 *
 * Every payload lands 4-byte aligned, which is what lets the reader view the vertex data
 * in place rather than copying it out.
 */
export function writeDrft(source: DrftSource): ArrayBuffer {
  /*
   * **Geometry *or* a capture, since 1.5.** This said "at least one mesh" while a mesh was the
   * only thing an asset could be made of; a file holding one Gaussian splat capture is an
   * ordinary asset and the reader accepts it, so refusing to write one would be the two halves of
   * the format disagreeing about what a file may contain.
   */
  /*
   * **And networks, since 1.15**, on the same argument: a converted model is weights and nothing
   * else, and refusing it for the absence of geometry would be the format telling a consumer what
   * an asset may be made of.
   */
  if (
    source.meshes.length === 0 &&
    (source.splats === undefined || source.splats.count === 0) &&
    (source.networks?.length ?? 0) === 0 &&
    (source.graphs?.length ?? 0) === 0
  ) {
    throw new DrftError(
      'an asset must contain at least one mesh, a capture with splats in it, or a network',
    );
  }

  const materials = source.materials;
  if (materials !== undefined && materials.length !== source.meshes.length) {
    throw new DrftError(
      `${materials.length} materials for ${source.meshes.length} meshes; they pair by ordinal, so the counts must match`,
    );
  }

  /*
   * **Laid out in the order a viewer needs it, which is docs/FORMAT.md §4.6 and costs nothing.**
   *
   * Offsets are absolute, so where a payload sits is a bake-time choice no reader pays for, and
   * this order is what makes a *plain sequential fetch* refine the model as bytes arrive: no
   * range requests, no server support beyond serving a file. See `drftStream.ts`.
   *
   * `MATL` before the geometry is the part worth explaining. It is about 8 KB for a 187-mesh
   * car against 74 MB of file, and it is what turns arriving parts from grey shapes into a
   * correctly painted model. Paint costs almost nothing and buys the largest single jump in how
   * finished the thing looks, so it goes early; textures are megabytes and buy the smallest, so
   * they go last.
   *
   * `MATL` is optional and therefore skipped in silence by a reader that predates it, per rule 2
   * in §4.4: an older reader draws the asset with its vertex colours and no maps, which is the
   * same asset less its textures rather than a refusal. Moving it earlier in the file changes
   * nothing about that, because a chunk is found through the table rather than by position.
   */
  const chunks: PendingChunk[] = [buildHead(source.head, source.meshes)];
  /*
   * The outline first, ahead of even the paint. It is the one thing that puts a recognisable
   * whole object on screen, it is a few hundred kilobytes against tens of megabytes, and the
   * order it is written in is the order a plain sequential fetch delivers it.
   */
  for (const lod of source.lods ?? []) chunks.push(buildMesh(lod, CHUNK_LODM, 0));
  /*
   * Discrete levels, finest first — the opposite of `lods` above, and deliberately. `LODM` is
   * coarsest first because it serves a progressive load, where drawing *something* early is the
   * point; a discrete chain serves distance selection, where level 0 should be the full-detail
   * model the consumer already holds.
   */
  for (const level of source.levels ?? [])
    chunks.push({ code: CHUNK_LODF, flags: 0, bytes: level });
  if (materials !== undefined && materials.length > 0) chunks.push(buildMaterials(materials));
  /*
   * After the paint and before the parts. Paint is a few kilobytes and turns everything after it
   * from grey into a finished surface; a capture is the place the parts stand in, and its first
   * block is a recognisable whole. Both come before the meshes for the same reason the outline
   * does: what puts something worth looking at on screen goes early.
   */
  if (source.splats !== undefined) chunks.push(...buildSplats(source.splats));
  /*
   * The rig before the geometry it deforms. A streaming consumer that has the skeleton and the
   * clips can start a character the moment the first mesh lands, where the reverse order makes it
   * wait for both; and all three are small beside the parts, so nothing is delayed by much.
   */
  for (const node of source.nodes === undefined ? [] : [source.nodes]) {
    chunks.push({ code: CHUNK_NODE, flags: 0, bytes: buildNodes(node) });
  }
  for (const skin of source.skins ?? []) {
    chunks.push({ code: CHUNK_SKIN, flags: 0, bytes: buildSkin(skin) });
  }
  for (const clip of source.clips ?? []) {
    chunks.push({ code: CHUNK_ANIM, flags: 0, bytes: buildClip(clip) });
  }
  for (const entry of source.dtex ?? []) {
    /*
     * **Refused here rather than at the reader**, because a decode program for a material the file
     * does not carry is a bake that went wrong, and the writer is where the author can still be
     * told. A reader meeting one has nothing useful to do with it.
     */
    if (entry.material >= (source.materials?.length ?? 0)) {
      throw new DrftError(
        `drft: DTEX names material ${entry.material} and the file carries ` +
          `${source.materials?.length ?? 0}`,
      );
    }
    chunks.push({ code: CHUNK_DTEX, flags: 0, bytes: buildDtex(entry) });
  }
  if (source.navigation !== undefined) {
    chunks.push({ code: CHUNK_NAVM, flags: 0, bytes: buildNavm(source.navigation) });
  }
  if (source.entities !== undefined) {
    chunks.push({ code: CHUNK_ENTS, flags: 0, bytes: buildEnts(source.entities) });
  }
  source.meshes.forEach((mesh, ordinal) => {
    /*
     * **Its deltas immediately before it, not after.** A streaming consumer uploads a mesh the
     * moment its chunk lands, so deltas arriving afterwards are deltas for geometry already on the
     * GPU — and a stream cannot rewrite a mesh it has handed over. Written first, the consumer has
     * them in hand when it builds. The mesh ordinal in the payload still does the pairing, so a
     * reader meeting them in another order is unaffected.
     */
    if (mesh.morphTargets !== undefined && mesh.morphTargetCount !== undefined) {
      chunks.push({
        code: CHUNK_MORP,
        flags: 0,
        bytes: buildMorph({
          mesh: ordinal,
          targetCount: mesh.morphTargetCount,
          deltas: mesh.morphTargets,
        }),
      });
    }
    chunks.push(buildMesh(mesh));
  });
  for (const texture of source.textures ?? []) chunks.push(buildTexture(texture));
  /* One `SUBS` for the file, and only where something was labelled — an empty chunk would cost
     sixteen bytes to say nothing, and rule 2 already covers its absence. */
  if ((source.substances?.length ?? 0) > 0) {
    chunks.push({
      code: CHUNK_SUBS,
      flags: 0,
      bytes: buildSubs({ entries: source.substances as readonly DrftSubstanceEntry[] }),
    });
  }
  /* And one `SDFV`, on exactly the same terms. */
  if ((source.fields?.length ?? 0) > 0) {
    chunks.push({
      code: CHUNK_SDFV,
      flags: 0,
      bytes: buildSdfv({ entries: source.fields as readonly DrftSdfvEntry[] }),
    });
  }
  /* And one `NNET`, on the same terms again. */
  if ((source.networks?.length ?? 0) > 0) {
    chunks.push({
      code: CHUNK_NNET,
      flags: 0,
      bytes: buildNnet({ networks: source.networks as readonly DrftNetwork[] }),
    });
  }
  /* And one `NGRF`, for the networks a perceptron's table cannot describe. */
  if ((source.graphs?.length ?? 0) > 0) {
    chunks.push({
      code: CHUNK_NGRF,
      flags: 0,
      bytes: buildNgrf(source.graphs as readonly DrftGraph[]),
    });
  }

  /*
   * `COLL` last among the small chunks, because collision is the one thing a viewer never needs and
   * a consumer that simulates has already waited for the whole file by the time it builds a world.
   */
  if ((source.colliders?.length ?? 0) > 0) {
    chunks.push({
      code: CHUNK_COLL,
      flags: 0,
      bytes: buildColliders(source.colliders as readonly Float32Array[]),
    });
  }

  const tableBytes = chunks.length * CHUNK_ENTRY_BYTES;
  let cursor = align(HEADER_BYTES + tableBytes);
  const offsets: number[] = [];
  for (const chunk of chunks) {
    offsets.push(cursor);
    cursor = align(cursor + chunk.bytes.length);
  }

  const total = cursor;
  const buffer = new ArrayBuffer(total);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  view.setUint32(0, DRFT_MAGIC, true);
  view.setUint16(4, DRFT_VERSION_MAJOR, true);
  view.setUint16(6, DRFT_VERSION_MINOR, true);
  /*
   * The oldest reader that may open this. Equal to the current major because nothing here
   * needs a newer one — a writer raises it only when it emits something a previous
   * generation would misread, which is exactly what a major bump means.
   */
  view.setUint16(8, DRFT_VERSION_MAJOR, true);
  view.setUint16(10, FLAG_LITTLE_ENDIAN, true);
  view.setUint32(12, chunks.length, true);
  view.setUint32(16, total, true);
  /* Bytes 20..31 stay zero: reserved, and readers must ignore them so they can become
     fields later without a major bump. */

  /*
   * `index` is the ordinal *within a FourCC*, not the chunk's position in the table.
   *
   * It used to be written as the table position, which happened to be right for `MESH`
   * because the meshes come first, and was wrong for everything after them: the six `TEXS`
   * chunks in a 195 chunk file were numbered 188 to 193. Nothing here noticed, because this
   * reader takes textures in the order it meets them rather than by the number they carry.
   * A second implementation reading §4.3 would have used the number, and indexed six
   * textures at 188.
   */
  const ordinals = new Map<number, number>();
  let entry = HEADER_BYTES;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i] as PendingChunk;
    const offset = offsets[i] as number;
    const ordinal = ordinals.get(chunk.code) ?? 0;
    ordinals.set(chunk.code, ordinal + 1);
    view.setUint32(entry, chunk.code, true);
    view.setUint32(entry + 4, offset, true);
    view.setUint32(entry + 8, chunk.bytes.length, true);
    view.setUint16(entry + 12, chunk.flags, true);
    view.setUint16(entry + 14, ordinal, true);
    entry += CHUNK_ENTRY_BYTES;
    bytes.set(chunk.bytes, offset);
    if (offset % ALIGNMENT !== 0) {
      throw new DrftError(`internal: chunk ${i} landed unaligned at ${offset}`);
    }
  }

  return buffer;
}

/**
 * The `.drft` container: constants, layout and the compatibility rules.
 *
 * Shared by the reader and the writer so the two cannot disagree about a byte. Everything
 * here is a fact about the format rather than about either side of it — if a number lives
 * in this file, changing it changes the format.
 *
 * See docs/FORMAT.md for the specification this implements and the reasoning behind it.
 */

/** `DRFT`, little-endian, as a u32. The first four bytes of every file. */
export const DRFT_MAGIC = 0x54465244;

/**
 * The generation of the layout. Bumped only when a byte changes meaning.
 *
 * A file whose major exceeds the reader's is refused — that is the one direction
 * compatibility is allowed to fail, and it fails loudly rather than by misreading.
 */
export const DRFT_VERSION_MAJOR = 1;

/**
 * Additive revisions within a generation: new optional chunks, new attribute bits, new
 * enum values with a defined fallback. Never a changed meaning.
 */
export const DRFT_VERSION_MINOR = 12;

/** Bytes before the chunk table. */
export const HEADER_BYTES = 32;
/** Bytes per chunk table entry. */
export const CHUNK_ENTRY_BYTES = 16;

/**
 * Everything is 4-byte aligned so a reader can build a `Float32Array` view straight over
 * the fetched buffer. A typed array cannot start at an arbitrary offset, so alignment is
 * not tidiness here — it is the entire reason this format exists rather than glTF.
 */
export const ALIGNMENT = 4;

/** Round up to the next aligned boundary. */
export function align(value: number): number {
  return (value + (ALIGNMENT - 1)) & ~(ALIGNMENT - 1);
}

/** A four-character code as a u32, so chunk identity is one integer compare. */
export function fourCC(code: string): number {
  if (code.length !== 4) throw new Error(`drft: a FourCC is four characters, got "${code}"`);
  return (
    (code.charCodeAt(0) & 0xff) |
    ((code.charCodeAt(1) & 0xff) << 8) |
    ((code.charCodeAt(2) & 0xff) << 16) |
    ((code.charCodeAt(3) & 0xff) << 24)
  );
}

/** Back to text, for error messages that name what was not understood. */
export function fourCCName(code: number): string {
  return String.fromCharCode(
    code & 0xff,
    (code >> 8) & 0xff,
    (code >> 16) & 0xff,
    (code >> 24) & 0xff,
  );
}

export const CHUNK_HEAD = fourCC('HEAD');
export const CHUNK_MESH = fourCC('MESH');
/**
 * The asset's own hierarchy: parent index, TRS, mesh index and name. Optional.
 *
 * **Specified in v1 and implemented in 1.6**, which is worth stating rather than quietly fixing.
 * This constant and its `KNOWN_CHUNKS` entry have existed since the format did, and docs/FORMAT.md
 * §4.3 described the payload — while no writer emitted one and no reader consumed one, for the
 * whole of v1. Rigid TRS animation is the first thing that needs a hierarchy, so the chunk is
 * finally built, and to the layout §4.3 already promised rather than to a new one.
 */
export const CHUNK_NODE = fourCC('NODE');
export const CHUNK_MATL = fourCC('MATL');
export const CHUNK_TEXS = fourCC('TEXS');
/**
 * Baked colliders: a set of convex hulls, as the points whose hulls they are.
 *
 * **Claimed in v1 and defined in 1.12.** The code and the `KNOWN_CHUNKS` entry existed from the
 * start while no writer emitted one and no reader consumed one — the same history `CHUNK_NODE` and
 * `CHUNK_ANIM` had. `drftColliders.ts` carries the payload and the reason it is points rather than
 * shapes.
 */
export const CHUNK_COLL = fourCC('COLL');
/**
 * A discrete level of detail, as a **complete nested `.drft`**. Added at 1.9.
 *
 * **Not `LODM`, and the difference is what the chunk exists for.** `LODM` is one merged,
 * material-less outline standing in for a whole asset while it loads. A discrete level is a whole
 * model in its own right — its own meshes, its own materials, its own hierarchy — which is what a
 * source that ships four hand-authored levels actually has, and folding one into `LODM` would
 * merge its parts into a single mesh and discard every material it carries.
 *
 * **A nested file rather than appended arrays, and that is what keeps it additive.** `MATL` is
 * parallel to `MESH` by ordinal and `NODE.mesh` indexes `MESH`, so appending another level's
 * meshes to the same arrays would leave an older reader drawing every level at once, on top of
 * itself. Nesting means an older reader skips one unknown chunk under §4.4 rule 2 and opens the
 * file as the full-detail model it also is, which is the degradation that rule promises.
 *
 * Read as bytes rather than parsed, so a consumer pays only for a level it decides to use.
 */
export const CHUNK_LODF = fourCC('LODF');
export const CHUNK_LITE = fourCC('LITE');
/**
 * A coarse whole-asset level of detail, added in 1.2. Its payload is a `MESH` payload.
 *
 * **A chunk of its own rather than a level field inside `MESH`**, which is what §4.6 of
 * docs/FORMAT.md proposed and is the one part of that design that could not stand. Three
 * things break if a coarse level arrives as a `MESH`, and every one of them is silent:
 *
 * - `MESH` is a *required* chunk kind, so rule 2's protection does not apply. A 1.1 reader
 *   would draw the coarse level as a real part, on top of the model it stands for.
 * - `MATL` pairs with `MESH` **by ordinal** and both sides refuse a count mismatch, so a
 *   file with one extra `MESH` either fails to open or shifts every material by one.
 * - The manifest counts `MESH` chunks, so "142 of 187 parts" would gain a part that is not
 *   one.
 *
 * Optional and skipped in silence, which is rule 2 doing exactly its job: a 1.1 reader opens
 * a 1.2 file as the model without its outline, and the outline is not something a reader that
 * has never heard of it should draw. The table's `index` is the **level ordinal, coarsest
 * first**, which is the same "ordinal within a FourCC" every other chunk kind uses.
 */
export const CHUNK_LODM = fourCC('LODM');

/**
 * One block of a Gaussian splat capture, added in 1.5. Optional, and there are usually several.
 *
 * **Several chunks rather than one, and that is the whole point of putting splats in this
 * container at all.** A chunk is reported when its last byte lands, so a single chunk holding a
 * million splats arrives all at once and streaming buys nothing. Split into blocks whose contents
 * are interleaved across the *whole* capture — see `coarseFirst.ts` — the first block that lands
 * is a complete sparse capture rather than a finished corner of one, and the load opens on a
 * recognisable place that densifies. The table's `index` is the block ordinal.
 *
 * Optional, so rule 2 of docs/FORMAT.md §4.4 applies exactly as it does to `LODM`: a 1.4 reader
 * skips every block in silence and opens the file as whatever else it holds. That is the right
 * degradation — a reader that has never heard of a splat cannot draw one, and a capture is not a
 * mesh it could approximate.
 *
 * **The payload is opaque to this format.** Its per-splat record is `wordsPerSplat` `u32`s whose
 * meaning belongs to whoever packed them, which is `@driftengine/splats`. That keeps the container
 * free of the shader's texel layout and lets a later minor version widen the record — for
 * spherical harmonics, say — without this file learning anything new.
 */
export const CHUNK_SPLT = fourCC('SPLT');

/**
 * A skin: joints, their parents and their inverse bind matrices. Optional, added in 1.6.
 *
 * Written **parents-first**, and the reader refuses any other order. A palette is resolved in
 * index order and reads each joint's parent as it goes, so a nearly-sorted rig is wrong in one
 * limb — which reads as a bad animation rather than as a bad file. The importer is the layer that
 * sorts, because it is also the one that can remap every index naming a joint.
 */
export const CHUNK_SKIN = fourCC('SKIN');

/**
 * One animation clip. Optional, one chunk per clip, added in 1.6.
 *
 * **This FourCC was claimed and undefined for the whole of v1** — docs/FORMAT.md §4.3 listed it as
 * "Reserved. Not in v1", and §4.4's own example of a free additive change was "a v1.4 file carrying
 * `ANIM` opens in a v1.0 reader as a v1.0 file would". That example stops being hypothetical here,
 * and it holds: the chunk is optional, so rule 2 skips it in silence.
 *
 * The table's `index` is the clip ordinal, which is the same "ordinal within a FourCC" every other
 * repeated chunk kind uses.
 */
export const CHUNK_ANIM = fourCC('ANIM');

/**
 * One mesh's morph target deltas. Optional, one chunk per mesh that has any, added in 1.7.
 *
 * **A chunk of its own rather than more attribute bits in `MESH`**, and the reason is the one
 * `CHUNK_LODM` gives about not being a `MESH`: an attribute covers every vertex once, and morph
 * deltas cover every vertex once *per target*. There is no attribute bit that can express a length
 * that scales with a count stored elsewhere, and a reader that guessed would read the wrong number
 * of floats and hand back geometry rather than fail.
 *
 * The table's `index` is the **mesh ordinal** it belongs to, which is how a reader pairs them — the
 * same "ordinal within a FourCC" `MATL` uses, except that `MATL` pairs by position and this pairs
 * by an index a mesh may not have. A mesh with no targets simply has no chunk.
 */
export const CHUNK_MORP = fourCC('MORP');

/**
 * Which substance each material is made of. Optional, one chunk per file, added in 1.8.
 *
 * **`§16` of the chemistry design, and it exists so there is no code between an artist and a fire**:
 * the baker reads `extras.substance` off a glTF material and writes it here, and a consumer hands
 * the ids to `installChemistry().match`. Labelling the oak in Blender is the whole of what a
 * consumer does to make a log burn like oak.
 *
 * **One chunk for the file, pairing by an ordinal in the payload.** `CHUNK_MORP`'s note records why:
 * the table's `index` is the ordinal within a FourCC, so a file where only the fourth material is
 * labelled would carry a chunk at index 0 and a reader pairing by it would set the wrong material on
 * fire. See `drftSubs.ts` for the layout.
 */
export const CHUNK_SUBS = fourCC('SUBS');

/** Bytes before the records in a `SPLT` payload. See `DrftSplatBlock` for the fields. */
export const SPLAT_BLOCK_PREFIX = 40;

/**
 * Chunks this reader understands.
 *
 * The set matters because of rule 3 in docs/FORMAT.md §4.4: a *required* chunk that is not in
 * here is a refusal. An optional one is skipped in silence, which is what makes adding a
 * chunk in a minor version free.
 */
export const KNOWN_CHUNKS: ReadonlySet<number> = new Set([
  CHUNK_HEAD,
  CHUNK_MESH,
  CHUNK_NODE,
  CHUNK_MATL,
  CHUNK_TEXS,
  CHUNK_COLL,
  CHUNK_LITE,
  CHUNK_LODM,
  CHUNK_LODF,
  CHUNK_SPLT,
  CHUNK_SKIN,
  CHUNK_ANIM,
  CHUNK_MORP,
  CHUNK_SUBS,
]);

/** Chunk flags. */
export const CHUNK_REQUIRED = 1 << 0;

/** File flags. Bit 0 is set on every file this engine writes. */
export const FLAG_LITTLE_ENDIAN = 1 << 0;

/**
 * Which optional attributes a `MESH` chunk carries.
 *
 * Positions, normals, colours and emissive are mandatory — every `MeshData` has them —
 * so they take no bit. The four optional arrays do, in the order they appear in the
 * payload, and the order is frozen: a new attribute takes the next free bit and appends
 * to the payload, which is why an older reader can stop at the bits it knows.
 */
export const ATTR_SPECULAR = 1 << 0;
export const ATTR_UVS = 1 << 1;
export const ATTR_EMISSIVE_COLOR = 1 << 2;
export const ATTR_ROUGHNESS = 1 << 3;
/**
 * Added in 1.1, and the worked example of why the order is frozen rather than tidy.
 *
 * It takes the next free bit and appends to the end of the payload, so a 1.0 reader meets
 * exactly the arrays it knows in exactly the places it expects them and stops before this
 * one. The asset then draws without grain, which is what a reader that has never heard of
 * grain should produce. Inserting it beside `roughness`, where it belongs conceptually,
 * would have shifted every array after it and repainted the model with no error raised.
 */
export const ATTR_GRAIN = 1 << 4;
/**
 * Added in 1.3, and it is the same story as `grain` one bit along.
 *
 * `MeshData.relief` and `MeshBuilder.setRelief` shipped in engine 0.23.0 and the container was
 * never taught the bit, so a mesh carrying microscopic relief went through `writeDrft` and came
 * back without it. Everything else survived, which is what made it invisible: a round trip gave
 * the right shape with its surface texture gone, and that reads as a lighting problem rather
 * than as a format dropping an array. Found from outside by a test that writes every optional
 * attribute and reports *all* the losses rather than the first.
 *
 * Next free bit and appended last, for the reason spelled out above: a 1.2 reader meets the
 * arrays it knows where it expects them, stops before this one, and draws the asset smooth,
 * which is what a reader that has never heard of relief should produce.
 */
export const ATTR_RELIEF = 1 << 5;
/**
 * Added in 1.4, and the first optional attribute wider than three floats a vertex.
 *
 * A tangent frame: `xyz` running with u, and the bitangent's handedness in `w`. Four floats
 * rather than three because a UV layout can mirror, and a bitangent computed without the sign
 * lights one side of a model inside out. See `generateTangents` for the derivation.
 *
 * Next free bit, appended last, exactly as `grain` and `relief` each explain at length: a 1.3
 * reader meets the six arrays it knows in the six places it expects them, stops before this one,
 * and draws the asset with no tangent frame — which is what a reader that has never heard of
 * tangents should produce, and which is precisely what today's shaders do with one.
 */
export const ATTR_TANGENT = 1 << 6;
/**
 * Added in 1.11, and it is `relief` again with more at stake.
 *
 * **Which joints move a vertex, four of them, as indices into a skinning palette.** `MeshData`
 * declared `joints` and `weights` from the day skinning shipped and `validateMeshData` checked
 * both — four floats a vertex, and neither present without the other — and this format wrote
 * neither, because `buildMesh` listed the six optional arrays it knew and there was no bit to
 * list. The `SKIN` chunk beside it was correct the whole time, so a file carried a skeleton, its
 * bind pose and its clips, pointing at vertices that recorded no influence on any of them.
 *
 * **The failure was silent, which is what makes it the worse kind.** A baker handed the writer a
 * correctly-validated skinned mesh, got no error, and produced a file nothing could skin — and
 * `Mesh.isSkinned` reads `data.joints`, so what came back drew in bind pose for ever. Confine
 * wrote its own binary for one human body rather than use this, about seventy lines across a
 * baker and a loader, and that is the cost this closes.
 *
 * Two bits rather than one, because they are two arrays in the payload and the frozen order is a
 * property of arrays. They are still both-or-neither: `validateMeshData` refuses one without the
 * other on the way out and again on the way in, so the pair cannot half-arrive.
 *
 * Next free bits, appended last, for the reason `grain`, `relief` and `tangents` each spell out:
 * a 1.10 reader meets the seven arrays it knows in the seven places it expects them, stops before
 * these, and draws the asset in bind pose — which is what a reader that has never heard of
 * skinning should produce.
 */
export const ATTR_JOINTS = 1 << 7;
/** How much each of `ATTR_JOINTS`' four influences moves the vertex. See it for the whole story. */
export const ATTR_WEIGHTS = 1 << 8;

/** Everything this version defines, so a reader can spot bits from a later writer. */
export const ATTR_KNOWN =
  ATTR_SPECULAR |
  ATTR_UVS |
  ATTR_EMISSIVE_COLOR |
  ATTR_ROUGHNESS |
  ATTR_GRAIN |
  ATTR_RELIEF |
  ATTR_TANGENT |
  ATTR_JOINTS |
  ATTR_WEIGHTS;

/**
 * How a `TEXS` payload is encoded.
 *
 * The compressed three are decoded by `createImageBitmap`, which every target browser has,
 * so carrying them costs no dependency and no decoder of ours. `RAW` is uncompressed RGBA8
 * for generated data and tests. `KTX2` is reserved rather than defined: it is the right
 * long-term answer and it needs a transcoder of some 200 KB, so it becomes an additive
 * minor version once a game needs it rather than a cost every asset pays now.
 */
export const CODEC_PNG = 1;
export const CODEC_JPEG = 2;
export const CODEC_WEBP = 3;
export const CODEC_RAW = 4;

/** What a codec is called, for a message naming what was not understood. */
export function codecName(codec: number): string {
  return codec === CODEC_PNG
    ? 'PNG'
    : codec === CODEC_JPEG
      ? 'JPEG'
      : codec === CODEC_WEBP
        ? 'WEBP'
        : codec === CODEC_RAW
          ? 'RAW'
          : `codec ${codec}`;
}

/**
 * A capture, as the writer is handed it.
 *
 * **`positions` is read and never stored**, which is the one surprising field here. The writer
 * needs them to decide the coarse-first block layout, and the reader gets them back out of the
 * records — so writing them a second time would be twelve bytes a splat of duplicate in the one
 * place this format is trying hardest to be small.
 */
export interface DrftSplats {
  readonly count: number;
  /** Three per splat, in the capture's own space. Read for layout only. */
  readonly positions: Float32Array;
  /** `wordsPerSplat` `u32`s per splat, in `count` order. Opaque here. */
  readonly records: Uint32Array;
  readonly wordsPerSplat: number;
  readonly boundsMin: Float32Array;
  readonly boundsMax: Float32Array;
  /** Coefficients the source carried and the packer did not read. Carried as a number. */
  readonly sphericalHarmonics?: number;
  /**
   * How many blocks to split the capture into, or absent for a size this writer chooses.
   *
   * More blocks means a capture that opens sooner and a longer chunk table; each entry is
   * sixteen bytes, so even thirty-two blocks is half a kilobyte against megabytes of records.
   */
  readonly blocks?: number;
}

/**
 * One block of a capture, as the reader hands it back.
 *
 * Every block repeats the whole capture's count and bounds, which is twenty-eight bytes each and
 * makes a block self-describing: a consumer that has only the first one can size its buffers and
 * cull against the final extent, rather than waiting for a manifest it may already have passed.
 */
export interface DrftSplatBlock {
  /** Splats in this block. */
  readonly count: number;
  /** Splats in the whole capture, so a reader allocates once from the first block it meets. */
  readonly totalCount: number;
  readonly wordsPerSplat: number;
  readonly sphericalHarmonics: number;
  /** The whole capture's extent, not this block's. */
  readonly boundsMin: Float32Array;
  readonly boundsMax: Float32Array;
  /** A view over the file's own bytes: `wordsPerSplat * count` words, no copy. */
  readonly records: Uint32Array;
}

/**
 * One surface, stored once per mesh rather than once per vertex.
 *
 * Parallel to the `MESH` chunks by ordinal: material *n* describes mesh *n*. A parallel
 * array rather than a field inside `MESH` because a material is small and a mesh is
 * megabytes, and the loader wants every material before it uploads anything, so it can
 * create each texture once and share it between the meshes that name it.
 */
export interface DrftMaterial {
  /**
   * What the source called this surface. Diagnostic, and more than diagnostic.
   *
   * A bought asset frequently carries **no material data worth the name** and yet names its
   * materials perfectly well: the one this format was built against stores every surface as
   * the same default grey with no transparency, while calling them `body`, `glass`,
   * `chrome`, `tire_mat5` and `calipers`. The name is then the only thing in the file that
   * says what a surface *is*, so it is carried rather than discarded, and a scene can dress
   * an import without editing the import.
   */
  readonly name: string;
  readonly color: readonly [number, number, number];
  readonly specular: number;
  readonly roughness: number;
  readonly emissive: number;
  readonly emissiveColor: readonly [number, number, number];
  /** 1 is opaque. Below 1 the surface blends, and the loader draws it after the solid ones. */
  readonly opacity: number;
  /** Index into the asset's textures for the colour map, or -1 for an untextured surface. */
  readonly albedo: number;
  /**
   * Index into the asset's textures for the surface-space normal map, or -1 for none.
   *
   * **Written by any baker that can derive it, and bound by nothing yet.** Normal maps ship in the
   * renderer; carrying one through the container is the plan after ORM's. The field is defined
   * here rather than appended later so that all four indices cost the format one minor version
   * instead of three — see `MATERIAL_INDICES`.
   */
  readonly normalMap: number;
  /** Occlusion in R, roughness in G, metallic in B, or -1 for none. glTF's packing. */
  readonly ormMap: number;
  /** Index into the asset's textures for the emissive map, or -1. Written, not yet bound. */
  readonly emissiveMap: number;
  /**
   * glTF's `roughnessFactor` where an `ormMap` supplies the roughness, and 1 where it does not.
   *
   * **A factor that multiplies a texture is not a value**, which is the mistake this pair exists
   * to stop repeating. `roughness` and `specular` above are the scalars a material states when it
   * has no map; these are what the same numbers mean when it has one.
   */
  readonly roughnessScale: number;
  /** glTF's `metallicFactor` where an `ormMap` supplies the metallic, and 1 where it does not. */
  readonly metallicScale: number;
  /**
   * glTF's `occlusionTexture.strength`, or **0** where nothing establishes that the ORM map's R
   * channel holds occlusion at all.
   *
   * glTF assigns G and B of a `metallicRoughnessTexture` and says nothing about R, so occlusion is
   * only there when `occlusionTexture` names the same image — which is what the ORM convention is.
   * Anywhere else this is 0, because reading R would be reading whatever the exporter left.
   */
  readonly occlusionStrength: number;
  /**
   * How much of the environment this surface mirrors, 0 to 1.
   *
   * Distinct from `specular`, which is the strength of a highlight from a *light*. A surface
   * can take a sharp highlight and reflect nothing, which is most plastic, or reflect its
   * surroundings strongly, which is what makes paint and chrome read as what they are.
   */
  readonly reflectivity: number;
  /**
   * Alpha below which a fragment is discarded, 0 for a surface that discards nothing.
   *
   * **A test, not an opacity, and the difference is the whole reason this field exists.** A cutout
   * says which *texels* of a surface are there at all — the gaps in a grille, the space between
   * leaves, the holes in a fence — and leaves everything it keeps at full strength. An opacity
   * says how much of the light passes through the surface that is there. A format with only the
   * second has to spend it on the first, and `SurfaceMaterial.cutout` had no way through the
   * container until this: an alpha-tested surface arrived as a solid rectangle or as nothing.
   *
   * glTF states it exactly — `alphaMode: 'MASK'` with `alphaCutoff`, which defaults to 0.5 — and
   * it is what a vehicle format's alpha-test reference is, on the materials that say they are
   * tested.
   */
  readonly cutout: number;
}

/** Floats in a `MATL` entry, then the signed texture indices that follow them. */
export const MATERIAL_FLOATS = 15;
/**
 * Albedo, normal, ORM and emissive.
 *
 * **Four at once rather than one per feature, and the arithmetic is the argument.** Each appended
 * field is a writer change, a reader change, a `FORMAT.md` table edit and a forged-old-file test,
 * so taking them one at a time would spend three minor versions arriving where this arrives in
 * one. A glTF material names all four of its maps as plainly as it names the first, so none of
 * them is speculative — only unbound, and the plans that bind them need no second stride bump.
 */
export const MATERIAL_INDICES = 4;
export const MATERIAL_ENTRY_BYTES = MATERIAL_FLOATS * 4 + MATERIAL_INDICES * 4;

/** What `HEAD` says about the asset as a whole. */
export interface DrftHead {
  /** The asset's own name, for diagnostics. Never load-bearing. */
  readonly name: string;
  /** What wrote it — tool and version — so a bad bake can be traced to its baker. */
  readonly generator: string;
  /** Metres per unit in the source. 1 for an asset already authored in metres. */
  readonly unitScale: number;
  /** Axis-aligned bounds of everything, in this file's units: min x/y/z then max x/y/z. */
  readonly bounds: readonly number[];
}

/** A chunk as the table describes it, before its payload is touched. */
export interface DrftChunk {
  readonly code: number;
  readonly offset: number;
  readonly byteLength: number;
  readonly flags: number;
  readonly index: number;
}

/**
 * Thrown for any malformed or unreadable file, with the offset that failed.
 *
 * One error type rather than several, because every caller does the same thing with it:
 * a `.drft` that cannot be read is an asset that cannot be shown, and the useful part is
 * the message. Loading fails loudly at init; nothing partial is ever returned.
 */
export class DrftError extends Error {
  constructor(message: string) {
    super(`drft: ${message}`);
    this.name = 'DrftError';
  }
}

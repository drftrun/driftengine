/**
 * One dispatcher from a model file to meshes, shared by the baker and by a browser.
 *
 * **It exists because there were nearly two of them.** The baker grew the only mapping from
 * an extension to a reader, and it grew it against Node: `readFileSync` for a `.gltf`'s
 * external buffers, `readFileSync` again for an `.obj`'s `.mtl`, `node:zlib` for the two
 * compressed containers. None of that is about *which reader a file needs*, and a second
 * host wanting the same answer would have had to copy the dispatch and keep the copy in step
 * with every format added afterwards. So the dispatch moved here and the IO stayed with the
 * caller, which is the split `assetPath.ts` and the injected `Inflate` already make.
 *
 * **Every capability is optional, and what needs one says so when it is missing.** A `.glb`,
 * a `.stl`, a `.usdz` and a `.usda` need nothing at all, so the common case runs anywhere
 * with no configuration. A `.gltf` and an `.obj` may name a file beside them; a `.fbx` and a
 * `.3mf` store compressed arrays. Asking for those without supplying the capability fails
 * with the name of what to pass rather than with a parse error thirty frames later.
 *
 * The rule from docs/FORMAT.md §3.3 is unchanged by this: reading a source format at runtime
 * is not the default, never belongs on the main thread, and never belongs inside a frame.
 * This module makes it *possible* from a browser. Where it is allowed to run is the caller's
 * decision, and `demo/showroom.ts` runs it in a worker.
 */

import type { MeshData } from '@driftengine/drft';
import type { AnimationClip, DrftMaterial, DrftNode, DrftSkin } from '@driftengine/drft';
import { DrftError } from '@driftengine/drft';
import type { AssetReference } from './assetPath.ts';
import { assetCandidates } from './assetPath.ts';
import type { Handedness, UpAxis } from './orient.ts';
import type { Inflate } from './fbx.ts';
import { fbxToMeshes } from './fbx.ts';
import { gltfToMeshes, readGlb } from './gltf.ts';
import { readGltfSkins } from './gltfSkin.ts';
import type { GltfDocument } from './gltf.ts';
import { parseMtl, parseObj } from './obj.ts';
import { parseStl } from './stl.ts';
import { parseUsda, usdzToMeshes } from './usd.ts';
import { threeMfToMeshes } from './threemf.ts';
import { kn5ToMeshes, toDrftNodes } from './kn5.ts';
import { describeRecognised, recognise } from './recognise.ts';

/**
 * Every extension this project reads, in the order a bundle should be picked from.
 *
 * Sorted by tier first and then by how much of a scene the format can carry. `.glb` beats
 * `.gltf` only because one file cannot half-arrive; both read identically. It is data rather
 * than a chain of ifs because two callers need to *inventory* a folder against it, and a
 * chain of ifs cannot be enumerated.
 */
export const MODEL_FORMATS: readonly { ext: string; tier: number; note: string }[] = [
  { ext: '.glb', tier: 1, note: 'glTF 2.0, packed' },
  { ext: '.gltf', tier: 1, note: 'glTF 2.0' },
  { ext: '.obj', tier: 1, note: 'Wavefront OBJ' },
  { ext: '.stl', tier: 1, note: 'STL, geometry only, with no colour or materials' },
  { ext: '.usdz', tier: 1, note: 'USD, zipped' },
  { ext: '.usda', tier: 1, note: 'USD, ASCII' },
  { ext: '.3mf', tier: 1, note: '3MF, geometry and colour, with no UVs in the core format' },
  { ext: '.fbx', tier: 2, note: 'FBX, experimental reader, geometry, materials, skins and clips' },
  { ext: '.kn5', tier: 2, note: 'experimental reader, geometry, materials and hierarchy' },
];

/** Whether this project has a reader for an extension. Lower case or not. */
export function readerFor(ext: string): (typeof MODEL_FORMATS)[number] | undefined {
  return MODEL_FORMATS.find((reader) => reader.ext === ext.toLowerCase());
}

/** The extension of a file name, lower case, including the dot. Empty when it has none. */
export function extensionOf(name: string): string {
  const at = name.lastIndexOf('.');
  return at < 0 ? '' : name.slice(at).toLowerCase();
}

/** A model file, plus the capabilities its format may need to be read. */
export interface ModelSource {
  /**
   * The file's own name, used for its extension and in messages.
   *
   * The extension is a claim and the magic bytes are the fact, which is why `recognise` runs
   * before the dispatch below rather than after it.
   */
  readonly name: string;
  readonly bytes: Uint8Array;
  /**
   * Fetch a file named *beside* this one, or null where there is none.
   *
   * Needed by a `.gltf` naming external buffers and by an `.obj` naming an `.mtl`. The path
   * is relative and comes from inside the model, so a host that fetches it is choosing to
   * resolve a name the file supplied: resolve it against the model's own directory and
   * nothing above it.
   */
  readonly beside?: (relativePath: string) => Promise<Uint8Array | null>;
  /** zlib-wrapped inflate, for `.fbx`. See `fbxInflate.ts` for the browser's. */
  readonly inflate?: Inflate;
  /** Raw deflate inflate, for the zip inside a `.3mf`. Not the same function as `inflate`. */
  readonly inflateRaw?: Inflate;
  /**
   * Derive a tangent frame where a material declares a normal map and the file supplies none.
   *
   * **On by default. A caller that is about to weld should pass false** and call
   * `deriveTangentsFor` afterwards, which the baker does: the derivation accumulates per index, so
   * on a mesh stored as one vertex per triangle corner it gives every corner its own frame and the
   * weld can merge none of them. Measured at 9,600 corners welding to 9,482 rather than 1,681.
   *
   * Only glTF derives one at all, so this is inert for every other format. A frame the file
   * supplies is kept either way.
   */
  readonly deriveTangents?: boolean;
}

/** What a reader found, before anything is oriented, welded or written. */
export interface ModelImport {
  meshes: MeshData[];
  /** Caveats a person should read: an experimental reader, a missing axis convention. */
  warnings: string[];
  /** Informational lines, worth printing and not worth worrying about. */
  notes: string[];
  /** What the *file* says is up, where the format says anything at all. */
  declaredUp?: UpAxis;
  /** One per mesh, by ordinal, when the format carries materials. */
  materials?: DrftMaterial[];
  /**
   * Which substance each material is made of, from a glTF material's `extras.substance`.
   *
   * Absent for every other format and for a glTF that labels nothing, which is the same
   * all-or-nothing shape `materials` and `textures` have beside it. The baker writes these into the
   * `SUBS` chunk; `§16` of the chemistry design is why they exist.
   */
  substances?: { material: number; substance: string }[];
  /** Textures the model named, with bytes in hand where it carried them inline. */
  textures?: AssetReference[];
  /** Metres per source unit, when the format states one. USD and FBX do; nothing else here does. */
  unitScale?: number;
  /**
   * Skins and clips, where the format carries them. glTF and FBX do; nothing else here does.
   *
   * Optional, so every reader that knows nothing about rigs stays exactly as it was — the same
   * reason `materials` and `textures` are optional beside it.
   */
  skins?: readonly DrftSkin[];
  clips?: readonly AnimationClip[];
  /**
   * The asset's own hierarchy, where the format carries one. Absent for a format with none.
   *
   * **`MESH` stays world-space beside it**, which is what makes this additive: §4.4 rule 4 says a
   * minor version never changes the meaning of an existing byte, and moving positions into
   * node-local space would change the meaning of every vertex in the format while leaving the
   * bytes identical. It would also defeat rule 2, which promises that a reader skipping an
   * optional chunk still gets a usable asset — a local-space model whose `NODE` was skipped draws
   * as a heap at the origin. So a reader that skips `NODE` still draws the model, and one that
   * reads it calls `localiseNodes` to get parts it can turn.
   */
  nodes?: readonly DrftNode[];
  /** Which way round the source's coordinate system was. `orient.ts` is what acts on it. */
  declaredHand?: Handedness;
}

function needed(ext: string, capability: string): DrftError {
  return new DrftError(
    `${ext} needs a "${capability}" to be read. Bake it with \`npm run bake\`, which supplies one, ` +
      `or pass ${capability} to readModel.`,
  );
}

/**
 * Read one model file into meshes.
 *
 * Asynchronous because two formats may name a file beside them, and resolving that is IO
 * whichever host is doing it. Every reader underneath stays synchronous: the sidecars are
 * fetched first and the parse then runs in one pass, which is also what lets a caller put the
 * whole call in a worker and keep the parse off the main thread.
 */
export async function readModel(source: ModelSource): Promise<ModelImport> {
  return withTextures(await dispatch(source), source);
}

/**
 * Fetch the images a model named, through the same hook a `.gltf`'s buffers and an `.obj`'s
 * `.mtl` already come through.
 *
 * **This used to be left to the caller and the caller is where it went missing.** A reader
 * reports a texture as a *name* and fills `bytes` only where the format carried the image
 * inline, so a `.glb` was fine and every other format handed back references pointing at
 * nothing. Two hosts then wrote the same loop to fix that: `scripts/bake.ts` walks
 * `assetCandidates` against the model's folder and a search root, and a browser consumer walked
 * the same candidates against a zip's entry list — after shipping for months without it, which
 * is what made a bought archive draw untextured with its images two folders away inside itself.
 * One of those hosts writing the walk is a host doing its job; both of them writing it means the
 * walk was in the wrong place.
 *
 * **The split `assetPath.ts` describes is unchanged, and that is the point.** The engine decides
 * *what to look for*, which is the same everywhere and is `assetCandidates`; the host decides
 * *where*, which is `beside` and is the only half that knows whether it is holding a folder, a
 * zip or a URL. What moved here is the walk and nothing else.
 *
 * **What it costs: one `beside` call per candidate until one answers**, and `assetCandidates`
 * offers up to seven for a name with a folder in it. For a host reading a filesystem or an
 * in-memory archive that is nothing. For a host whose `beside` is a network request, a texture
 * that is genuinely absent costs seven round trips before the reference is left alone — so a
 * remote host should answer from an index it already holds rather than probing. What would make
 * this wrong: a `beside` with a side effect, since it is now called speculatively rather than
 * only for a name the model insisted on.
 *
 * A reference that resolves to nothing is left exactly as it was rather than dropped, because
 * `DrftMaterial.albedo` is an ordinal into this list and removing an entry renumbers every one
 * after it, which silently repaints the model.
 */
async function withTextures(imported: ModelImport, source: ModelSource): Promise<ModelImport> {
  const references = imported.textures;
  const beside = source.beside;
  if (references === undefined || beside === undefined) return imported;
  if (references.every((reference) => reference.bytes !== undefined)) return imported;

  const notes = [...imported.notes];
  const resolved: AssetReference[] = [];
  for (const reference of references) {
    if (reference.bytes !== undefined) {
      resolved.push(reference);
      continue;
    }
    let found: { candidate: string; bytes: Uint8Array } | null = null;
    for (const candidate of assetCandidates(reference.name)) {
      const bytes = await beside(candidate);
      if (bytes !== null) {
        found = { candidate, bytes };
        break;
      }
    }
    if (found === null) {
      resolved.push(reference);
      continue;
    }
    /* Only worth saying when it was somewhere other than where the model looked, which is the
       case somebody would otherwise go hunting for the file over. */
    if (found.candidate !== reference.name) {
      notes.push(`texture "${reference.name}" was found as "${found.candidate}"`);
    }
    resolved.push({ ...reference, bytes: found.bytes });
  }
  return { ...imported, textures: resolved, notes };
}

async function dispatch(source: ModelSource): Promise<ModelImport> {
  const { name, bytes } = source;
  /* Only glTF reads this today, and it is passed as the whole option object so a second field
     costs one line here rather than one per reader. */
  const options = { deriveTangents: source.deriveTangents ?? true };
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const ext = extensionOf(name);

  /*
   * Tier 4 first, and by content rather than by extension. A file this project has no reader
   * for should say so and name the export that works, rather than reaching a parser that
   * fails on bytes it was never going to understand.
   */
  const foreign = recognise(bytes);
  if (foreign !== null) throw new DrftError(describeRecognised(foreign, name));

  if (ext === '.glb') {
    const { json, binary } = readGlb(buffer);
    const parts = binary === null ? [] : [binary];
    /*
     * The rig alongside the geometry, and read from the same document. `gltfToMeshes` reads it too
     * — to remap a mesh's joint indices — and both go through `readGltfSkins`, so there is one
     * sort rather than two that could disagree about which joint is which.
     */
    return complete({ ...gltfToMeshes(json, parts, options), ...readGltfSkins(json, parts) });
  }

  if (ext === '.gltf') {
    const doc = JSON.parse(new TextDecoder().decode(bytes)) as GltfDocument;
    const buffers: Uint8Array[] = [];
    for (const entry of doc.buffers ?? []) {
      if (entry.uri === undefined) throw new DrftError('gltf: a buffer with no uri needs a .glb');
      if (entry.uri.startsWith('data:')) {
        const comma = entry.uri.indexOf(',');
        buffers.push(base64Bytes(entry.uri.slice(comma + 1)));
        continue;
      }
      if (source.beside === undefined) throw needed('.gltf with external buffers', 'beside');
      const found = await source.beside(decodeURIComponent(entry.uri));
      if (found === null)
        throw new DrftError(`gltf: the buffer "${entry.uri}" was not found beside the model`);
      buffers.push(found);
    }
    return complete({ ...gltfToMeshes(doc, buffers, options), ...readGltfSkins(doc, buffers) });
  }

  if (ext === '.obj') {
    /* The `.mtl` is named inside the file, and is optional: a bare OBJ still imports. */
    const text = new TextDecoder().decode(bytes);
    const named = /^mtllib\s+(.+)$/m.exec(text)?.[1]?.trim();
    let materials = new Map<
      string,
      ReturnType<typeof parseMtl> extends Map<string, infer V> ? V : never
    >();
    const notes: string[] = [];
    const missing: string[] = [];
    if (named !== undefined && source.beside !== undefined) {
      const found = await source.beside(named);
      if (found === null) {
        /*
         * A **warning**, not a note, and the distinction is the whole point of the change.
         *
         * A consumer cannot tell "this model has no textures" from "this model's textures could
         * not be found", and the two want opposite handling: the first is a model to paint by
         * material name, the second is a file to go looking for. The engine is the only party
         * that knows which happened, because it is what called `beside` and got null back.
         *
         * It was a note, which is the channel for things that are merely true. Reported from
         * outside after an hour spent treating a packing mistake, a bundle shipped without its
         * `.mtl` at all, as a model with no maps.
         */
        missing.push(
          `obj: the material library "${named}" was not found beside the model, so every ` +
            'surface takes a default and no material declares a map. If this asset should be ' +
            'textured, the file is missing from the bundle rather than absent from the model.',
        );
      } else {
        materials = parseMtl(new TextDecoder().decode(found));
      }
    }
    const parsed = parseObj(text, materials);
    return complete({ ...parsed, warnings: [...missing, ...parsed.warnings] }, notes);
  }

  if (ext === '.stl') {
    /*
     * STL carries no axis convention, no units and no materials, so there is nothing to read
     * here and nothing to trust. It is also, overwhelmingly, a printing format, and printing
     * is Z-up almost everywhere, so the common case lands on its face in a Y-up engine. Said
     * once, plainly, rather than guessed at: guessing is what put a car upside down and
     * reported it as verified.
     */
    return {
      meshes: [parseStl(buffer)],
      warnings: ['stl states no up axis. Most are Z-up; pass --up z if this lands on its side.'],
      notes: [],
    };
  }

  if (ext === '.usdz' || ext === '.usda') {
    /*
     * No inflate is passed and that is the format speaking rather than an omission: a `.usdz`
     * must store its entries uncompressed so a runtime can memory map them, so it is the one
     * zip container that needs no decompressor at all.
     */
    const result =
      ext === '.usdz' ? usdzToMeshes(buffer) : parseUsda(new TextDecoder().decode(bytes));
    const notes =
      result.unitScale === 1
        ? []
        : /* Carried into HEAD rather than multiplied into the vertices: the format has a field
             for exactly this, and scaling here would throw away what the file said in favour of
             a number nobody could check afterwards. */
          [`usd: metersPerUnit ${result.unitScale}, carried into HEAD.`];
    return {
      meshes: result.meshes,
      warnings: result.warnings,
      notes,
      ...(result.declaredUp === undefined ? {} : { declaredUp: result.declaredUp }),
      materials: result.materials,
      textures: result.textures,
      unitScale: result.unitScale,
    };
  }

  if (ext === '.3mf') {
    /*
     * Ordinary deflate, unlike usdz, so this is the zip path that needs the decompressor, and
     * it is the *raw* one. A zip stores a bare deflate stream with no zlib header while FBX
     * embeds a wrapped one, so the two paths take different functions. Passing the wrong one
     * fails cleanly rather than decoding to plausible noise, which is the good kind of
     * mistake, and is why they are two fields here rather than one.
     */
    if (source.inflateRaw === undefined) throw needed('.3mf', 'inflateRaw');
    const result = threeMfToMeshes(buffer, source.inflateRaw);
    return {
      meshes: result.meshes,
      warnings: result.warnings,
      notes: [`3mf: ${result.meshes.length} object(s), Z-up by specification.`],
      declaredUp: result.declaredUp,
      materials: result.materials,
      unitScale: result.unitScale,
    };
  }

  if (ext === '.fbx') {
    if (source.inflate === undefined) throw needed('.fbx', 'inflate');
    const result = fbxToMeshes(buffer, source.inflate);
    return {
      meshes: result.meshes,
      warnings: [
        ...result.warnings,
        `fbx: version ${result.version}, experimental reader (tier 2), not covered by the compatibility promise.`,
      ],
      notes: [],
      declaredUp: result.declaredUp,
      materials: result.materials,
      textures: result.textures,
      /*
       * The rig, on the same terms glTF's is: absent where the file carries none, so every static
       * `.fbx` returns exactly what it always did. `.fbx` is how characters are *sold* — it is the
       * only thing Mixamo exports — so a reader that returned geometry alone made the one format
       * most rigs arrive in the one format a rig could not be read from.
       */
      skins: result.skins,
      clips: result.clips,
      /*
       * **Carried rather than multiplied in**, which is the ruling `.usdz` already made in this
       * file: the format has a field for exactly this, and scaling here would throw away what the
       * file said in favour of a number nobody could check afterwards.
       */
      unitScale: result.unitScale,
    };
  }

  if (ext === '.kn5') {
    /*
     * No capability of any kind: a `.kn5` embeds every texture it uses, so this is the one binary
     * format here with nothing to inject and no sidecar to resolve.
     */
    const result = kn5ToMeshes(buffer);
    /*
     * **Nothing is mirrored here, and until 3.26.0 everything was.** The frame was declared
     * left-handed on the strength of the simulator being a DirectX title, and a consumer importing
     * a second car found the mirror by eye: a rear badge reading backwards, a number plate written
     * backwards, and the steering wheel on the wrong side of the cabin. `kn5.ts` carries the
     * measurement that settles it. Nothing numeric had caught it in between, because a mirrored car
     * has the same bounds, the same triangle count and the same consistent winding as an
     * unmirrored one.
     *
     * A reader that does meet a left-handed format applies **both** halves — `convertHandedness`
     * over the meshes and `mirrorNodes` over the graph — or it desynchronises two individually
     * well-formed halves. The half that was missing while this branch existed put a wheel hub
     * 1.385 m from its own geometry, on the other side of the car.
     */
    const nodes = toDrftNodes(result.nodes);
    return {
      meshes: result.meshes,
      warnings: [
        ...result.warnings,
        'kn5: experimental reader (tier 2), not covered by the compatibility promise.',
      ],
      notes: [`kn5: ${result.nodes.length} nodes, ${result.meshes.length} meshes.`],
      declaredUp: result.declaredUp,
      declaredHand: result.declaredHand,
      materials: result.materials,
      textures: result.textures,
      nodes,
    };
  }

  throw new DrftError(
    `no reader for "${ext}". This project reads ${MODEL_FORMATS.map((entry) => entry.ext).join(', ')}.`,
  );
}

/** Give a reader's result the two fields every caller reads, without each reader restating them. */
function complete(
  result: { meshes: MeshData[]; warnings: string[] } & Omit<
    ModelImport,
    'meshes' | 'warnings' | 'notes'
  >,
  notes: string[] = [],
): ModelImport {
  return { ...result, notes };
}

/** Base64 without Node's Buffer, since this module runs in a browser too. */
function base64Bytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * The collision hull a vehicle folder ships beside its model, or null.
 *
 * **A convention, not a statement in any file**, which is why it is one named function instead of
 * a rule spread through the baker: a folder naming its hull differently gets no collider and the
 * baker says what it looked for, rather than leaving a consumer to wonder why physics has nothing
 * to work with.
 *
 * It is read by the ordinary reader and baked as its own asset. Carrying a hull *inside* the
 * model's own file would mean defining `COLL`, which is a declared FourCC with no payload, no
 * reader and no writer — a format decision about whether a hull is triangle soup or a set of
 * convex hulls, and not one an import should make in passing.
 */
export function levelsBeside(model: string, names: readonly string[]): string[] {
  /*
   * `<name>_lod_<letter>.kn5` beside `<name>.kn5`, finest first, which is the order the letters
   * already give. A **convention and not a statement in any file**, so a bundle naming its levels
   * differently gets the model alone and the baker prints what it looked for.
   */
  const stem = model.replace(/\.[^.]*$/, '');
  const pattern = new RegExp(
    `^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_lod_([a-z])\\.kn5$`,
    'i',
  );
  return names
    .map((name) => ({ name, match: pattern.exec(name) }))
    .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
    .sort((a, b) =>
      (a.match[1] as string).toLowerCase().localeCompare((b.match[1] as string).toLowerCase()),
    )
    .map((entry) => entry.name);
}

export function colliderBeside(names: readonly string[]): string | null {
  return names.find((name) => name.toLowerCase() === 'collider.kn5') ?? null;
}

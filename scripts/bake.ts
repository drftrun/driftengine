/**
 * `drft bake` — turn a model, or a bought bundle, into a `.drft`.
 *
 *   npx tsx scripts/bake.ts model.glb -o model.drft
 *   npx tsx scripts/bake.ts ./tomb-props -o tomb-props.drft
 *   npx tsx scripts/bake.ts ./tomb-props --from obj
 *
 * **A bought asset is a bundle, not a file.** A download is typically the source the
 * artist worked in plus conversions — glb, gltf, obj, fbx, usdz — every one of them the
 * same model, exactly one of them the best thing to read. So a directory is a valid input
 * and the tool inventories it, picks the highest tier present, and *prints what it chose
 * and what it passed over*. Choosing in silence would be the worst outcome available: an
 * experimental reader used while a conformance-tested file sat in the next folder, with
 * nobody able to notice.
 *
 * Offline, in Node. No third-party format is ever parsed at runtime, so a reader meeting
 * a file it does not understand costs a failed bake rather than a broken frame.
 */

import { readFileSync, statSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MODEL_FORMATS, readModel, readerFor } from '@driftengine/assets';
import type { ModelImport } from '@driftengine/assets';
import { describeRecognised, recognise } from '@driftengine/assets';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { writeDrft } from '@driftengine/drft';
import { deriveTangentsFor, dropDefaultAttributes, weldMesh } from '@driftengine/assets';
import { buildCoarseLevel, isOutlineWorthWriting, DEFAULT_COARSE_CELLS } from '@driftengine/assets';
import { describeUpAxis, orientMeshes, orientNodes, parseUpAxis } from '@driftengine/assets';
import type { UpAxis } from '@driftengine/assets';
import { CODEC_PNG, CODEC_RAW, DrftError, codecName } from '@driftengine/drft';
import { MAX_COLLIDER_HULLS } from '@driftengine/drft';
import { decomposeConvex } from '@driftengine/physics';
import { readFile } from 'node:fs/promises';
import type { DrftMaterial } from '@driftengine/drft';
import type { DrftTextureSource } from '@driftengine/drft';
import { assetCandidates } from '@driftengine/assets';
import type { AssetReference } from '@driftengine/assets';
import { describeImage } from '@driftengine/assets';
import { ddsToRgba, isDds } from '@driftengine/assets';
/* The Node-side PNG encoder, which is why a decoded surface is not embedded uncompressed. */
import { encodePng } from '../packages/core/scripts/png.mjs';
import { colliderBeside, levelsBeside } from '@driftengine/assets';
import type { MeshData } from '@driftengine/drft';

/**
 * The reader table and the dispatch both live in `packages/assets/src/readModel.ts` now.
 *
 * They were here, and they were written against Node: `readFileSync` for a `.gltf`'s external
 * buffers and for an `.obj`'s `.mtl`, `node:zlib` for the two compressed containers. None of
 * that is about *which reader a file needs*, so a browser wanting the same answer would have
 * had to copy the dispatch and keep the copy in step with every format added after it. The
 * dispatch moved; the IO below stayed here, which is where it belongs.
 */
const READERS = MODEL_FORMATS;

/**
 * Say so when a model has ended up standing below its own origin.
 *
 * **A container's declared up axis can simply be wrong, and this tool believes it.** The car this
 * pipeline was built against declares `+y` and is a half turn about X inside that: it baked roof
 * down, and nothing in the output said anything, because a reader has no way to know. `--up -y`
 * is the fix and the whole difficulty is finding out that it is needed.
 *
 * The sign of the y range is the check that works, and it is the one recorded in the reader parity matrix
 * §2.1 as ground truth after two other heuristics gave false positives. A model that sits almost
 * entirely under y=0 has its origin on top of it, which for anything meant to stand on a floor is
 * upside down. It is a *warning* rather than a rotation, for the reason the rest of the axis
 * handling exists: every rule for measuring which way is up is wrong on something ordinary, so
 * this points at the answer and lets a person decide.
 */
function warnIfUpsideDown(meshes: readonly MeshData[]): void {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const mesh of meshes) {
    for (let at = 1; at < mesh.positions.length; at += 3) {
      const y = mesh.positions[at] as number;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minY) || maxY <= minY) return;
  /* Nine tenths below the origin rather than merely more than half: a model centred on its own
     middle is ordinary and must not warn, and one standing on y=0 is the common case. */
  const below = -minY / (maxY - minY);
  if (below < 0.9) return;
  console.warn(
    `  warning: this model spans y=${minY.toFixed(2)}..${maxY.toFixed(2)}, so it sits below its ` +
      `origin.\n           If it looks upside down, try --up -y.`,
  );
}

/** Every file under a directory, so a bundle's nested `gltf/` and `source/` are both seen. */
function walk(dir: string, depth = 0): string[] {
  if (depth > 4) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, depth + 1));
    else out.push(full);
  }
  return out;
}

/**
 * Node's side of a read: the filesystem and zlib, handed to the shared dispatcher.
 *
 * `beside` resolves against the model's own directory, which is what a `.gltf` and an
 * `.obj` mean by a relative name. The two inflates are different functions on purpose: a
 * zip stores a bare deflate stream and FBX embeds a zlib-wrapped one.
 */
function loadModel(file: string): Promise<ModelImport> {
  const bytes = readFileSync(file);
  return readModel({
    name: path.basename(file),
    bytes,
    beside: (relative) => {
      try {
        return Promise.resolve(
          new Uint8Array(readFileSync(path.join(path.dirname(file), relative))),
        );
      } catch {
        return Promise.resolve(null);
      }
    },
    /*
     * The frame is derived after the weld, below, and not here. The derivation accumulates per
     * index, so on a file storing one vertex per triangle corner it gives every corner its own
     * frame and the weld can merge none of them: 9,600 corners to 9,482 vertices instead of 1,681,
     * measured in `tangentOrder.test.ts`. Deriving on the merged mesh is a smaller file and a
     * better frame, since sharing is what the derivation averages over.
     */
    deriveTangents: false,
    inflate: (data, expected) =>
      new Uint8Array(inflateSync(data, { maxOutputLength: Math.max(expected, 1) * 2 })),
    inflateRaw: (data, expected) =>
      new Uint8Array(inflateRawSync(data, { maxOutputLength: Math.max(expected, 1) * 2 })),
  });
}

/**
 * Derive a tangent frame for a welded mesh whose material declares a normal map.
 *
 * **Deliberately here and not in the reader**, which is the correction 3.30.0 makes. A frame
 * exists to sample a normal map, and there is one place in this engine that reads one, so a
 * material with no map wants no frame — that gate has been in the reader since 3.27.0. What was
 * still wrong is the *order*: `generateTangents` accumulates per index, and a file storing one
 * vertex per triangle corner gives every corner one triangle's frame, so no two corners at a
 * point agree and `weldMesh` — which keys on the frame, since a mirrored shell differs in nothing
 * else — merges none of them.
 *
 * Measured on a rotationally unwrapped corner soup: 9,600 corners weld to 1,681 vertices with no
 * frame and to 9,482 with one derived per corner, six different frames at one point at worst.
 */
function withTangentsIfMapped(mesh: MeshData, material: DrftMaterial | undefined): MeshData {
  if (material === undefined || material.normalMap < 0) return mesh;
  return deriveTangentsFor(mesh);
}

/**
 * An image the model already carried, identified and wrapped for embedding.
 *
 * A glTF keeps its images inside the binary chunk or in a data URI as often as it points at
 * files, so this path is the common one for that format and never taken for FBX or OBJ. The
 * bytes are still identified rather than trusted: `mimeType` is optional in glTF and wrong
 * often enough that reading the image's own header is the only reliable answer.
 */
function describeEmbedded(name: string, bytes: Uint8Array, warnings: string[]): DrftTextureSource {
  /*
   * Block-compressed DDS is decoded here rather than identified and refused, because a third of a
   * shipped vehicle's textures are in it and the alternative is a model that imports correctly
   * shaped and visibly half-painted.
   *
   * **It is then re-encoded, which it was not for three minor versions.** The decoded surface used
   * to be embedded as `CODEC_RAW`, on the argument that a bake runs offline and never in a frame —
   * true of the *time* and not of the file, which a browser downloads. Measured on a shipped car's
   * level of detail B: 21 textures, 3.6 MB of DDS, 11.6 MB of RGBA, in a 22.8 MB container. A
   * consumer wrote the missing encoder themselves and reported it as the difference between a
   * model that needs sharding to clear a static host's per-file limit and one that does not.
   *
   * Both ends are lossless, so this is a smaller file and not a worse one.
   */
  if (isDds(bytes)) {
    try {
      const decoded = ddsToRgba(bytes);
      const png = encodePng(decoded.width, decoded.height, Buffer.from(decoded.rgba));
      console.log(
        `  texture ${name} — DDS decoded and re-encoded ${decoded.width}x${decoded.height}, ` +
          `${(png.length / 1024).toFixed(0)} KB from ${(bytes.length / 1024).toFixed(0)} KB ` +
          `(${(decoded.rgba.length / 1024).toFixed(0)} KB uncompressed)`,
      );
      return { name, codec: CODEC_PNG, width: decoded.width, height: decoded.height, bytes: png };
    } catch (error) {
      warnings.push(`texture "${name}": ${error instanceof Error ? error.message : String(error)}`);
      return {
        name,
        codec: CODEC_RAW,
        width: 1,
        height: 1,
        bytes: new Uint8Array([255, 255, 255, 255]),
      };
    }
  }
  try {
    const info = describeImage(bytes);
    console.log(
      `  texture ${name} — ${codecName(info.codec)} ${info.width}x${info.height}, ` +
        `${(bytes.length / 1024).toFixed(0)} KB carried by the model`,
    );
    return { name, codec: info.codec, width: info.width, height: info.height, bytes };
  } catch (error) {
    warnings.push(`texture "${name}": ${error instanceof Error ? error.message : String(error)}`);
    return {
      name,
      codec: CODEC_RAW,
      width: 1,
      height: 1,
      bytes: new Uint8Array([255, 255, 255, 255]),
    };
  }
}

/**
 * Drop the images no material samples, and renumber the ones that stay.
 *
 * **A reader keeps every image the file declared, on purpose**: `gltf.ts` indexes by *texture*
 * rather than by image so a material's index means what the file said it meant, and `readModel`
 * leaves a reference that resolved to nothing in the list for the same reason. That invariant is
 * about the *read*. By the time a `.drft` is written the four ordinals in `MATL` are the only
 * things that can reach `TEXS` at all, so an entry nothing points at is bytes a browser downloads
 * and never decodes.
 *
 * It was measured at a whole model: a car written in glTF's archived specular-glossiness model
 * imported with **20 textures embedded and none of them bound**, the largest a 10 MB body map. The
 * reader now binds them, and the ones that stay unreachable — a specular-glossiness map, whose
 * channels no rearrangement fits into an ORM one — are what this drops.
 *
 * **Renumbering is the whole difficulty and the reason this is one function.** Compacting the list
 * without rewriting the ordinals repaints the model, which is exactly why both `embedTextures` and
 * `readModel` refuse to drop an entry on their own; the two halves have to happen together or
 * neither may happen.
 *
 * **What it gives up**: an image no material samples is no longer in the asset, so
 * `TextureSet.get` cannot return it and a consumer holding a name for one gets the throw that
 * lookup exists to give. That is the documented behaviour — `HANDBOOK` §3 had promised *only
 * images a material actually reaches are embedded* for longer than it had been true — and the
 * alternative is every asset carrying its source's whole texture folder. **What would make it wrong**: a
 * consumer that wants an unsampled image out of the container for its own use, which would need a
 * way to say so rather than the accident of it having been left in.
 *
 * An ordinal already past the end of the list is left exactly where it is. It is a broken import
 * either way and `readDrft` refuses it by name; renumbering it would turn that refusal into a
 * silently wrong texture.
 */
function reachableTextures(
  refs: readonly AssetReference[],
  materials: readonly DrftMaterial[] | undefined,
): {
  refs: readonly AssetReference[];
  materials: readonly DrftMaterial[] | undefined;
  dropped: readonly AssetReference[];
} {
  const reached = new Set<number>();
  for (const material of materials ?? []) {
    for (const index of [
      material.albedo,
      material.normalMap,
      material.ormMap,
      material.emissiveMap,
    ]) {
      if (index >= 0 && index < refs.length) reached.add(index);
    }
  }
  if (reached.size === refs.length) return { refs, materials, dropped: [] };

  const at = new Int32Array(refs.length).fill(-1);
  const kept: AssetReference[] = [];
  const dropped: AssetReference[] = [];
  for (let i = 0; i < refs.length; i++) {
    const reference = refs[i] as AssetReference;
    if (reached.has(i)) {
      at[i] = kept.length;
      kept.push(reference);
    } else {
      dropped.push(reference);
    }
  }
  const through = (index: number): number =>
    index >= 0 && index < refs.length ? (at[index] as number) : index;

  return {
    refs: kept,
    materials: materials?.map((material) => ({
      ...material,
      albedo: through(material.albedo),
      normalMap: through(material.normalMap),
      ormMap: through(material.ormMap),
      emissiveMap: through(material.emissiveMap),
    })),
    dropped,
  };
}

/** One line naming what was left out, because an image silently missing from a bake is not a saving. */
function reportDropped(dropped: readonly AssetReference[]): void {
  if (dropped.length === 0) return;
  const carried = dropped.reduce((sum, reference) => sum + (reference.bytes?.length ?? 0), 0);
  const names = dropped.map((reference) => reference.name);
  const listed =
    names.length > 6
      ? `${names.slice(0, 6).join(', ')} and ${names.length - 6} more`
      : names.join(', ');
  /* KB under a megabyte: this line exists to show what was saved, and `0.0 MB` shows nothing. */
  const size =
    carried >= 1024 * 1024
      ? `${(carried / 1024 / 1024).toFixed(1)} MB`
      : `${(carried / 1024).toFixed(0)} KB`;
  console.log(
    `  ${dropped.length} image${dropped.length === 1 ? '' : 's'} no material samples, not embedded: ${listed}` +
      (carried === 0 ? '' : ` (${size} the model carried)`),
  );
}

/**
 * Find the images a model named, and embed them.
 *
 * The engine says what to look for and this says where to look, which is the split the
 * whole of `assetPath.ts` exists for: only the host knows it is reading a folder on a disk.
 *
 * A texture that cannot be found is a **warning and not a refusal**, and that is a departure
 * from the tier 2 rule that a reader refuses rather than half-imports. The reason is that
 * this failure is not ambiguous the way a half-read mesh is: the geometry, the UVs and the
 * material colours are all completely read, the model draws correctly, and the only thing
 * missing is named on screen. Refusing the whole bake because one map was left out of a
 * download would make a 50 MB asset unusable over a file the artist may never have shipped.
 */
function embedTextures(
  refs: readonly AssetReference[],
  modelFile: string,
  searchRoot: string,
  warnings: string[],
): DrftTextureSource[] {
  const out: DrftTextureSource[] = [];
  const roots = [path.dirname(modelFile), searchRoot];
  for (const reference of refs) {
    const declared = reference.name;
    /* Already in hand: a glTF image inside the binary chunk or a data URI needs no lookup. */
    if (reference.bytes !== undefined) {
      out.push(describeEmbedded(declared, reference.bytes, warnings));
      continue;
    }
    let found: { file: string; bytes: Uint8Array } | null = null;
    for (const root of roots) {
      for (const candidate of assetCandidates(declared)) {
        const full = path.join(root, candidate);
        try {
          if (!statSync(full).isFile()) continue;
          found = { file: full, bytes: new Uint8Array(readFileSync(full)) };
          break;
        } catch {
          /* Not there. The next candidate is the point of having candidates. */
        }
      }
      if (found !== null) break;
    }

    if (found === null) {
      warnings.push(
        `texture "${declared}" was not found beside the model; it will draw untextured`,
      );
      /* A placeholder keeps every material's index meaning what it meant. Dropping the
         entry instead would renumber every texture after it and repaint the model. */
      out.push({
        name: declared,
        codec: CODEC_RAW,
        width: 1,
        height: 1,
        bytes: new Uint8Array([255, 255, 255, 255]),
      });
      continue;
    }

    try {
      const info = describeImage(found.bytes);
      out.push({
        name: declared,
        codec: info.codec,
        width: info.width,
        height: info.height,
        bytes: found.bytes,
      });
      console.log(
        `  texture ${path.relative(searchRoot, found.file)} — ${codecName(info.codec)} ` +
          `${info.width}x${info.height}, ${(found.bytes.length / 1024).toFixed(0)} KB embedded`,
      );
    } catch (error) {
      warnings.push(
        `texture "${declared}": ${error instanceof Error ? error.message : String(error)}`,
      );
      out.push({
        name: declared,
        codec: CODEC_RAW,
        width: 1,
        height: 1,
        bytes: new Uint8Array([255, 255, 255, 255]),
      });
    }
  }
  return out;
}

/** What `--collider` asked for. `none` is the default and writes no chunk at all. */
type ColliderMode = { kind: 'none' } | { kind: 'box' } | { kind: 'hull'; maxHulls: number };

/**
 * `--collider none | box | hull | hull:N`.
 *
 * **`none` by default**, because collision is not something a bake should invent: an asset that
 * carries hulls it was never asked for is bytes every consumer pays for and a shape somebody has to
 * discover is wrong. Asking for it is one flag.
 */
function colliderFlag(args: readonly string[]): ColliderMode {
  const at = args.indexOf('--collider');
  if (at === -1) return { kind: 'none' };
  const value = args[at + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error('--collider takes none, box, hull, or hull:N');
  }
  if (value === 'none') return { kind: 'none' };
  if (value === 'box') return { kind: 'box' };
  if (value === 'hull') return { kind: 'hull', maxHulls: 16 };
  const match = /^hull:(\d+)$/.exec(value);
  if (match === null) throw new Error(`--collider ${value} is not none, box, hull, or hull:N`);
  const maxHulls = Number(match[1]);
  if (!(maxHulls >= 1 && maxHulls <= MAX_COLLIDER_HULLS)) {
    throw new Error(`--collider hull:${maxHulls} is outside 1 to ${MAX_COLLIDER_HULLS}`);
  }
  return { kind: 'hull', maxHulls };
}

/** Every mesh's positions, end to end, as one array for the decomposition to rasterise. */
function collisionPositions(meshes: readonly { positions: Float32Array }[]): Float32Array {
  let total = 0;
  for (const mesh of meshes) total += mesh.positions.length;
  const out = new Float32Array(total);
  let at = 0;
  for (const mesh of meshes) {
    out.set(mesh.positions, at);
    at += mesh.positions.length;
  }
  return out;
}

/** The same for indices, with each mesh's shifted past the vertices before it. */
function collisionIndices(
  meshes: readonly { positions: Float32Array; indices: Uint32Array }[],
): Uint32Array {
  let total = 0;
  for (const mesh of meshes) total += mesh.indices.length;
  const out = new Uint32Array(total);
  let at = 0;
  let base = 0;
  for (const mesh of meshes) {
    for (let i = 0; i < mesh.indices.length; i++) out[at + i] = (mesh.indices[i] as number) + base;
    at += mesh.indices.length;
    base += mesh.positions.length / 3;
  }
  return out;
}

/** The eight corners of a point cloud's bounds, which is the cheapest honest collider there is. */
function boundsHull(positions: Float32Array): Float32Array {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    minX = Math.min(minX, positions[i] as number);
    maxX = Math.max(maxX, positions[i] as number);
    minY = Math.min(minY, positions[i + 1] as number);
    maxY = Math.max(maxY, positions[i + 1] as number);
    minZ = Math.min(minZ, positions[i + 2] as number);
    maxZ = Math.max(maxZ, positions[i + 2] as number);
  }
  const out = new Float32Array(24);
  for (let i = 0; i < 8; i++) {
    out[i * 3] = i & 1 ? maxX : minX;
    out[i * 3 + 1] = i & 2 ? maxY : minY;
    out[i * 3 + 2] = i & 4 ? maxZ : minZ;
  }
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const input = args[0];
  if (input === undefined || input.startsWith('-')) {
    console.error(
      'usage: bake <file-or-folder> [-o out.drft] [--from glb|gltf|obj|stl] [--up x|-x|y|-y|z|-z]' +
        ' [--lod cells] [--no-lod] [--no-levels]',
    );
    process.exit(1);
  }
  const outIndex = args.indexOf('-o');
  const fromIndex = args.indexOf('--from');
  const forced = fromIndex === -1 ? null : (args[fromIndex + 1] ?? null);
  /*
   * Which way is up in the asset, when the asset itself is not to be believed.
   *
   * Deliberately not guessed. A model can be measured for which of its axes looks most like
   * "up" — the tallest extent, the widest base — and every such rule is wrong on something
   * ordinary: a wheel is symmetrical, a plank is not upright, a car is wider at the bottom
   * until it is a van. Guessing also fails silently, which is the expensive part, so this is
   * told rather than inferred and the line below records what it was told.
   */
  const upIndex = args.indexOf('--up');
  const assetUp = upIndex === -1 ? null : parseUpAxis(args[upIndex + 1] ?? '');

  /*
   * The coarse outline, **written unless `--no-lod` refuses it**, at `--lod cells` for a
   * resolution other than the default.
   *
   * It was off unless asked for, on the argument that whether a coarse level of *this* asset is
   * worth looking at cannot be measured here: detail living well below the grid decimated into
   * lumps and ridges, and a viewer waiting for a car saw white cliffs, which is worse than an
   * empty stage because an empty stage reads as a load and a bad preview reads as a broken
   * import. That argument was about the clustering hull. The occupancy hull emits the boundary
   * of a solid, so the worst case is a coarse version of the shape rather than a shape that was
   * never there, and the cost is 150 KB of a 76 MB car and about 640 ms of a bake.
   *
   * `--no-lod` still refuses, and it is the flag to reach for on anything where the printed
   * triangle count comes out absurd for the model.
   */
  const lodIndex = args.indexOf('--lod');
  /*
   * A token beginning with `-` is the next flag, not a cell count.
   *
   * Reported from outside: `--lod -o out.drft` refused with `--lod wants a number of cells, got
   * "-o"`, so `--lod` silently had to be last. The message was right about what it read and gave
   * no hint that the position was the problem.
   */
  const lodArg = args[lodIndex + 1];
  const lodNamed = lodArg !== undefined && !lodArg.startsWith('-');
  const lodCells = args.includes('--no-lod')
    ? undefined
    : lodIndex === -1 || !lodNamed
      ? DEFAULT_COARSE_CELLS
      : Number(lodArg);
  if (lodCells !== undefined && !Number.isFinite(lodCells)) {
    console.error(`--lod wants a number of cells, got "${lodArg ?? ''}"`);
    process.exit(1);
  }

  /* Choosing the file, which for a bundle is the whole job. */
  let chosen: string;
  const stat = statSync(input);
  if (stat.isDirectory()) {
    const candidates = walk(input)
      .map((file) => ({ file, reader: readerFor(path.extname(file)) }))
      .filter(
        (entry): entry is { file: string; reader: (typeof READERS)[number] } =>
          entry.reader !== undefined,
      );
    if (candidates.length === 0) {
      console.error(
        `${input} — nothing readable here. Looked for: ${READERS.map((r) => r.ext).join(', ')}`,
      );
      /*
       * Before the generic advice, say something specific about what *is* in the folder.
       * A bundle whose only model is a Maya binary should be told which export works,
       * rather than being handed a list of extensions it does not contain.
       */
      let named = false;
      for (const file of walk(input)) {
        let head: Uint8Array;
        try {
          head = readFileSync(file);
        } catch {
          continue;
        }
        const foreign = recognise(head);
        if (foreign === null) continue;
        console.error(describeRecognised(foreign, path.basename(file)));
        named = true;
      }
      if (!named)
        console.error('If this bundle has a blend or an ma only, export glTF from it for now.');
      process.exit(1);
    }
    const found = [...new Set(candidates.map((c) => c.reader.ext.slice(1)))];
    console.log(`${input} — found ${found.join(', ')}`);

    const wanted =
      forced === null ? candidates : candidates.filter((c) => c.reader.ext === `.${forced}`);
    if (wanted.length === 0) {
      console.error(`--from ${forced}: no such file in this bundle`);
      process.exit(1);
    }
    wanted.sort(
      (a, b) =>
        a.reader.tier - b.reader.tier || READERS.indexOf(a.reader) - READERS.indexOf(b.reader),
    );
    const pick = wanted[0] as { file: string; reader: (typeof READERS)[number] };
    chosen = pick.file;
    const passed = found.filter((ext) => ext !== pick.reader.ext.slice(1));
    console.log(
      `Using ${path.relative(input, chosen)} — ${pick.reader.note} (tier ${pick.reader.tier})` +
        (passed.length === 0 ? '' : `. Passed over: ${passed.join(', ')}.`),
    );
  } else {
    chosen = input;
  }

  const {
    meshes: raw,
    warnings,
    notes,
    declaredUp,
    materials,
    substances,
    textures: textureRefs,
    unitScale,
    skins,
    clips,
    nodes,
  } = await loadModel(chosen);
  for (const note of notes) console.log(`  ${note}`);
  for (const warning of warnings) console.warn(`  warning: ${warning}`);
  const warned = warnings.length;

  /*
   * Weld, then drop what never varies. Importers emit one vertex per triangle corner
   * because the source formats index attributes separately, so a real model arrives
   * several times larger than it is — and an attribute holding one repeated number costs
   * four bytes a vertex to say nothing.
   */
  const before = raw.reduce((sum, mesh) => sum + mesh.positions.length / 3, 0);
  const welded = raw.map((mesh, at) =>
    dropDefaultAttributes(withTangentsIfMapped(weldMesh(mesh), materials?.[at])),
  );
  const after = welded.reduce((sum, mesh) => sum + mesh.positions.length / 3, 0);
  if (after < before) {
    console.log(
      `  welded ${before} corners to ${after} vertices (${(100 - (after / before) * 100).toFixed(0)}% fewer)`,
    );
  }

  /*
   * Stand it up. `--up` wins over what the file declared, because the reason to type it is
   * having looked at a model whose file was wrong — and when the two disagree, both are
   * printed, so an override is never mistaken for what the file said.
   *
   * After welding rather than before: the turn is rigid, so it cannot change which vertices
   * merge, and doing it here touches the deduplicated set rather than every corner.
   */
  const up = assetUp ?? declaredUp ?? null;
  const meshes = up === null || up === '+y' ? welded : orientMeshes(welded, up);
  if (assetUp !== null && declaredUp !== undefined && declaredUp !== assetUp) {
    console.log(`  the file declares up is ${declaredUp}; --up ${assetUp} overrides it`);
  }
  if (up !== null && up !== '+y') {
    const source = assetUp === null ? 'the file declares' : '--up';
    console.log(`  ${source} ${up}: ${describeUpAxis(up)}, into the engine's Y-up frame`);
  }
  /*
   * The hierarchy turns with the geometry. `orientMeshes` above rotates the meshes, and a graph
   * left unturned would claim every part is somewhere it no longer is — with both halves
   * individually well formed, so nothing downstream could detect the disagreement.
   */
  const turnedNodes = nodes === undefined || up === null ? nodes : orientNodes(nodes, up);
  if (turnedNodes !== undefined && turnedNodes.length > 0) {
    const transforms = turnedNodes.filter((node) => node.mesh < 0).length;
    console.log(
      `  hierarchy: ${turnedNodes.length} nodes, ${transforms} of them transforms only, ` +
        'written as NODE beside world-space meshes',
    );
  }
  warnIfUpsideDown(meshes);

  /* Textures last, because a reference is only worth resolving once the meshes that name
     it have survived the read. */
  const reached = reachableTextures(textureRefs ?? [], materials);
  reportDropped(reached.dropped);
  const embedded =
    reached.refs.length === 0
      ? []
      : embedTextures(
          reached.refs,
          chosen,
          stat.isDirectory() ? input : path.dirname(chosen),
          warnings,
        );
  for (const warning of warnings.slice(warned)) console.warn(`  warning: ${warning}`);

  /*
   * The outline, built from the meshes as they will be written rather than as they were read:
   * welded and stood the right way up, so it lands in the same frame as the model it stands for.
   *
   * A model whose geometry all collapses into one cell has no outline worth a chunk, and that is
   * a `null` rather than an empty mesh — see `buildCoarseLevel`. It is said out loud either way,
   * because a stage of the reveal silently not being in a file is exactly the kind of absence
   * nobody notices until they are watching a load and wondering why it starts on nothing.
   */
  const built = lodCells === undefined ? null : buildCoarseLevel(meshes, { cells: lodCells });
  /* An outline bigger than the model it stands for is not one: see `isOutlineWorthWriting`. */
  const lod = built !== null && isOutlineWorthWriting(built, meshes) ? built : null;
  if (lod !== null) {
    const lodTriangles = lod.indices.length / 3;
    const lodBytes =
      lod.positions.length * 4 * 3 + lod.emissive.length * 4 + lod.indices.length * 4;
    console.log(
      `  outline at ${lodCells ?? DEFAULT_COARSE_CELLS} cells: ${lod.positions.length / 3} vertices, ` +
        `${lodTriangles} triangles (${(lodBytes / 1024).toFixed(0)} KB), which is what arrives first. ` +
        `Look at it before shipping it.`,
    );
  } else if (built !== null) {
    console.log(
      `  no outline: the grid gives ${built.indices.length / 3} triangles for a model of ` +
        `${meshes.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0)}, so it would cost more than it saves`,
    );
  } else if (lodCells !== undefined) {
    console.log(
      '  no outline: this asset has no extent to lay a grid over, so the parts arrive first',
    );
  } else {
    console.log('  no outline: --no-lod, so a load of this file opens on an empty stage');
  }

  /*
   * Discrete levels of detail, where a bundle ships them as sibling files.
   *
   * **Each is baked whole and nested, not merged into `LODM`.** A hand-authored level is a
   * complete model with its own materials and hierarchy; `LODM` holds one merged, material-less
   * outline for a progressive load. Folding one into the other would discard every material the
   * level carries, which is the opposite of why a source ships four of them.
   */
  const siblings = readdirSync(path.dirname(chosen));
  const levelFiles = args.includes('--no-levels')
    ? []
    : levelsBeside(path.basename(chosen), siblings);
  const levels: Uint8Array[] = [];
  for (const name of levelFiles) {
    const full = path.join(path.dirname(chosen), name);
    const level = await loadModel(full);
    /* The same order as level 0 above: weld, then derive for the materials that sample one. */
    const levelMeshes = level.meshes.map((mesh, at) =>
      dropDefaultAttributes(withTangentsIfMapped(weldMesh(mesh), level.materials?.[at])),
    );
    const oriented = up === null || up === '+y' ? levelMeshes : orientMeshes(levelMeshes, up);
    /*
     * A level carries its own textures, and it has to: `DrftMaterial.albedo` is an ordinal into
     * the asset's own texture list, so a nested file whose materials point at level 0's images is
     * not a valid asset and `readDrft` refuses it — correctly. That is what makes a level
     * independently openable, and it is the cost `--no-levels` exists to decline.
     */
    const levelReached = reachableTextures(level.textures ?? [], level.materials);
    reportDropped(levelReached.dropped);
    const levelTextures =
      levelReached.refs.length === 0
        ? []
        : embedTextures(levelReached.refs, full, path.dirname(full), warnings);
    levels.push(
      new Uint8Array(
        writeDrft({
          meshes: oriented,
          head: { name: path.basename(name, path.extname(name)), generator: 'drft bake' },
          ...(levelTextures.length === 0 ? {} : { textures: levelTextures }),
          ...(levelReached.materials === undefined
            ? {}
            : { materials: [...levelReached.materials] }),
          ...(level.nodes === undefined || level.nodes.length === 0
            ? {}
            : { nodes: up === null ? level.nodes : orientNodes(level.nodes, up) }),
        }),
      ),
    );
    console.log(
      `  level ${levels.length}: ${name}, ${oriented.length} meshes, ` +
        `${level.materials?.length ?? 0} materials, ${(levels[levels.length - 1]!.length / 1024 / 1024).toFixed(1)} MB`,
    );
  }
  /*
   * **`--collider` decides what the file collides as, and `none` is the default.**
   *
   * `box` is the asset's own bounds as one hull, which costs nothing and is what a great many props
   * actually want. `hull[:N]` decomposes the geometry with `decomposeConvex`, at most N parts.
   *
   * **A vehicle folder's `collider.kn5` is preferred over the model's own geometry**, and that is
   * the whole point of finding it: an artist who shipped a collision mesh meant that mesh to be the
   * collision, and it is a fraction of the triangles. This printed a line telling the operator to
   * bake it separately for as long as `COLL` had no payload to put it in; it has one at 1.12.
   */
  const colliderMode = colliderFlag(args);
  let colliders: Float32Array[] | undefined;
  if (colliderMode.kind !== 'none') {
    const hull = colliderBeside(siblings);
    let source = { positions: collisionPositions(meshes), indices: collisionIndices(meshes) };
    if (hull !== null) {
      const beside = await readModel({
        name: hull,
        bytes: new Uint8Array(await readFile(path.join(path.dirname(chosen), hull))),
      });
      const besideMeshes = up === null ? beside.meshes : orientMeshes(beside.meshes, up);
      source = {
        positions: collisionPositions(besideMeshes),
        indices: collisionIndices(besideMeshes),
      };
      console.log(`  collider: ${hull}, ${besideMeshes.length} meshes — baked into this file`);
    }
    if (colliderMode.kind === 'box') {
      colliders = [boundsHull(source.positions)];
      console.log('  collider: the asset bounds, as one hull');
    } else {
      const decomposed = decomposeConvex(source.positions, source.indices, {
        maxHulls: colliderMode.maxHulls,
      });
      colliders = decomposed.parts.map((part) => part.points);
      console.log(
        `  collider: ${colliders.length} hulls, ` +
          `${(decomposed.bloat * 100).toFixed(1)}% over the source by volume, ` +
          `${(decomposed.coverage * 100).toFixed(1)}% of it covered`,
      );
    }
  } else if (colliderBeside(siblings) !== null) {
    console.log(
      `  collider: ${colliderBeside(siblings)} found and not baked — pass --collider hull to carry it`,
    );
  }

  const output =
    outIndex === -1
      ? `${path.basename(chosen, path.extname(chosen))}.drft`
      : (args[outIndex + 1] as string);
  const buffer = writeDrft({
    meshes,
    ...(lod === null ? {} : { lods: [lod] }),
    head: {
      name: path.basename(chosen, path.extname(chosen)),
      generator: 'drft bake',
      ...(unitScale === undefined ? {} : { unitScale }),
    },
    ...(reached.materials === undefined ? {} : { materials: [...reached.materials] }),
    /*
     * The substance labels an artist put on their glTF materials, as `SUBS` at 1.8.
     *
     * Spread conditionally like every optional field beside it, so a model with no labels writes
     * exactly the bytes it always did — which is what keeps `bake:check` meaningful and what makes
     * 1.8 additive in practice rather than only on paper.
     */
    ...(substances === undefined || substances.length === 0 ? {} : { substances }),
    ...(colliders === undefined || colliders.length === 0 ? {} : { colliders }),
    /*
     * The rig, where the source carried one. Spread conditionally like every optional field beside
     * it, so a static model writes the same bytes it always did — which is what keeps `bake:check`
     * meaningful and what makes 1.6 additive in practice rather than only on paper.
     */
    ...(skins === undefined || skins.length === 0 ? {} : { skins }),
    ...(clips === undefined || clips.length === 0 ? {} : { clips }),
    /*
     * The asset's own hierarchy, where the reader found one, as `NODE`.
     *
     * **Written beside world-space meshes and never instead of them.** §4.4 rule 4 forbids
     * changing what an existing byte means, so the geometry above is the same geometry it has
     * always been and this chunk is additive: a reader that predates it skips it under rule 2 and
     * opens the file as the static model it also is. A reader that knows it calls `localiseNodes`
     * and gets parts it can move. Spread conditionally like every optional field beside it, so a
     * format carrying no hierarchy writes exactly the bytes it always did.
     */
    ...(turnedNodes === undefined || turnedNodes.length === 0 ? {} : { nodes: turnedNodes }),
    ...(levels.length === 0 ? {} : { levels }),
    ...(embedded.length === 0 ? {} : { textures: embedded }),
  });
  writeFileSync(output, Buffer.from(buffer));

  const vertices = meshes.reduce((sum, mesh) => sum + mesh.positions.length / 3, 0);
  const triangles = meshes.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0);
  console.log(
    `${meshes.length} mesh${meshes.length === 1 ? '' : 'es'}, ${vertices} vertices, ` +
      `${triangles} triangles → ${output} (${(buffer.byteLength / 1024).toFixed(1)} KB)`,
  );
}

main().catch((error: unknown) => {
  /* A refusal is the designed outcome for a file that cannot be read, so it prints as one
     line rather than a stack — the message already names what was not understood. */
  console.error(error instanceof DrftError ? error.message : error);
  process.exit(1);
});

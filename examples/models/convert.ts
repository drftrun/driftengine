/**
 * A model file in, a `.drft` container out, off the main thread.
 *
 * Reading a source format is not free: a large model takes seconds to parse and weld, which on the
 * page's own thread is a freeze. So the page posts the file's bytes here and gets back one buffer,
 * a container `DrftLoader` streams exactly as it would stream a baked file from a server. The
 * baker does the same steps offline, and for anything shipped it is the better answer: a baked
 * file needs none of this work at load.
 */
import { writeDrft } from '@driftengine/drft';
import type { DrftMaterial } from '@driftengine/drft';
import {
  DEFAULT_COARSE_CELLS,
  assetCandidates,
  basenameOf,
  browserInflate,
  browserInflateRaw,
  buildCoarseLevel,
  describeImage,
  dropDefaultAttributes,
  extensionOf,
  isOutlineWorthWriting,
  orientMeshes,
  prepareFbxInflate,
  prepareZipInflate,
  readModel,
  weldMesh,
} from '@driftengine/assets';

/**
 * What the page sends: a file's name and bytes, and where to find files the model names beside
 * it, an `.obj`'s `.mtl` or a `.gltf`'s pictures: a folder to fetch from, or the other files that
 * were dropped with it. What comes back: a container, or why not.
 */
export interface ConvertRequest {
  readonly name: string;
  readonly bytes: ArrayBuffer;
  readonly folder?: string;
  readonly dropped?: Readonly<Record<string, ArrayBuffer>>;
}
export type ConvertReply =
  | { readonly ok: true; readonly drft: ArrayBuffer; readonly meshes: number; readonly ms: number }
  | { readonly ok: false; readonly reason: string };

/**
 * A compressed `.blend`: gzip, which Blender wrote up to 2.9, is the browser's own; zstd, which it
 * writes from 3.0, is not a browser format, so such a file is refused with what to do instead.
 */
async function unpack(compressed: Uint8Array, codec: 'gzip' | 'zstd'): Promise<Uint8Array> {
  if (codec === 'zstd') {
    throw new Error(
      'this .blend is saved with zstd, which a browser cannot decompress: save it uncompressed, or bake it',
    );
  }
  const stream = new Blob([compressed.slice()])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// #region convert
async function convert({ name, bytes, folder, dropped }: ConvertRequest): Promise<ConvertReply> {
  const started = performance.now();
  const file = new Uint8Array(bytes);
  /* A file the model names, by the places it could be: the engine says what to look for. */
  const beside = async (named: string): Promise<Uint8Array | null> => {
    for (const candidate of assetCandidates(named)) {
      const own = dropped?.[basenameOf(candidate)];
      if (own !== undefined) return new Uint8Array(own);
      if (folder === undefined) continue;
      const found = await fetch(new URL(candidate, folder));
      if (found.ok) return new Uint8Array(await found.arrayBuffer());
    }
    return null;
  };
  /* The two zipped or deflated formats need their decompressor ready before the parse. */
  const ext = extensionOf(name);
  const inflate = ext === '.fbx' ? await prepareFbxInflate(bytes, browserInflate) : undefined;
  const inflateRaw = ext === '.3mf' ? await prepareZipInflate(bytes, browserInflateRaw) : undefined;
  const imported = await readModel({
    name,
    bytes: file,
    beside,
    decompress: unpack,
    ...(inflate === undefined ? {} : { inflate }),
    ...(inflateRaw === undefined ? {} : { inflateRaw }),
  });

  /* Y up, one vertex per distinct corner, and no attribute every vertex holds the same value of. */
  const up = imported.declaredUp;
  const oriented = up === undefined ? imported.meshes : orientMeshes(imported.meshes, up);
  const meshes = oriented.map((mesh) => dropDefaultAttributes(weldMesh(mesh)));

  /* The pictures the model carries or names, by what their own bytes say they are. A picture
     that cannot be found is left out, and the surfaces that wear it draw untextured. */
  const textures = [];
  for (const reference of imported.textures ?? []) {
    const image = reference.bytes ?? (await beside(reference.name));
    if (image === null) continue;
    const info = describeImage(image);
    textures.push({
      name: reference.name,
      codec: info.codec,
      width: info.width,
      height: info.height,
      bytes: image,
    });
  }

  /* A coarse outline of the whole model, drawn while the rest arrives, where one is worth it. */
  const outline = buildCoarseLevel(meshes, { cells: DEFAULT_COARSE_CELLS });
  const drft = writeDrft({
    meshes,
    ...(outline !== null && isOutlineWorthWriting(outline, meshes) ? { lods: [outline] } : {}),
    ...(imported.materials === undefined
      ? {}
      : { materials: imported.materials as DrftMaterial[] }),
    ...(textures.length === 0 ? {} : { textures }),
  });
  return { ok: true, drft, meshes: meshes.length, ms: performance.now() - started };
}
// #endregion

self.onmessage = (event: MessageEvent<ConvertRequest>): void => {
  convert(event.data).then(
    (reply) => {
      if (reply.ok) self.postMessage(reply, { transfer: [reply.drft] });
    },
    (error: unknown) => {
      self.postMessage({
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      });
    },
  );
};

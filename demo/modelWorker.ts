/**
 * Reading a source format off the main thread, and handing back a `.drft`.
 *
 * **Why a conversion rather than a second loader.** `DrftLoader` already owns everything that
 * happens after the first byte: the stream, a bounded amount of uploading per frame, a fade per
 * part, and the merge down to one draw per material. None of that is about which format the
 * bytes started in, so a scene that read a `.glb` directly would need a second copy of all of
 * it, kept in step with the first by hand. Writing a container here instead means a `.glb`, an
 * `.obj` and a `.fbx` all reach the screen through the exact path a `.drft` does, and the
 * reveal a viewer watches is the same one.
 *
 * **Why a worker.** docs/FORMAT.md §3.3 states the rule and the measurement behind it: a 52 MB
 * car is about 1.6 s to parse and several more to weld. On the main thread that is a freeze
 * rather than a hitch, so the parse never runs there. The page keeps drawing at its own rate
 * throughout, and the only thing that crosses back is one transferable buffer.
 *
 * **A bake is still the better answer for anything shipped**, and this does not replace it.
 * Zero-copy is given up the moment a source format is parsed into fresh arrays, and the memory
 * cost is paid in full: the same car is 52 MB on disk and about 226 MB unwelded. What this buys
 * is that a file dropped beside a page is looked at without a tool being run first.
 */

import type { MeshData } from '../packages/core/src/index';
import type { ModelProgress, ModelReply, ModelRequest } from './modelFormats';
import { CODEC_RAW, writeDrft } from '@driftengine/drft';
import type { DrftMaterial, DrftTextureSource } from '@driftengine/drft';
import {
  DEFAULT_COARSE_CELLS,
  assetCandidates,
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
  readZip,
  weldMesh,
} from '@driftengine/assets';
import type { Inflate } from '@driftengine/assets';

/** Keeps a missing image's ordinal meaning what it meant. See the loop that uses it. */
const WHITE_PIXEL = new Uint8Array([255, 255, 255, 255]);

/** Fetch a file named beside a model, or null. Shared by the sidecars and the textures. */
async function beside(modelUrl: string, relative: string): Promise<Uint8Array | null> {
  const base = modelUrl.slice(0, modelUrl.lastIndexOf('/') + 1);
  const found = await fetch(base + relative.replace(/\\/g, '/').replace(/^\/+/, ''), {
    cache: 'no-store',
  });
  return found.ok ? new Uint8Array(await found.arrayBuffer()) : null;
}

/**
 * Find an image a model named, over the network, by trying the places it could be.
 *
 * **A model almost never states a path that resolves where it ends up.** The declared name is
 * whatever was true on the machine that exported it, so a real asset says things like
 * `C:\Users\...\Desktop\formula 1\Substance SpecGloss\Right ones\body_Diffuse.png` for a file
 * that now sits in `textures/` beside the model. Asking for the declared string alone finds
 * nothing and the surface draws untextured, which reads as a missing feature rather than as a
 * file that moved.
 *
 * `assetCandidates` is the engine's answer to that and it is used here unchanged: the declared
 * path with any drive letter and root removed, then the bare filename beside the model, then
 * the handful of conventional folders. The engine says what to look for and this says where to
 * look, which is the same split the baker makes with a directory instead of a URL.
 */
async function findTexture(modelUrl: string, declared: string): Promise<Uint8Array | null> {
  for (const candidate of assetCandidates(declared)) {
    const found = await beside(modelUrl, candidate);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Download the body while saying how much of it has arrived.
 *
 * `arrayBuffer()` is one await that reports nothing, and on a twenty megabyte model that is most
 * of the wait spent behind a bar that cannot move. Reading the stream costs one concatenation at
 * the end and buys a figure that is true rather than interpolated.
 *
 * `Content-Length` is absent often enough to plan for, so a caller is told 0 and has to show that
 * as an unknown size rather than as a complete one.
 */
async function download(
  response: Response,
  report: (p: ModelProgress) => void,
): Promise<Uint8Array> {
  const total = Number(response.headers.get('content-length') ?? 0);
  const body = response.body;
  if (body === null) return new Uint8Array(await response.arrayBuffer());
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    received += value.length;
    report({ stage: 'downloading', received, total });
  }
  const out = new Uint8Array(received);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Read one model at a URL and write it into a container. */
export async function convert(
  request: ModelRequest,
  report: (p: ModelProgress) => void = () => {},
): Promise<ArrayBuffer & { notes?: never }> {
  const { url } = request;
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`no model at ${url}`);
  /*
   * The same guard `DrftLoader` makes, for the same reason and one level down. A host answering
   * an unknown path with its own page under a 200 hands a reader a document, and every reader
   * then complains about the bytes rather than about the missing file: the OBJ reader's honest
   * "no vertices" is what an HTML page looks like to it.
   */
  if ((response.headers.get('content-type') ?? '').toLowerCase().startsWith('text/html')) {
    throw new Error(`${url} is a page, not a model`);
  }
  const bytes = await download(response, report);
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const ext = extensionOf(url);
  report({ stage: 'reading', received: bytes.length, total: bytes.length });

  /*
   * The two compressed containers need their decompressor prepared before the parse, because the
   * parse is synchronous and a browser's is not. Prepared only for the format that wants one, so
   * a `.glb` never pays for a walk it has no use for.
   */
  const inflate = ext === '.fbx' ? await prepareFbxInflate(buffer, browserInflate) : undefined;
  const inflateRaw =
    ext === '.3mf' ? await prepareZipInflate(buffer, browserInflateRaw) : undefined;

  const imported = await readModel({
    name: url.slice(url.lastIndexOf('/') + 1),
    bytes,
    /*
     * A `.gltf`'s external buffers and an `.obj`'s `.mtl` are named *inside* the model, relative
     * to it. Resolved against the model's own directory and nowhere else: the name came from the
     * file rather than from the page, so it does not get to reach outside where the model lives.
     */
    beside: (relative) => beside(url, relative),
    ...(inflate === undefined ? {} : { inflate }),
    ...(inflateRaw === undefined ? {} : { inflateRaw }),
  });

  /*
   * Oriented, welded and stripped of constant attributes, which is exactly what the baker does
   * and for the same reasons. An importer emits one vertex per triangle corner, so skipping the
   * weld would upload roughly six times the geometry the model actually has.
   */
  report({ stage: 'building', received: 0, total: 0 });
  const up = request.up ?? imported.declaredUp;
  const oriented = up === undefined ? imported.meshes : orientMeshes(imported.meshes, up);

  /*
   * Leave out the geometry the caller said is not part of the subject, before anything measures
   * the model.
   *
   * The order matters and is the whole reason this happens here rather than at draw time. A
   * container's `HEAD` carries the bounds, `writeDrft` computes them from the meshes it is
   * given, and the loader fits the model to a scene using them. So a backdrop plane and two
   * studio lights left in an export do not merely draw: they widen the box everything else is
   * scaled against, and the subject arrives correctly fitted to a bounding volume that is
   * mostly empty air. Measured on one asset here: 606 x 288 x 791 with them, 204 x 124 x 442
   * without, so the car came out at a fraction of its size and nothing about the geometry was
   * wrong.
   *
   * Materials pair with meshes by ordinal, so both are filtered together or every surface after
   * the first drop wears the wrong paint.
   */
  const excluded = new Set(request.exclude ?? []);
  const materials = imported.materials;
  const keep: number[] = [];
  for (let i = 0; i < oriented.length; i++) {
    if (excluded.has(materials?.[i]?.name ?? '')) continue;
    keep.push(i);
  }
  if (keep.length === 0) throw new Error(`every mesh in ${url} was excluded`);
  const meshes = keep.map((i) => dropDefaultAttributes(weldMesh(oriented[i] as MeshData)));
  const kept = materials === undefined ? undefined : keep.map((i) => materials[i] as DrftMaterial);

  /*
   * The images the model named, carried across rather than dropped.
   *
   * A glTF keeps them inside its binary chunk or in a data URI, which is the case that matters
   * here: those arrive with bytes already in hand and need no lookup. One that points at a file
   * beside the model is fetched the same way the sidecars above are. A reference that resolves
   * to nothing keeps its place with a white pixel, because dropping the entry would renumber
   * every texture after it and repaint the model.
   */
  const textures: DrftTextureSource[] = [];
  for (const reference of imported.textures ?? []) {
    const image = reference.bytes ?? (await findTexture(url, reference.name));
    if (image === null) {
      textures.push({
        name: reference.name,
        codec: CODEC_RAW,
        width: 1,
        height: 1,
        bytes: WHITE_PIXEL,
      });
      continue;
    }
    try {
      const info = describeImage(image);
      textures.push({
        name: reference.name,
        codec: info.codec,
        width: info.width,
        height: info.height,
        bytes: image,
      });
    } catch {
      textures.push({
        name: reference.name,
        codec: CODEC_RAW,
        width: 1,
        height: 1,
        bytes: WHITE_PIXEL,
      });
    }
  }

  report({ stage: 'packing', received: 0, total: 0 });
  /*
   * An outline, unless the caller refused one, so a converted source format reveals as a
   * container does — that sentence is what this file exists for, and it would stop being true if
   * a `.drft` opened on an outline and an `.fbx` could not.
   *
   * The default matches the baker's, which is the property that matters: the same model, taken
   * through the two paths this engine offers, has to arrive the same. See `ModelRequest.outline`.
   * It costs about four hundred milliseconds on the 187-mesh car, measured, on a thread nothing
   * else is waiting on.
   */
  const built =
    request.outline === false
      ? null
      : buildCoarseLevel(meshes, { cells: request.outline ?? DEFAULT_COARSE_CELLS });
  /* The same budget the baker applies, from the same function, so a model converted here and the
     same model baked offline carry the same answer. See `isOutlineWorthWriting`. */
  const lod = built !== null && isOutlineWorthWriting(built, meshes) ? built : null;
  return writeDrft({
    meshes,
    ...(lod === null ? {} : { lods: [lod] }),
    ...(kept === undefined ? {} : { materials: kept }),
    ...(textures.length === 0 ? {} : { textures }),
  }) as ArrayBuffer & { notes?: never };
}

/*
 * The worker entry point.
 *
 * Guarded on the *absence of a document*, which is the only reliable way to ask this. The obvious
 * check, whether `self` has an `onmessage`, is true on a main thread as well, because there `self`
 * is `window`: a page importing this module for one constant would install this handler on
 * itself and then answer every unrelated message event, including a dev server's hot updates.
 * That is not hypothetical, and `modelFormats.ts` exists so nothing needs to import this at all.
 */
if (typeof window === 'undefined' && typeof self !== 'undefined') {
  self.onmessage = (event: MessageEvent<ModelRequest>): void => {
    const post = (message: ModelReply, transfer: Transferable[] = []): void => {
      (self as unknown as Worker).postMessage(message, transfer);
    };
    void convert(event.data, (progress) => post({ progress }))
      .then((drft) => {
        post({ ok: true, drft }, [drft]);
      })
      .catch((error: unknown) => {
        post({ ok: false, message: error instanceof Error ? error.message : String(error) });
      });
  };
}

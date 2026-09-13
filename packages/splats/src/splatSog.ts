/**
 * The `.sog` reader: a ZIP of lossless WebP images and a manifest that says what each channel is.
 *
 * **SOG is a container, and the name is shared with the technique it grew out of.** The row that
 * asked for this pointed at `fraunhoferhhi/Self-Organizing-Gaussians`, which is the ECCV 2024 paper
 * that sorts Gaussian parameters into a 2D grid so that ordinary image compression can carry them.
 * That paper ships pre-trained scenes and a script that decompresses them to `.ply`, and documents
 * no on-disk `.sog` structure at all. What capture tools emit is the container specified by
 * PlayCanvas and open-sourced with `splat-transform`, and this file reads *that*: version 2, a
 * `meta.json` naming its images, and a fixed encoding per property.
 *
 * A reader built against the paper would decode something no tool produces. The distinction is
 * recorded here because it cost an afternoon to find and the next person should start with it.
 *
 * ## Two capabilities this cannot supply itself
 *
 * **WebP decode**, which is `WebpDecoder` below and is a parameter rather than a dependency. Every
 * browser has a decoder; Node has none, and the alternative to asking for one is a WebP decoder in
 * this package, which is `AGENTS.md`'s "do not add dependencies" arriving as a thousand lines of
 * vendored VP8L instead. `browserWebpDecoder` is the ordinary implementation, exactly as
 * `BrowserStore` is for `KeyValueStore` — and it forwards to core rather than reaching for a
 * canvas, for a measured reason its own note carries.
 *
 * **Inflate**, if a producer ever deflates. `splat-transform` 3.3.3 stores every entry
 * uncompressed — the images are already compressed and a second pass buys nothing — so the common
 * path needs no inflate at all, and `DecompressionStream` covers the other one. It is in every
 * browser and in Node 18, which is under this engine's floor.
 */

import { SPLAT_SH1_COEFFICIENTS, packSplats } from './splatData.ts';
import type { SplatData, SplatSource } from './splatData.ts';

/**
 * The band-0 constant, `0.5 * sqrt(1 / pi)`.
 *
 * The same number `splatPly.ts` carries and for the same reason: a capture stores colour as the DC
 * term of a spherical-harmonic expansion, which is signed radiance rather than a colour, and
 * `0.5 + C0 * dc` is the conversion. Duplicated rather than shared because each reader states the
 * encoding it is undoing, and this one undoes a codebook lookup first.
 */
const SH_C0 = 0.28209479177387814;

/** The container version this reader understands. */
export const SOG_VERSION = 2;

/** What a `.sog` manifest declares. Field names are the file's, not this engine's. */
export interface SogMeta {
  readonly version: number;
  readonly count: number;
  readonly asset?: { readonly generator?: string };
  readonly antialias?: boolean;
  readonly means: {
    readonly mins: readonly number[];
    readonly maxs: readonly number[];
    readonly files: readonly string[];
  };
  readonly scales: { readonly codebook: readonly number[]; readonly files: readonly string[] };
  readonly quats: { readonly files: readonly string[] };
  readonly sh0: { readonly codebook: readonly number[]; readonly files: readonly string[] };
  /** Absent where the capture carries no bands past the DC term, which is the common case. */
  readonly shN?: {
    readonly count: number;
    readonly bands: number;
    readonly codebook: readonly number[];
    readonly files: readonly string[];
  };
}

/** One decoded image: 8-bit RGBA, row-major from the top left, four bytes a texel. */
export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array | Uint8ClampedArray;
}

/** What turns a WebP file's bytes into texels. See this file's header for why it is a parameter. */
export type WebpDecoder = (bytes: Uint8Array) => Promise<DecodedImage>;

/* ------------------------------------------------------------------ the zip */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
/** The end-of-central-directory record with no comment. A comment may follow, up to 65535 bytes. */
const EOCD_BYTES = 22;

/**
 * Unpack a bundled `.sog`, which is a ZIP with every file at the root.
 *
 * **Read through the central directory and never through the local headers**, and that is not
 * defensive: `splat-transform` writes its entries streaming, so bit 3 of the general-purpose flags
 * is set and every local header carries a compressed size of *zero* with the real sizes in a data
 * descriptor after the payload. A reader that trusted the local header would extract nothing from
 * every file a capture tool has produced. Measured on a file that tool wrote: flags `0x808`, sizes
 * zero in the local header and correct in the central directory.
 *
 * Only the two methods the format can produce: stored, which is what `splat-transform` writes
 * because the images are already compressed, and deflate, through `DecompressionStream`.
 */
export async function unbundleSog(bundle: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bundle);
  const bytes = new Uint8Array(bundle);

  let eocd = -1;
  const earliest = Math.max(0, bundle.byteLength - EOCD_BYTES - 0xffff);
  for (let at = bundle.byteLength - EOCD_BYTES; at >= earliest; at--) {
    if (view.getUint32(at, true) === EOCD_SIGNATURE) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error(
      'splatSog: this is not a bundled `.sog`. A bundle is a ZIP and no end-of-central-directory ' +
        'record was found — an unbundled capture is a `meta.json` beside its images, which ' +
        '`readSplatSog` takes directly.',
    );
  }

  const entries = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const files = new Map<string, Uint8Array>();

  for (let i = 0; i < entries; i++) {
    if (view.getUint32(at, true) !== CENTRAL_SIGNATURE) {
      throw new Error(`splatSog: the central directory entry ${i} is not one.`);
    }
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const uncompressed = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;

    /* The local header's own name and extra lengths, which are the only two of its fields a
       streaming writer fills in truthfully. Everything else comes from the directory above. */
    const localName = view.getUint16(localAt + 26, true);
    const localExtra = view.getUint16(localAt + 28, true);
    const from = localAt + 30 + localName + localExtra;
    const payload = bytes.subarray(from, from + compressed);

    if (method === 0) {
      files.set(name, payload);
    } else if (method === 8) {
      files.set(name, await inflateRaw(payload, uncompressed));
    } else {
      throw new Error(
        `splatSog: \`${name}\` uses ZIP method ${method}, which is neither stored nor deflate.`,
      );
    }
  }
  return files;
}

async function inflateRaw(payload: Uint8Array, expected: number): Promise<Uint8Array> {
  const stream = new Blob([payload as unknown as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  if (expected !== 0 && out.byteLength !== expected) {
    throw new Error(
      `splatSog: an entry inflated to ${out.byteLength} bytes where the directory says ${expected}.`,
    );
  }
  return out;
}

/* ------------------------------------------------------------- the manifest */

/** Parse and check a `meta.json`. Refuses a version it does not understand rather than guessing. */
export function readSogMeta(bytes: Uint8Array | string): SogMeta {
  const text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
  const meta = JSON.parse(text) as SogMeta;
  if (meta.version !== SOG_VERSION) {
    throw new Error(
      `splatSog: this manifest declares version ${String(meta.version)} and this reader ` +
        `implements ${SOG_VERSION}. The encodings are versioned, so reading it anyway would ` +
        'produce a plausible cloud rather than an error.',
    );
  }
  if (!Number.isFinite(meta.count) || meta.count <= 0) {
    throw new Error('splatSog: the manifest declares no `count`.');
  }
  for (const name of ['means', 'scales', 'quats', 'sh0'] as const) {
    if (meta[name] === undefined)
      throw new Error(`splatSog: the manifest declares no \`${name}\`.`);
  }
  return meta;
}

/* --------------------------------------------------------- the dequantisers */

/**
 * A position's own inverse, and it is not the obvious one.
 *
 * **Positions are stored in a signed logarithmic domain**, so that a capture's dense middle gets
 * the resolution and its far outliers do not spend it: what is quantised is
 * `sign(x) * log(1 + |x|)`, and `mins`/`maxs` in the manifest are in *that* domain rather than in
 * metres. Read as metres they are wrong by an exponential, which does not look like an error — it
 * looks like a cloud that has been squashed toward its own centre.
 */
function unlog(n: number): number {
  return Math.sign(n) * (Math.exp(Math.abs(n)) - 1);
}

/**
 * The smallest-three quaternion, whose fourth component the file does not store.
 *
 * Three components quantised into `[-sqrt(2)/2, +sqrt(2)/2]` and an alpha of 252 to 255 saying
 * which one was dropped — it is always the largest, so the reconstructed one is non-negative and
 * the sign is not ambiguous. The order the three are read back into is the *rotation* of the
 * component list past the dropped one, which is what makes 252 mean w and 255 mean z.
 */
const QUAT_SCALE = Math.SQRT2;

function unpackQuaternion(
  r: number,
  g: number,
  b: number,
  mode: number,
  out: Float32Array,
  at: number,
): void {
  const a = (r / 255 - 0.5) * QUAT_SCALE;
  const c = (g / 255 - 0.5) * QUAT_SCALE;
  const d = (b / 255 - 0.5) * QUAT_SCALE;
  const largest = Math.sqrt(Math.max(0, 1 - a * a - c * c - d * d));
  /* wxyz as the file thinks of it, with the dropped component put back where it belongs. */
  const wxyz = [0, 0, 0, 0];
  const dropped = mode - 252;
  const rest = [a, c, d];
  let k = 0;
  for (let i = 0; i < 4; i++) wxyz[i] = i === dropped ? largest : (rest[k++] ?? 0);
  /* And out as xyzw, which is what `SplatSource` takes. See its own note on the two conventions. */
  out[at] = wxyz[1] ?? 0;
  out[at + 1] = wxyz[2] ?? 0;
  out[at + 2] = wxyz[3] ?? 0;
  out[at + 3] = wxyz[0] ?? 0;
}

/* ------------------------------------------------------------- the reader */

/** The files a capture is made of, by the names its manifest gives them. */
export type SogFiles = ReadonlyMap<string, Uint8Array>;

/**
 * Read a `.sog` capture into a `SplatSource`.
 *
 * `files` is what `unbundleSog` returns for a bundle, or the files of an unbundled capture keyed by
 * the names its `meta.json` uses. `decode` turns one WebP into texels; see `browserWebpDecoder`.
 *
 * **Every per-Gaussian property is co-located**: the texel at `(x, y)` means the same Gaussian in
 * every image, and the Gaussians run row-major from the top left. So one index walks all of them,
 * which is the property that makes this reader a single loop and is also the property a reader that
 * transposed one image would break silently.
 */
export async function readSplatSog(files: SogFiles, decode: WebpDecoder): Promise<SplatData> {
  return packSplats(await readSogSource(files, decode));
}

/**
 * The same read, stopping one step short: the linear values, before they are packed for the GPU.
 *
 * **Exported because the packing is lossy and a check has to see what was decoded**, not what
 * survived a half-float. `splatSog.test.ts` compares sixty-four Gaussians against the `.ply` they
 * were encoded from and needs metres and quaternions to do it; a consumer transforming a capture
 * before it is uploaded wants the same thing, which is why this is public rather than internal.
 */
export async function readSogSource(files: SogFiles, decode: WebpDecoder): Promise<SplatSource> {
  const metaBytes = files.get('meta.json');
  if (metaBytes === undefined) throw new Error('splatSog: the capture has no `meta.json`.');
  const meta = readSogMeta(metaBytes);

  const image = async (name: string): Promise<DecodedImage> => {
    const bytes = files.get(name);
    if (bytes === undefined) {
      throw new Error(
        `splatSog: the manifest names \`${name}\` and the capture does not carry it. ` +
          `It carries: ${[...files.keys()].join(', ')}`,
      );
    }
    return decode(bytes);
  };

  const [meansLow, meansHigh, scales, quats, sh0] = await Promise.all([
    image(meta.means.files[0] ?? 'means_l.webp'),
    image(meta.means.files[1] ?? 'means_u.webp'),
    image(meta.scales.files[0] ?? 'scales.webp'),
    image(meta.quats.files[0] ?? 'quats.webp'),
    image(meta.sh0.files[0] ?? 'sh0.webp'),
  ]);

  const count = meta.count;
  const positions = new Float32Array(count * 3);
  const scaleOut = new Float32Array(count * 3);
  const rotations = new Float32Array(count * 4);
  const colors = new Float32Array(count * 3);
  const opacities = new Float32Array(count);

  const scaleBook = meta.scales.codebook;
  const colourBook = meta.sh0.codebook;
  const mins = meta.means.mins;
  const maxs = meta.means.maxs;

  for (let i = 0; i < count; i++) {
    const t = i * 4;
    for (let axis = 0; axis < 3; axis++) {
      /* Sixteen bits per axis, split across two images: the low byte and the high one. */
      const q = ((meansHigh.rgba[t + axis] ?? 0) << 8) | (meansLow.rgba[t + axis] ?? 0);
      const lo = mins[axis] ?? 0;
      const hi = maxs[axis] ?? 0;
      positions[i * 3 + axis] = unlog(lo + (hi - lo) * (q / 65535));
      /* The codebook is in the log domain, exactly as a `.ply`'s `scale_n` is. */
      scaleOut[i * 3 + axis] = Math.exp(scaleBook[scales.rgba[t + axis] ?? 0] ?? 0);
      /* And the colour's codebook is a DC coefficient, so it takes the band constant. */
      colors[i * 3 + axis] = 0.5 + (colourBook[sh0.rgba[t + axis] ?? 0] ?? 0) * SH_C0;
    }
    unpackQuaternion(
      quats.rgba[t] ?? 0,
      quats.rgba[t + 1] ?? 0,
      quats.rgba[t + 2] ?? 0,
      quats.rgba[t + 3] ?? 252,
      rotations,
      i * 4,
    );
    /* Opacity is linear in alpha here, where a `.ply` stores its logit. */
    opacities[i] = (sh0.rgba[t + 3] ?? 0) / 255;
  }

  const source: SplatSource = { count, positions, scales: scaleOut, rotations, colors, opacities };
  const sh1 = await readSh1(meta, image, count);
  return sh1 === null ? source : { ...source, sh1 };
}

/**
 * The l=1 band, out of the palette the container stores it in, or null where there is none.
 *
 * **A capture's higher bands are a palette and an index per Gaussian**, not a value per Gaussian:
 * `shN_labels` is a sixteen-bit index into `shN_centroids`, whose rows hold 64 palette entries and
 * whose width is the band count times three. Only the l=1 coefficients are read, because that is
 * what `SplatSource.sh1` carries and what this engine's shader evaluates — degrees 2 and 3 are
 * declined against a measured bandwidth figure, which `docs/IMPROVEMENTS.md` records with its
 * number.
 */
async function readSh1(
  meta: SogMeta,
  image: (name: string) => Promise<DecodedImage>,
  count: number,
): Promise<Float32Array | null> {
  const shN = meta.shN;
  if (shN === undefined || shN.bands < 1) return null;
  const centroids = await image(shN.files[0] ?? 'shN_centroids.webp');
  const labels = await image(shN.files[1] ?? 'shN_labels.webp');
  const book = shN.codebook;
  /* Three coefficients a band for l=1, one palette entry per row of `coefficients` pixels. */
  const coefficients = shN.bands * (shN.bands + 2);
  const out = new Float32Array(count * SPLAT_SH1_COEFFICIENTS);

  for (let i = 0; i < count; i++) {
    const label = (labels.rgba[i * 4] ?? 0) | ((labels.rgba[i * 4 + 1] ?? 0) << 8);
    const entry = label * coefficients;
    /* Interleaved by basis function and then by channel, which is what `SplatSource.sh1` takes and
       is not how the palette stores it: the palette is one pixel per coefficient, RGB in it. */
    for (let basis = 0; basis < 3; basis++) {
      const at = (entry + basis) * 4;
      for (let channel = 0; channel < 3; channel++) {
        out[i * SPLAT_SH1_COEFFICIENTS + basis * 3 + channel] =
          book[centroids.rgba[at + channel] ?? 0] ?? 0;
      }
    }
  }
  return out;
}

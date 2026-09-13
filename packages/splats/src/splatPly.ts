/** The `.ply` reader: an ASCII header describing a binary body, as a training run writes it. */

import { SPLAT_SH1_COEFFICIENTS, packSplats } from './splatData.ts';
import type { SplatData } from './splatData.ts';

/** Coefficients per channel in the l=1 band: the three basis functions Y(1,−1), Y(1,0), Y(1,1). */
const SH1_PER_CHANNEL = 3;

/**
 * The spherical-harmonic band-0 constant, `0.5 * sqrt(1 / pi)`.
 *
 * A capture stores colour as the DC term of a spherical-harmonic expansion, which is a *radiance
 * coefficient* and not a colour: it is signed, unbounded, and centred on zero rather than on a half.
 * `0.5 + C0 * f_dc` is the conversion every viewer of this format uses, and getting it wrong is not
 * subtle — dropping the 0.5 leaves half the capture negative and clamped to black.
 */
const SH_C0 = 0.28209479177387814;

/** How many bytes each PLY scalar type occupies, and how to read one. */
const SCALARS: Readonly<
  Record<string, { readonly bytes: number; readonly read: (view: DataView, at: number) => number }>
> = {
  char: { bytes: 1, read: (v, at) => v.getInt8(at) },
  int8: { bytes: 1, read: (v, at) => v.getInt8(at) },
  uchar: { bytes: 1, read: (v, at) => v.getUint8(at) },
  uint8: { bytes: 1, read: (v, at) => v.getUint8(at) },
  short: { bytes: 2, read: (v, at) => v.getInt16(at, true) },
  int16: { bytes: 2, read: (v, at) => v.getInt16(at, true) },
  ushort: { bytes: 2, read: (v, at) => v.getUint16(at, true) },
  uint16: { bytes: 2, read: (v, at) => v.getUint16(at, true) },
  int: { bytes: 4, read: (v, at) => v.getInt32(at, true) },
  int32: { bytes: 4, read: (v, at) => v.getInt32(at, true) },
  uint: { bytes: 4, read: (v, at) => v.getUint32(at, true) },
  uint32: { bytes: 4, read: (v, at) => v.getUint32(at, true) },
  float: { bytes: 4, read: (v, at) => v.getFloat32(at, true) },
  float32: { bytes: 4, read: (v, at) => v.getFloat32(at, true) },
  double: { bytes: 8, read: (v, at) => v.getFloat64(at, true) },
  float64: { bytes: 8, read: (v, at) => v.getFloat64(at, true) },
};

const HEADER_END = 'end_header';

interface Property {
  readonly name: string;
  readonly offset: number;
  readonly read: (view: DataView, at: number) => number;
}

interface Header {
  readonly count: number;
  readonly stride: number;
  readonly properties: ReadonlyMap<string, Property>;
  readonly bodyAt: number;
  readonly sphericalHarmonics: number;
}

/**
 * Parse the ASCII header and build a property offset table from the **declared** order.
 *
 * **Declared, never assumed.** Training runs emit roughly
 * `x y z nx ny nz f_dc_0..2 f_rest_0..44 opacity scale_0..2 rot_0..3`, and the normals are unused
 * and sometimes absent — so a reader that hard-codes offsets reads a file that is one property
 * short as garbage, silently, at every field after the gap.
 */
function parseHeader(bytes: Uint8Array): Header {
  /* Latin-1 rather than UTF-8: the header is ASCII and the body is not text, so decoding the whole
     buffer as UTF-8 can throw on a byte sequence that is simply a float. */
  const text = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
  const endsAt = text.indexOf(HEADER_END);
  if (endsAt < 0) {
    throw new Error(
      `no \`${HEADER_END}\` in the first ${Math.min(bytes.length, 65536)} bytes, so this is not a ` +
        'PLY this reader understands.',
    );
  }
  /* Past the marker and its line ending, which is \n or \r\n depending on the writer. */
  const afterMarker = endsAt + HEADER_END.length;
  let bodyAt = afterMarker;
  if (text[bodyAt] === '\r') bodyAt++;
  if (text[bodyAt] === '\n') bodyAt++;

  const lines = text
    .slice(0, endsAt)
    .split(/\r?\n/)
    .map((line) => line.trim());
  if ((lines[0] ?? '') !== 'ply')
    throw new Error('the first line of a PLY is `ply`; this one is not.');

  const format = lines.find((line) => line.startsWith('format '));
  if (format === undefined) throw new Error('the header declares no `format` line.');
  if (format !== 'format binary_little_endian 1.0') {
    throw new Error(
      `this reader takes \`format binary_little_endian 1.0\` and the file says \`${format}\`. ` +
        'An ASCII or big-endian body is refused rather than misread, because a silent misread of a ' +
        'two-hundred-megabyte capture is worse than a stop.',
    );
  }

  /*
   * Only the `vertex` element carries splats. Other elements are skipped entirely rather than
   * parsed: a capture that also declares faces is still a capture, and this reader has no use for
   * them — but their properties must not land in the vertex stride.
   */
  const properties = new Map<string, Property>();
  let count = -1;
  let stride = 0;
  let inVertex = false;
  let sphericalHarmonics = 0;
  for (const line of lines) {
    if (line.startsWith('element ')) {
      const [, name, howMany] = line.split(/\s+/);
      inVertex = name === 'vertex';
      if (inVertex) count = Number(howMany);
      continue;
    }
    if (!inVertex || !line.startsWith('property ')) continue;
    const [, type, name] = line.split(/\s+/);
    if (type === 'list') {
      throw new Error(
        'a `property list` in the vertex element gives every splat a different size, which this ' +
          'reader does not handle. A Gaussian capture has none.',
      );
    }
    const scalar = SCALARS[type ?? ''];
    if (scalar === undefined) throw new Error(`unknown PLY scalar type \`${type}\`.`);
    if (name === undefined) throw new Error(`a \`property ${type}\` line names no property.`);
    properties.set(name, { name, offset: stride, read: scalar.read });
    /* Located and counted, never read: view-dependent colour is out of this row's scope, and
       knowing a capture carries the coefficients is what makes adding it a reader change. */
    if (name.startsWith('f_rest_')) sphericalHarmonics++;
    stride += scalar.bytes;
  }

  if (count < 0) throw new Error('the header declares no `vertex` element.');
  return { count, stride, properties, bodyAt, sphericalHarmonics };
}

function require_(header: Header, name: string): Property {
  const found = header.properties.get(name);
  if (found === undefined) {
    throw new Error(
      `the vertex element declares no \`${name}\`, which a Gaussian capture must carry. ` +
        `It declares: ${[...header.properties.keys()].slice(0, 12).join(', ')}…`,
    );
  }
  return found;
}

/**
 * Read a `.ply` Gaussian capture.
 *
 * **The encodings are the whole of this function's risk.** Scale is stored as its *logarithm* and
 * opacity as its *logit*, so both are undone here — and here only, because `packSplats` documents
 * that it takes linear values. Getting the boundary wrong produces a capture that is either
 * invisible or a solid block, and both have been reported against other viewers as rendering bugs.
 *
 * **The file stores rotation as wxyz** — `rot_0` is the real part — and `SplatSource` takes xyzw,
 * so the reorder happens here for the same reason it happens in the `.splat` reader.
 */
export function readSplatPly(buffer: ArrayBuffer): SplatData {
  const bytes = new Uint8Array(buffer);
  const header = parseHeader(bytes);
  const { count, stride, bodyAt } = header;

  const needed = bodyAt + count * stride;
  if (buffer.byteLength < needed) {
    throw new Error(
      `the header declares ${count} vertices of ${stride} bytes after a ${bodyAt}-byte header, ` +
        `which needs ${needed} bytes; the file is ${buffer.byteLength}. It is truncated.`,
    );
  }

  const x = require_(header, 'x');
  const y = require_(header, 'y');
  const z = require_(header, 'z');
  const dc0 = require_(header, 'f_dc_0');
  const dc1 = require_(header, 'f_dc_1');
  const dc2 = require_(header, 'f_dc_2');
  const alpha = require_(header, 'opacity');
  const s0 = require_(header, 'scale_0');
  const s1 = require_(header, 'scale_1');
  const s2 = require_(header, 'scale_2');
  const r0 = require_(header, 'rot_0');
  const r1 = require_(header, 'rot_1');
  const r2 = require_(header, 'rot_2');
  const r3 = require_(header, 'rot_3');

  /*
   * The l=1 band, if the file has one, and **the transpose that finding it needs**.
   *
   * A training run writes `f_rest_*` **channel-major**: all of red's coefficients, then all of
   * green's, then all of blue's. So the per-channel stride is the total over three, and the l=1
   * band is the first three of each channel — `f_rest_0..2`, then `f_rest_{n}..{n+2}`, then
   * `f_rest_{2n}..{2n+2}` — where `n` is 3 at degree 1, 8 at degree 2 and 15 at degree 3.
   *
   * **Reading them as if they were interleaved is the failure to expect**, because it produces a
   * capture that is plausible from a distance: the nine values are all real coefficients of
   * *something*, so the cloud still has a sheen, and it is the wrong sheen in the wrong channel.
   * The count is checked against a multiple of three rather than trusted, and a file whose
   * `f_rest_*` count is not divisible by three is read as having no harmonics at all.
   */
  const perChannel = Math.floor(header.sphericalHarmonics / 3);
  const wantsSh =
    header.sphericalHarmonics > 0 &&
    header.sphericalHarmonics % 3 === 0 &&
    perChannel >= SH1_PER_CHANNEL;
  const restBands: Property[] = [];
  if (wantsSh) {
    for (let channel = 0; channel < 3; channel++) {
      for (let band = 0; band < SH1_PER_CHANNEL; band++) {
        const property = header.properties.get(`f_rest_${channel * perChannel + band}`);
        if (property === undefined) {
          restBands.length = 0;
          break;
        }
        restBands.push(property);
      }
      if (restBands.length === 0) break;
    }
  }
  const hasSh = restBands.length === SH1_PER_CHANNEL * 3;
  const sh1 = hasSh ? new Float32Array(count * SPLAT_SH1_COEFFICIENTS) : undefined;

  const view = new DataView(buffer);
  const positions = new Float32Array(count * 3);
  const scales = new Float32Array(count * 3);
  const rotations = new Float32Array(count * 4);
  const colors = new Float32Array(count * 3);
  const opacities = new Float32Array(count);

  const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

  for (let index = 0; index < count; index++) {
    const at = bodyAt + index * stride;
    const p = index * 3;
    positions[p] = x.read(view, at + x.offset);
    positions[p + 1] = y.read(view, at + y.offset);
    positions[p + 2] = z.read(view, at + z.offset);

    /* Stored as a logarithm, so the standard deviation is its exponential. */
    scales[p] = Math.exp(s0.read(view, at + s0.offset));
    scales[p + 1] = Math.exp(s1.read(view, at + s1.offset));
    scales[p + 2] = Math.exp(s2.read(view, at + s2.offset));

    colors[p] = clamp01(0.5 + SH_C0 * dc0.read(view, at + dc0.offset));
    colors[p + 1] = clamp01(0.5 + SH_C0 * dc1.read(view, at + dc1.offset));
    colors[p + 2] = clamp01(0.5 + SH_C0 * dc2.read(view, at + dc2.offset));
    /* Stored as a logit, so the opacity is its logistic. */
    opacities[index] = 1 / (1 + Math.exp(-alpha.read(view, at + alpha.offset)));

    const r = index * 4;
    rotations[r] = r1.read(view, at + r1.offset);
    rotations[r + 1] = r2.read(view, at + r2.offset);
    rotations[r + 2] = r3.read(view, at + r3.offset);
    rotations[r + 3] = r0.read(view, at + r0.offset);

    /*
     * Channel-major in the file, basis-major in `SplatSource` — the transpose the block above
     * describes, in the one loop that touches the file's own order.
     */
    if (sh1 !== undefined) {
      const to = index * SPLAT_SH1_COEFFICIENTS;
      for (let band = 0; band < SH1_PER_CHANNEL; band++) {
        for (let channel = 0; channel < 3; channel++) {
          const property = restBands[channel * SH1_PER_CHANNEL + band];
          sh1[to + band * 3 + channel] =
            property === undefined ? 0 : property.read(view, at + property.offset);
        }
      }
    }
  }

  const data = packSplats({
    count,
    positions,
    scales,
    rotations,
    colors,
    opacities,
    ...(sh1 === undefined ? {} : { sh1 }),
  });
  return { ...data, sphericalHarmonics: header.sphericalHarmonics };
}

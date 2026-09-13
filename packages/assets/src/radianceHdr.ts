/** The Radiance `.hdr` container (RGBE), decoded to linear floats. */

/**
 * An equirectangular image, linear, three floats a texel, row 0 at the top.
 *
 * Three rather than four because an environment has no alpha and never will: the fourth channel
 * would be a byte a texel of ones, and at 2048x1024 that is eight megabytes of nothing.
 */
export interface RadianceImage {
  readonly width: number;
  readonly height: number;
  /** `width * height * 3` linear values, row-major from the top. */
  readonly data: Float32Array;
}

/**
 * Where a decoded byte sits inside its bucket.
 *
 * Radiance's own `colr_color` is `ldexp(mantissa + 0.5, exponent - (128 + 8))`, and the half is
 * the part every reimplementation drops. Dropping it makes an image about 0.2% dark, which is
 * invisible on its own, survives every eyeball comparison, and is exactly the kind of thing that
 * is never found. It is written as a named constant so that nobody removes it as a typo.
 */
const BUCKET_CENTRE = 0.5;

/** `2^-(128 + 8)`, the scale a stored exponent of zero would otherwise land on. */
const EXPONENT_BIAS = 128 + 8;

/**
 * Read a Radiance RGBE file into linear radiance.
 *
 * **Pure, and it takes bytes rather than a URL.** It knows nothing about a device, a fetch or a
 * texture, which is what lets it be tested exactly and what keeps the fetching decision — cache
 * headers, retries, where the file lives — with the consumer who has to make it.
 *
 * **Both scanline encodings, because only one of them is optional in practice.** A file narrower
 * than 8 or wider than 0x7fff stores flat RGBE quadruples; everything else is new-style
 * run-length, and that is every environment map anybody actually has. A decoder that handles only
 * the flat path passes a hand-built test and fails on every real file.
 *
 * **Every refusal names what it found.** `AGENTS.md` requires failing loudly at load with an
 * actionable message: a decoder that quietly answers black for a header it does not recognise
 * hands a scene an environment of nothing, which is indistinguishable from a probe that has not
 * baked yet and is diagnosed as the renderer's fault.
 *
 * **What it costs** is `width * height * 12` bytes for the result, which at 2048x1024 is 25 MB
 * held while the faces are built. **What would make it wrong** is a consumer streaming an
 * environment larger than memory; this reads whole files, and a tiled format is what that consumer
 * wants — which is one of the reasons KTX2 is named and deliberately not taken.
 */
export function readRadianceHdr(bytes: Uint8Array): RadianceImage {
  const signature = readLine(bytes, 0);
  if (!signature.text.startsWith('#?RADIANCE') && !signature.text.startsWith('#?RGBE')) {
    throw new Error(
      `readRadianceHdr: not a Radiance file — expected a "#?RADIANCE" signature, found ` +
        `"${signature.text.slice(0, 20)}"`,
    );
  }

  let at = signature.next;
  let format: string | null = null;
  /* The header runs to a blank line, and the resolution line is the one after it. */
  for (;;) {
    const line = readLine(bytes, at);
    at = line.next;
    if (line.text === '') break;
    if (line.text.startsWith('FORMAT=')) format = line.text.slice('FORMAT='.length).trim();
    if (at >= bytes.length) throw new Error('readRadianceHdr: the header never ended');
  }

  if (format !== null && format !== '32-bit_rle_rgbe') {
    throw new Error(
      `readRadianceHdr: only 32-bit_rle_rgbe is decoded here, and this file declares ` +
        `"${format}". An XYZE file carries CIE primaries rather than RGB and converting it is a ` +
        'colour decision rather than a decoding one.',
    );
  }

  const resolution = readLine(bytes, at);
  at = resolution.next;
  /*
   * `-Y height +X width` only. Radiance permits eight orientations, six of which nothing has
   * produced in decades, and treating one as another silently returns an image that is flipped —
   * which in an environment map puts the sky underfoot and is the most confusing available failure.
   */
  const match = /^-Y\s+(\d+)\s+\+X\s+(\d+)$/.exec(resolution.text.trim());
  if (match === null) {
    throw new Error(
      `readRadianceHdr: only "-Y height +X width" is handled, and this file says ` +
        `"${resolution.text.trim()}". Any other orientation would decode to a flipped image.`,
    );
  }
  const height = Number(match[1]);
  const width = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`readRadianceHdr: a ${width} by ${height} image is not decodable`);
  }

  const data = new Float32Array(width * height * 3);
  /* One scanline of RGBE, reused, because a 2048-wide image would otherwise allocate per row. */
  const scanline = new Uint8Array(width * 4);

  for (let y = 0; y < height; y++) {
    at = readScanline(bytes, at, scanline, width);
    for (let x = 0; x < width; x++) {
      const exponent = scanline[x * 4 + 3] ?? 0;
      const out = (y * width + x) * 3;
      /*
       * A stored exponent of zero is exactly black and Radiance reserves it for that. Running it
       * through the same arithmetic gives `0.5 * 2^-136`: denormal, nonzero, and enough to make
       * every black texel of a night sky something a prefilter will average into a grey haze.
       */
      if (exponent === 0) {
        data[out] = 0;
        data[out + 1] = 0;
        data[out + 2] = 0;
        continue;
      }
      const scale = 2 ** (exponent - EXPONENT_BIAS);
      data[out] = ((scanline[x * 4] ?? 0) + BUCKET_CENTRE) * scale;
      data[out + 1] = ((scanline[x * 4 + 1] ?? 0) + BUCKET_CENTRE) * scale;
      data[out + 2] = ((scanline[x * 4 + 2] ?? 0) + BUCKET_CENTRE) * scale;
    }
  }

  return { width, height, data };
}

/** One newline-terminated line as text, and where the next one starts. */
function readLine(bytes: Uint8Array, from: number): { text: string; next: number } {
  let end = from;
  while (end < bytes.length && bytes[end] !== 0x0a) end++;
  let text = '';
  for (let i = from; i < end; i++) text += String.fromCharCode(bytes[i] ?? 0);
  return { text: text.replace(/\r$/, ''), next: end + 1 };
}

/**
 * One scanline of RGBE into `out`, in either encoding, returning where the next one starts.
 *
 * The new-style marker is `2, 2, hi, lo` with `hi<<8 | lo` equal to the width. That third and
 * fourth byte being the width is what distinguishes it from an old-style scanline whose first
 * pixel happens to be `(2, 2, ...)`, which is a real colour and does occur.
 */
function readScanline(bytes: Uint8Array, from: number, out: Uint8Array, width: number): number {
  const declared = ((bytes[from + 2] ?? 0) << 8) | (bytes[from + 3] ?? 0);
  const isRle =
    width >= 8 &&
    width < 0x8000 &&
    bytes[from] === 2 &&
    bytes[from + 1] === 2 &&
    declared === width;

  if (!isRle) {
    /* Flat quadruples, which is what a narrow image and an old encoder both produce. */
    for (let x = 0; x < width; x++) {
      out[x * 4] = bytes[from + x * 4] ?? 0;
      out[x * 4 + 1] = bytes[from + x * 4 + 1] ?? 0;
      out[x * 4 + 2] = bytes[from + x * 4 + 2] ?? 0;
      out[x * 4 + 3] = bytes[from + x * 4 + 3] ?? 0;
    }
    return from + width * 4;
  }

  let at = from + 4;
  /*
   * The four channels are stored one after another rather than interleaved, which is the whole
   * reason this encoding compresses: a sky's red channel is a smooth ramp and its exponent channel
   * is nearly constant, and neither is compressible while they are interleaved with the others.
   */
  for (let channel = 0; channel < 4; channel++) {
    let x = 0;
    while (x < width) {
      const count = bytes[at] ?? 0;
      at++;
      if (count > 128) {
        /* A run: repeat the next byte this many times, minus the flag bit. */
        const value = bytes[at] ?? 0;
        at++;
        const run = count - 128;
        if (x + run > width) throw new Error('readRadianceHdr: a run overran its scanline');
        for (let i = 0; i < run; i++) out[(x + i) * 4 + channel] = value;
        x += run;
      } else {
        if (count === 0) throw new Error('readRadianceHdr: a zero-length literal run');
        if (x + count > width)
          throw new Error('readRadianceHdr: a literal run overran its scanline');
        for (let i = 0; i < count; i++) out[(x + i) * 4 + channel] = bytes[at + i] ?? 0;
        at += count;
        x += count;
      }
    }
  }
  return at;
}

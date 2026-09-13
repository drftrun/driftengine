/** The IESNA LM-63 photometric file: what a real fixture actually throws, and in which direction. */

/**
 * A fixture's measured intensity, as a grid over vertical and horizontal angles.
 *
 * **Candela rather than a normalised curve**, because the two answer different questions and only
 * one of them is in the file: the shape of the distribution is what a renderer samples, and the
 * absolute output is what tells a consumer whether this fixture is a reading lamp or a floodlight.
 * Normalising here would throw the second away, and a consumer that wants the shape can divide by
 * `maxCandela` — which is why it is carried rather than left to be recomputed.
 */
export interface IesProfile {
  /**
   * Vertical angles in degrees, increasing. 0 is straight down for the common type-C fixture.
   *
   * Not resampled to a regular grid here. A real file is dense where the distribution changes and
   * sparse where it does not, and flattening that is a decision about a texture rather than about
   * a file — `iesProfile.ts` in the renderer makes it.
   */
  readonly verticalAngles: Float32Array;
  /** Horizontal angles in degrees, increasing. A single 0 means the fixture is axially symmetric. */
  readonly horizontalAngles: Float32Array;
  /** Candela, horizontal-major: all vertical angles of the first plane, then the second. */
  readonly candela: Float32Array;
  /** The brightest value in the grid, so a consumer can normalise without walking it again. */
  readonly maxCandela: number;
}

/**
 * Read an LM-63 photometric file.
 *
 * **Whitespace-delimited across line breaks, because that is what the format is.** LM-63 attaches
 * no meaning to a newline inside its numeric lists, and every file a manufacturer publishes wraps
 * them — so a reader that parses line by line passes a hand-built fixture and fails on everything
 * real. The header is the only part that is line-oriented, and it ends at `TILT=`.
 *
 * **Pure, and it takes text rather than a URL**, for the reason `readRadianceHdr` gives: the
 * fetching decision belongs to the consumer who has to make it, and a pure function is one that can
 * be tested exactly.
 *
 * **What it costs** is holding the whole grid, which for a dense fixture is a few thousand floats.
 * **What would make it wrong** is a `TILT` other than `NONE`: that describes a fixture mounted at
 * an angle with its own correction table, and applying the distribution without it would be
 * confidently wrong rather than obviously wrong — so it is refused by name.
 */
export function readIesProfile(text: string): IesProfile {
  if (!/IESNA/i.test(text.slice(0, 200))) {
    throw new Error(
      `readIesProfile: not an IESNA photometric file — no IESNA signature in the first line, ` +
        `found "${text.slice(0, 40).replace(/\n[\s\S]*/, '')}"`,
    );
  }

  const tilt = /^TILT=(.*)$/m.exec(text);
  if (tilt === null) throw new Error('readIesProfile: no TILT= line, so the header never ended');
  const tiltValue = (tilt[1] ?? '').trim().toUpperCase();
  if (tiltValue !== 'NONE') {
    throw new Error(
      `readIesProfile: TILT=${tiltValue} is not handled. That fixture is mounted at an angle and ` +
        'carries its own correction table; applying its distribution without one would be ' +
        'confidently wrong rather than obviously wrong.',
    );
  }

  /* Everything after the TILT line is numbers, and the line breaks in it mean nothing. */
  const body = text.slice(tilt.index + tilt[0].length);
  const numbers = body
    .split(/[\s,]+/)
    .filter((token) => token.length > 0)
    .map(Number);
  let at = 0;
  const next = (what: string): number => {
    const value = numbers[at];
    at += 1;
    if (value === undefined || !Number.isFinite(value)) {
      throw new Error(
        `readIesProfile: expected ${what} at value ${at} and the file ended or held "${value}"`,
      );
    }
    return value;
  };

  /* The ten-number line: lamps, lumens, multiplier, counts, type, units, and three dimensions. */
  next('the lamp count');
  next('lumens per lamp');
  const multiplier = next('the candela multiplier');
  const verticalCount = Math.round(next('the vertical angle count'));
  const horizontalCount = Math.round(next('the horizontal angle count'));
  next('the photometric type');
  next('the units type');
  next('the fixture width');
  next('the fixture length');
  next('the fixture height');

  /* The seven-number line, of which only the ballast factor reaches the output. */
  const ballast = next('the ballast factor');
  next('the future-use field');
  next('the input watts');

  if (verticalCount <= 0 || horizontalCount <= 0) {
    throw new Error(
      `readIesProfile: a ${verticalCount} by ${horizontalCount} grid has no distribution in it`,
    );
  }

  const verticalAngles = new Float32Array(verticalCount);
  for (let i = 0; i < verticalCount; i++) verticalAngles[i] = next(`vertical angle ${i}`);
  const horizontalAngles = new Float32Array(horizontalCount);
  for (let i = 0; i < horizontalCount; i++) horizontalAngles[i] = next(`horizontal angle ${i}`);

  const wanted = verticalCount * horizontalCount;
  const remaining = numbers.length - at;
  if (remaining !== wanted) {
    throw new Error(
      `readIesProfile: ${verticalCount} vertical by ${horizontalCount} horizontal needs ${wanted} ` +
        `candela values and the file holds ${remaining}`,
    );
  }

  /*
   * **Both factors, and the file means their product.** The multiplier is on the ten-number line
   * and the ballast factor on the seven-number line, and a fixture's real output is candela times
   * both. Dropping either gives a profile uniformly too dim, which reads as the light having been
   * authored wrong rather than as the file being misread.
   */
  const scale = multiplier * ballast;
  const candela = new Float32Array(wanted);
  let maxCandela = 0;
  for (let i = 0; i < wanted; i++) {
    const value = next(`candela ${i}`) * scale;
    candela[i] = value;
    if (value > maxCandela) maxCandela = value;
  }

  return { verticalAngles, horizontalAngles, candela, maxCandela };
}

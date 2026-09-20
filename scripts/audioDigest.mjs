/**
 * Turning rendered audio into numbers, in one place.
 *
 * **A module with no top-level behaviour, and that is the point.** These two functions started out
 * in `audio-baseline.mjs`, which is a *script*: importing it to reuse them ran the whole baseline
 * flow and rewrote the fixture that file exists to protect. The hash happened to be identical, so
 * nothing was lost, and it would not have stayed that way.
 */

/**
 * FNV-1a over the raw float bytes, with statistics beside it.
 *
 * Order-sensitive and bit-sensitive, which is the whole point: two mixes differing by one sample in
 * the last millisecond must not agree. Not cryptographic — nothing here is adversarial, and the
 * only thing this has to survive is a mix that changed.
 *
 * The statistics are carried because a bare hash is a bad failure message. "The mix changed" is
 * where every investigation starts and is worth nothing on its own; a level per quarter says
 * *where* it changed, against the moves that were scheduled there.
 */
export function digest(samples) {
  const view = new DataView(new ArrayBuffer(4));
  let hash = 0x811c9dc5;
  let peak = 0;
  let sum = 0;
  for (const value of samples) {
    view.setFloat32(0, value);
    for (let byte = 0; byte < 4; byte++) {
      hash ^= view.getUint8(byte);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    const magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
    sum += value * value;
  }
  return {
    hash: hash.toString(16).padStart(8, '0'),
    peak: Number(peak.toFixed(9)),
    rms: Number(Math.sqrt(sum / samples.length).toFixed(9)),
    quarters: quarterRms(samples),
  };
}

/**
 * Level in each quarter of the render, which is what turns "the mix changed" into "where".
 *
 * The opening samples are useless for this and were tried first: the master filter then started at
 * 320 Hz, so the first milliseconds of any render were its impulse climbing out of zero, and eight
 * leading samples agreed to nine decimal places between two mixes that differed everywhere after.
 */
function quarterRms(samples) {
  const span = Math.floor(samples.length / 4);
  const out = [];
  for (let q = 0; q < 4; q++) {
    let sum = 0;
    for (let i = q * span; i < (q + 1) * span; i++) sum += samples[i] * samples[i];
    out.push(Number(Math.sqrt(sum / span).toFixed(9)));
  }
  return out;
}

/** Base64 of raw float bytes, back to the floats the browser rendered. Exact, unlike decimal text. */
export function decode(base64) {
  return new Float32Array(Buffer.from(base64, 'base64').buffer);
}

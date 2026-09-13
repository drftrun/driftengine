/** The order splats are written to the container in, so any prefix of the file is the whole place. */

/**
 * Bits per axis in the spatial key. Ten, so three of them fit a 30-bit integer sort key.
 *
 * A thousand and twenty-four cells an axis over the capture's own extent, which for a room-sized
 * capture is under a centimetre. What it gives up is that two splats inside one cell are ordered
 * arbitrarily against each other, which is invisible at any block size a stream uses. What would
 * make it wrong is a capture whose extent is dominated by one distant outlier, squeezing the rest
 * into a handful of cells — the same failure any quantisation has.
 */
const AXIS_BITS = 10;
const AXIS_CELLS = (1 << AXIS_BITS) - 1;

/** Spread ten bits out to every third bit, so three of them interleave into one integer. */
function spread(value: number): number {
  let bits = value & AXIS_CELLS;
  bits = (bits | (bits << 16)) & 0x030000ff;
  bits = (bits | (bits << 8)) & 0x0300f00f;
  bits = (bits | (bits << 4)) & 0x030c30c3;
  bits = (bits | (bits << 2)) & 0x09249249;
  return bits;
}

/**
 * The order to write a capture's splats in, so that **every prefix of the file is a complete
 * sparse capture** rather than a finished corner of one.
 *
 * **This is the reason the container is worth having at all.** Everything above it is a splat
 * viewer; a load that opens on a recognisable place and densifies is what a viewer streaming from
 * a plain file cannot do by accident. It is the same trick `coarseLevel.ts` plays for meshes,
 * where a decimated whole body reads as a car and one finished wheel does not.
 *
 * Two steps, and both are needed:
 *
 * 1. **Sort by Morton code**, so index order becomes spatial order. Without this the sequence
 *    below decimates whatever order the trainer happened to leave — which is usually fine and is
 *    a slab of one axis when it is not, and the difference is invisible until somebody opens a
 *    capture that was written out in scan order. `coarseFirst.test.ts` builds exactly that case.
 * 2. **Walk that order bit-reversed**, which is the van der Corput sequence and is what makes
 *    each *block* a sparse capture rather than only the first. Reversing the bits of a counter
 *    visits 0, half way, quarter, three quarters, and so on, so consecutive slots are maximally
 *    far apart in the spatial order and every block is an even scattering over the whole thing.
 *
 * What it costs is a sort at bake time — `O(n log n)` once, on a machine with a keyboard — and
 * nothing at all at load. **What would make it wrong** is a capture meant to be read in its
 * authored order, which this format has no notion of: a `.drft` splat chunk is a set, and a
 * consumer that needed the original indices would need them stored.
 */
export function coarseFirstOrder(positions: Float32Array, count: number): Uint32Array {
  const order = new Uint32Array(Math.max(0, count));
  if (count <= 0) return order;
  if (count === 1) return order;

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let index = 0; index < count; index++) {
    const at = index * 3;
    const x = positions[at] ?? 0;
    const y = positions[at + 1] ?? 0;
    const z = positions[at + 2] ?? 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  /* A capture with no extent on an axis quantises every splat to cell zero there, which is the
     right answer: with no range there is no spatial order along it to preserve. */
  const scaleX = maxX > minX ? AXIS_CELLS / (maxX - minX) : 0;
  const scaleY = maxY > minY ? AXIS_CELLS / (maxY - minY) : 0;
  const scaleZ = maxZ > minZ ? AXIS_CELLS / (maxZ - minZ) : 0;

  const spatial = new Uint32Array(count);
  const keys = new Uint32Array(count);
  for (let index = 0; index < count; index++) {
    const at = index * 3;
    const x = Math.round(((positions[at] ?? 0) - minX) * scaleX);
    const y = Math.round(((positions[at + 1] ?? 0) - minY) * scaleY);
    const z = Math.round(((positions[at + 2] ?? 0) - minZ) * scaleZ);
    keys[index] = (spread(x) | (spread(y) << 1) | (spread(z) << 2)) >>> 0;
    spatial[index] = index;
  }
  /*
   * A comparison sort, deliberately. This runs once per bake on a workstation, against a counting
   * sort's 4 MB of buckets for a 30-bit key; the frame-time sort in `@driftengine/splats` is the
   * one where that trade goes the other way, and it says so.
   */
  const sorted = Array.from(spatial).sort((a, b) => (keys[a] ?? 0) - (keys[b] ?? 0));

  /*
   * Bit-reversal over the spatial order. `width` is the number of bits the count needs, so the
   * counter covers a power of two at least as large; reversed values landing past the end are
   * skipped, which keeps the sequence's spread and costs at most one extra pass.
   */
  let width = 0;
  while (1 << width < count) width++;
  let slot = 0;
  for (let counter = 0; counter < 1 << width; counter++) {
    let reversed = 0;
    for (let bit = 0; bit < width; bit++) {
      if ((counter & (1 << bit)) !== 0) reversed |= 1 << (width - 1 - bit);
    }
    if (reversed >= count) continue;
    order[slot++] = sorted[reversed] ?? 0;
  }
  return order;
}

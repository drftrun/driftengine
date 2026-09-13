import { DrftError, align } from './drftFormat.ts';

/**
 * `COLL`: the convex hulls an asset collides as.
 *
 * **A FourCC that was claimed and undefined for the whole of v1.** `docs/FORMAT.md` §4.3 listed the
 * row and `KNOWN_CHUNKS` held the code while no writer emitted one and no reader consumed one.
 * `readModel.ts` said why in as many words when it declined to put a vehicle's collision hull inside
 * the model's own file: *"a format decision about whether a hull is triangle soup or a set of convex
 * hulls, and not one an import should make in passing."* This is that decision, made — **a set of
 * convex hulls**.
 *
 * **Points, not shapes, because this package depends on nothing.** `boundaries.test.mjs` asserts
 * that import graph and `drft-only` measures what it is worth. A serialised `ConvexShape` would mean
 * the format package knowing what a face plane and a separating axis are, and it would freeze a
 * representation the physics package is still free to change. A hull here is the points whose hull
 * it is, which is exactly what `hullShape` takes:
 *
 * ```ts
 * const shapes = asset.colliders.map((points) => hullShape(points));
 * ```
 *
 * **One chunk for the file**, pairing with nothing. An asset's collision is a fact about the whole
 * asset the way `SUBS` is a fact about all its materials, not a thing that belongs to mesh three.
 *
 * ```
 * u32  hullCount
 * u32  pointTotal
 * u32  starts[hullCount + 1]     offsets in points; starts[0] = 0, starts[n] = pointTotal
 * f32  points[pointTotal * 3]    xyz, in the asset's own space
 * ```
 *
 * The starts table is written whole, with its closing entry, so a reader takes every hull's extent
 * from one subtraction and never has to special-case the last one. Everything is four-byte aligned,
 * so the points come back as one `Float32Array` view over the fetched buffer and each hull is a
 * `subarray` of it — the same property `MESH` exists for.
 */

/** How many points one hull may carry, which is what `hullShape` accepts. */
export const MAX_COLLIDER_POINTS = 64;

/**
 * A cap on hulls per asset, so a malformed length cannot ask a reader for gigabytes.
 *
 * Matches `MAX_BODY_PARTS` in `@driftengine/physics` by intent rather than by import — this package
 * depends on nothing, and the two are checked against each other by a test in the engine instead.
 */
export const MAX_COLLIDER_HULLS = 32;

export function buildColliders(hulls: readonly Float32Array[]): Uint8Array {
  if (hulls.length > MAX_COLLIDER_HULLS) {
    throw new DrftError(`${hulls.length} collision hulls exceeds ${MAX_COLLIDER_HULLS}`);
  }
  let pointTotal = 0;
  for (const hull of hulls) {
    if (hull.length % 3 !== 0) {
      throw new DrftError(`a collision hull has ${hull.length} floats, which is not whole points`);
    }
    const points = hull.length / 3;
    if (points === 0) throw new DrftError('a collision hull has no points');
    if (points > MAX_COLLIDER_POINTS) {
      throw new DrftError(
        `a collision hull has ${points} points, over the ${MAX_COLLIDER_POINTS} cap`,
      );
    }
    pointTotal += points;
  }

  const startsBytes = (hulls.length + 1) * 4;
  const size = 8 + startsBytes + pointTotal * 3 * 4;
  const bytes = new Uint8Array(align(size));
  const view = new DataView(bytes.buffer);
  view.setUint32(0, hulls.length, true);
  view.setUint32(4, pointTotal, true);

  let start = 0;
  for (let i = 0; i < hulls.length; i++) {
    view.setUint32(8 + i * 4, start, true);
    start += (hulls[i] as Float32Array).length / 3;
  }
  view.setUint32(8 + hulls.length * 4, pointTotal, true);

  const points = new Float32Array(bytes.buffer, 8 + startsBytes, pointTotal * 3);
  let at = 0;
  for (const hull of hulls) {
    points.set(hull, at);
    at += hull.length;
  }
  return bytes;
}

/**
 * The hulls a `COLL` chunk carries, as views over the fetched buffer.
 *
 * Views rather than copies, exactly like the vertex arrays, so a load allocates nothing beyond the
 * array holding them. They keep the file alive for as long as they are held, which is the same trade
 * `DrftTexture.bytes` makes and for the same reason.
 */
export function readColliders(
  buffer: ArrayBuffer,
  offset: number,
  byteLength: number,
): readonly Float32Array[] {
  if (byteLength < 8) throw new DrftError('COLL is too short to hold its counts');
  const view = new DataView(buffer, offset, byteLength);
  const hullCount = view.getUint32(0, true);
  const pointTotal = view.getUint32(4, true);
  if (hullCount > MAX_COLLIDER_HULLS) {
    throw new DrftError(`COLL claims ${hullCount} hulls, over the ${MAX_COLLIDER_HULLS} cap`);
  }

  const startsBytes = (hullCount + 1) * 4;
  const needed = 8 + startsBytes + pointTotal * 3 * 4;
  if (byteLength < needed) {
    throw new DrftError(
      `COLL claims ${hullCount} hulls and ${pointTotal} points, which runs past the chunk`,
    );
  }

  /*
   * The starts are read and checked before a single point is handed out. A table that runs backwards
   * or past the total would otherwise produce a `subarray` of a length nobody wrote, which is a hull
   * of arbitrary geometry rather than an error.
   */
  const starts = new Uint32Array(hullCount + 1);
  for (let i = 0; i <= hullCount; i++) starts[i] = view.getUint32(8 + i * 4, true);
  if ((starts[0] as number) !== 0)
    throw new DrftError('COLL does not start its first hull at zero');
  if ((starts[hullCount] as number) !== pointTotal) {
    throw new DrftError('COLL closes its table at a point count it did not declare');
  }
  for (let i = 0; i < hullCount; i++) {
    const from = starts[i] as number;
    const to = starts[i + 1] as number;
    if (to < from) throw new DrftError(`COLL hull ${i} runs backwards`);
    const points = to - from;
    if (points === 0) throw new DrftError(`COLL hull ${i} has no points`);
    if (points > MAX_COLLIDER_POINTS) {
      throw new DrftError(
        `COLL hull ${i} has ${points} points, over the ${MAX_COLLIDER_POINTS} cap`,
      );
    }
  }

  const all = new Float32Array(buffer, offset + 8 + startsBytes, pointTotal * 3);
  const hulls: Float32Array[] = [];
  for (let i = 0; i < hullCount; i++) {
    const from = (starts[i] as number) * 3;
    const to = (starts[i + 1] as number) * 3;
    hulls.push(all.subarray(from, to));
  }
  return hulls;
}

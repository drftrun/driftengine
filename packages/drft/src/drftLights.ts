/**
 * `LITE`: the lights a scene was authored with, in glTF's own terms.
 *
 * **The source's numbers, unconverted.** Intensity is candela for a point or a spot and lux for a
 * directional light, as `KHR_lights_punctual` states it, because what a candela is in a consumer's
 * units is that consumer's exposure decision and no two agree. The chunk says where the lamps are and
 * what their author said about them. Deciding how bright they draw is the consumer's job.
 *
 * **Optional.** A reader that skips it loses the lights and nothing else; they were only ever the
 * consumer's to place. What that gives up is a file whose lights are essential saying so, which
 * none is: a scene without its lamps is darker, not wrong.
 *
 * Layout, little-endian:
 * - u32 light count, u32 name count;
 * - the names, each a u32 byte length and UTF-8, padded to four bytes. **Each distinct name is
 *   written once**: a pack of ten thousand candles names every one "Instance";
 * - per light, 64 bytes: u32 kind (0 point, 1 spot, 2 directional), u32 name index, position,
 *   direction, colour (three f32 each), intensity, range (0 is unbounded), inner and outer cone
 *   in radians, and one reserved f32.
 */
import { DrftError, align } from './drftFormat.ts';

export type DrftLightKind = 'point' | 'spot' | 'directional';

export interface DrftLight {
  readonly kind: DrftLightKind;
  /** The node's name in the source, or empty. */
  readonly name: string;
  /** World space, metres. */
  readonly position: readonly [number, number, number];
  /** Where a spot or a directional light points, world space and unit length. glTF's local −z. */
  readonly direction: readonly [number, number, number];
  /** Linear, 0 to 1 a channel. */
  readonly color: readonly [number, number, number];
  /** Candela for a point or a spot, lux for a directional light. */
  readonly intensity: number;
  /** Metres at which the source's author cut the light off, or 0 for no cut. */
  readonly range: number;
  readonly innerConeRad: number;
  readonly outerConeRad: number;
}

const KINDS: readonly DrftLightKind[] = ['point', 'spot', 'directional'];
const LIGHT_BYTES = 64;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function buildLights(lights: readonly DrftLight[]): Uint8Array {
  const names: string[] = [];
  const nameIndex = new Map<string, number>();
  for (const light of lights) {
    if (!nameIndex.has(light.name)) {
      nameIndex.set(light.name, names.length);
      names.push(light.name);
    }
  }
  const encoded = names.map((name) => encoder.encode(name));
  let nameBytes = 0;
  for (const text of encoded) nameBytes += align(4 + text.length);
  const bytes = new Uint8Array(8 + nameBytes + lights.length * LIGHT_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, lights.length, true);
  view.setUint32(4, names.length, true);
  let at = 8;
  for (const text of encoded) {
    view.setUint32(at, text.length, true);
    bytes.set(text, at + 4);
    at += align(4 + text.length);
  }
  for (const light of lights) {
    view.setUint32(at, KINDS.indexOf(light.kind), true);
    view.setUint32(at + 4, nameIndex.get(light.name) ?? 0, true);
    const floats = [
      ...light.position,
      ...light.direction,
      ...light.color,
      light.intensity,
      light.range,
      light.innerConeRad,
      light.outerConeRad,
    ];
    for (let i = 0; i < floats.length; i++)
      view.setFloat32(at + 8 + i * 4, floats[i] as number, true);
    at += LIGHT_BYTES;
  }
  return bytes;
}

/** The lights in a `LITE` payload. */
export function readLights(
  buffer: ArrayBufferLike,
  offset: number,
  byteLength: number,
): DrftLight[] {
  const view = new DataView(buffer, offset, byteLength);
  if (byteLength < 8) throw new DrftError('LITE is shorter than its own header');
  const count = view.getUint32(0, true);
  const nameCount = view.getUint32(4, true);
  const names: string[] = [];
  let at = 8;
  for (let n = 0; n < nameCount; n++) {
    if (at + 4 > byteLength) throw new DrftError('LITE ends inside its names');
    const length = view.getUint32(at, true);
    if (at + 4 + length > byteLength) throw new DrftError('a LITE name runs past the chunk');
    names.push(decoder.decode(new Uint8Array(buffer, offset + at + 4, length)));
    at += align(4 + length);
  }
  if (at + count * LIGHT_BYTES > byteLength) {
    throw new DrftError(`LITE says ${count} lights and ends inside them`);
  }
  const f = (o: number): number => view.getFloat32(o, true);
  const out: DrftLight[] = [];
  for (let i = 0; i < count; i++) {
    const kind = KINDS[view.getUint32(at, true)];
    if (kind === undefined)
      throw new DrftError(`LITE light ${i} is of a kind this reader does not know`);
    out.push({
      kind,
      name: names[view.getUint32(at + 4, true)] ?? '',
      position: [f(at + 8), f(at + 12), f(at + 16)],
      direction: [f(at + 20), f(at + 24), f(at + 28)],
      color: [f(at + 32), f(at + 36), f(at + 40)],
      intensity: f(at + 44),
      range: f(at + 48),
      innerConeRad: f(at + 52),
      outerConeRad: f(at + 56),
    });
    at += LIGHT_BYTES;
  }
  return out;
}

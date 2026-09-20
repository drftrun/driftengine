import { DrftError, align } from './drftFormat.ts';

/**
 * `ENTS`: the things in a scene, as the entity model wrote them.
 *
 * ```
 * u32  byteLength        of the text that follows
 * u8   scene[byteLength] UTF-8 JSON, padded to the container's alignment
 * ```
 *
 * **Text, in a binary container, on purpose.** Every other chunk here holds numbers whose meaning
 * this package knows — positions, indices, weights. A scene holds a *consumer's* component fields,
 * whose types are declared in that consumer's own code and in its `.drs` files. A binary encoding
 * for them would be an encoding of somebody else's type system, extended every time they add a
 * field, and wrong in the direction that reads as working: a field the container did not know how
 * to write would silently not be there. What `serializeWorld` produces is already a value; this
 * carries it unchanged.
 *
 * **The scene's own version is inside it and is not repeated.** `MSHL` states the reason in one
 * line — a second version is a second thing to keep in step, and the one that drifts is the one
 * nobody reads.
 *
 * **What is checked is that this is a scene, not that it is a scene anybody can load.** Whether a
 * component named here exists, and whether its schema still matches, is `deserializeWorld`'s
 * question and it answers in words. Refusing text that is not a scene at all belongs here, so a
 * consumer meets a sentence rather than `undefined.entities` three calls later.
 *
 * Additive on the same terms as `DTEX`: a reader that does not know this code skips it by its
 * length and loses only the scene, which it had no entity model to load into anyway.
 */

/** A world as data. `@driftengine/entities`' `SerializedScene` is one of these. */
export interface EntsScene {
  readonly version: number;
  /** What each component type looked like when this was written. */
  readonly schemas: Readonly<Record<string, unknown>>;
  readonly entities: readonly {
    /** Component name → field id → value. */
    readonly components: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  }[];
}

const HEADER = 4;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function buildEnts(scene: EntsScene): Uint8Array {
  refuseNonScene(scene);
  const text = encoder.encode(JSON.stringify(scene));
  const bytes = new Uint8Array(align(HEADER + text.length));
  new DataView(bytes.buffer).setUint32(0, text.length, true);
  bytes.set(text, HEADER);
  return bytes;
}

/**
 * The scene an `ENTS` chunk carries.
 *
 * **A copy rather than a view, and it is the only chunk here that has to be.** Text is not a typed
 * array over the buffer; parsing it is what makes it a scene. A consumer that loads one is about
 * to create every entity in it anyway, so the copy is not the cost that matters.
 */
export function readEnts(buffer: ArrayBuffer, offset: number, byteLength: number): EntsScene {
  if (byteLength < HEADER) throw new DrftError('ENTS is too short to hold its header');
  const view = new DataView(buffer, offset, byteLength);
  const length = view.getUint32(0, true);
  if (HEADER + length > byteLength) {
    throw new DrftError(
      `ENTS declares ${String(length)} bytes of scene in a ${String(byteLength)}-byte chunk`,
    );
  }

  const text = decoder.decode(new Uint8Array(buffer, offset + HEADER, length));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new DrftError(`ENTS does not hold a scene: ${(error as Error).message}`);
  }
  refuseNonScene(parsed);
  return parsed;
}

/** The shape a scene has, checked on both sides so neither end can write one the other refuses. */
function refuseNonScene(scene: unknown): asserts scene is EntsScene {
  if (typeof scene !== 'object' || scene === null) {
    throw new DrftError('ENTS holds no scene at all');
  }
  const held = scene as Partial<EntsScene>;
  if (!Number.isInteger(held.version) || (held.version as number) < 1) {
    throw new DrftError(`ENTS holds a scene at version ${String(held.version)}`);
  }
  if (typeof held.schemas !== 'object' || held.schemas === null) {
    throw new DrftError('ENTS holds a scene with no schemas, so nothing in it could be matched up');
  }
  if (!Array.isArray(held.entities)) {
    throw new DrftError('ENTS holds a scene whose entities are not a list');
  }
  for (let at = 0; at < held.entities.length; at += 1) {
    const entity = held.entities[at] as { components?: unknown } | null;
    if (typeof entity !== 'object' || entity === null || typeof entity.components !== 'object') {
      throw new DrftError(`ENTS holds an entity at ${at} with no components`);
    }
  }
}

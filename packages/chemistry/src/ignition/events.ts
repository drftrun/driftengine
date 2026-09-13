/**
 * What happened this tick, as a buffer a caller drains.
 *
 * The shape `drift/physics`'s contact buffer established, and for the reason that one exists: a
 * stream a consumer polls is allocation-free, and a callback per event is not. Cleared at the top
 * of every tick, so an event not read this frame is gone — which is the same contract contacts have
 * and the same one a consumer already knows.
 *
 * **The kinds are closed.** A consumer that wants a distinction this list does not draw reads the
 * numbers instead; adding a kind is a decision about what the model claims to notice.
 */

export const EVENT_IGNITED = 0;
export const EVENT_EXTINGUISHED = 1;
export const EVENT_SMOULDER_START = 2;
export const EVENT_SMOULDER_END = 3;
export const EVENT_CONSUMED = 4;
export const EVENT_CHARRED = 5;
export const EVENT_STRUCTURAL_FAIL = 6;
export const EVENT_FROZEN = 7;
export const EVENT_MELTED = 8;
export const EVENT_BOILED = 9;
export const EVENT_CONDENSED = 10;
export const EVENT_SUBLIMED = 11;
export const EVENT_CORRODED = 12;
export const EVENT_CALCINED = 13;
export const EVENT_DISSOLVED = 14;
export const EVENT_DENATURED = 15;
export const EVENT_BROWNED = 16;
export const EVENT_CARAMELISED = 17;
export const EVENT_FERMENTED = 18;
export const EVENT_DECAYED = 19;
/**
 * A confined deflagration crossed a pressure threshold.
 *
 * `§26` refuses detonation in writing: a supersonic shock front is a physics problem in a package
 * that owns no solver. This is the refusal **reporting** rather than simulating — the event says a
 * pressure was exceeded and where, and the consumer decides what a wall does about it.
 */
export const EVENT_EXPLODED = 20;

export const EVENT_KIND_COUNT = 21;

export class ChemistryEvents {
  private kind = new Int32Array(64);
  private parcel = new Int32Array(64);
  private species = new Int32Array(64);
  private value = new Float64Array(64);
  private used = 0;

  get count(): number {
    return this.used;
  }

  clear(): void {
    this.used = 0;
  }

  /** @param species `-1` where the kind does not name one. @param value the kind's own quantity. */
  push(kind: number, parcel: number, species: number, value: number): void {
    if (this.used === this.kind.length) this.grow();
    const at = this.used++;
    this.kind[at] = kind;
    this.parcel[at] = parcel;
    this.species[at] = species;
    this.value[at] = value;
  }

  kindOf(event: number): number {
    return this.kind[event] as number;
  }

  parcelOf(event: number): number {
    return this.parcel[event] as number;
  }

  speciesOf(event: number): number {
    return this.species[event] as number;
  }

  valueOf(event: number): number {
    return this.value[event] as number;
  }

  private grow(): void {
    const size = this.kind.length * 2;
    const kind = new Int32Array(size);
    kind.set(this.kind);
    this.kind = kind;
    const parcel = new Int32Array(size);
    parcel.set(this.parcel);
    this.parcel = parcel;
    const species = new Int32Array(size);
    species.set(this.species);
    this.species = species;
    const value = new Float64Array(size);
    value.set(this.value);
    this.value = value;
  }
}

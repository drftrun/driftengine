/**
 * Which parcels are touching, this tick.
 *
 * Refilled by the caller each tick rather than held, the same shape `RadiativeSources` takes and
 * for the same reason: contact is a property of the world's arrangement, which this package does
 * not know. In practice it is fed from Track B's contact event buffer, which already reports pairs
 * by feature id — and feeding it is the whole of what a consumer does to make a pan heat a steak.
 */
export class ContactSet {
  private a = new Int32Array(32);
  private b = new Int32Array(32);
  private area = new Float64Array(32);
  private used = 0;

  get count(): number {
    return this.used;
  }

  clear(): void {
    this.used = 0;
  }

  /** @param area m² of shared surface, which is what sets how fast heat crosses. */
  add(a: number, b: number, area: number): void {
    if (this.used === this.a.length) this.grow();
    const at = this.used++;
    this.a[at] = a;
    this.b[at] = b;
    this.area[at] = area;
  }

  firstOf(contact: number): number {
    return this.a[contact] as number;
  }

  secondOf(contact: number): number {
    return this.b[contact] as number;
  }

  areaOf(contact: number): number {
    return this.area[contact] as number;
  }

  private grow(): void {
    const size = this.a.length * 2;
    const a = new Int32Array(size);
    a.set(this.a);
    this.a = a;
    const b = new Int32Array(size);
    b.set(this.b);
    this.b = b;
    const area = new Float64Array(size);
    area.set(this.area);
    this.area = area;
  }
}

/**
 * Heat crossing empty space, which is how a fire reaches anything it is not touching.
 *
 * **Radiation dominates every fire beyond a few centimetres, and `§10` is the argument.** A flame
 * at 1200 K radiates about 118 kW/m², and the fourth power means halving its temperature cuts that
 * sixteenfold. A model without it cannot make a log ignite from across a hearth — which is the
 * scenario the whole track exists for.
 *
 * **The view factor is a point source: `cos θ · A / (π r²)`.** It is wrong close in, where a flame
 * is not a point, and it is right where it matters. What it buys is the single relationship this
 * model is built on: **flux falls as `1/r²`**, so moving a log twice as far from a fire makes it
 * take four times as long to catch. One line of arithmetic, and without it "leading a piece of wood
 * near the fire" has no right answer at all.
 */

/** W/(m²·K⁴). */
export const STEFAN_BOLTZMANN = 5.670374419e-8;

/**
 * How close a point source may be approached before the approximation is capped.
 *
 * A point source's flux is unbounded at zero distance, and the honest failure there is a large
 * number rather than an infinite one. The clamp is the scale at which a real source stops looking
 * like a point, which is its own size.
 */
const MIN_DISTANCE = 0.05;

/**
 * Radiant flux onto a surface, W/m².
 *
 * @param sourceTemperature K
 * @param sourceArea m² of radiating surface
 * @param surfaceTemperature K of the receiver
 * @param emissivity of the receiver, 0..1
 * @param distance m
 * @param cosine of the angle between the receiver's normal and the line to the source
 */
export function radiantFlux(
  sourceTemperature: number,
  sourceArea: number,
  surfaceTemperature: number,
  emissivity: number,
  distance: number,
  cosine: number,
): number {
  if (!(cosine > 0)) return 0;
  const range = Math.max(distance, MIN_DISTANCE);
  const viewFactor = (cosine * sourceArea) / (Math.PI * range * range);
  const source = sourceTemperature * sourceTemperature * sourceTemperature * sourceTemperature;
  const surface = surfaceTemperature * surfaceTemperature * surfaceTemperature * surfaceTemperature;
  return emissivity * STEFAN_BOLTZMANN * viewFactor * (source - surface);
}

/**
 * How far a source of a given power is worth considering, m.
 *
 * From `P / (4π r²) = q_min`, so a **big fire reaches further than a small one** rather than every
 * source sharing a constant radius. That is what stops a candle being tested against every parcel
 * in a scene and a bonfire being cut off at the same distance.
 */
export function sourceRange(power: number, minimumFlux: number): number {
  if (!(power > 0) || !(minimumFlux > 0)) return 0;
  return Math.sqrt(power / (4 * Math.PI * minimumFlux));
}

/**
 * Convective heat transfer coefficient from the local gas speed, W/(m²·K).
 *
 * Two to twenty-five in still air, and up to about two hundred and fifty in a gale. **Above a fire
 * convection dominates radiation and beside one radiation dominates convection**, and the crossover
 * is at the plume edge — which is why standing beside a bonfire is pleasant and standing in the
 * smoke is not.
 */
export function convectiveCoefficient(gasSpeed: number): number {
  const speed = gasSpeed > 0 ? gasSpeed : 0;
  const h = 5 + 12 * Math.sqrt(speed);
  return h > 250 ? 250 : h;
}

/** Whether anything solid stands between two points. */
export type OcclusionTest = (
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
) => boolean;

/** Below this a source is not worth testing against anything, W/m². */
const MINIMUM_USEFUL_FLUX = 200;

/**
 * The radiating things in a scene this tick: flames and hot surfaces both.
 *
 * Gathered into columns once per tick and read many times, which is why it is a structure rather
 * than a callback. Cleared and refilled rather than reallocated.
 */
export class RadiativeSources {
  private x = new Float64Array(32);
  private y = new Float64Array(32);
  private z = new Float64Array(32);
  private temperature = new Float64Array(32);
  private area = new Float64Array(32);
  private range = new Float64Array(32);
  private used = 0;

  get count(): number {
    return this.used;
  }

  clear(): void {
    this.used = 0;
  }

  /** @param power W, which decides how far this source is worth testing against. */
  add(x: number, y: number, z: number, temperature: number, area: number, power: number): void {
    if (this.used === this.x.length) this.grow();
    const at = this.used++;
    this.x[at] = x;
    this.y[at] = y;
    this.z[at] = z;
    this.temperature[at] = temperature;
    this.area[at] = area;
    this.range[at] = sourceRange(power, MINIMUM_USEFUL_FLUX);
  }

  temperatureOf(source: number): number {
    return this.temperature[source] as number;
  }

  areaOf(source: number): number {
    return this.area[source] as number;
  }

  /** Whether a point is inside this source's own reach. */
  reaches(source: number, x: number, y: number, z: number): boolean {
    const dx = x - (this.x[source] as number);
    const dy = y - (this.y[source] as number);
    const dz = z - (this.z[source] as number);
    const reach = this.range[source] as number;
    return dx * dx + dy * dy + dz * dz <= reach * reach;
  }

  /**
   * Total flux onto a point from every source that can see it, W/m².
   *
   * The receiver is treated as facing each source — a parcel is a lump rather than a plane, so
   * there is no one normal to take a cosine against. What that costs is that a flat plate edge-on
   * to a fire receives as much as one facing it; what it buys is not asking a consumer for a normal
   * per parcel, which is a number most of them do not have.
   */
  fluxAt(
    x: number,
    y: number,
    z: number,
    surfaceTemperature: number,
    emissivity: number,
    occluded: OcclusionTest | null,
  ): number {
    let total = 0;
    for (let source = 0; source < this.used; source++) {
      if (!this.reaches(source, x, y, z)) continue;
      const sx = this.x[source] as number;
      const sy = this.y[source] as number;
      const sz = this.z[source] as number;
      if (occluded !== null && occluded(sx, sy, sz, x, y, z)) continue;
      const dx = x - sx;
      const dy = y - sy;
      const dz = z - sz;
      total += radiantFlux(
        this.temperature[source] as number,
        this.area[source] as number,
        surfaceTemperature,
        emissivity,
        Math.sqrt(dx * dx + dy * dy + dz * dz),
        1,
      );
    }
    return total;
  }

  /**
   * The temperature of the hottest source that reaches a point, or zero where none does.
   *
   * **What a radiative exchange is bounded by**, and the reason it has to be bounded at all: the
   * radiative term is explicit, so a parcel whose surface shell has a small heat capacity — a coin,
   * a nail, a leaf — can absorb more in one step than would take it past the source that is heating
   * it, and then radiate the excess back as `T⁴` and ring itself to pieces. It was found by putting
   * a copper coin on a hearth in `demo/dev/chemistry.ts`, where it reached 4,000 K on the first step
   * and 100 K a minute later.
   *
   * Nothing can be heated past the thing heating it, so this is the equilibrium the step may reach
   * and not exceed — which is what an implicit solve would give and costs one comparison per source.
   */
  hottestAt(x: number, y: number, z: number, occluded: OcclusionTest | null): number {
    let hottest = 0;
    for (let source = 0; source < this.used; source++) {
      if (!this.reaches(source, x, y, z)) continue;
      const sx = this.x[source] as number;
      const sy = this.y[source] as number;
      const sz = this.z[source] as number;
      if (occluded !== null && occluded(sx, sy, sz, x, y, z)) continue;
      const temperature = this.temperature[source] as number;
      if (temperature > hottest) hottest = temperature;
    }
    return hottest;
  }

  /**
   * Whether **any** source reaches a point at all, which is the whole of the wake test.
   *
   * `§14`'s scan has to be coarse or sleeping saves nothing: this is a range comparison per source
   * and no view factor, no temperature and no occlusion ray. A source's range already comes from its
   * own power, so a bonfire wakes a parcel a candle would not.
   */
  reachesPoint(x: number, y: number, z: number): boolean {
    for (let source = 0; source < this.used; source++) {
      if (this.reaches(source, x, y, z)) return true;
    }
    return false;
  }

  private grow(): void {
    const size = this.x.length * 2;
    const grow = (from: Float64Array<ArrayBuffer>): Float64Array<ArrayBuffer> => {
      const to = new Float64Array(size);
      to.set(from);
      return to;
    };
    this.x = grow(this.x);
    this.y = grow(this.y);
    this.z = grow(this.z);
    this.temperature = grow(this.temperature);
    this.area = grow(this.area);
    this.range = grow(this.range);
  }
}

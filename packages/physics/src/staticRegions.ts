/**
 * A world's static scenery by region: one body a region, added when the region streams in and
 * removed when it streams out, with each region's body index kept right as the world moves bodies.
 *
 * **One body a region, and a triangle mesh is what makes that cheap.** A city region holds hundreds
 * of boxes and a few odd shapes; as bodies they would be tens of thousands for the city, every one
 * an index to follow. As one static triangle mesh each — `meshShape`, which carries its own tree —
 * the whole city is a few hundred bodies and a region comes and goes as one add and one remove.
 *
 * **Why the indices need following.** `PhysicsWorld.removeBody` fills the hole with its last body,
 * so removing one region's body moves another's — possibly another region's, possibly anything
 * else in the world. It returns the index that moved, and this uses it. **What it gives up** is any
 * other caller's body index in the same world: a removal moves whatever was last, and only the
 * caller that asked for it hears where it went. A world that also holds bodies somebody else tracks
 * by index needs those removed through one place that follows them all.
 */
import type { BodyDesc } from './bodies.ts';
import type { PhysicsWorld } from './world.ts';

export class StaticRegions {
  private readonly bodyOfRegion = new Map<number, number>();
  /** The region each body index belongs to, or −1. Grows with the world. */
  private regionOfBody = new Int32Array(64).fill(-1);

  constructor(private readonly world: PhysicsWorld) {}

  /** How many regions are in the world. */
  get size(): number {
    return this.bodyOfRegion.size;
  }

  has(region: number): boolean {
    return this.bodyOfRegion.has(region);
  }

  /** The body index a region stands as now, or −1. It changes as other regions are removed. */
  bodyOf(region: number): number {
    return this.bodyOfRegion.get(region) ?? -1;
  }

  /** Add a region as one body. A region already in the world is refused rather than doubled. */
  add(region: number, desc: BodyDesc): number {
    if (this.bodyOfRegion.has(region)) {
      throw new Error(
        `StaticRegions: region ${region} is already in the world — remove it before adding it ` +
          'again, or its scenery would collide twice',
      );
    }
    const body = this.world.addBody(desc);
    while (body >= this.regionOfBody.length) {
      const wider = new Int32Array(this.regionOfBody.length * 2).fill(-1);
      wider.set(this.regionOfBody);
      this.regionOfBody = wider;
    }
    this.regionOfBody[body] = region;
    this.bodyOfRegion.set(region, body);
    return body;
  }

  /** Take a region out of the world. A region that is not there is nothing to remove. */
  remove(region: number): void {
    const body = this.bodyOfRegion.get(region);
    if (body === undefined) return;
    this.bodyOfRegion.delete(region);
    const moved = this.world.removeBody(body);
    if (moved < 0) {
      this.regionOfBody[body] = -1;
      return;
    }
    /* The body that was last now sits at `body`: whichever region owned it follows it there. */
    const owner = this.regionOfBody[moved] ?? -1;
    this.regionOfBody[body] = owner;
    this.regionOfBody[moved] = -1;
    if (owner >= 0) this.bodyOfRegion.set(owner, body);
  }
}

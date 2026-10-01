/**
 * The city's doors as places people go: every venue by kind, each tied to the pavement node nearest
 * its door, and a venue of a kind found within a radius of somewhere.
 *
 * A draw among the candidates rather than the nearest, so two neighbours sent to "a café within
 * 400 m" do not always meet at the same one — the radius is the reference's, the draw is ours.
 */
import type { PavementGraph } from './pavements';

export interface VenueData {
  readonly x: number;
  readonly z: number;
  readonly kind: string;
}

export class Places {
  readonly count: number;
  readonly x: Float32Array;
  readonly z: Float32Array;
  /** The pavement node nearest each venue's door. */
  readonly node: Int32Array;
  private readonly byKind = new Map<string, Int32Array>();

  constructor(venues: readonly VenueData[], pavements: PavementGraph) {
    this.count = venues.length;
    this.x = Float32Array.from(venues.map((v) => v.x));
    this.z = Float32Array.from(venues.map((v) => v.z));
    this.node = Int32Array.from(venues.map((v) => pavements.nearest(v.x, v.z)));
    const kinds = new Map<string, number[]>();
    venues.forEach((v, i) => {
      const list = kinds.get(v.kind) ?? [];
      list.push(i);
      kinds.set(v.kind, list);
    });
    for (const [kind, list] of kinds) this.byKind.set(kind, Int32Array.from(list));
  }

  /**
   * A venue of `kind` within `radius` of (x, z), drawn by `u` in [0, 1) among those; the nearest of
   * the kind when none is that close; −1 when the city has none.
   */
  pick(kind: string, x: number, z: number, radius: number, u: number): number {
    const list = this.byKind.get(kind);
    if (list === undefined || list.length === 0) return -1;
    const r2 = radius * radius;
    let within = 0;
    let nearest = -1;
    let nearestD = Infinity;
    for (let i = 0; i < list.length; i++) {
      const v = list[i] as number;
      const d = ((this.x[v] as number) - x) ** 2 + ((this.z[v] as number) - z) ** 2;
      if (d <= r2) within++;
      if (d < nearestD) {
        nearestD = d;
        nearest = v;
      }
    }
    if (within === 0) return nearest;
    let chosen = Math.floor(u * within);
    for (let i = 0; i < list.length; i++) {
      const v = list[i] as number;
      const d = ((this.x[v] as number) - x) ** 2 + ((this.z[v] as number) - z) ** 2;
      if (d <= r2 && chosen-- === 0) return v;
    }
    return nearest;
  }
}

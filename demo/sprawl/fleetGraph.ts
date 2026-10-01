/**
 * What a fleet needs of the lane graph beyond the graph itself: the turns that feed each lane, for
 * a merge to look across, and a lane drawn in proportion to its length, for a car to be put on.
 */
import type { LaneGraph } from './laneEdges';

export class FleetGraph {
  /** Turns into each lane: `feed[feedFirst[e]]` up to `feed[feedFirst[e + 1]]`. */
  readonly feedFirst: Uint32Array;
  readonly feed: Uint32Array;
  private readonly lanes: Uint32Array;
  private readonly laneSum: Float64Array;

  constructor(graph: LaneGraph) {
    const lanes: number[] = [];
    for (let e = 0; e < graph.count; e++) if (graph.turn[e] === 0) lanes.push(e);
    this.lanes = Uint32Array.from(lanes);
    this.laneSum = new Float64Array(lanes.length + 1);
    lanes.forEach((e, i) => {
      this.laneSum[i + 1] = (this.laneSum[i] as number) + (graph.length[e] as number);
    });
    const feeds: number[][] = Array.from({ length: graph.count }, () => []);
    for (let e = 0; e < graph.count; e++) {
      if (graph.turn[e] === 0) continue;
      for (let i = graph.first[e] as number; i < (graph.first[e + 1] as number); i++) {
        feeds[graph.next[i] as number]?.push(e);
      }
    }
    this.feedFirst = new Uint32Array(graph.count + 1);
    feeds.forEach((f, e) => {
      this.feedFirst[e + 1] = (this.feedFirst[e] as number) + f.length;
    });
    this.feed = Uint32Array.from(feeds.flat());
  }

  /** The lane a draw `u` in [0, 1) lands on, each lane as likely as it is long. */
  laneAt(u: number): number {
    const { lanes, laneSum } = this;
    const pick = u * (laneSum[lanes.length] as number);
    let lo = 0;
    let hi = lanes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((laneSum[mid + 1] as number) > pick) hi = mid;
      else lo = mid + 1;
    }
    return lanes[lo] as number;
  }
}

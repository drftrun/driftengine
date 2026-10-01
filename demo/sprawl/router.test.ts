import { mulberry32 } from '../../packages/core/src/index';
import { describe, expect, it } from 'vitest';

import { Router } from './router';

/** Neighbour lists from `[from, to, length]` steps, both ways. */
function graph(nodes: number, steps: readonly [number, number, number][]): Router {
  const both = steps.flatMap(([a, b, l]) => [
    [a, b, l],
    [b, a, l],
  ]);
  both.sort((p, q) => (p[0] as number) - (q[0] as number));
  const first = new Uint32Array(nodes + 1);
  for (const [a] of both) first[(a as number) + 1] = (first[(a as number) + 1] as number) + 1;
  for (let i = 0; i < nodes; i++) first[i + 1] = (first[i + 1] as number) + (first[i] as number);
  return new Router(
    first,
    Uint32Array.from(both.map((p) => p[1] as number)),
    Float32Array.from(both.map((p) => p[2] as number)),
  );
}

describe('the router', () => {
  it('THE SHORTEST WALK IS THE SHORTEST IN METRES, NOT IN STEPS', () => {
    /* 0–1–4 is two steps and 11 m; 0–2–3–4 is three and 9 m; 0–5–6–4 is three and 10 m; and
       0–4 is one step of 9.5 m, which the search must not settle before the 9 m walk. */
    const router = graph(7, [
      [0, 4, 9.5],
      [0, 1, 1],
      [1, 4, 10],
      [0, 2, 4],
      [2, 3, 4],
      [3, 4, 1],
      [0, 5, 3],
      [5, 6, 3],
      [6, 4, 4],
    ]);
    const out = new Uint16Array(8);
    expect(router.route(0, 4, out, 0, 8)).toBe(3);
    expect(Array.from(out.subarray(0, 3))).toEqual([2, 3, 4]);
    /* A node nothing reaches. */
    const apart = graph(3, [[0, 1, 1]]);
    expect(apart.route(0, 2, out, 0, 8)).toBe(0);
  });

  it('ON A HUNDRED RANDOM GRAPHS A ROUTE IS AS SHORT AS AN EXHAUSTIVE SEARCH SAYS IT CAN BE', () => {
    const random = mulberry32(5);
    const out = new Uint16Array(64);
    for (let trial = 0; trial < 100; trial++) {
      const nodes = 12;
      const steps: [number, number, number][] = [];
      for (let i = 0; i < 30; i++) {
        const a = Math.floor(random() * nodes);
        const b = Math.floor(random() * nodes);
        if (a !== b) steps.push([a, b, 1 + Math.floor(random() * 20)]);
      }
      /* The oracle: relax every step until nothing shortens. */
      const best = new Array<number>(nodes).fill(Infinity);
      best[0] = 0;
      for (let pass = 0; pass < nodes; pass++) {
        for (const [a, b, l] of steps) {
          best[b] = Math.min(best[b] as number, (best[a] as number) + l);
          best[a] = Math.min(best[a] as number, (best[b] as number) + l);
        }
      }
      const router = graph(nodes, steps);
      const length = (a: number, b: number): number =>
        Math.min(
          ...steps
            .filter(([p, q]) => (p === a && q === b) || (p === b && q === a))
            .map((s) => s[2]),
        );
      for (let to = 1; to < nodes; to++) {
        const n = router.route(0, to, out, 0, 64);
        let walked = 0;
        let at = 0;
        for (let i = 0; i < n; i++) {
          walked += length(at, out[i] as number);
          at = out[i] as number;
        }
        expect(n === 0 ? Infinity : walked).toBe(best[to]);
      }
    }
  });
});

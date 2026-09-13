/**
 * What `MeshBuilder.build()` costs, and what it used to.
 *
 * **A benchmark rather than a test**, in `island-bench.ts`'s shape: nothing here asserts, because a
 * wall-clock number on one machine is evidence and not a contract. `npm run bench:mesh`.
 *
 * **Why the number matters to somebody other than this repository.** A consumer streaming a world
 * builds its geometry between frames, and `build()` was one uninterruptible call: measured at
 * 41.9 ms here for 110,628 triangles, two and a half frames at 16.7 ms. That is what made them cap
 * a batch at a triangle count tuned to one laptop — 32,000, which is seven milliseconds there and
 * unknown on a phone — and overshoot it by whatever the last object was, up to 47,040 against a cap
 * of 32,000, because a batch is told what went into it after it went in.
 *
 * Two things fixed it and both are visible below: the builder writes into growable typed arrays as
 * geometry arrives, so `build()` is a slice rather than ten conversions of boxed doubles; and the
 * five "did anything differ from the default" questions it asked by scanning every vertex are now
 * answered by a flag the write sets. **41.9 ms to 1.6 ms.**
 *
 * `triangleCount` is printed beside them because it is the other half of the same report: a caller
 * can now ask how big a builder has become instead of tallying it, which is what lets a cap be
 * honest rather than approximate.
 */
import { MeshBuilder } from '../src/geometry/meshBuilder';

/** The consumer's own figure for one region's street-plate lettering, at twelve triangles a box. */
const TRIANGLES = 110628;
const BOXES = Math.round(TRIANGLES / 12);
const RUNS = 7;

function fill(): MeshBuilder {
  const builder = new MeshBuilder();
  for (let i = 0; i < BOXES; i++) {
    builder.addBox(i * 0.01, 0, (i % 37) * 0.01, 0.004, 0.004, 0.001, [0.9, 0.9, 0.9]);
  }
  return builder;
}

const median = (values: number[]): number =>
  values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)] as number;

/* Warm up: the first run of anything in a fresh isolate measures the compiler. */
for (let i = 0; i < 2; i++) fill().build();

const fills: number[] = [];
const builds: number[] = [];
let triangles = 0;
let vertices = 0;
for (let run = 0; run < RUNS; run++) {
  let started = performance.now();
  const builder = fill();
  fills.push(performance.now() - started);

  /* Asked before building, which is the point of it: no mesh exists yet. */
  triangles = builder.triangleCount;
  vertices = builder.vertexCountSoFar;

  started = performance.now();
  const mesh = builder.build();
  builds.push(performance.now() - started);
  if (mesh.indices.length / 3 !== triangles) {
    throw new Error(
      `triangleCount said ${triangles} and build() produced ${mesh.indices.length / 3}. ` +
        'Those are the same question and a caller batching by size is trusting the first one.',
    );
  }
}

console.log(`\n  ${triangles} triangles, ${vertices} vertices, median of ${RUNS}`);
console.log(`    fill    ${median(fills).toFixed(1)} ms   the caller's own loop`);
console.log(`    build   ${median(builds).toFixed(1)} ms   the stop, against 41.9 ms before`);
console.log(`    total   ${(median(fills) + median(builds)).toFixed(1)} ms\n`);

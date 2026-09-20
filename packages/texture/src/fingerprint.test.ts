/**
 * A texture cannot change what the simulation computes.
 *
 * Sampling is view-dependent and time is an argument, so this ought to be true by construction —
 * which is exactly why it is asserted. The interesting case is the animated one: a DriftTexture
 * sampled at simulation time is a function of state the fingerprint already covers, and a decoder
 * that reached for a clock would break that silently and only under replay.
 *
 * **Three runs, because one proves nothing.** A run that samples nothing and a run that samples
 * everything must agree — that is the claim that decoding has no side effect on state. Then the
 * same simulation run twice at *different wall-clock times* must agree — that is the claim that
 * `t` is the caller's. And a fourth run, deliberately sampling at the wall clock instead, must
 * **differ**: without it the test above passes for a decoder that reads a clock nobody noticed,
 * on a machine fast enough that two runs happened in the same millisecond.
 */
import { describe, expect, test } from 'vitest';

import {
  DECODE_OP,
  addDecodeNode,
  createDecodeGraph,
  createDecodeRegisters,
  decodeCpu,
  type DecodeGraph,
  type DecodeResources,
} from './index.ts';

const TICKS = 240;
const DT = 1 / 60;

/** A decode program with a time-varying node in it, which is the case that can fail. */
function animatedGraph(): DecodeGraph {
  const graph = createDecodeGraph(3);
  /* Flipbook index, then a procedural field, composited: two different readers of `t`. */
  addDecodeNode(graph, DECODE_OP.FLIPBOOK_INDEX, 16, 12, 0);
  addDecodeNode(graph, DECODE_OP.PROCEDURAL_FBM, 7, 3, 1);
  addDecodeNode(graph, DECODE_OP.COMPOSITE, 0, 1, 2);
  graph.result = 2;
  return graph;
}

const RESOURCES: DecodeResources = { latents: [], blocks: [], networks: [] };

interface World {
  frame: number;
  heat: number;
  drift: number;
}

/** FNV-1a over the eight bytes of every value, which is the construction `Fingerprint` uses. */
function digestOf(values: readonly number[]): string {
  const bytes = new DataView(new ArrayBuffer(8));
  let low = 0x811c9dc5;
  let high = 0x811c9dc5;
  for (const value of values) {
    bytes.setFloat64(0, value);
    for (let at = 0; at < 8; at += 1) {
      low = Math.imul(low ^ bytes.getUint8(at), 0x01000193) >>> 0;
      high = Math.imul(high ^ (low & 0xff), 0x01000193) >>> 0;
    }
  }
  return (high >>> 0).toString(16).padStart(8, '0') + (low >>> 0).toString(16).padStart(8, '0');
}

/**
 * Run the fixed simulation.
 *
 * `sample` decides whether textures are decoded at all; `clock` decides what time they are decoded
 * at. `feed` decides whether what comes back reaches the world — which is the difference between
 * "decoding has no side effect" and "decoding at the wrong time changes the answer".
 */
function run(options: { sample: boolean; feed?: boolean; clock?: () => number }): {
  digest: string;
  samples: number;
} {
  const world: World = { frame: 0, heat: 1, drift: 0 };
  const graph = animatedGraph();
  const registers = createDecodeRegisters();
  const out = new Float32Array(4);
  const trace: number[] = [];
  let samples = 0;

  for (let tick = 0; tick < TICKS; tick += 1) {
    world.frame += 1;
    world.heat = (world.heat * 31 + world.frame) % 1000003;

    if (options.sample) {
      /* Simulation time, unless the caller deliberately asks for the wrong clock. */
      const t = options.clock === undefined ? world.frame * DT : options.clock();
      const u = (world.frame % 17) / 17;
      const v = (world.frame % 23) / 23;
      decodeCpu(graph, RESOURCES, u, v, t, out, registers);
      samples += 1;
      if (options.feed === true) world.drift += out[0] as number;
    }

    trace.push(world.frame, world.heat, world.drift);
  }
  return { digest: digestOf(trace), samples };
}

describe('sampling a texture does not change the simulation', () => {
  test('a run that samples everything fingerprints like one that samples nothing', () => {
    const sampled = run({ sample: true });
    const bare = run({ sample: false });
    expect(sampled.samples).toBe(TICKS);
    expect(bare.samples).toBe(0);
    expect(sampled.digest).toBe(bare.digest);
  });

  test('and the sampling really happened, so the agreement is not an empty loop', () => {
    /* A decode that returned nothing would also agree with a run that decoded nothing. */
    const out = new Float32Array(4);
    const registers = createDecodeRegisters();
    decodeCpu(animatedGraph(), RESOURCES, 0.3, 0.7, 2.5, out, registers);
    const later = new Float32Array(4);
    decodeCpu(animatedGraph(), RESOURCES, 0.3, 0.7, 9.5, later, registers);
    expect([...out]).not.toEqual([...later]);
  });
});

describe('an animated texture is a function of simulation time', () => {
  test('two runs at different wall-clock times fingerprint identically', async () => {
    /*
     * **The case a static texture would pass while a clock-reading implementation shipped.** The
     * runs are separated in real time on purpose; `t` is the caller's, so nothing about when the
     * second one happened can reach the digest.
     */
    const first = run({ sample: true, feed: true });
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
    const second = run({ sample: true, feed: true });
    expect(first.digest).toBe(second.digest);
    /* And the samples reached the world, so the digest is one a wrong time could have moved. */
    expect(run({ sample: false }).digest).not.toBe(first.digest);
  });

  test('a run that reads a wall clock instead diverges, which is what makes the test above mean something', () => {
    /*
     * **The clock is injected rather than read, and the first version of this test was flaky for
     * the reason that matters.** It separated two wall-clock runs by a real 25 ms and asserted they
     * differed — but `FLIPBOOK_INDEX` quantises time into frames at twelve a second, so anything
     * under 83 ms lands on the same frame and the two digests matched. A test whose result depends
     * on how long a `setTimeout` actually took is a test that fails on a loaded machine and passes
     * on a quiet one.
     *
     * So the two wrong clocks are half a second apart, which is six flipbook frames, and the
     * numbers are chosen rather than measured.
     */
    const honest = run({ sample: true, feed: true });
    const first = run({ sample: true, feed: true, clock: () => 1000 });
    const second = run({ sample: true, feed: true, clock: () => 1000.5 });
    expect(first.digest).not.toBe(honest.digest);
    expect(second.digest).not.toBe(first.digest);
  });
});

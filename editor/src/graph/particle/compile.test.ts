import { describe, expect, it } from 'vitest';
import { ParticlePool } from '@driftengine/core';
import { addLink, addNode, createGraph, nodeOf, type Graph } from '../model.ts';
import { PARTICLE_VOCABULARY, evaluateCurve } from './nodes.ts';
import {
  compileParticleGraph,
  createEmitStream,
  pumpEmitter,
  type CompiledEmitter,
} from './compile.ts';

declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; import: string; eager: true },
    ): Record<string, string>;
  }
}

function params(graph: Graph, id: number, values: Record<string, number>): number {
  const node = nodeOf(graph, id);
  if (node === undefined) throw new Error(`no node ${String(id)}`);
  node.params = { ...values };
  return id;
}

/** A plume: ten a second, living two seconds, growing and reddening as it goes. */
function plume(): Graph {
  const graph = createGraph();
  const emitter = addNode(graph, 'emitter', 0, 0);
  const rate = params(graph, addNode(graph, 'constant', 0, 0), { value: 10 });
  const life = params(graph, addNode(graph, 'constant', 0, 0), { value: 2 });
  const size = params(graph, addNode(graph, 'curve', 0, 0), { start: 0.5, end: 2 });
  const colour = params(graph, addNode(graph, 'gradient', 0, 0), {
    r0: 1,
    g0: 0,
    b0: 0,
    r1: 0,
    g1: 0,
    b1: 1,
  });
  const velocity = params(graph, addNode(graph, 'vector', 0, 0), { x: 0, y: 3, z: 0 });
  const spread = params(graph, addNode(graph, 'constant', 0, 0), { value: 1.5 });
  const seed = params(graph, addNode(graph, 'constant', 0, 0), { value: 1234 });
  const rise = params(graph, addNode(graph, 'constant', 0, 0), { value: 0.5 });

  const wire = (from: number, port: number): void => {
    addLink(graph, PARTICLE_VOCABULARY, { from, fromPort: 0, to: emitter, toPort: port });
  };
  wire(rate, 0);
  wire(life, 1);
  wire(velocity, 2);
  wire(spread, 3);
  wire(size, 4);
  wire(colour, 5);
  wire(seed, 10);
  wire(rise, 9);
  return graph;
}

function compiled(graph: Graph): CompiledEmitter {
  const { emitter, error } = compileParticleGraph(graph);
  if (emitter === null) throw new Error(error ?? 'no emitter');
  return emitter;
}

describe('a graph compiles to the parameters the pool already takes', () => {
  it('fills both records, written out by hand', () => {
    expect(compiled(plume())).toEqual({
      pool: {
        /* Ten a second for two seconds is twenty alive at once. */
        capacity: 20,
        lifeSec: 2,
        sizeStart: 0.5,
        sizeEnd: 2,
        colorStart: [1, 0, 0],
        colorEnd: [0, 0, 1],
        gravity: 0,
        drag: 0,
        rise: 0.5,
        alphaStart: 1,
        alphaEnd: 0,
      },
      emission: {
        rate: 10,
        velocityX: 0,
        velocityY: 3,
        velocityZ: 0,
        spread: 1.5,
        seed: 1234,
      },
    });
  });

  it('rounds a fractional headcount up, not down', () => {
    const graph = plume();
    /* Ten a second for a quarter of a second is two and a half alive: three, so the third is not
       recycled while it is still on screen. The floor at one hides this case entirely, which is
       why it is tested above one rather than at it. */
    params(graph, 3, { value: 0.25 });
    expect(compiled(graph).pool.capacity).toBe(3);
  });

  it('derives a capacity that never reaches zero', () => {
    const graph = plume();
    params(graph, 2, { value: 0.2 });
    /* A fifth of a particle a second for two seconds rounds up to one, not down to none. */
    expect(compiled(graph).pool.capacity).toBe(1);
    expect(() => new ParticlePool(compiled(graph).pool)).not.toThrow();
  });

  it('is plain data a project can write beside the graph', () => {
    /*
     * There is no particle serialisation in this engine to round-trip through — the plan assumed
     * one — so what a compiled emitter owes instead is that it is data: no functions, no `NaN`, no
     * `undefined`, nothing JSON loses. That is what lets a build step save it next to the graph.
     */
    const emitter = compiled(plume());
    expect(JSON.parse(JSON.stringify(emitter))).toEqual(emitter);
  });
});

describe('a curve is evaluated where the runtime evaluates it', () => {
  it('agrees with the pool at the middle of a particle life', () => {
    const graph = plume();
    const emitter = compiled(graph);
    const pool = new ParticlePool(emitter.pool);
    const stream = createEmitStream(emitter.emission.seed);

    /* Ten a second for a tenth of a second is exactly one particle. */
    expect(pumpEmitter(pool, emitter, stream, 0.1)).toBe(1);
    pool.update(1);

    const curve = nodeOf(graph, 4);
    if (curve === undefined) throw new Error('no curve node');
    /* Half of a two-second life: 0.5 + (2 − 0.5) × 0.5 = 1.25, from both sides. */
    expect(evaluateCurve(curve, 0.5)).toBe(1.25);
    expect(pool.particles.ages[0]).toBeCloseTo(0.5, 6);
    expect(pool.particles.sizes[0]).toBeCloseTo(1.25, 5);
    /* And the gradient and the alpha ramp land on their own midpoints. */
    expect(pool.particles.colors[0]).toBeCloseTo(0.5, 5);
    expect(pool.particles.colors[2]).toBeCloseTo(0.5, 5);
    expect(pool.particles.alphas[0]).toBeCloseTo(0.5, 5);
  });

  it('takes a plain number as a curve that does not move', () => {
    const graph = plume();
    const flat = params(graph, addNode(graph, 'constant', 0, 0), { value: 0.75 });
    addLink(graph, PARTICLE_VOCABULARY, { from: flat, fromPort: 0, to: 1, toPort: 4 });
    const { pool } = compiled(graph);
    expect([pool.sizeStart, pool.sizeEnd]).toEqual([0.75, 0.75]);
  });
});

describe('randomness is a seed', () => {
  function run(emitter: CompiledEmitter, seed: number): readonly number[] {
    const pool = new ParticlePool(emitter.pool);
    const stream = createEmitStream(seed);
    for (let step = 0; step < 60; step += 1) {
      pumpEmitter(pool, emitter, stream, 1 / 60);
      pool.update(1 / 60);
    }
    return [...pool.particles.positions.slice(0, pool.instances.count * 3)];
  }

  /** Every emission a run makes, without a pool in the way. */
  function record(
    emitter: CompiledEmitter,
    seed: number,
    steps: number,
  ): { vx: number[]; seeds: number[] } {
    const vx: number[] = [];
    const seeds: number[] = [];
    const sink = {
      emit: (
        _x: number,
        _y: number,
        _z: number,
        vxOf: number,
        _vy: number,
        _vz: number,
        seedOf: number,
      ): void => {
        vx.push(vxOf);
        seeds.push(seedOf);
      },
    };
    const stream = createEmitStream(seed);
    for (let step = 0; step < steps; step += 1) pumpEmitter(sink, emitter, stream, 1 / 60);
    return { vx, seeds };
  }

  it('reaches the same plume twice from one seed', () => {
    const emitter = compiled(plume());
    const first = run(emitter, emitter.emission.seed);
    expect(first.length).toBeGreaterThan(9);
    expect(run(emitter, emitter.emission.seed)).toEqual(first);
  });

  it('reaches a different one from another seed', () => {
    const emitter = compiled(plume());
    expect(run(emitter, 99)).not.toEqual(run(emitter, emitter.emission.seed));
  });

  it('emits the fractional part a step owes rather than dropping it', () => {
    /* Thirty a second at a sixtieth of a second: one every other step, never none at all. */
    const emitter = compiled(plume());
    const slower: CompiledEmitter = { ...emitter, emission: { ...emitter.emission, rate: 30 } };
    const stream = createEmitStream(1);
    const counted: number[] = [];
    const sink = { emit: (): void => {} };
    for (let step = 0; step < 6; step += 1) {
      counted.push(pumpEmitter(sink, slower, stream, 1 / 60));
    }
    expect(counted).toEqual([0, 1, 0, 1, 0, 1]);
  });

  it('spreads the velocities across the cone, and gives every particle its own seed', () => {
    /*
     * Reproducibility on its own is a weak claim: a generator that returns almost the same number
     * every time is perfectly reproducible and produces a plume that is a line. Both halves of
     * "seeded randomness" are needed, so both are measured.
     */
    const emitter = compiled(plume());
    const seen = record(emitter, 1234, 300);
    /*
     * Forty-nine and not fifty: ten a second times a sixtieth is a shade under a sixth in binary,
     * so three hundred steps come to 49.999999999999986 rather than 50. The fiftieth is owed, not
     * lost — one more step delivers it, which is the whole reason the carry exists.
     */
    expect(seen.vx.length).toBe(49);
    expect(record(emitter, 1234, 301).vx.length).toBe(50);

    /* The cone is ±1.5 wide. Fifty draws should cover most of it; a generator that barely moves
       parks every particle at one edge. */
    expect(Math.max(...seen.vx) - Math.min(...seen.vx)).toBeGreaterThan(2);
    expect(new Set(seen.seeds).size).toBe(seen.seeds.length);
  });

  it('gives every particle the same velocity when nothing is spread', () => {
    const graph = plume();
    params(graph, 7, { value: 0 });
    const seen = record(compiled(graph), 1234, 300);
    expect(new Set(seen.vx)).toEqual(new Set([0]));
  });

  it('never reaches the global generator, and the sources say so', () => {
    /*
     * The double-run test above would still pass if a call were added somewhere it did not affect a
     * position. This reads the directory instead, so the claim cannot rot quietly — the same reason
     * `ParticlePool.emit` takes a seed rather than reaching for a global.
     *
     * **It looks for a call and not for the name**, and the first version looked for the name and
     * failed on `compile.ts` — whose header says, in prose, that it never makes one. Prose about a
     * rule is not a breach of it. The pattern is checked against something that is, first, because
     * a scanner whose regex is broken passes silently and is the test that cannot fail.
     */
    const CALL = /\bMath\s*\.\s*random\s*\(/;
    expect(CALL.test('const r = Math.random();')).toBe(true);
    expect(CALL.test('const r = Math . random ();')).toBe(true);
    expect(CALL.test('a comment saying never to use Math.random for this')).toBe(false);

    const sources = import.meta.glob('./*.ts', { query: '?raw', import: 'default', eager: true });
    /* Named rather than counted: the bundler leaves this file out of its own glob, so a count
       would have been two either way and a file added later would slip past a floor. */
    expect(Object.keys(sources).sort()).toEqual(['./compile.ts', './nodes.ts']);
    for (const [name, source] of Object.entries(sources)) {
      expect(CALL.test(source), `${name} calls the global generator`).toBe(false);
    }
  });
});

describe('what the emitter has no parameter for is refused by name', () => {
  it('names the turbulence node rather than dropping it', () => {
    const graph = plume();
    const strength = params(graph, addNode(graph, 'constant', 0, 0), { value: 2 });
    const noise = addNode(graph, 'turbulence', 0, 0);
    addLink(graph, PARTICLE_VOCABULARY, { from: strength, fromPort: 0, to: noise, toPort: 0 });
    addLink(graph, PARTICLE_VOCABULARY, { from: noise, fromPort: 0, to: 1, toPort: 2 });

    const { emitter, error } = compileParticleGraph(graph);
    expect(emitter).toBeNull();
    expect(error).toContain('turbulence');
    expect(error).toContain('velocity');
  });

  it('refuses a graph with no emitter at all', () => {
    const graph = createGraph();
    addNode(graph, 'constant', 0, 0);
    expect(compileParticleGraph(graph).error).toContain('no emitter node');
  });

  it('refuses two emitters, naming the second', () => {
    /*
     * Wired, because the model's own checks run first in all three of this editor's compilers and
     * an unwired second emitter fails on its missing rate instead. An output fanning out to two
     * inputs is what the model is for.
     */
    const graph = plume();
    const second = addNode(graph, 'emitter', 0, 0);
    addLink(graph, PARTICLE_VOCABULARY, { from: 2, fromPort: 0, to: second, toPort: 0 });
    addLink(graph, PARTICLE_VOCABULARY, { from: 3, fromPort: 0, to: second, toPort: 1 });
    const { error } = compileParticleGraph(graph);
    expect(error).toContain('2 emitter nodes');
    expect(error).toContain('node 10');
  });

  it('refuses an emitter with no rate, which the model already does', () => {
    const graph = createGraph();
    addNode(graph, 'emitter', 0, 0);
    expect(compileParticleGraph(graph).error).toContain('"rate"');
  });

  it('refuses a kind the vocabulary does not have', () => {
    const graph = createGraph();
    addNode(graph, 'attractor', 0, 0);
    expect(compileParticleGraph(graph).error).toContain('not in the vocabulary');
  });
});

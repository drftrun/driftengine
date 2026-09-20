/**
 * A particle graph, as the parameters the engine's emitter already takes.
 *
 * **The target is `ParticlePoolOptions`, which exists**, plus the emission the pool deliberately
 * does not own. `ParticlePool` is a simulation over a ring buffer; *when* to emit and *with what
 * velocity* is the caller's, and has been since the pool was written. So a compiled graph is two
 * records: what the pool is constructed with, and what drives `emit`. Inventing a third
 * representation in between would be a second description of an emitter to keep in step.
 *
 * **Randomness is a seed and never `Math.random`.** The pool's own `emit` already takes one rather
 * than reaching for a global, for the reason its comment gives — a replay has to look the same on
 * the way to being a clip — and the emission stream here is the same discipline one level up: a
 * state word advanced by an integer recurrence, so two runs from one seed are identical and a run
 * from another is not. `Math.random` appears nowhere in this directory, and a test reads the
 * sources to say so rather than trusting that nobody adds one.
 *
 * **The capacity is derived rather than asked for.** A rate and a lifetime already say how many
 * particles are alive at once — `rate × life` — and a capacity somebody typed is a number that
 * disagrees with them the moment either changes, by silently dropping the oldest particle. The one
 * thing it must never be is zero, which the pool refuses.
 */
import type { ParticlePoolOptions } from '@driftengine/core';
import { inputLink, nodeOf, validateGraph, type Graph, type GraphNode } from '../model.ts';
import { EMITTER_INPUTS, PARTICLE_VOCABULARY, evaluateCurve } from './nodes.ts';

/** What drives `ParticlePool.emit`, which the pool itself has never owned. */
export interface EmissionOptions {
  /** Particles a second. */
  readonly rate: number;
  readonly velocityX: number;
  readonly velocityY: number;
  readonly velocityZ: number;
  /** Half-width of the random cone about that velocity, in metres a second. */
  readonly spread: number;
  /** Where this stream starts. A number, because a replay has to reach the same plume. */
  readonly seed: number;
}

export interface CompiledEmitter {
  readonly pool: ParticlePoolOptions;
  readonly emission: EmissionOptions;
}

export interface CompiledParticleGraph {
  readonly emitter: CompiledEmitter | null;
  readonly error: string | null;
}

const RATE = EMITTER_INPUTS.indexOf('rate');
const LIFE = EMITTER_INPUTS.indexOf('life');
const VELOCITY = EMITTER_INPUTS.indexOf('velocity');
const SPREAD = EMITTER_INPUTS.indexOf('spread');
const SIZE = EMITTER_INPUTS.indexOf('size');
const COLOUR = EMITTER_INPUTS.indexOf('colour');
const ALPHA = EMITTER_INPUTS.indexOf('alpha');
const GRAVITY = EMITTER_INPUTS.indexOf('gravity');
const DRAG = EMITTER_INPUTS.indexOf('drag');
const RISE = EMITTER_INPUTS.indexOf('rise');
const SEED = EMITTER_INPUTS.indexOf('seed');

export function compileParticleGraph(graph: Graph): CompiledParticleGraph {
  const invalid = validateGraph(graph, PARTICLE_VOCABULARY, { forCompile: true });
  if (invalid !== null) return { emitter: null, error: invalid };

  const emitters = graph.nodes.filter((node) => node.kind === 'emitter');
  if (emitters.length === 0) {
    return { emitter: null, error: 'the graph has no emitter node, so nothing says what to emit' };
  }
  if (emitters.length > 1) {
    const extra = emitters[1] as GraphNode;
    return {
      emitter: null,
      error: `the graph has ${String(emitters.length)} emitter nodes; node ${String(extra.id)} is the second, and one emitter is one particle system`,
    };
  }
  const emitter = emitters[0] as GraphNode;

  /* Every wire has to end at a parameter. The one that cannot is named rather than ignored. */
  for (let port = 0; port < EMITTER_INPUTS.length; port += 1) {
    const source = feeding(graph, emitter, port);
    if (source === undefined) continue;
    if (EXPRESSIBLE.has(source.kind)) continue;
    return {
      emitter: null,
      error: `node ${String(source.id)} (${source.kind}) feeds "${String(EMITTER_INPUTS[port])}" and the emitter has no parameter for it`,
    };
  }

  const life = numberAt(graph, emitter, LIFE, 1);
  const rate = numberAt(graph, emitter, RATE, 0);
  const size = curveAt(graph, emitter, SIZE, 1, 1);
  const alpha = curveAt(graph, emitter, ALPHA, 1, 0);
  const colour = gradientAt(graph, emitter, COLOUR);
  const velocity = vectorAt(graph, emitter, VELOCITY);

  return {
    emitter: {
      pool: {
        capacity: Math.max(1, Math.ceil(rate * life)),
        lifeSec: life,
        sizeStart: size[0],
        sizeEnd: size[1],
        colorStart: colour[0],
        colorEnd: colour[1],
        gravity: numberAt(graph, emitter, GRAVITY, 0),
        drag: numberAt(graph, emitter, DRAG, 0),
        rise: numberAt(graph, emitter, RISE, 0),
        alphaStart: alpha[0],
        alphaEnd: alpha[1],
      },
      emission: {
        rate,
        velocityX: velocity[0],
        velocityY: velocity[1],
        velocityZ: velocity[2],
        spread: numberAt(graph, emitter, SPREAD, 0),
        seed: numberAt(graph, emitter, SEED, 1),
      },
    },
    error: null,
  };
}

/** The kinds that are a value the emitter has somewhere to put. `turbulence` is not one. */
const EXPRESSIBLE = new Set(['constant', 'curve', 'gradient', 'vector']);

function feeding(graph: Graph, node: GraphNode, port: number): GraphNode | undefined {
  const link = inputLink(graph, node.id, port);
  return link === undefined ? undefined : nodeOf(graph, link.from);
}

function numberAt(graph: Graph, node: GraphNode, port: number, fallback: number): number {
  const source = feeding(graph, node, port);
  if (source === undefined) return fallback;
  if (source.kind === 'curve') return evaluateCurve(source, 0);
  return source.params['value'] ?? fallback;
}

function curveAt(
  graph: Graph,
  node: GraphNode,
  port: number,
  start: number,
  end: number,
): [number, number] {
  const source = feeding(graph, node, port);
  if (source === undefined) return [start, end];
  /* A plain number where a curve was expected is a constant curve, not an error: somebody who
     wants a size that does not change should not have to say it twice. */
  if (source.kind !== 'curve') {
    const flat = source.params['value'] ?? start;
    return [flat, flat];
  }
  return [evaluateCurve(source, 0), evaluateCurve(source, 1)];
}

function gradientAt(
  graph: Graph,
  node: GraphNode,
  port: number,
): [[number, number, number], [number, number, number]] {
  const source = feeding(graph, node, port);
  if (source === undefined) {
    return [
      [1, 1, 1],
      [1, 1, 1],
    ];
  }
  const at = (name: string): number => source.params[name] ?? 1;
  return [
    [at('r0'), at('g0'), at('b0')],
    [at('r1'), at('g1'), at('b1')],
  ];
}

function vectorAt(graph: Graph, node: GraphNode, port: number): [number, number, number] {
  const source = feeding(graph, node, port);
  if (source === undefined) return [0, 0, 0];
  return [source.params['x'] ?? 0, source.params['y'] ?? 0, source.params['z'] ?? 0];
}

/**
 * Where a stream of emissions comes from.
 *
 * `carry` is the fraction of a particle owed from the last step, and it is why a rate of thirty a
 * second at a sixtieth of a second emits every other step rather than nothing at all: truncating
 * per step would round every rate below the frame rate down to zero, which is most of them.
 */
export interface EmitStream {
  state: number;
  carry: number;
}

export function createEmitStream(seed: number): EmitStream {
  /* `>>> 0` rather than a cast: a seed a person typed as a negative or a fraction still has to
     land on a state word, and the alternative is a generator that silently stops advancing. */
  return { state: seed >>> 0, carry: 0 };
}

/** The next value in 0..1. An integer recurrence, so it is exact on every engine. */
function nextRandom(stream: EmitStream): number {
  stream.state = (Math.imul(stream.state, 1664525) + 1013904223) >>> 0;
  return stream.state / 0x100000000;
}

/** What `pumpEmitter` puts particles into: `ParticlePool`, without naming the class. */
export interface EmitTarget {
  emit(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    seed: number,
    sizeScale?: number,
    lifeScale?: number,
  ): void;
}

/**
 * Emit whatever this step owes, at the emitter's origin. Returns how many.
 *
 * The position is the origin because where an emitter *is* belongs to whatever placed it, and a
 * particle system that decided its own position would have to be told twice.
 */
export function pumpEmitter(
  target: EmitTarget,
  emitter: CompiledEmitter,
  stream: EmitStream,
  dt: number,
): number {
  stream.carry += emitter.emission.rate * dt;
  let emitted = 0;
  while (stream.carry >= 1) {
    stream.carry -= 1;
    const spread = emitter.emission.spread;
    const vx = emitter.emission.velocityX + (nextRandom(stream) - 0.5) * 2 * spread;
    const vy = emitter.emission.velocityY + (nextRandom(stream) - 0.5) * 2 * spread;
    const vz = emitter.emission.velocityZ + (nextRandom(stream) - 0.5) * 2 * spread;
    target.emit(0, 0, 0, vx, vy, vz, stream.state);
    emitted += 1;
  }
  return emitted;
}

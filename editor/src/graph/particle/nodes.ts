/**
 * The particle vocabulary: what a node in a particle graph can be.
 *
 * **The emitter node is a sink with named inputs, not a tree of arithmetic.** A material graph
 * composes — a blend of a sample and a noise is itself a colour — and a particle graph does not:
 * every wire ends at one of the emitter's parameters, and what it carries is a value rather than an
 * expression. So there is no `add` node here and no need for one. A graph shaped like the thing it
 * configures is a graph nobody has to learn twice.
 *
 * **`turbulence` is here and does not compile**, deliberately, and for the same reason `separate`
 * is in the material vocabulary. Per-particle noise is the first force somebody reaches for that
 * `ParticlePool` genuinely does not have — it integrates gravity, drag and rise and nothing else —
 * and a palette that silently lacked it would send them looking for a bug in their graph. Offering
 * it and refusing it by name is the honest state.
 *
 * **A curve is two numbers, because that is what the runtime interpolates.** `ParticlePool` lerps
 * size, colour and alpha from a start to an end by `age / life`; a curve node with five control
 * points would be a promise the pool cannot keep, and the graph would be lying about what will be
 * drawn. Two points, and `evaluateCurve` is the same arithmetic the pool does — which is what makes
 * a preview in the editor agree with the frame.
 */
import { createVocabulary, type GraphNode, type Vocabulary } from '../model.ts';

/** Which input of the `emitter` node is which. The compiler and the palette share these. */
export const EMITTER_INPUTS = [
  'rate',
  'life',
  'velocity',
  'spread',
  'size',
  'colour',
  'alpha',
  'gravity',
  'drag',
  'rise',
  'seed',
] as const;

export const PARTICLE_VOCABULARY: Vocabulary = createVocabulary([
  /** A number. `params.value`. */
  { kind: 'constant', inputs: [], outputs: [{ name: 'value', type: 'number' }] },
  /** A straight ramp over a particle's life. `params.start`, `params.end`. */
  { kind: 'curve', inputs: [], outputs: [{ name: 'value', type: 'number' }] },
  /** Linear colour at birth and at death. `params.r0` … `params.b1`. */
  { kind: 'gradient', inputs: [], outputs: [{ name: 'colour', type: 'colour' }] },
  /** Three numbers. `params.x`, `params.y`, `params.z`. */
  { kind: 'vector', inputs: [], outputs: [{ name: 'vector', type: 'vector' }] },
  /** The one node with no emitter parameter behind it. See the header. */
  {
    kind: 'turbulence',
    inputs: [{ name: 'strength', type: 'number', required: true }],
    outputs: [{ name: 'force', type: 'vector' }],
  },
  {
    kind: 'emitter',
    inputs: [
      { name: 'rate', type: 'number', required: true },
      { name: 'life', type: 'number', required: true },
      { name: 'velocity', type: 'vector' },
      { name: 'spread', type: 'number' },
      { name: 'size', type: 'number' },
      { name: 'colour', type: 'colour' },
      { name: 'alpha', type: 'number' },
      { name: 'gravity', type: 'number' },
      { name: 'drag', type: 'number' },
      { name: 'rise', type: 'number' },
      { name: 'seed', type: 'number' },
    ],
    outputs: [],
  },
]);

/**
 * A curve at `t`, where `t` is a particle's age as a share of its own life.
 *
 * The same arithmetic `ParticlePool.update` does, on purpose: a preview drawn from this and a
 * frame drawn from the pool have to show the same particle, and two lerps written twice is how
 * they stop doing so.
 */
export function evaluateCurve(node: GraphNode, t: number): number {
  const start = node.params['start'] ?? 0;
  const end = node.params['end'] ?? 0;
  return start + (end - start) * t;
}

/**
 * The material vocabulary: what a node in a material graph can be.
 *
 * **Every kind here maps to one decode operation, and that is the design rather than a coincidence.**
 * Wave 2B defined a texture as a small interpreted decode program, so a material graph is a visual
 * editor for exactly that structure — the compiler's target is `DecodeGraph` and never a shader.
 * A kind the vocabulary cannot express grows the *decode* vocabulary, which costs bytes linearly
 * because an operation is data; `ARCHITECTURE.md` prices the alternative at 196,910 gzipped bytes
 * for one more shader flag.
 *
 * **`separate` is here and does not compile**, deliberately. Splitting a colour into channels is
 * the first node somebody reaches for that this vocabulary genuinely cannot do, and a palette that
 * silently lacked it would send them looking for a bug in their graph. Offering it and refusing it
 * by name is the honest state, and it is what `compileMaterialGraph`'s "names the node" case is.
 */
import { createVocabulary, type Vocabulary } from '../model.ts';

export const MATERIAL_VOCABULARY: Vocabulary = createVocabulary([
  /** A colour picker. `params.r/g/b/a`. */
  { kind: 'constant', inputs: [], outputs: [{ name: 'colour', type: 'colour' }] },
  /** A latent image, by slot. `params.slot`. */
  { kind: 'sample', inputs: [], outputs: [{ name: 'colour', type: 'colour' }] },
  /** Block-compressed content, the passthrough for what a network does not help. `params.slot`. */
  { kind: 'block', inputs: [], outputs: [{ name: 'colour', type: 'colour' }] },
  /** Value noise. `params.seed`, `params.octaves`. */
  { kind: 'noise', inputs: [], outputs: [{ name: 'colour', type: 'colour' }] },
  /** Which frame of a flipbook the sample time is in. `params.frames`, `params.fps`. */
  { kind: 'flipbook', inputs: [], outputs: [{ name: 'index', type: 'colour' }] },
  {
    kind: 'blend',
    inputs: [
      { name: 'over', type: 'colour', required: true },
      { name: 'under', type: 'colour', required: true },
    ],
    outputs: [{ name: 'colour', type: 'colour' }],
  },
  {
    kind: 'lerp',
    inputs: [
      { name: 'a', type: 'colour', required: true },
      { name: 'b', type: 'colour', required: true },
    ],
    outputs: [{ name: 'colour', type: 'colour' }],
  },
  {
    kind: 'remap',
    inputs: [{ name: 'colour', type: 'colour', required: true }],
    outputs: [{ name: 'colour', type: 'colour' }],
  },
  /** The one node with no decode operation behind it. See the header. */
  {
    kind: 'separate',
    inputs: [{ name: 'colour', type: 'colour', required: true }],
    outputs: [{ name: 'r', type: 'number' }],
  },
  { kind: 'output', inputs: [{ name: 'colour', type: 'colour', required: true }], outputs: [] },
]);

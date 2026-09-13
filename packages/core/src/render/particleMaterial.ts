import {
  PARTICLE_MOTE_FRAG,
  PARTICLE_SMOKE_FRAG,
  PARTICLE_SPARK_FRAG,
  PARTICLE_VERT,
} from './shaders/particle.ts';
import {
  PARTICLE_BINDINGS,
  PARTICLE_MOTE_FRAG_WGSL,
  PARTICLE_SMOKE_FRAG_WGSL,
  PARTICLE_SPARK_FRAG_WGSL,
  PARTICLE_VERT_WGSL,
} from './shaders/generated/particle.wgsl.ts';

/**
 * Which particle material a caller wants, by name rather than by source.
 *
 * **The same change `PlumeMaterial` documents, for the same reason.**
 * `ParticleBatchOptions.fragmentSource` was a GLSL string, and a caller-supplied GLSL string
 * is a capability that can only ever exist on WebGL2 — WebGPU has no runtime compiler and this
 * package must never ship one. Naming the material lets each backend resolve what it can
 * compile.
 *
 * **The three are not interchangeable and never were**, which is why the names read as
 * materials rather than as shaders: `erosion` is ignored by the spark and the mote, `coreGain`
 * by the smoke and the mote, and `fog` by the spark and the smoke — and the options already
 * document that. Naming them makes the pairing explicit instead of leaving it to a caller to
 * match a source with the constants that suit it.
 */
export type ParticleMaterial = 'smoke' | 'spark' | 'mote';

/** Both compilations of one material, and what the generator recorded about each stage. */
export interface ParticleShaders {
  readonly label: string;
  readonly vertexSource: string;
  readonly fragmentSource: string;
  readonly vertexWgsl: string;
  readonly fragmentWgsl: string;
}

/**
 * Every particle material this engine ships.
 *
 * One table with both compilations, rather than a lookup per backend — a material present in
 * one and absent from the other is the drift the 2026-08-13 rule in `AGENTS.md` prevents.
 */
const MATERIALS: Readonly<Record<ParticleMaterial, ParticleShaders>> = {
  smoke: {
    label: 'particle:smoke',
    vertexSource: PARTICLE_VERT,
    fragmentSource: PARTICLE_SMOKE_FRAG,
    vertexWgsl: PARTICLE_VERT_WGSL,
    fragmentWgsl: PARTICLE_SMOKE_FRAG_WGSL,
  },
  spark: {
    label: 'particle:spark',
    vertexSource: PARTICLE_VERT,
    fragmentSource: PARTICLE_SPARK_FRAG,
    vertexWgsl: PARTICLE_VERT_WGSL,
    fragmentWgsl: PARTICLE_SPARK_FRAG_WGSL,
  },
  mote: {
    label: 'particle:mote',
    vertexSource: PARTICLE_VERT,
    fragmentSource: PARTICLE_MOTE_FRAG,
    vertexWgsl: PARTICLE_VERT_WGSL,
    fragmentWgsl: PARTICLE_MOTE_FRAG_WGSL,
  },
};

/** What the generator recorded about the shared vertex stage. */
export const PARTICLE_VERT_BINDINGS = PARTICLE_BINDINGS.PARTICLE_VERT;

/** Resolve a material name, or say which names exist. */
export function particleShaders(material: ParticleMaterial): ParticleShaders {
  const found = MATERIALS[material];
  if (found === undefined) {
    throw new Error(
      `createParticles: unknown particle material "${String(material)}". ` +
        `Known materials: ${Object.keys(MATERIALS).join(', ')}.`,
    );
  }
  return found;
}

import { ARCANE_FRAG } from './shaders/arcane.ts';
import { FIRE_FRAG, PLUME_VERT } from './shaders/fire.ts';
import { SMOKE_FRAG } from './shaders/smoke.ts';
import { ARCANE_FRAG_WGSL, ARCANE_BINDINGS } from './shaders/generated/arcane.wgsl.ts';
import { FIRE_FRAG_WGSL, PLUME_VERT_WGSL, FIRE_BINDINGS } from './shaders/generated/fire.wgsl.ts';
import { SMOKE_FRAG_WGSL, SMOKE_BINDINGS } from './shaders/generated/smoke.wgsl.ts';

/**
 * Which plume material a caller wants, by name rather than by source.
 *
 * **`PlumeOptions` used to take GLSL strings, and that could not cross to a second backend.**
 * WebGPU has no runtime GLSL compiler and this package must never ship one — the toolchain is
 * dev-only, for the licensing and size reasons the WGSL toolchain design
 * records — so a caller-supplied `vertexSource` was a capability that existed on exactly one
 * backend and could never exist on the other.
 *
 * Naming the material instead makes it universal by construction: each backend resolves the
 * name to the shader it can actually compile, and neither can be handed something it cannot
 * use. **The cost is real and was accepted deliberately**: a caller can no longer supply its
 * own plume shader at all. That capability was documented — `uCameraRight` is set
 * unconditionally precisely so a caller's own vertex shader could billboard against it — and
 * it is gone. A world that needs a plume this engine does not ship now needs the engine to
 * ship it.
 */
export type PlumeMaterial = 'fire' | 'smoke' | 'arcane';

/** The two source pairs one material resolves to, one per backend. */
export interface PlumeShaders {
  readonly label: string;
  readonly vertexSource: string;
  readonly fragmentSource: string;
  readonly vertexWgsl: string;
  readonly fragmentWgsl: string;
  /** What the generator recorded about the fragment stage's uniform block. */
  readonly fragmentBindings: unknown;
  readonly vertexBindings: unknown;
}

/**
 * Every plume this engine ships, with both compilations of each.
 *
 * One table rather than a lookup per backend: a material present in one and absent from the
 * other is precisely the drift the 2026-08-13 rule in `AGENTS.md` exists to prevent, and here
 * it would be a plume that draws on WebGL2 and throws on WebGPU.
 */
const MATERIALS: Readonly<Record<PlumeMaterial, PlumeShaders>> = {
  fire: {
    label: 'plume:fire',
    vertexSource: PLUME_VERT,
    fragmentSource: FIRE_FRAG,
    vertexWgsl: PLUME_VERT_WGSL,
    fragmentWgsl: FIRE_FRAG_WGSL,
    vertexBindings: FIRE_BINDINGS.PLUME_VERT,
    fragmentBindings: FIRE_BINDINGS.FIRE_FRAG,
  },
  smoke: {
    label: 'plume:smoke',
    vertexSource: PLUME_VERT,
    fragmentSource: SMOKE_FRAG,
    vertexWgsl: PLUME_VERT_WGSL,
    fragmentWgsl: SMOKE_FRAG_WGSL,
    /* Smoke shares the plume vertex stage; its own file records only the fragment one. */
    vertexBindings: FIRE_BINDINGS.PLUME_VERT,
    fragmentBindings: SMOKE_BINDINGS.SMOKE_FRAG,
  },
  /*
   * A radial counter-rotating swirl rather than a rising column, so it reads as a spell
   * containing a thing rather than as a fire underneath it.
   *
   * **Added because a consumer already drew with it.** The shader has existed here since
   * before the second backend and a consumer passed it as `ARCANE_FRAG`, which the move to
   * named materials took away with nothing to replace it — the one effect in either consumer
   * that the material table did not already cover. It is the only material that reads
   * `uTint`, and that is why: an aura takes the day's glow colour, so relics shift with the
   * palette exactly as the lamps do.
   */
  arcane: {
    label: 'plume:arcane',
    vertexSource: PLUME_VERT,
    fragmentSource: ARCANE_FRAG,
    vertexWgsl: PLUME_VERT_WGSL,
    fragmentWgsl: ARCANE_FRAG_WGSL,
    /* Arcane shares the plume vertex stage; its own file records only the fragment one. */
    vertexBindings: FIRE_BINDINGS.PLUME_VERT,
    fragmentBindings: ARCANE_BINDINGS.ARCANE_FRAG,
  },
};

/** Resolve a material name, or say which names exist. */
export function plumeShaders(material: PlumeMaterial): PlumeShaders {
  const found = MATERIALS[material];
  if (found === undefined) {
    throw new Error(
      `createPlumes: unknown plume material "${String(material)}". ` +
        `Known materials: ${Object.keys(MATERIALS).join(', ')}.`,
    );
  }
  return found;
}

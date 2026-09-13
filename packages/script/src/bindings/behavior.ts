import { BehaviorRunner } from '@driftengine/core';
import { type CapabilityDefinition, type OpaqueType, defineCapability } from 'driftscript';

export const BEHAVIOR_MODULE = 'drift/behavior';

/**
 * `drift/behavior` — driving and watching a behaviour tree from a script.
 *
 * **A script drives a tree; it does not author one.** A tree is nested data with a name on every
 * node, and the useful thing to have in a script is not a builder for it but the two verbs a
 * hand-written routine cannot offer: advance it, and ask what it is doing. Authoring stays in
 * TypeScript beside the actions the tree calls, which is where the consumer's own verbs already
 * are.
 *
 * **`doing` is the capability worth pointing at.** It answers whether the agent is currently inside
 * a node of a given name, which is what turns a tree from something that runs into something a
 * script can react to — play a sound while an agent is sheltering, show an icon while it is walking
 * home, refuse to talk to it mid-errand — without the tree and the script keeping a second copy of
 * the same state in step.
 *
 * The same effect seam as `drift/navigation` and for the same reason: `behavior.read` is in the
 * language's deterministic set and `behavior.write` is not, so a `@deterministic` system may watch
 * a tree and not tick one. See `bindings/navigation.ts`, where the argument and its reversal
 * condition are written out.
 */
export const BEHAVIOR_TYPES: readonly OpaqueType[] = [
  {
    module: BEHAVIOR_MODULE,
    name: 'Behavior',
    doc: 'One agent running one behaviour tree: where it is in its routine.',
  },
];

const define = (
  name: string,
  params: readonly { name: string; type: string }[],
  returns: string,
  effects: readonly string[],
  doc: string,
  deterministic = true,
): CapabilityDefinition =>
  defineCapability({
    module: BEHAVIOR_MODULE,
    name,
    signature: `fn(${params.map((p) => `${p.name}: ${p.type}`).join(', ')}) -> ${returns}`,
    params: [...params],
    returns,
    effects: effects as CapabilityDefinition['effects'],
    deterministic,
    doc,
    implementation: `${BEHAVIOR_MODULE}.${name}`,
  });

export const BEHAVIOR_CAPABILITIES: readonly CapabilityDefinition[] = [
  define(
    'tick',
    [{ name: 'behavior', type: 'Behavior' }],
    'i32',
    ['behavior.write'],
    'Advance the routine one tick. Answers 0 failed, 1 finished, 2 still going. Does nothing while paused.',
    false,
  ),
  define(
    'step',
    [{ name: 'behavior', type: 'Behavior' }],
    'i32',
    ['behavior.write'],
    'Advance one tick even while paused, which is what a step button is.',
    false,
  ),
  define(
    'restart',
    [{ name: 'behavior', type: 'Behavior' }],
    'void',
    ['behavior.write'],
    'Forget where the routine had got to, so the next tick starts it from the top.',
    false,
  ),
  define(
    'setPaused',
    [
      { name: 'behavior', type: 'Behavior' },
      { name: 'paused', type: 'bool' },
    ],
    'void',
    ['behavior.write'],
    'Hold this one agent while the world carries on.',
    false,
  ),
  define(
    'paused',
    [{ name: 'behavior', type: 'Behavior' }],
    'bool',
    ['behavior.read'],
    'Whether it is being held.',
  ),
  define(
    'status',
    [{ name: 'behavior', type: 'Behavior' }],
    'i32',
    ['behavior.read'],
    'What the last tick answered, without ticking again.',
  ),
  /*
   * **The reason a tree beats a loop, from a script's side.** A hand-written routine keeps its
   * state where nothing else can see it, so a script that wants to react to what an agent is doing
   * keeps a second copy and the two drift. This reads the tree's own answer.
   */
  define(
    'doing',
    [
      { name: 'behavior', type: 'Behavior' },
      { name: 'node', type: 'String' },
    ],
    'bool',
    ['behavior.read'],
    "Whether the agent is currently inside a node of this name — the routine's own answer, not a copy of it.",
  ),
  define(
    'depth',
    [{ name: 'behavior', type: 'Behavior' }],
    'i32',
    ['behavior.read'],
    'How deep in the tree the last tick reached. For a debug readout.',
  ),
];

/** What a consumer hands the host so scripts can drive their agents' routines. */
export interface BehaviorServices {
  /**
   * What a character's tick is handed: a world, an entity, whatever the tree's own actions read.
   *
   * A function of the character rather than one context for all of them, because a routine is per
   * agent and the thing its actions act on almost always is too.
   */
  context(character: BehaviorRunner<unknown>): unknown;
}

export function behaviorImplementation(services: BehaviorServices): Record<string, unknown> {
  /* Reused across every `doing` call: the path is at most the tree's depth and this is read every
     tick by anything watching an agent. */
  let scratch: Uint32Array<ArrayBuffer> = new Uint32Array(32);

  return {
    tick: (character: BehaviorRunner<unknown>) => character.tick(services.context(character)),
    step: (character: BehaviorRunner<unknown>) => character.stepOnce(services.context(character)),
    restart: (character: BehaviorRunner<unknown>) => character.reset(),
    setPaused: (character: BehaviorRunner<unknown>, paused: boolean) => {
      character.paused = paused;
    },
    paused: (character: BehaviorRunner<unknown>) => character.paused,
    status: (character: BehaviorRunner<unknown>) => character.status,
    depth(character: BehaviorRunner<unknown>): number {
      scratch = fit(scratch, character);
      return character.activePath(scratch);
    },
    doing(character: BehaviorRunner<unknown>, node: string): boolean {
      scratch = fit(scratch, character);
      const depth = character.activePath(scratch);
      for (let i = 0; i < depth; i++) {
        if (character.nameOf(scratch[i] ?? 0) === node) return true;
      }
      return false;
    },
  };
}

/**
 * Grow the scratch to hold this tree's deepest possible path.
 *
 * A path cannot be longer than the tree has nodes, so this settles after the first call per tree
 * and never runs again — which is what keeps a per-tick read allocation-free in the steady state
 * without asking a consumer to declare a depth they would have to keep correct.
 */
function fit(
  scratch: Uint32Array<ArrayBuffer>,
  character: BehaviorRunner<unknown>,
): Uint32Array<ArrayBuffer> {
  const needed = character.tree.nodeCount;
  return scratch.length >= needed ? scratch : new Uint32Array(needed);
}

/**
 * `drift/animation` — Track A, complete, and the one binding with a trap to disarm.
 *
 * **`BlendTree` allocates its own scratch poses, and without a bind pose they start at zero
 * translation.** `sampleClip` leaves a channel no track mentions exactly as it found it, so a
 * rotation-only clip — which is most of them — preserves whatever translations the pose already
 * held. `blendPoses` cannot do that: it interpolates *every* channel of two poses. So a tree or a
 * state machine built without a bind pose collapses every joint onto its parent's origin, and the
 * symptom is a figure folded in on itself rather than an error.
 *
 * The TypeScript constructor makes `bind` optional, and that is right there: its caller is holding
 * the skeleton and knows what a rest pose is. **A script never meets that argument**, because a
 * script does not build a tree — it drives one its host built and handed it, which is what
 * `blendSet` and `blendAt` are for and what the block above them explains. `reach` is this file's
 * worked example of the rule that used to live here: its pole hint is required at the boundary
 * because a chain that is already straight has no plane to bend in, and a script author meets that
 * trap first.
 *
 * **`blendPoses` does not take one and must not be given one**, which the paraphrase this binding
 * was first written from got wrong. It writes into a caller-owned `out`, so the caller already
 * controls what the untouched channels start as; adding a bind-pose parameter here would be
 * inventing an argument the engine does not have. The rule belongs to the thing that allocates.
 */
import {
  type AnimationClip,
  type BlendTree,
  type Pose,
  type RootMotion,
  Skeleton,
  blendPoses,
  createPose,
  createRootMotion,
  extractRootMotion,
  restPose,
  sampleClip,
  solveTwoBone,
  stripRootMotion,
} from '@driftengine/animation';
import { type CapabilityDefinition, type OpaqueType, defineCapability } from 'driftscript';

export const ANIMATION_MODULE = 'drift/animation';

export const ANIMATION_TYPES: readonly OpaqueType[] = [
  {
    module: ANIMATION_MODULE,
    name: 'Skeleton',
    doc: 'A joint hierarchy, parents before children.',
  },
  { module: ANIMATION_MODULE, name: 'Pose', doc: 'One set of joint transforms.' },
  { module: ANIMATION_MODULE, name: 'Clip', doc: 'Keyframed tracks over time.' },
  { module: ANIMATION_MODULE, name: 'Blend', doc: 'A blend tree over clips.' },
  { module: ANIMATION_MODULE, name: 'Motion', doc: "A root's displacement over an interval." },
];

const define = (
  name: string,
  params: readonly { name: string; type: string }[],
  returns: string,
  effects: CapabilityDefinition['effects'],
  deterministic: boolean,
  doc: string,
): CapabilityDefinition =>
  defineCapability({
    module: ANIMATION_MODULE,
    name,
    signature: `fn(${params.map((p) => `${p.name}: ${p.type}`).join(', ')}) -> ${returns}`,
    params: [...params],
    returns,
    effects,
    deterministic,
    doc,
    implementation: `${ANIMATION_MODULE}.${name}`,
  });

export const ANIMATION_CAPABILITIES: readonly CapabilityDefinition[] = [
  define(
    'pose',
    [{ name: 'jointCount', type: 'u32' }],
    'Pose',
    ['pure'],
    true,
    'A new pose at rest. This is where a bind pose comes from; take one and keep it.',
  ),
  define(
    'toRest',
    [
      { name: 'pose', type: 'Pose' },
      { name: 'jointCount', type: 'u32' },
    ],
    'void',
    ['animation.write'],
    false,
    'Return a pose to rest without allocating another, which is what a state machine does on re-entry.',
  ),
  define(
    'sample',
    [
      { name: 'clip', type: 'Clip' },
      { name: 'at', type: 'f32' },
      { name: 'into', type: 'Pose' },
    ],
    'void',
    ['animation.write'],
    false,
    'Sample a clip at a time. A channel no track mentions is left as it was, so a rotation-only clip preserves the rest of the pose.',
  ),
  define(
    'blend',
    [
      { name: 'a', type: 'Pose' },
      { name: 'b', type: 'Pose' },
      { name: 'amount', type: 'f32' },
      { name: 'into', type: 'Pose' },
    ],
    'void',
    ['animation.write'],
    false,
    'Blend two poses into a third, clamped at the ends. Safe when `into` is also `a` or `b`. It interpolates every channel, so `into` decides what an untouched joint blends from.',
  ),
  /*
   * **A script drives a tree; it does not build one. And `blendTree` used to say otherwise.**
   *
   * That capability took a `Skeleton` and handed it to `new BlendTree(skeleton as never, …)`,
   * whose first parameter is the *root node* of the graph. Run, it threw `Cannot read properties
   * of undefined (reading 'length')` — measured 2026-08-28, not reasoned about — because `prepare`
   * asked a skeleton for its children. Nothing caught it: `host.test.ts` asserted that the
   * *compiler* required three arguments, which it did, and no test ever called the implementation.
   * A capability nobody could use, with a message naming nothing a script author could act on.
   *
   * **Why building one is a design and not an oversight.** A tree is a graph of nodes, and a
   * script has no node value: it would need a `clip` node, a `lerp`, a set with a list of stops
   * and a weight per stop, and then a name for the whole shape. That is a surface to design, and
   * `docs/IMPROVEMENTS.md` carries it with what it needs.
   *
   * **What works today is the shape DriftScript 1.8.1 opened.** A host builds the tree in
   * TypeScript, where the skeleton and the clips already are, and hands it to a system through
   * `uses`; the script then sets its parameters and evaluates it. So these two are the whole
   * script-side surface of a blend tree, and they are enough for the case the language was given
   * `uses` for.
   */
  define(
    'blendSet',
    [
      { name: 'tree', type: 'Blend' },
      { name: 'parameter', type: 'String' },
      { name: 'value', type: 'f32' },
    ],
    'void',
    ['animation.write'],
    false,
    "Set one of a tree's parameters. A name no node in that tree declares is refused by name, because a typo that silently did nothing would present as an animation that will not respond. Both kinds of parameter are set this way: a blend weight, and a clock — the time a `clip` node named for its own sampling.",
  ),
  define(
    'blendAt',
    [
      { name: 'tree', type: 'Blend' },
      { name: 'at', type: 'f32' },
      { name: 'into', type: 'Pose' },
    ],
    'void',
    ['animation.write'],
    false,
    'Evaluate a whole tree into a pose. `at` is the clock for every node that did not name one of its own, so a tree of ordinary clips is sampled at one time and a node with a clock reads that parameter instead.',
  ),
  define(
    'reach',
    [
      { name: 'skeleton', type: 'Skeleton' },
      { name: 'pose', type: 'Pose' },
      { name: 'root', type: 'u32' },
      { name: 'mid', type: 'u32' },
      { name: 'tip', type: 'u32' },
      { name: 'targetX', type: 'f32' },
      { name: 'targetY', type: 'f32' },
      { name: 'targetZ', type: 'f32' },
      /*
       * The pole hint decides the one thing a target cannot: which way the joint bends. Required
       * for the same reason as the bind pose — a chain that is already straight has no plane to
       * bend in, and without a hint the elbow flips unpredictably as a character turns. The engine
       * requires it too; it is listed here so a reader of the signature knows what it is for.
       */
      { name: 'poleX', type: 'f32' },
      { name: 'poleY', type: 'f32' },
      { name: 'poleZ', type: 'f32' },
    ],
    'bool',
    ['animation.write'],
    false,
    'Bend a two-bone chain so its tip reaches a target. Answers whether it was reachable; an unreachable target straightens the chain toward it rather than giving up.',
  ),
  /*
   * **Root motion is two calls and it is a mistake to make only one of them.** `rootMotion` hands
   * the caller the displacement and `stripRoot` takes it out of the pose; a script that extracts
   * without stripping moves its character twice, at exactly double speed, with nothing failing.
   * Both descriptions say so, because a script author has no signature to read.
   *
   * The displacement is read back through separate accessors, the shape `hitX` and `input.axisX`
   * already use — a script has no way to receive an engine record. Here the accessors take the
   * `Motion` rather than reading a scratch the last call wrote, so two characters extracted in one
   * frame do not clobber each other; the raycast surface keys its scratch on the world for the
   * same reason, and animation has no equivalent handle to key on.
   */
  define(
    'motion',
    [],
    'Motion',
    ['pure'],
    true,
    'A new root displacement, at zero. Take one and keep it; nothing here allocates per frame.',
  ),
  define(
    'rootMotion',
    [
      { name: 'clip', type: 'Clip' },
      { name: 'joint', type: 'u32' },
      { name: 'from', type: 'f32' },
      { name: 'to', type: 'f32' },
      { name: 'into', type: 'Motion' },
    ],
    'void',
    ['animation.write'],
    false,
    'How far the root travelled between two times, in its own frame at `from`. Loops are accumulated, so a clip that wraps between the two times still answers a step forward. Pair every call with `stripRoot` or the character moves twice.',
  ),
  define(
    'stripRoot',
    [
      { name: 'clip', type: 'Clip' },
      { name: 'joint', type: 'u32' },
      { name: 'pose', type: 'Pose' },
    ],
    'void',
    ['animation.write'],
    false,
    "Pin a sampled pose's root to the clip's value at time zero, so the displacement `rootMotion` handed you is not also in the pose. Every other joint is left as it was.",
  ),
  define(
    'motionX',
    [{ name: 'motion', type: 'Motion' }],
    'f32',
    ['pure'],
    true,
    "The displacement along the root's own x axis at the earlier time.",
  ),
  define(
    'motionY',
    [{ name: 'motion', type: 'Motion' }],
    'f32',
    ['pure'],
    true,
    "The displacement along the root's own y axis at the earlier time.",
  ),
  define(
    'motionZ',
    [{ name: 'motion', type: 'Motion' }],
    'f32',
    ['pure'],
    true,
    "The displacement along the root's own z axis at the earlier time.",
  ),
  define(
    'motionTurnX',
    [{ name: 'motion', type: 'Motion' }],
    'f32',
    ['pure'],
    true,
    'The x part of the rotation the root turned through, as a quaternion.',
  ),
  define(
    'motionTurnY',
    [{ name: 'motion', type: 'Motion' }],
    'f32',
    ['pure'],
    true,
    'The y part of the rotation the root turned through, as a quaternion.',
  ),
  define(
    'motionTurnZ',
    [{ name: 'motion', type: 'Motion' }],
    'f32',
    ['pure'],
    true,
    'The z part of the rotation the root turned through, as a quaternion.',
  ),
  define(
    'motionTurnW',
    [{ name: 'motion', type: 'Motion' }],
    'f32',
    ['pure'],
    true,
    'The w part of the rotation the root turned through, as a quaternion. One means it did not turn.',
  ),
];

/**
 * The implementations.
 *
 * `blendTree` passes the bind pose straight through to the engine's optional parameter — the
 * requirement lives entirely in the *description*, which is exactly where a capability boundary
 * should hold a rule. The engine's own callers keep their option; script authors get the safe
 * behaviour without the engine changing.
 */
export function animationImplementation(): Record<string, unknown> {
  return {
    pose: (jointCount: number) => createPose(jointCount),
    toRest: (pose: Pose, jointCount: number) => restPose(jointCount, pose),
    sample: (clip: AnimationClip, at: number, into: Pose) => sampleClip(clip, at, into),
    blend: (a: Pose, b: Pose, amount: number, into: Pose) => blendPoses(a, b, amount, into),
    blendSet: (tree: BlendTree, parameter: string, value: number) => tree.set(parameter, value),
    blendAt: (tree: BlendTree, at: number, into: Pose) => tree.evaluate(at, into),
    motion: () => createRootMotion(),
    rootMotion: (clip: AnimationClip, joint: number, from: number, to: number, into: RootMotion) =>
      extractRootMotion(clip, joint, from, to, into),
    stripRoot: (clip: AnimationClip, joint: number, pose: Pose) =>
      stripRootMotion(clip, joint, pose),
    motionX: (motion: RootMotion) => motion.translation[0] as number,
    motionY: (motion: RootMotion) => motion.translation[1] as number,
    motionZ: (motion: RootMotion) => motion.translation[2] as number,
    motionTurnX: (motion: RootMotion) => motion.rotation[0] as number,
    motionTurnY: (motion: RootMotion) => motion.rotation[1] as number,
    motionTurnZ: (motion: RootMotion) => motion.rotation[2] as number,
    motionTurnW: (motion: RootMotion) => motion.rotation[3] as number,
    reach: (
      skeleton: Skeleton,
      pose: Pose,
      root: number,
      mid: number,
      tip: number,
      targetX: number,
      targetY: number,
      targetZ: number,
      poleX: number,
      poleY: number,
      poleZ: number,
    ) =>
      solveTwoBone(
        skeleton,
        pose,
        root,
        mid,
        tip,
        [targetX, targetY, targetZ],
        [poleX, poleY, poleZ],
      ),
  };
}

import type { AnimationClip } from './clip.ts';
import { sampleClip } from './clip.ts';
import { blendPoses } from './blend.ts';
import type { Pose } from './pose.ts';
import { createPose } from './pose.ts';

/**
 * A tree of clips blended by parameters the game names.
 *
 * **The parameters are the consumer's own strings, never an engine enumeration**, for the reason
 * the input action maps give: a game's verbs are a game's business, and an engine that enumerated
 * them would be deciding what a character can be doing.
 *
 * Evaluation is a pure function of a caller-supplied time and the current parameters. Nothing here
 * reads a clock, which is the contract `sampleClip` establishes and which a graph over clips has
 * to keep or the replay story ends one layer up.
 *
 * **A parameter is one of two things, and the tree keeps them apart.** A *blend* parameter is a
 * weight: which children a set brackets, how far a lerp has gone. A *clock* is a time: which
 * instant of its own clip a node is sampled at, named by a `clip` node's `clock` and defaulting to
 * the time `evaluate` was given. A name may be one or the other and never both — see `clocks` for
 * why that is refused rather than allowed.
 */

export type BlendNode =
  | {
      readonly kind: 'clip';
      readonly clip: AnimationClip;
      /**
       * The parameter whose value is this clip's own time, or omitted for the frame clock.
       *
       * **A tree had one clock for every node until 2026-08-28, and that cannot express the
       * canonical blend space.** A locomotion set is stand, walk, run over one speed parameter —
       * and a stride has to advance with **distance travelled** or the foot slides while the body
       * passes over it, which is the fact `rootMotion` exists for, while an idle has to advance
       * with **time**, because somebody standing still is still breathing. On one clock one of the
       * two is wrong: share the distance and the idle freezes whenever nobody moves, share the time
       * and the walk skates. Reported from outside, where the workaround was two clocks kept by
       * hand and a `blendPoses` per overlay — which gives up the declared graph, the scratch poses
       * claimed at construction, and a state machine's crossfades on top.
       *
       * **The value is a time on the clip's own axis, in seconds**, and what advances it is the
       * caller's business: a stride measured in metres is divided by the metres a cycle covers and
       * multiplied by the cycle's duration, and an angle turned is the same arithmetic. The engine
       * does not know about metres, and a parameter that meant metres here would be the engine
       * deciding what a character is doing.
       *
       * **What it gives up** is inheritance: a clock names one clip, so a subtree of four gait
       * clips names it four times. **What would change that** is a consumer with a subtree deep
       * enough for the repetition to hide a mistake, and the answer then is a clock on an interior
       * node that its children inherit — which is a rule about scope, so it is worth having a
       * reason for rather than adding now.
       */
      readonly clock?: string;
    }
  | {
      readonly kind: 'lerp';
      readonly a: BlendNode;
      readonly b: BlendNode;
      readonly parameter: string;
    }
  | {
      readonly kind: 'oneDimensional';
      readonly children: readonly { readonly at: number; readonly node: BlendNode }[];
      readonly parameter: string;
    };

export class BlendTree {
  private readonly parameters = new Map<string, number>();
  /**
   * One scratch pose per interior node, claimed at construction.
   *
   * A tree evaluates depth-first and every interior node needs somewhere to put its two operands,
   * so without these `evaluate` would allocate per node per frame. Keyed by the node object
   * itself, which is stable because a tree is immutable.
   */
  private readonly scratch = new Map<BlendNode, [Pose, Pose]>();
  /**
   * Which names are clocks, so one cannot quietly be both.
   *
   * A parameter is a blend input and a clock is a time; one number doing both jobs is a rig that
   * responds to the wrong dial, which reads as a broken tree rather than as a name used twice.
   * `clock: 'speed'` written while meaning "the speed drives the blend" is the slip this catches.
   */
  private readonly clocks = new Set<string>();

  /**
   * @param bind The bind pose, or omitted for one whose channels start at rest.
   *
   * **Supply it whenever the clips are rotation-only, which is most of them.** `sampleClip` leaves
   * a channel no track mentions exactly as it found it, so a rotation-only clip preserves whatever
   * translations the pose already held. `blendPoses` cannot do that — it interpolates *every*
   * channel of two poses — so without a bind pose here the scratch poses start at zero translation
   * and every joint collapses onto its parent's origin the moment a tree or a transition is
   * involved. Found by building a demo scene with it: one figure folded in on itself and the other,
   * which happened to go through `retargetPose` instead, did not.
   */
  constructor(
    private readonly root: BlendNode,
    jointCount: number,
    private readonly bind?: Pose,
  ) {
    this.prepare(root, jointCount);
  }

  /**
   * Set a parameter, refusing a name no node declares.
   *
   * **Loud rather than ignored.** A typo silently does nothing, and what a consumer then sees is
   * an animation that will not respond — a symptom a long way from the misspelling that caused it,
   * and one no test of theirs would catch. What it costs is that a caller cannot set a parameter
   * ahead of building the tree that uses it.
   */
  set(parameter: string, value: number): void {
    if (!this.parameters.has(parameter)) {
      throw new Error(`BlendTree: no node in this tree takes a parameter called "${parameter}"`);
    }
    this.parameters.set(parameter, value);
  }

  /**
   * Sample the whole tree at `timeSec` into `out`. Allocates nothing.
   *
   * `timeSec` is the clock for every node that did not name one of its own, so a tree of ordinary
   * clips behaves exactly as it did before clocks existed.
   */
  evaluate(timeSec: number, out: Pose): void {
    this.walk(this.root, timeSec, out);
  }

  /** A scratch pose starting from the bind pose where one was given, or at rest where none was. */
  private blank(jointCount: number): Pose {
    const pose = createPose(jointCount);
    if (this.bind !== undefined) {
      pose.translation.set(this.bind.translation.subarray(0, pose.translation.length));
      pose.rotation.set(this.bind.rotation.subarray(0, pose.rotation.length));
      pose.scale.set(this.bind.scale.subarray(0, pose.scale.length));
    }
    return pose;
  }

  /** Collect parameter names and claim scratch, once, so evaluation allocates nothing. */
  private prepare(node: BlendNode, jointCount: number): void {
    if (node.kind === 'clip') {
      if (node.clock !== undefined) {
        if (this.parameters.has(node.clock) && !this.clocks.has(node.clock)) {
          throw new Error(
            `BlendTree: "${node.clock}" is a blend parameter in this tree and cannot also be a ` +
              `clock; one number cannot be both a weight and a time`,
          );
        }
        this.clocks.add(node.clock);
        /* Zero, so a tree evaluates before a caller has set anything — the same start every
           blend parameter gets. */
        this.parameters.set(node.clock, this.parameters.get(node.clock) ?? 0);
      }
      return;
    }

    if (this.clocks.has(node.parameter)) {
      throw new Error(
        `BlendTree: "${node.parameter}" is a clock in this tree and cannot also be a blend ` +
          `parameter; one number cannot be both a time and a weight`,
      );
    }
    this.parameters.set(node.parameter, this.parameters.get(node.parameter) ?? 0);
    this.scratch.set(node, [this.blank(jointCount), this.blank(jointCount)]);

    if (node.kind === 'lerp') {
      this.prepare(node.a, jointCount);
      this.prepare(node.b, jointCount);
      return;
    }

    if (node.children.length === 0) {
      throw new Error(
        `BlendTree: the set on "${node.parameter}" has no children; it needs at least one`,
      );
    }
    for (let i = 1; i < node.children.length; i++) {
      const previous = node.children[i - 1]?.at ?? 0;
      const current = node.children[i]?.at ?? 0;
      /*
       * Ascending stops are what makes the bracketing search a walk rather than a sort, and an
       * unsorted set does not fail — it picks a neighbouring pair that is not the nearest one and
       * blends between the wrong two clips, which reads as a rig that responds oddly to a
       * parameter rather than as a misconfigured tree.
       */
      if (current <= previous) {
        throw new Error(
          `BlendTree: the set on "${node.parameter}" has stops ${previous} then ${current}; ` +
            `they must be ascending`,
        );
      }
    }
    for (const child of node.children) this.prepare(child.node, jointCount);
  }

  private walk(node: BlendNode, timeSec: number, out: Pose): void {
    if (node.kind === 'clip') {
      /* Its own clock where it named one, and the frame clock where it did not — which is what
         every tree written before clocks existed keeps doing, unchanged. */
      const at = node.clock === undefined ? timeSec : (this.parameters.get(node.clock) ?? 0);
      sampleClip(node.clip, at, out);
      return;
    }

    const scratch = this.scratch.get(node);
    if (scratch === undefined) throw new Error('BlendTree: a node was not prepared');
    const [left, right] = scratch;
    const value = this.parameters.get(node.parameter) ?? 0;

    if (node.kind === 'lerp') {
      this.walk(node.a, timeSec, left);
      this.walk(node.b, timeSec, right);
      blendPoses(left, right, value, out);
      return;
    }

    const stops = node.children;
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (first === undefined || last === undefined) throw new Error('BlendTree: an empty set');

    /*
     * **A shortcut, not the clamp.** Outside the set these walk one child instead of two, which
     * halves the work for a parameter parked at an extreme — a character standing still, which is
     * the common case. The *correctness* is `blendPoses`, which clamps its own weight: deleting
     * these two returns changes no output, only the work done, and perturbing them proved exactly
     * that by leaving every assertion green. The comment said they were the clamp until then.
     */
    if (value <= first.at) {
      this.walk(first.node, timeSec, out);
      return;
    }
    if (value >= last.at) {
      this.walk(last.node, timeSec, out);
      return;
    }

    let upper = 1;
    while (upper < stops.length - 1 && (stops[upper]?.at ?? 0) < value) upper += 1;
    const lower = stops[upper - 1];
    const higher = stops[upper];
    if (lower === undefined || higher === undefined) throw new Error('BlendTree: a gap in a set');

    const span = higher.at - lower.at;
    const t = span > 0 ? (value - lower.at) / span : 0;
    this.walk(lower.node, timeSec, left);
    this.walk(higher.node, timeSec, right);
    blendPoses(left, right, t, out);
  }
}

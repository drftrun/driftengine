import { blendPoses } from './blend.ts';
import type { BlendTree } from './blendTree.ts';
import type { Pose } from './pose.ts';
import { createPose } from './pose.ts';

/**
 * States over blend trees, and crossfaded transitions between them.
 *
 * **`advance` takes the step rather than reading a clock**, which is the same contract
 * `sampleClip` and `BlendTree` keep and the last layer that could have broken it. A state machine
 * is where an engine most naturally reaches for `performance.now`, because a transition has a
 * duration and a duration wants a clock — and one here would mean a recorded run played back a
 * different pose on a different machine.
 *
 * The conditions are predicates over parameters the consumer names, for the reason the tree gives
 * about a game's own verbs. The engine decides *when a fade completes*, not what a character is
 * doing.
 */

export interface AnimationState {
  readonly name: string;
  readonly tree: BlendTree;
}

export interface AnimationTransition {
  readonly from: string;
  readonly to: string;
  readonly durationSec: number;
  /** The consumer's own predicate over the consumer's own parameters. */
  readonly when: (parameters: Readonly<Record<string, number>>) => boolean;
}

export class AnimationStateMachine {
  private readonly states = new Map<string, AnimationState>();
  private readonly parameters: Record<string, number> = {};

  private active: AnimationState;
  /** The state being left while a fade runs, or null when none is. */
  private leaving: AnimationState | null = null;
  private fadeElapsed = 0;
  private fadeDuration = 0;

  /** One per side of a fade, claimed at construction so `evaluate` allocates nothing. */
  private readonly fromPose: Pose;
  private readonly toPose: Pose;

  /**
   * Each state's own elapsed time.
   *
   * Per state rather than one for the machine, so a looping clip is not restarted every time
   * something else changes — and so a state re-entered later resumes where its own clip was rather
   * than wherever the machine happened to be.
   */
  private readonly elapsed = new Map<string, number>();

  /**
   * @param bind The bind pose, or omitted for one whose channels start at rest.
   *
   * The same reason `BlendTree` takes one: a crossfade calls `blendPoses`, which interpolates
   * every channel, so without a bind pose the two sides of a fade start at zero translation and
   * the figure folds toward its own origin for the length of the transition.
   */
  constructor(
    states: readonly AnimationState[],
    private readonly transitions: readonly AnimationTransition[],
    jointCount: number,
    bind?: Pose,
  ) {
    const first = states[0];
    if (first === undefined) throw new Error('AnimationStateMachine: needs at least one state');
    for (const state of states) {
      this.states.set(state.name, state);
      this.elapsed.set(state.name, 0);
    }
    /*
     * Checked here rather than met at the moment a transition fires. A transition naming a state
     * that does not exist is a configuration error with exactly one correct outcome, and finding
     * it at construction is the difference between a message naming the state and a character that
     * silently never leaves an animation.
     */
    for (const transition of transitions) {
      for (const name of [transition.from, transition.to]) {
        if (!this.states.has(name)) {
          throw new Error(
            `AnimationStateMachine: a transition names state "${name}", which was not given`,
          );
        }
      }
    }
    this.active = first;
    this.fromPose = createPose(jointCount);
    this.toPose = createPose(jointCount);
    if (bind !== undefined) {
      for (const pose of [this.fromPose, this.toPose]) {
        pose.translation.set(bind.translation.subarray(0, pose.translation.length));
        pose.rotation.set(bind.rotation.subarray(0, pose.rotation.length));
        pose.scale.set(bind.scale.subarray(0, pose.scale.length));
      }
    }
  }

  get current(): string {
    return this.active.name;
  }

  /** Whether a crossfade is running. A caller wanting to gate input on one asks this. */
  get transitioning(): boolean {
    return this.leaving !== null;
  }

  /**
   * Set a parameter the transitions read.
   *
   * Unlike `BlendTree.set` this accepts any name: the predicates are the consumer's own functions
   * and this class cannot know which keys they read. The tree below it still refuses a name no node
   * declares, which is where a typo that matters is caught.
   */
  set(parameter: string, value: number): void {
    this.parameters[parameter] = value;
  }

  /**
   * Advance by a caller-supplied step: the fade, the active state's clock, and any transition
   * whose condition now holds.
   */
  advance(dtSec: number): void {
    if (this.leaving === null) this.start();
    this.elapsed.set(this.active.name, (this.elapsed.get(this.active.name) ?? 0) + dtSec);

    if (this.leaving === null) return;
    this.elapsed.set(this.leaving.name, (this.elapsed.get(this.leaving.name) ?? 0) + dtSec);
    /*
     * **The frame that triggers a transition advances its fade too.** Starting the fade at zero
     * and leaving it there until the next call is a one-frame stall at the top of every
     * transition — invisible at 60 Hz on a long fade and a whole transition on a short one, which
     * is the case a fade is shortest for.
     */
    this.fadeElapsed += dtSec;
    /*
     * A running fade completes; it is not re-evaluated against the condition that started it. A
     * transition interruptible by its own trigger would stutter whenever that parameter sat on its
     * threshold — which is exactly where a speed parameter spends its time.
     */
    if (this.fadeElapsed >= this.fadeDuration) this.leaving = null;
  }

  /** Take the first transition out of the active state whose condition holds. */
  private start(): void {
    for (const transition of this.transitions) {
      if (transition.from !== this.active.name) continue;
      if (!transition.when(this.parameters)) continue;
      const next = this.states.get(transition.to);
      if (next === undefined) continue;

      this.leaving = this.active;
      this.active = next;
      this.elapsed.set(next.name, 0);
      this.fadeElapsed = 0;
      this.fadeDuration = transition.durationSec;
      /*
       * A zero-duration transition is a switch. Ended here rather than divided by below, because
       * the division is what would produce the NaN — and a NaN weight reaches the palette and
       * takes every vertex it touches.
       */
      if (this.fadeDuration <= 0) this.leaving = null;
      return;
    }
  }

  /** The current pose, crossfaded if a transition is running. Allocates nothing. */
  evaluate(out: Pose): void {
    const activeTime = this.elapsed.get(this.active.name) ?? 0;
    if (this.leaving === null) {
      this.active.tree.evaluate(activeTime, out);
      return;
    }
    this.leaving.tree.evaluate(this.elapsed.get(this.leaving.name) ?? 0, this.fromPose);
    this.active.tree.evaluate(activeTime, this.toPose);
    blendPoses(this.fromPose, this.toPose, this.fadeElapsed / this.fadeDuration, out);
  }
}

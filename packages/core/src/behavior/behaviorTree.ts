/**
 * A behaviour tree that is data, so it can be looked at, paused and stepped.
 *
 * **The complaint this answers is not "a routine cannot be written".** It can, and a consumer
 * reported theirs: a table of places and a loop that decides where to send everybody once an
 * in-game hour. It works. What they also reported is what it is — a hand-written behaviour tree
 * that cannot be inspected, paused or stepped — and where it gets expensive, which is the moment a
 * routine needs **interrupting**: an agent dropping what it is doing because it started raining,
 * and picking it up again afterwards.
 *
 * So the two things here are the two things a hand-rolled loop does not give you.
 *
 * **The tree is data.** Nodes are arrays of integers and names resolved once at build time; the
 * consumer's own functions live in a table beside it. A running tree can therefore say which node
 * it is in, by name, without anything having been instrumented — `activePath` walks it — and a
 * `paused` character can be advanced one node at a time.
 *
 * **A preempted branch is suspended, not reset**, which is the whole of "picking it up again". A
 * selector that switches to a higher-priority child leaves the lower one's cursors exactly where
 * they were, so when the interruption ends the agent resumes at the step it had reached rather than
 * at the start of its errand. State is reset only when a branch *finishes* — succeeds or fails —
 * because that is when starting again is what starting again means. Every behaviour-tree
 * implementation has to choose here, most reset on abort, and the difference is a villager who
 * walks back to the shop after a shower against one who walks home and starts the day over.
 *
 * **Nothing allocates during a tick and nothing reads a clock.** A tick is a function of the tree,
 * the character's own cursors, and whatever the consumer's context object holds.
 */

export const FAILURE = 0;
export const SUCCESS = 1;
export const RUNNING = 2;
export type BehaviorStatus = 0 | 1 | 2;

const SEQUENCE = 0;
const SELECTOR = 1;
const ACTION = 2;
const CONDITION = 3;
const GUARD = 4;

/**
 * A node, as a consumer writes one.
 *
 * Names are the point of the whole shape: they are what an inspector shows and what a log line
 * says, and a tree whose nodes are anonymous is one you can watch running and still not read.
 */
export type BehaviorSpec =
  | { readonly name: string; readonly sequence: readonly BehaviorSpec[] }
  | { readonly name: string; readonly selector: readonly BehaviorSpec[] }
  | { readonly name: string; readonly action: string }
  | { readonly name: string; readonly condition: string }
  /**
   * Run the child only while the condition holds.
   *
   * **The interruption primitive.** A selector of guards is a list of priorities: the first guard
   * whose condition is true runs its branch, and a branch that was running under a lower-priority
   * guard is suspended rather than abandoned. That is how "stop what you are doing because it
   * started raining" is expressed, and how the errand survives it.
   */
  | { readonly name: string; readonly whileTrue: string; readonly does: BehaviorSpec };

/** What a running tree calls: the consumer's own verbs, by the names the tree uses. */
export interface BehaviorTasks {
  /** Something that takes time. Returns `RUNNING` until it is done. */
  readonly actions: Readonly<Record<string, (context: never) => BehaviorStatus>>;
  /** Something with an answer now. */
  readonly conditions: Readonly<Record<string, (context: never) => boolean>>;
}

/** The tree, flattened. Built once; a character per agent shares it. */
export interface BehaviorTree {
  readonly kind: Uint8Array;
  /** For a composite: where its children start in `child`. Length `nodeCount + 1`. */
  readonly childStart: Uint32Array;
  readonly child: Uint32Array;
  /** For an action, condition or guard: which function in the table. */
  readonly slot: Int32Array;
  readonly names: readonly string[];
  readonly nodeCount: number;
  /** The functions, in the order `slot` indexes them. */
  readonly actions: readonly ((context: never) => BehaviorStatus)[];
  readonly conditions: readonly ((context: never) => boolean)[];
}

/**
 * Flatten a spec, resolving every name against the tables.
 *
 * **A name with no function is refused here rather than at the moment the agent needs it.** A tree
 * is authored once and run for hours; a typo that surfaces the first time a villager reaches the
 * market is a typo that surfaces in front of somebody playing.
 */
export function buildBehaviorTree(root: BehaviorSpec, tasks: BehaviorTasks): BehaviorTree {
  const kind: number[] = [];
  const names: string[] = [];
  const slot: number[] = [];
  const childLists: number[][] = [];
  const actions: ((context: never) => BehaviorStatus)[] = [];
  const conditions: ((context: never) => boolean)[] = [];
  const actionSlot = new Map<string, number>();
  const conditionSlot = new Map<string, number>();

  const resolveAction = (name: string, node: string): number => {
    const found = actionSlot.get(name);
    if (found !== undefined) return found;
    const fn = tasks.actions[name];
    if (fn === undefined) {
      throw new Error(
        `buildBehaviorTree: node "${node}" does an action "${name}" nothing provides`,
      );
    }
    actions.push(fn);
    actionSlot.set(name, actions.length - 1);
    return actions.length - 1;
  };
  const resolveCondition = (name: string, node: string): number => {
    const found = conditionSlot.get(name);
    if (found !== undefined) return found;
    const fn = tasks.conditions[name];
    if (fn === undefined) {
      throw new Error(`buildBehaviorTree: node "${node}" asks "${name}", which nothing answers`);
    }
    conditions.push(fn);
    conditionSlot.set(name, conditions.length - 1);
    return conditions.length - 1;
  };

  const visit = (spec: BehaviorSpec): number => {
    const at = kind.length;
    names.push(spec.name);
    kind.push(0);
    slot.push(-1);
    childLists.push([]);

    if ('sequence' in spec || 'selector' in spec) {
      const children = 'sequence' in spec ? spec.sequence : spec.selector;
      if (children.length === 0) {
        throw new Error(`buildBehaviorTree: "${spec.name}" is a composite with no children`);
      }
      kind[at] = 'sequence' in spec ? SEQUENCE : SELECTOR;
      const list = childLists[at] as number[];
      for (const each of children) list.push(visit(each));
    } else if ('action' in spec) {
      kind[at] = ACTION;
      slot[at] = resolveAction(spec.action, spec.name);
    } else if ('condition' in spec) {
      kind[at] = CONDITION;
      slot[at] = resolveCondition(spec.condition, spec.name);
    } else {
      kind[at] = GUARD;
      slot[at] = resolveCondition(spec.whileTrue, spec.name);
      (childLists[at] as number[]).push(visit(spec.does));
    }
    return at;
  };
  visit(root);

  const nodeCount = kind.length;
  const childStart = new Uint32Array(nodeCount + 1);
  for (let i = 0; i < nodeCount; i++) {
    childStart[i + 1] = (childStart[i] ?? 0) + (childLists[i]?.length ?? 0);
  }
  const child = new Uint32Array(childStart[nodeCount] ?? 0);
  for (let i = 0; i < nodeCount; i++) {
    const list = childLists[i] ?? [];
    for (let k = 0; k < list.length; k++) child[(childStart[i] ?? 0) + k] = list[k] ?? 0;
  }

  return {
    kind: Uint8Array.from(kind),
    childStart,
    child,
    slot: Int32Array.from(slot),
    names,
    nodeCount,
    actions,
    conditions,
  };
}

/**
 * One agent running one tree.
 *
 * A character per agent and one tree between them: the tree is read-only after building, and
 * everything that differs between two villagers following the same routine is here.
 */
export class BehaviorRunner<Context> {
  readonly tree: BehaviorTree;
  /** How far through each composite this agent is. The state a suspension preserves. */
  private readonly cursor: Uint32Array;
  /** Which node each composite last handed control to, so a switch can be noticed. */
  private readonly running: Int32Array;
  /** The chain of nodes entered on the last tick, root first. */
  private readonly path: Uint32Array;
  private pathLength = 0;
  private lastStatus: BehaviorStatus = RUNNING;

  /**
   * When true, `tick` does nothing and reports the last status.
   *
   * Paused rather than not-called, so a debugger can hold one agent while the world runs — and so
   * `stepOnce` has something to mean.
   */
  paused = false;

  constructor(tree: BehaviorTree) {
    this.tree = tree;
    this.cursor = new Uint32Array(tree.nodeCount);
    this.running = new Int32Array(tree.nodeCount).fill(-1);
    this.path = new Uint32Array(tree.nodeCount);
  }

  get status(): BehaviorStatus {
    return this.lastStatus;
  }

  /** Advance one tick, unless paused. */
  tick(context: Context): BehaviorStatus {
    if (this.paused) return this.lastStatus;
    return this.run(context);
  }

  /** Advance one tick even while paused. What a step button is wired to. */
  stepOnce(context: Context): BehaviorStatus {
    return this.run(context);
  }

  /** Forget everything: the next tick starts the routine from the beginning. */
  reset(): void {
    this.cursor.fill(0);
    this.running.fill(-1);
    this.pathLength = 0;
    this.lastStatus = RUNNING;
  }

  /**
   * The chain of nodes the last tick was inside, root first, filled into `out`.
   *
   * **This is the inspection the report asked for**, and it costs nothing to keep: the chain is
   * recorded as the tick descends, so asking for it later is a copy rather than a second walk.
   * `nameOf` turns the indices into the names the tree was written with.
   */
  activePath(out: Uint32Array): number {
    const count = Math.min(this.pathLength, out.length);
    for (let i = 0; i < count; i++) out[i] = this.path[i] ?? 0;
    return count;
  }

  nameOf(node: number): string {
    return this.tree.names[node] ?? '?';
  }

  private run(context: Context): BehaviorStatus {
    this.pathLength = 0;
    this.lastStatus = this.visit(0, context);
    return this.lastStatus;
  }

  private visit(node: number, context: Context): BehaviorStatus {
    if (this.pathLength < this.path.length) this.path[this.pathLength++] = node;
    const tree = this.tree;
    switch (tree.kind[node]) {
      case ACTION: {
        const fn = tree.actions[tree.slot[node] ?? 0];
        return fn === undefined ? FAILURE : fn(context as never);
      }
      case CONDITION: {
        const fn = tree.conditions[tree.slot[node] ?? 0];
        return fn !== undefined && fn(context as never) ? SUCCESS : FAILURE;
      }
      case GUARD: {
        const fn = tree.conditions[tree.slot[node] ?? 0];
        /*
         * The condition has stopped holding. The child keeps every cursor it had: this is the node
         * that makes an interruption resumable, and clearing here is the single change that would
         * turn a villager who returns to their errand into one who starts the day again.
         */
        if (fn === undefined || !fn(context as never)) return FAILURE;
        return this.visit(tree.child[tree.childStart[node] ?? 0] ?? 0, context);
      }
      case SEQUENCE:
        return this.sequence(node, context);
      default:
        return this.selector(node, context);
    }
  }

  private sequence(node: number, context: Context): BehaviorStatus {
    const tree = this.tree;
    const start = tree.childStart[node] ?? 0;
    const end = tree.childStart[node + 1] ?? 0;
    const count = end - start;
    /* Resumed from the cursor, which is what makes a sequence a routine rather than a list of
       things attempted from the top every tick. */
    for (let i = this.cursor[node] ?? 0; i < count; i++) {
      const status = this.visit(tree.child[start + i] ?? 0, context);
      if (status === RUNNING) {
        this.cursor[node] = i;
        return RUNNING;
      }
      if (status === FAILURE) {
        this.clear(node);
        return FAILURE;
      }
      /* Succeeded: on to the next, and the child starts clean the next time it is entered. */
      this.clear(tree.child[start + i] ?? 0);
    }
    this.clear(node);
    return SUCCESS;
  }

  private selector(node: number, context: Context): BehaviorStatus {
    const tree = this.tree;
    const start = tree.childStart[node] ?? 0;
    const end = tree.childStart[node + 1] ?? 0;

    for (let i = start; i < end; i++) {
      const branch = tree.child[i] ?? 0;
      const status = this.visit(branch, context);
      if (status === FAILURE) continue;
      /*
       * **A different branch has taken over, and the one it displaced is left exactly as it was.**
       * Nothing is cleared here, which is the whole feature: the displaced branch's cursors say
       * which step of the errand it had reached, and it resumes there when this one stops being
       * eligible. Resetting instead is the version of this that most implementations ship, and it
       * is why interrupting an agent usually costs the thing it was doing.
       */
      this.running[node] = branch;
      if (status === SUCCESS) {
        this.clear(branch);
        this.running[node] = -1;
      }
      return status;
    }
    this.clear(node);
    return FAILURE;
  }

  /** Forget a subtree's progress, so it is entered fresh. Called when a branch finishes. */
  private clear(node: number): void {
    this.cursor[node] = 0;
    this.running[node] = -1;
    const start = this.tree.childStart[node] ?? 0;
    const end = this.tree.childStart[node + 1] ?? 0;
    for (let i = start; i < end; i++) this.clear(this.tree.child[i] ?? 0);
  }
}

/**
 * Every change to the world, as an object that can be undone.
 *
 * **Built before any panel exists, and that order is the point.** An undo stack added after the
 * panels is an undo stack with holes in it, and the holes are found by users rather than by tests:
 * one panel mutated directly, once, and now a particular sequence of actions cannot be taken back.
 * Built first, every panel is written against it.
 *
 * **A panel is never handed the world.** `Panel.route` returns a `Command` or nothing, so a panel
 * physically cannot change anything — the rule is enforced by the signature rather than by review.
 *
 * **Merging is what makes a drag usable.** A gizmo emits a command per frame; sixty of them in the
 * undo stack means sixty presses of undo to take back one movement. `merge` lets a command absorb
 * the next of its kind, so a drag is one entry.
 */
export interface Command {
  /** Shown in the undo menu and in the palette. */
  readonly label: string;
  apply(): void;
  revert(): void;
  /**
   * Absorb a following command of the same kind. Return true if it was absorbed.
   *
   * **Called after the stack has already applied `next`, and an implementation must not apply it
   * again.** Apply happens exactly once, by the stack, for every command — the alternative splits
   * that responsibility between the stack and each mergeable command, and the first implementation
   * of this got it wrong in exactly that way: the change ran twice and a drag moved twice as far
   * as the pointer.
   *
   * What absorbing means is that the *earlier* command's `revert` now takes back both.
   */
  merge?(next: Command): boolean;
}

export interface UndoStack {
  push(command: Command): void;
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  undoLabel(): string | null;
  redoLabel(): string | null;
  clear(): void;
}

export function createUndoStack(limit: number): UndoStack {
  /* Entries below `at` are done; entries from `at` up are the redo branch. */
  let entries: Command[] = [];
  let at = 0;

  return {
    push(command: Command): void {
      command.apply();

      const previous = at > 0 ? entries[at - 1] : undefined;
      if (previous?.merge !== undefined && previous.merge(command)) {
        /*
         * Absorbed. `command` has already been applied above and must not be applied again; what
         * changed is that `previous.revert` now takes back both. The redo branch still dies.
         */
        entries.length = at;
        return;
      }

      /* A new command after an undo discards the redo branch, which is what every editor does. */
      entries.length = at;
      entries.push(command);
      at += 1;

      if (entries.length > limit) {
        /*
         * The oldest is forgotten, never reverted. Reverting it on the way out would undo a change
         * the user made and kept, which is the ring-buffer bug this comment exists to prevent.
         */
        entries = entries.slice(entries.length - limit);
        at = entries.length;
      }
    },

    undo(): boolean {
      if (at === 0) return false;
      at -= 1;
      (entries[at] as Command).revert();
      return true;
    },

    redo(): boolean {
      if (at >= entries.length) return false;
      (entries[at] as Command).apply();
      at += 1;
      return true;
    },

    canUndo: () => at > 0,
    canRedo: () => at < entries.length,
    undoLabel: () => (at > 0 ? (entries[at - 1] as Command).label : null),
    redoLabel: () => (at < entries.length ? (entries[at] as Command).label : null),
    clear(): void {
      entries = [];
      at = 0;
    },
  };
}

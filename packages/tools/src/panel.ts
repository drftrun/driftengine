/**
 * The shape every panel shares.
 *
 * **`route` is handed the world read-only and returns a command or nothing.** That one signature is
 * what makes "a panel mutates only through commands" enforceable rather than aspirational: a panel
 * physically cannot change the world, because it is given no way to. The undo stack is only as good
 * as its worst offender, and this is how there is no worst offender.
 *
 * **The world and the view are two parameters, and the plan had them as one.** Writing the scene
 * tree found out why they cannot be: a drag in progress, which row is hovered, how far the list is
 * scrolled and which branches are open are all things `route` must write, and none of them belongs
 * to the world. With one state object, "never mutates state" is either false or the panel cannot
 * record a drag. Split, the claim is exact — `Readonly<W>` for what the world owns, `V` for what
 * the panel owns — and the frozen-state test below is meaningful rather than true by construction.
 * `Readonly` is shallow and so is not a proof; it is a statement of intent in the place a reader
 * will look, which is the same standing every other rule in this repository has.
 *
 * **`build` is a function of both.** Building twice over the same world and view reaches the same
 * tree, so a panel can be rebuilt whenever anything changes without anybody reasoning about what it
 * was showing before. `treeShape` is how a test says that, and every panel's test uses it.
 *
 * **Nothing to show is a state and not a failure.** A panel with no selection, an asset browser
 * before the project has loaded and a profiler before the first frame all reach `emptyPanel`. An
 * empty dock with an exception behind it is the least useful thing an editor can show.
 */
import { addUiChild, createUiNode } from '@driftengine/ui2d';
import type { UiNode } from '@driftengine/ui2d';
import type { Command } from './command.ts';

/**
 * What a panel is asked to deal with.
 *
 * Positions are in the panel's own space — the caller has already subtracted the dock site's
 * origin — so a panel never knows where on screen it is, and a panel moved to another dock behaves
 * identically. `button` is 0 for the primary; a context menu is 2, as every platform spells it.
 */
export type UiEvent =
  | {
      readonly kind: 'pointer';
      readonly phase: 'down' | 'move' | 'up';
      readonly x: number;
      readonly y: number;
      readonly button: number;
    }
  | { readonly kind: 'key'; readonly key: string; readonly shift: boolean; readonly ctrl: boolean }
  | {
      readonly kind: 'wheel';
      readonly x: number;
      readonly y: number;
      readonly dx: number;
      readonly dy: number;
    };

export function pointerEvent(
  phase: 'down' | 'move' | 'up',
  x: number,
  y: number,
  button = 0,
): UiEvent {
  return { kind: 'pointer', phase, x, y, button };
}

export function keyEvent(key: string, shift = false, ctrl = false): UiEvent {
  return { kind: 'key', key, shift, ctrl };
}

export function wheelEvent(x: number, y: number, dx: number, dy: number): UiEvent {
  return { kind: 'wheel', x, y, dx, dy };
}

export interface Panel<W, V> {
  /** Stable for the life of the panel. What the dock layout stores. */
  readonly id: string;
  /** What the dock tab says. */
  readonly title: string;
  /** Fill `root` from the world and the view. Called whenever either may have changed. */
  build(world: Readonly<W>, view: V, root: UiNode): void;
  /**
   * What this event asks of the *world*, or nothing.
   *
   * May write `view` — a drag has to be recorded somewhere, and so do a scroll and a hover. May
   * not write `world`, which is what the command it returns is for.
   */
  route(world: Readonly<W>, view: V, event: UiEvent): Command | null;
}

/** The prefix a panel root's name carries, so the dock can recognise one. */
export const PANEL_PREFIX = 'panel:';

/**
 * The node a panel builds into.
 *
 * The identifier lives on the root rather than in a map beside the tree, so the dock reads it off
 * whatever node it is holding and there is nothing to keep in step. It takes the identifier alone
 * rather than a `Panel<S>`, so a caller need not name the state type to make a root. `clip`,
 * because a panel's content is
 * routinely taller than its site, and a panel drawing outside its dock is the first thing anybody
 * notices.
 */
export function createPanelRoot(panel: { readonly id: string }): UiNode {
  return createUiNode({
    direction: 'column',
    width: 'grow',
    height: 'grow',
    clip: true,
    name: `${PANEL_PREFIX}${panel.id}`,
  });
}

/** Which panel a node is the root of, or null. */
export function panelIdOf(node: UiNode | null): string | null {
  if (node === null || !node.name.startsWith(PANEL_PREFIX)) return null;
  const id = node.name.slice(PANEL_PREFIX.length);
  return id.length > 0 ? id : null;
}

/**
 * Replace a panel's contents with one line saying why there is nothing.
 *
 * Not interactive, because a message is not a control and a person who clicks it and gets a
 * selection has learnt something untrue about the panel.
 */
export function emptyPanel(root: UiNode, message: string): void {
  root.children.length = 0;
  addUiChild(
    root,
    createUiNode({ width: 'grow', height: 18, text: message, name: 'empty', interactive: false }),
  );
}

/**
 * A tree as a comparable string: structure, text, geometry and name, but never identity.
 *
 * **What it deliberately leaves out is object identity**, because a panel that reuses its pooled
 * rows and one that rebuilt them are the same panel as far as the contract is concerned — the
 * whole point of pooling is that nobody downstream can tell. What it deliberately includes is
 * `hidden`, because a pooled row that is not showing is exactly how a panel shrinks, and two trees
 * differing only there are showing different things.
 */
export function treeShape(node: UiNode, depth = 0): string {
  const pad = '  '.repeat(depth);
  const size = `${String(node.width)}x${String(node.height)}`;
  const flags = `${node.hidden ? 'h' : '-'}${node.interactive ? 'i' : '-'}${node.clip ? 'c' : '-'}`;
  const own = `${pad}${node.name || '(unnamed)'} ${size} ${flags} ${node.layer} ${JSON.stringify(node.text)}`;
  const children = node.children.map((child) => treeShape(child, depth + 1));
  return [own, ...children].join('\n');
}

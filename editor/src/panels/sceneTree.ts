/**
 * The world as a tree you can reorganise.
 *
 * **The selection is view state and not world state**, which the plan says in words — "selecting a
 * row updates the selection and not the world" — and which this file says in the type. Selecting is
 * not an undo entry in any editor anybody uses, so it cannot be a command; and it is shared between
 * the tree, the inspector and the viewport, so it is held by reference rather than owned here.
 *
 * **A node cannot become its own ancestor.** The alternative is not a wrong picture, it is a cycle,
 * and the next walk of the hierarchy does not return — so the refusal is in `reparentCommand`,
 * before a command exists, rather than in the panel that happens to call it.
 *
 * **Rows come from the tree widget**, so ten thousand entities build the same twenty-odd nodes as
 * ten, and expansion is keyed by entity identifier. Keyed by index, adding an entity above a
 * collapsed branch shifts every index below it and the collapse lands on whatever moved into the
 * slot — which is why a scene tree appears to collapse itself during ordinary work.
 */
import { addUiChild } from '@driftengine/ui2d';
import type { UiNode } from '@driftengine/ui2d';
import {
  type Command,
  addToSelection,
  selectOnly,
  type Selection,
  createPanelRoot,
  type Panel,
} from '@driftengine/tools';
import {
  createTree,
  layoutTree,
  rebuildTree,
  toggleTreeRow,
  treeRowAt,
  type Tree,
  type TreeItem,
} from '../widgets/tree.ts';

/**
 * The hierarchy, as identifiers and parents.
 *
 * **Identifiers and not `SceneNode`s**, so a panel can be tested with no engine at all — which is
 * this plan's second constraint — and so the same panel serves a scene graph and an entity store.
 * A caller holding either builds this from it.
 */
export class SceneModel {
  /** Every entity, in the order they were added. A subtree's order is its slice of this. */
  private readonly order: number[] = [];
  private readonly parent = new Map<number, number>();
  private readonly name = new Map<number, string>();

  get ids(): readonly number[] {
    return this.order;
  }

  has(id: number): boolean {
    return this.parent.has(id);
  }

  /** The parent's identifier, `-1` for a root, and `-1` for an entity that is not here. */
  parentOf(id: number): number {
    return this.parent.get(id) ?? -1;
  }

  nameOf(id: number): string {
    return this.name.get(id) ?? '';
  }

  add(id: number, parent: number, name: string, at = this.order.length): void {
    if (this.parent.has(id)) return;
    this.order.splice(at, 0, id);
    this.parent.set(id, parent);
    this.name.set(id, name);
  }

  remove(id: number): void {
    const at = this.order.indexOf(id);
    if (at >= 0) this.order.splice(at, 1);
    this.parent.delete(id);
    this.name.delete(id);
  }

  setParent(id: number, parent: number): void {
    if (this.parent.has(id)) this.parent.set(id, parent);
  }

  setName(id: number, name: string): void {
    if (this.parent.has(id)) this.name.set(id, name);
  }

  /** Where an entity sits in the flat order, so a delete can put it back where it was. */
  indexOf(id: number): number {
    return this.order.indexOf(id);
  }

  /** Move `id` immediately before `before` in the order. Used to reorder siblings. */
  moveBefore(id: number, before: number): void {
    const from = this.order.indexOf(id);
    if (from < 0) return;
    this.order.splice(from, 1);
    const to = this.order.indexOf(before);
    this.order.splice(to < 0 ? this.order.length : to, 0, id);
  }
}

export function createSceneModel(): SceneModel {
  return new SceneModel();
}

/** Whether `id` is anywhere beneath `ancestor`. The loop that a cycle would not leave is bounded. */
export function isDescendantOf(model: SceneModel, id: number, ancestor: number): boolean {
  let at = model.parentOf(id);
  /* Bounded by the number of entities, so a hierarchy that is already cyclic answers rather
     than hangs — this is the function that exists to stop cycles and must survive one. */
  for (let steps = 0; at !== -1 && steps <= model.ids.length; steps += 1) {
    if (at === ancestor) return true;
    at = model.parentOf(at);
  }
  return false;
}

/** The hierarchy flattened depth-first, which is the order it reads in. */
export function sceneTreeItems(model: SceneModel): TreeItem[] {
  const children = new Map<number, number[]>();
  for (const id of model.ids) {
    const parent = model.parentOf(id);
    const list = children.get(parent);
    if (list === undefined) children.set(parent, [id]);
    else list.push(id);
  }

  const items: TreeItem[] = [];
  const visit = (id: number, depth: number): void => {
    const kids = children.get(id) ?? [];
    items.push({ id, depth, hasChildren: kids.length > 0, label: model.nameOf(id) });
    for (const kid of kids) visit(kid, depth + 1);
  };
  for (const root of children.get(-1) ?? []) visit(root, 0);
  return items;
}

/** Every entity in a subtree, the root first, so a delete removes children before parents. */
function subtreeOf(model: SceneModel, root: number): number[] {
  const out: number[] = [];
  const items = sceneTreeItems(model);
  const at = items.findIndex((item) => item.id === root);
  if (at < 0) return out;
  const depth = (items[at] as TreeItem).depth;
  out.push(root);
  for (let i = at + 1; i < items.length && (items[i] as TreeItem).depth > depth; i += 1) {
    out.push((items[i] as TreeItem).id);
  }
  return out;
}

/**
 * Move `child` under `parent`. Null where the hierarchy refuses.
 *
 * **Null rather than a throw**, because the caller is a drop inside a frame and an exception there
 * takes down the frame somebody is dragging in — the same reasoning `SceneTree.reparent` gives for
 * answering instead of throwing.
 */
export function reparentCommand(model: SceneModel, child: number, parent: number): Command | null {
  if (!model.has(child)) return null;
  if (parent !== -1 && !model.has(parent)) return null;
  if (child === parent) return null;
  if (parent !== -1 && isDescendantOf(model, parent, child)) return null;

  const was = model.parentOf(child);
  if (was === parent) return null;
  return {
    label: `Reparent ${model.nameOf(child)}`,
    apply: () => model.setParent(child, parent),
    revert: () => model.setParent(child, was),
  };
}

export function renameCommand(model: SceneModel, id: number, to: string): Command | null {
  if (!model.has(id)) return null;
  const was = model.nameOf(id);
  if (was === to) return null;
  return {
    label: `Rename ${was}`,
    apply: () => model.setName(id, to),
    revert: () => model.setName(id, was),
  };
}

/**
 * Delete an entity and everything under it, as one entry.
 *
 * **One entry, because deleting a parent is one act.** Undo that put back a subtree one node per
 * press would be the editor insisting on its own internal structure, and the person would have to
 * count. The positions are recorded so the subtree comes back where it was rather than at the end,
 * which is otherwise the first thing anybody notices about undo.
 */
export function deleteEntityCommand(model: SceneModel, id: number): Command | null {
  if (!model.has(id)) return null;
  const doomed = subtreeOf(model, id);
  const record = doomed
    .map((entity) => ({
      id: entity,
      parent: model.parentOf(entity),
      name: model.nameOf(entity),
      at: model.indexOf(entity),
    }))
    .sort((a, b) => a.at - b.at);

  return {
    label: `Delete ${model.nameOf(id)}`,
    apply: (): void => {
      for (const entry of record) model.remove(entry.id);
    },
    revert: (): void => {
      for (const entry of record) model.add(entry.id, entry.parent, entry.name, entry.at);
    },
  };
}

/**
 * Copy an entity and its subtree in beside the original.
 *
 * `allocate` is the caller's, because identifiers belong to whatever owns the world — an entity
 * store hands out its own and a scene graph has none to hand out.
 */
export function duplicateEntityCommand(
  model: SceneModel,
  id: number,
  allocate: () => number,
): Command | null {
  if (!model.has(id)) return null;
  const source = subtreeOf(model, id);
  const copies = new Map<number, number>();
  for (const entity of source) copies.set(entity, allocate());

  const made = source.map((entity) => ({
    id: copies.get(entity) as number,
    parent: entity === id ? model.parentOf(id) : (copies.get(model.parentOf(entity)) as number),
    name: entity === id ? `${model.nameOf(id)} copy` : model.nameOf(entity),
  }));

  return {
    label: `Duplicate ${model.nameOf(id)}`,
    apply: (): void => {
      for (const entry of made) model.add(entry.id, entry.parent, entry.name);
    },
    revert: (): void => {
      for (const entry of made) model.remove(entry.id);
    },
  };
}

/** What the panel shows. Read-only: nothing here is written except through a command. */
export interface SceneTreeWorld {
  readonly model: SceneModel;
}

/** What the panel owns: the widget, the shared selection, and a drag in progress. */
export interface SceneTreeView {
  readonly root: UiNode;
  readonly tree: Tree;
  readonly selection: Selection;
  viewHeight: number;
  indent: number;
  /** How wide a row's twisty is, at whatever depth the row sits. */
  twistyWidth: number;
  /** Whether the modifier that extends a selection is held. The caller supplies it. */
  shift: boolean;
  /** The entity a press landed on, or -1. A drag and a click begin the same way. */
  dragFrom: number;
  /** Set when a press landed on a twisty, so the release does not also select. */
  twistyHit: boolean;
}

export interface SceneTreeViewOptions {
  readonly selection: Selection;
  readonly rowHeight?: number;
  readonly viewHeight?: number;
  readonly overscan?: number;
  readonly indent?: number;
  readonly twistyWidth?: number;
}

export function createSceneTreeView(options: SceneTreeViewOptions): SceneTreeView {
  const indent = options.indent ?? 12;
  const tree = createTree({
    rowHeight: options.rowHeight ?? 18,
    overscan: options.overscan ?? 2,
    indent,
    name: 'scene-tree-rows',
  });
  const root = createPanelRoot(sceneTreePanel);
  addUiChild(root, tree.node);
  return {
    root,
    tree,
    selection: options.selection,
    viewHeight: options.viewHeight ?? 360,
    indent,
    twistyWidth: options.twistyWidth ?? 12,
    shift: false,
    dragFrom: -1,
    twistyHit: false,
  };
}

/** Which entity a position in the panel names, or -1. Scroll is content space, as everywhere. */
function entityAt(view: SceneTreeView, y: number): TreeItem | null {
  return treeRowAt(view.tree, y + view.tree.scrollY);
}

/** Whether a press landed on the twisty of a row that has one. */
function onTwisty(view: SceneTreeView, item: TreeItem, x: number): boolean {
  if (!item.hasChildren) return false;
  const from = item.depth * view.indent;
  return x >= from && x < from + view.twistyWidth;
}

export const sceneTreePanel: Panel<SceneTreeWorld, SceneTreeView> = {
  id: 'scene-tree',
  title: 'Scene',

  build(world, view, root): void {
    rebuildTree(view.tree, sceneTreeItems(world.model));
    layoutTree(view.tree, view.viewHeight);
    if (root.children.length === 0) addUiChild(root, view.tree.node);
  },

  route(world, view, event): Command | null {
    if (event.kind !== 'pointer' || event.button !== 0) return null;
    const item = entityAt(view, event.y);

    if (event.phase === 'down') {
      view.twistyHit = false;
      view.dragFrom = -1;
      if (item === null) return null;
      if (onTwisty(view, item, event.x)) {
        toggleTreeRow(view.tree, item.id);
        view.twistyHit = true;
        return null;
      }
      view.dragFrom = item.id;
      return null;
    }

    if (event.phase === 'move') return null;

    const from = view.dragFrom;
    view.dragFrom = -1;
    if (view.twistyHit) {
      view.twistyHit = false;
      return null;
    }
    if (from < 0 || item === null) return null;

    /* Let go where it started: a click, which is a selection and never a command. */
    if (item.id === from) {
      if (view.shift) addToSelection(view.selection, from);
      else selectOnly(view.selection, from);
      return null;
    }
    return reparentCommand(world.model, from, item.id);
  },
};

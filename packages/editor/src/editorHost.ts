/**
 * Selection, the gizmo, and play-in-editor.
 *
 * **The loop already has the seam this needs.** `LoopHooks.shouldSimulate` exists so a paused game
 * keeps rendering — the world stays on screen behind the menu instead of freezing on whatever frame
 * it stopped at — and that is exactly what an editor wants. `shouldSimulate` here is handed to
 * `startLoop` and is the whole of pause.
 *
 * ## What makes stop harder than it looks
 *
 * **`deserializeWorld` creates entities.** It does not replace a world's contents; it appends to
 * them. So restoring a snapshot by loading it leaves the world holding both what was authored and
 * what play produced, which is not a restore — it is a duplication that grows every time somebody
 * presses stop. This clears first, walking the same `store.dense` per type that `serializeWorld`
 * walks to decide what is live.
 *
 * **And every entity handle changes across a stop**, because the restored entities are new ones. A
 * selection held as a handle is stale the moment play ends — pointing at nothing, or at whatever
 * reused the slot, which is the worse of the two because it looks like it worked. So an entity
 * selection is remembered by its *index in the snapshot*, which is the only identity that survives,
 * and an entity created during play has no index and the selection is cleared rather than moved to
 * a stranger.
 *
 * **What a snapshot covers is the component types it was given and nothing else.** Not the node
 * hierarchy, not a physics world, not an audio graph. `serializeWorld` makes the same point about
 * types: a scene is a decision about what to save.
 */
import { Gizmo } from '@driftengine/core';
import type { SceneNode } from '@driftengine/core';
import { deserializeWorld, serializeWorld } from '@driftengine/entities';
import type { ComponentType, Entity, SerializedScene, World } from '@driftengine/entities';
import { Inspector } from './inspector.ts';
import { SceneTree } from './sceneTree.ts';

export type EditorMode = 'edit' | 'play' | 'paused';

export interface EditorWorld {
  readonly world: World;
  /** What a snapshot covers. See the header: this is a decision, not a discovery. */
  readonly types: readonly ComponentType[];
}

export class EditorHost {
  readonly tree = new SceneTree();
  readonly inspector = new Inspector();
  readonly gizmo = new Gizmo();

  private state: EditorMode = 'edit';
  private readonly bound: EditorWorld | null;
  private snapshot: SerializedScene | null = null;
  /** Where the selected entity sat in the snapshot, so it can be found again after a restore. */
  private selectedIndex = -1;
  private selectedEntity: Entity | null = null;
  /** Consumed by the next `shouldSimulate`, which is what makes a step exactly one tick. */
  private pendingStep = false;

  constructor(bound: EditorWorld | null = null) {
    this.bound = bound;
  }

  get mode(): EditorMode {
    return this.state;
  }

  /** The entity selected, or null. Cleared by a stop that did not restore it. */
  get entity(): Entity | null {
    return this.selectedEntity;
  }

  /**
   * Hand this to `startLoop` as `shouldSimulate`.
   *
   * **It has a side effect and that is the point**: a pending step is consumed here, so exactly one
   * tick runs and the next call answers false. A step expressed as a duration would advance a
   * variable number of ticks depending on which frame it landed in, which is the opposite of what
   * stepping is for.
   */
  shouldSimulate = (): boolean => {
    if (this.state === 'play') return true;
    if (this.pendingStep) {
      this.pendingStep = false;
      return true;
    }
    return false;
  };

  /** Select a node, point the gizmo at it, and show its transform. */
  select(node: SceneNode | null): void {
    this.tree.selected = node;
    this.selectedEntity = null;
    this.selectedIndex = -1;
    if (node === null) {
      this.inspector.showNothing();
      return;
    }
    this.inspector.showNode(node);
    this.syncGizmo();
  }

  /**
   * Select an entity, and remember where it sits in the snapshot if one is open.
   *
   * The index is taken now rather than at stop, because at stop the entity may already be gone and
   * there would be nothing left to look it up by.
   */
  selectEntity(entity: Entity | null): void {
    this.tree.selected = null;
    this.selectedEntity = entity;
    this.selectedIndex = entity === null ? -1 : this.indexInSnapshot(entity);
    if (entity === null || this.bound === null) {
      this.inspector.showNothing();
      return;
    }
    this.inspector.showEntity(this.bound.world, entity, this.bound.types);
  }

  /** Move the gizmo onto the selection. A selection of nothing leaves it where it was. */
  syncGizmo(): void {
    const node = this.tree.selected;
    if (node === null) return;
    this.gizmo.position.set(node.position);
    this.gizmo.rotation.set(node.rotation);
    this.gizmo.scale.set(node.scale);
  }

  /**
   * Write the gizmo's transform onto the selection, and refresh what the inspector shows.
   *
   * Through the node's setters, for the reason `inspector.ts` gives: writing the arrays leaves the
   * world matrix stale and the node draws where it used to be.
   */
  applyGizmo(): void {
    const node = this.tree.selected;
    if (node === null) return;
    node.setPosition(
      this.gizmo.position[0] as number,
      this.gizmo.position[1] as number,
      this.gizmo.position[2] as number,
    );
    node.setScale(
      this.gizmo.scale[0] as number,
      this.gizmo.scale[1] as number,
      this.gizmo.scale[2] as number,
    );
    node.rotation.set(this.gizmo.rotation);
    node.markMoved();
    this.inspector.refresh();
  }

  /**
   * Enter play, taking a snapshot first. `false` when there is no world bound to snapshot.
   *
   * Playing from `paused` resumes without re-snapshotting, so pausing does not throw away the state
   * stop would have returned to.
   */
  play(): boolean {
    if (this.state === 'paused') {
      this.state = 'play';
      return true;
    }
    if (this.bound === null) return false;
    this.snapshot = serializeWorld(this.bound.world, this.bound.types);
    if (this.selectedEntity !== null)
      this.selectedIndex = this.indexInSnapshot(this.selectedEntity);
    this.state = 'play';
    return true;
  }

  pause(): void {
    if (this.state === 'play') this.state = 'paused';
  }

  /** One tick, then paused. Does nothing outside play mode, where there is nothing to step. */
  step(): void {
    if (this.state === 'edit') return;
    this.state = 'paused';
    this.pendingStep = true;
  }

  /**
   * Leave play and put the world back. `false` when there is nothing to put back.
   *
   * See the header for why this is a clear and then a load rather than a load.
   */
  stop(): boolean {
    if (this.bound === null || this.snapshot === null) {
      this.state = 'edit';
      return false;
    }
    this.clearWorld();
    const result = deserializeWorld(this.bound.world, this.snapshot, this.bound.types);
    this.state = 'edit';
    this.pendingStep = false;
    if (!result.loaded) return false;

    /* The selection follows its index, which is the only identity that survived. An entity that was
       created during play has none, and the selection is emptied rather than pointed at a stranger. */
    const restored = this.selectedIndex >= 0 ? result.entities[this.selectedIndex] : undefined;
    this.selectEntity(restored ?? null);
    return true;
  }

  /**
   * Every entity any of the bound types holds, destroyed.
   *
   * The same walk `serializeWorld` does, and for the same reason: a world's live set is what its
   * stores hold, and there is no other enumeration of it. Collected before destroying, because
   * destroying while walking a store's dense array moves entries under the walk.
   */
  private clearWorld(): void {
    if (this.bound === null) return;
    const { world, types } = this.bound;
    const seen = new Set<Entity>();
    for (const type of types) {
      const store = world.store(type);
      for (let at = 0; at < store.size; at++) seen.add(store.dense[at] as Entity);
    }
    for (const entity of seen) world.destroy(entity);
  }

  /** Where an entity sits in the snapshot's ordering, or `-1`. */
  private indexInSnapshot(entity: Entity): number {
    if (this.bound === null) return -1;
    const { world, types } = this.bound;
    const seen = new Set<Entity>();
    let index = 0;
    for (const type of types) {
      const store = world.store(type);
      for (let at = 0; at < store.size; at++) {
        const candidate = store.dense[at] as Entity;
        if (seen.has(candidate)) continue;
        if (candidate === entity) return index;
        seen.add(candidate);
        index += 1;
      }
    }
    return -1;
  }
}

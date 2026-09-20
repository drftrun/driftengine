/**
 * What the viewport holds, described once so a host can draw it with the engine.
 *
 * **This is what replaces the placeholder.** `frontEnd.ts` drew a disc per prop with a 2D context,
 * because the editor had to open before a renderer was wired to it — and it said so in its own
 * header rather than leaving somebody to discover it. A disc is not a scene: it cannot show what a
 * capture produced, which is the one thing the editor is now for.
 *
 * **Described rather than drawn, for the same reason the rest of the front end is.** A host turns
 * these calls into its own drawing — the browser into `RendererApi`, a native shell into the same
 * calls on its own device, a test into an array — so there is one decision about what the viewport
 * contains and one implementation of it, rather than one per host.
 *
 * **Allocation-free on purpose.** This runs every frame over every entity in a scene; a list of
 * fresh objects sixty times a second is exactly the garbage the engine's rules forbid, so the
 * caller owns the array and it is refilled in place.
 */
import type { Selection } from '@driftengine/tools';

import type { ShellScene } from '../shell.ts';

export interface ViewportItem {
  entity: number;
  x: number;
  y: number;
  z: number;
  /** What the scene says it is worth drawing at. Picking uses the same number. */
  radius: number;
  selected: boolean;
}

/** What a host draws with. One call for the capture's surface and one per thing in it. */
export interface ViewportTarget {
  /** The captured surface itself, at the origin, or nothing where none is open. */
  surface(): void;
  /** A marker for one entity: where it is, how big, and whether it is selected. */
  marker(item: Readonly<ViewportItem>): void;
}

/** Grow `out` to hold every entity, filling it in place. Returns how many were written. */
export function viewportItems(
  scene: ShellScene,
  selection: Selection,
  out: ViewportItem[],
): number {
  const entities = scene.entities();
  while (out.length < entities.length) {
    out.push({ entity: -1, x: 0, y: 0, z: 0, radius: 0, selected: false });
  }
  const at = scratch;
  let count = 0;
  for (const entity of entities) {
    if (!scene.positionOf(entity, at)) continue;
    const item = out[count] as ViewportItem;
    item.entity = entity;
    item.x = at[0] as number;
    item.y = at[1] as number;
    item.z = at[2] as number;
    item.radius = scene.radiusOf(entity);
    item.selected = selection.entities.includes(entity);
    count += 1;
  }
  return count;
}

const scratch = new Float32Array(3);

/**
 * One frame of the viewport, as calls on `target`.
 *
 * **The surface is drawn first and unconditionally**, because a capture's own geometry is the
 * subject and the markers are annotations over it. A host with nothing open draws nothing for it,
 * which is its decision rather than this file's.
 */
export function drawViewport(
  items: readonly ViewportItem[],
  count: number,
  target: ViewportTarget,
): void {
  target.surface();
  for (let at = 0; at < count; at += 1) target.marker(items[at] as ViewportItem);
}

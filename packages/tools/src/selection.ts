/**
 * What is selected, which of it is primary, and in what order.
 *
 * **Order is kept, and that is not cosmetic.** A multi-entity gizmo pivots on the primary
 * selection; if the order drifts between frames the pivot jumps, and a drag that started around one
 * object finishes around another. Insertion order with the primary as the most recent addition is
 * both what a person expects and what keeps the pivot still.
 */
export interface Selection {
  /** Selected entities, in the order they were added. */
  entities: number[];
}

export function createSelection(): Selection {
  return { entities: [] };
}

export function selectOnly(selection: Selection, entity: number): void {
  selection.entities.length = 0;
  selection.entities.push(entity);
}

export function addToSelection(selection: Selection, entity: number): void {
  if (selection.entities.includes(entity)) return;
  selection.entities.push(entity);
}

export function toggleSelection(selection: Selection, entity: number): void {
  const at = selection.entities.indexOf(entity);
  if (at === -1) selection.entities.push(entity);
  else selection.entities.splice(at, 1);
}

/**
 * Select everything between two entities in a caller-supplied order.
 *
 * The order is the caller's because only the caller knows it — a scene tree's order is its own
 * flattening, and an asset browser's is its filter and sort. Inclusive at both ends, and the same
 * set whichever end is given first.
 */
export function selectRange(
  selection: Selection,
  from: number,
  to: number,
  order: readonly number[],
): void {
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  if (a === -1 || b === -1) return;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  selection.entities.length = 0;
  for (let i = lo; i <= hi; i += 1) selection.entities.push(order[i] as number);
}

export function clearSelection(selection: Selection): void {
  selection.entities.length = 0;
}

export function selectedEntities(selection: Selection): readonly number[] {
  return selection.entities;
}

export function isSelected(selection: Selection, entity: number): boolean {
  return selection.entities.includes(entity);
}

/** The most recently added, which is what an inspector shows and what a gizmo pivots on. */
export function primarySelection(selection: Selection): number | null {
  return selection.entities.length === 0
    ? null
    : (selection.entities[selection.entities.length - 1] as number);
}

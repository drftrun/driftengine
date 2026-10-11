/**
 * A few bind groups kept under one key, each found again by the four resources it was built with,
 * compared by identity.
 *
 * **Why more than one.** A skinned draw's group was kept one a palette slot and material and made
 * again whenever a resource in it differed from the last draw's. A garment's particles live in two
 * textures that take turns, a step each, so a draw following cloth found the other texture every
 * frame; and several meshes following one cloth bind one particle texture each with a binding of
 * its own, so they replaced each other's group draw by draw. Reported at twenty-four groups made a
 * frame for two characters, and none with cloth off. A shelf keeps each combination it has seen,
 * so a steady garment's draws bind the groups of two frames ago and make none.
 *
 * **What it gives up** is a bound: `SHELF_CAPACITY` groups a key, replaced oldest first. Eight
 * meshes following cloth under one palette slot and material fit, two groups each; a ninth makes
 * groups again every frame, as every draw did before, and nothing worse. What would make it wrong
 * is a draw whose resources change every frame for another reason, which a shelf cannot help and
 * which would cycle it.
 */

/** Groups a shelf keeps before it replaces the oldest. See the module comment for the count. */
export const SHELF_CAPACITY = 16;

/** One key's groups and what each was built with, four identities a group, flat. */
export class GroupShelf {
  private readonly groups: (GPUBindGroup | null)[] = new Array<GPUBindGroup | null>(
    SHELF_CAPACITY,
  ).fill(null);
  private readonly made: (object | null)[] = new Array<object | null>(SHELF_CAPACITY * 4).fill(
    null,
  );
  /** Where the next group goes: the oldest, once the shelf is full. */
  private next = 0;

  /** The group built with exactly these four, or null. */
  find(
    a: object | null,
    b: object | null,
    c: object | null,
    d: object | null,
  ): GPUBindGroup | null {
    for (let slot = 0; slot < SHELF_CAPACITY; slot++) {
      const group = this.groups[slot] ?? null;
      if (group === null) return null;
      const at = slot * 4;
      if (
        this.made[at] === a &&
        this.made[at + 1] === b &&
        this.made[at + 2] === c &&
        this.made[at + 3] === d
      ) {
        return group;
      }
    }
    return null;
  }

  /** Keep `group` as the one built with these four. */
  keep(
    group: GPUBindGroup,
    a: object | null,
    b: object | null,
    c: object | null,
    d: object | null,
  ): void {
    const slot = this.next;
    this.groups[slot] = group;
    const at = slot * 4;
    this.made[at] = a;
    this.made[at + 1] = b;
    this.made[at + 2] = c;
    this.made[at + 3] = d;
    this.next = (slot + 1) % SHELF_CAPACITY;
  }
}

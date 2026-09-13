import { ColliderSet } from '../colliderSet.ts';

/**
 * The index buffer a `ColliderSet` query writes into.
 *
 * Shared by the sweep and the segment test rather than duplicated, because it was one buffer
 * in the file these were split from and neither caller is re-entrant. Giving each its own
 * would be a behaviour change smuggled into a move.
 */
export const hits = new Int32Array(ColliderSet.MAX_HITS);

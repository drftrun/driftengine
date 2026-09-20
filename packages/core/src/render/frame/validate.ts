/**
 * Whether a recorded frame is one that can be executed.
 *
 * One rule: a node may read an identifier only if something wrote it earlier in this frame, or
 * it was imported into the frame from outside. That catches the whole family of defects a fixed
 * resource table caught by construction — a pass sampling an attachment the quality settings
 * disabled, a pass reading a mip chain built only when a different feature is on — and which
 * identifiers do not catch by construction, because any integer is a plausible identifier.
 *
 * Returns a message rather than throwing. The renderer decides whether a malformed frame is a
 * developer-time assertion or a dropped frame, and a validator that throws has made that
 * decision for it.
 */
import type { Deps } from './deps.ts';
import { readsOf, writesOf } from './deps.ts';

export function validateGraph(
  deps: Deps,
  count: number,
  imported: readonly number[],
): string | null {
  const written = new Set<number>(imported);
  for (let node = 0; node < count; node += 1) {
    /*
     * Reads are checked before this node's writes join the set, which is what makes a read of
     * something written only later a refusal and a read-modify-write legal — the latter is
     * reading contents something earlier put there.
     */
    const reads = readsOf(deps, node);
    for (let i = 0; i < reads.length; i += 1) {
      const id = reads[i] ?? 0;
      if (!written.has(id)) {
        return `node ${node} reads resource ${id}, which nothing wrote and nothing imported`;
      }
    }
    const writes = writesOf(deps, node);
    for (let i = 0; i < writes.length; i += 1) written.add(writes[i] ?? 0);
  }
  return null;
}

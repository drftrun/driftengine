import type { Pose } from './pose.ts';
import type { Skeleton } from './skeleton.ts';

/**
 * Playing one skeleton's clip on another.
 *
 * **Rotations transfer and translations do not, and that is the whole of it.** Two rigs of
 * different proportions share joint *orientations* and not bone lengths, so copying a translation
 * puts the taller rig's limbs inside its own body. The root is the exception, because that is
 * where locomotion lives — a walk whose root did not move would be a moonwalk.
 *
 * What this does not do is retarget between *different topologies*: a rig with a split spine
 * playing a clip from one with a single spine needs a decision about how to distribute the
 * rotation, and that decision belongs to whoever knows what the character is. This matches by
 * name, transfers what matches, and says what did not.
 */

export interface RetargetMap {
  /** Source joint index to target joint index, or -1 where the target has no such joint. */
  readonly indices: Int16Array;
  /** Source joint names the target does not have, in source order. */
  readonly unmatched: readonly string[];
}

/**
 * Match two skeletons by joint name.
 *
 * **Exact matching, and no name database.** A table of "hips means Hips means pelvis" rots
 * silently and its failure is a limb that does not move, which no test of this engine could catch
 * — the same argument the gamepad layer makes for shipping no device database. A consumer whose
 * two rigs disagree about capitalisation knows that and can rename; this engine guessing would be
 * wrong in a way they could not see.
 */
export function buildRetargetMap(from: Skeleton, to: Skeleton): RetargetMap {
  const byName = new Map<string, number>();
  to.joints.forEach((joint, at) => {
    /* First wins, so a rig with two joints of one name maps to the earlier — the one nearer the
       root, since joints are sorted parents-first. */
    if (!byName.has(joint.name)) byName.set(joint.name, at);
  });

  const indices = new Int16Array(from.jointCount);
  const unmatched: string[] = [];
  from.joints.forEach((joint, at) => {
    const found = byName.get(joint.name);
    if (found === undefined) {
      indices[at] = -1;
      unmatched.push(joint.name);
      return;
    }
    indices[at] = found;
  });

  /*
   * Reported rather than acted on. Whether a missing joint is a broken import, a deliberately
   * simpler rig, or something to substitute for is a product decision — the same line `rebind`
   * draws when it reports the actions it displaced rather than deciding about them.
   */
  return { indices, unmatched };
}

/**
 * Write `source`, played on `from`, onto `to` in `out`. Allocates nothing.
 *
 * A joint the target has and the source does not is **left exactly as it was found**, so a
 * character with a tail wearing a clip from one without keeps its tail wherever its own idle put
 * it rather than snapping to rest. That is the layering `sampleClip` provides one level down, and
 * it is what lets a retargeted clip be laid over a base pose.
 */
export function retargetPose(
  map: RetargetMap,
  from: Skeleton,
  source: Pose,
  to: Skeleton,
  out: Pose,
): void {
  for (let j = 0; j < from.jointCount; j++) {
    const target = map.indices[j] ?? -1;
    /*
     * The `-1` is the real guard; the upper bound is unreachable from a map `buildRetargetMap`
     * produced, since it only ever names a joint the target has. Kept for a hand-built map, and
     * said so rather than left to read as load-bearing — perturbing it away leaves every test
     * green, which is how that was established.
     */
    if (target < 0 || target >= to.jointCount) continue;

    const sourceAt = j * 4;
    const targetAt = target * 4;
    for (let c = 0; c < 4; c++)
      out.rotation[targetAt + c] = source.rotation[sourceAt + c] as number;

    /*
     * The root's translation, and only the root's. Everything below it is placed by its parent, so
     * a bone length is the target rig's own fact — copying the source's would rebuild the target
     * as the source, one joint at a time, which is precisely what retargeting exists to avoid.
     */
    if ((to.joints[target]?.parent ?? -1) < 0) {
      const sourceT = j * 3;
      const targetT = target * 3;
      for (let c = 0; c < 3; c++) {
        out.translation[targetT + c] = source.translation[sourceT + c] as number;
      }
    }
  }
}

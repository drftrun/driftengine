import { describe, expect, it } from 'vitest';

import { buildRetargetMap, retargetPose } from './retarget.ts';
import { createPose, restPose } from './pose.ts';
import { Skeleton } from './skeleton.ts';

/** A straight chain of joints with the given names, identity binds. */
function rig(names: readonly string[]): Skeleton {
  const inverseBind = new Float32Array(names.length * 16);
  for (let j = 0; j < names.length; j++) {
    inverseBind[j * 16] = 1;
    inverseBind[j * 16 + 5] = 1;
    inverseBind[j * 16 + 10] = 1;
    inverseBind[j * 16 + 15] = 1;
  }
  return new Skeleton(
    names.map((name, at) => ({ parent: at === 0 ? -1 : at - 1, name })),
    inverseBind,
  );
}

describe('retargeting', () => {
  it('maps by name and reports what it could not match', () => {
    const map = buildRetargetMap(rig(['hips', 'spine', 'tail']), rig(['hips', 'spine']));
    expect(Array.from(map.indices)).toEqual([0, 1, -1]);
    expect(map.unmatched).toEqual(['tail']);
  });

  /*
   * **Rotations transfer and translations do not, which is the whole of retargeting in one
   * sentence.** Two rigs of different proportions share joint *orientations* and not bone lengths,
   * so copying a translation puts the taller rig's limbs inside its own body. The root is the
   * exception, because that is where locomotion lives — a walk that did not move the character
   * would be a moonwalk.
   */
  it('carries rotation and leaves the target its own proportions', () => {
    const from = rig(['hips', 'spine']);
    const to = rig(['hips', 'spine']);
    const map = buildRetargetMap(from, to);
    const source = createPose(2);
    const out = createPose(2);
    restPose(2, source);
    restPose(2, out);
    source.rotation.set([0, Math.SQRT1_2, 0, Math.SQRT1_2], 4);
    source.translation[3] = 99;
    out.translation[3] = 2;
    retargetPose(map, from, source, to, out);
    expect(out.rotation[5]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(out.translation[3], 'the spine keeps its own bone length').toBe(2);
  });

  it('carries the root translation, because that is where locomotion lives', () => {
    const from = rig(['hips', 'spine']);
    const to = rig(['hips', 'spine']);
    const map = buildRetargetMap(from, to);
    const source = createPose(2);
    const out = createPose(2);
    restPose(2, source);
    restPose(2, out);
    source.translation[0] = 7;
    retargetPose(map, from, source, to, out);
    expect(out.translation[0]).toBeCloseTo(7, 6);
  });

  /*
   * An unmatched *source* joint writes nowhere. There is no target joint to preserve — that is the
   * test below, which is the other direction — so what this pins is that a source with more joints
   * than the target does not disturb it. The `-1` is what does that work; the bound check beside it
   * in `retargetPose` is unreachable from a map `buildRetargetMap` produced — perturbing it away
   * leaves this green — and guards only a hand-built one.
   */
  it('writes nothing for a source joint the target does not have', () => {
    const from = rig(['hips', 'spine', 'tail']);
    const to = rig(['hips', 'spine']);
    const map = buildRetargetMap(from, to);
    const source = createPose(3);
    const out = createPose(2);
    restPose(3, source);
    restPose(2, out);
    source.rotation.set([0, 0, Math.SQRT1_2, Math.SQRT1_2], 8);
    retargetPose(map, from, source, to, out);
    /* Both target joints are still at rest: the tail's rotation reached neither of them. */
    expect(Array.from(out.rotation)).toEqual([0, 0, 0, 1, 0, 0, 0, 1]);
  });

  /*
   * A joint the *target* has and the source does not keeps whatever the caller left in `out` — a
   * character with a tail wearing a clip from one without keeps its tail wherever its own idle put
   * it, rather than snapping to rest. That is the same layering `sampleClip` provides one level
   * down, and it is what lets a retargeted clip be laid over a base pose.
   */
  it('leaves a joint the source does not have untouched', () => {
    const from = rig(['hips', 'spine']);
    const to = rig(['hips', 'spine', 'tail']);
    const map = buildRetargetMap(from, to);
    const source = createPose(2);
    const out = createPose(3);
    restPose(2, source);
    restPose(3, out);
    out.rotation.set([0, 0, Math.SQRT1_2, Math.SQRT1_2], 8);
    retargetPose(map, from, source, to, out);
    expect(out.rotation[10]).toBeCloseTo(Math.SQRT1_2, 6);
  });

  /*
   * The unmatched list is *reported* rather than acted on. Whether a missing joint is a broken
   * import, a deliberately simpler rig or something to substitute for is a product decision — the
   * same line `rebind` draws when it reports the actions it displaced rather than deciding about
   * them.
   */
  it('reports rather than decides, and matching is exact', () => {
    const map = buildRetargetMap(rig(['Hips']), rig(['hips']));
    expect(Array.from(map.indices)).toEqual([-1]);
    expect(map.unmatched).toEqual(['Hips']);
  });
});

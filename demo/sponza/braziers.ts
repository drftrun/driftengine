/**
 * The braziers: where they stand, and a tripod and a bowl of coals for each, one mesh for all four.
 *
 * Built from boxes and tubes rather than loaded, so the scene adds no asset. Iron is near black, and
 * the coals are emissive, so they glow at night and read as dark iron-red by day.
 */
import { MeshBuilder } from '../../packages/core/src/index';
import type { Vec3 } from '../../packages/core/src/index';

/** Bay centres on the courtyard side of each arcade, where a brazier stands clear of the columns. */
export const BRAZIERS: readonly Vec3[] = [
  [-5.93, 0, -2.6],
  [-5.93, 0, 2.6],
  [6.14, 0, -2.6],
  [6.14, 0, 2.6],
];
export const BRAZIER_TOP_M = 1.02;

/** A tripod and a bowl of coals, one mesh for all four. */
export function buildBraziers(): ReturnType<MeshBuilder['build']> {
  const builder = new MeshBuilder();
  const iron: Vec3 = [0.09, 0.08, 0.07];
  for (const [x, , z] of BRAZIERS) {
    for (let leg = 0; leg < 3; leg++) {
      const a = (leg / 3) * Math.PI * 2;
      const fx = x + Math.cos(a) * 0.34;
      const fz = z + Math.sin(a) * 0.34;
      builder.addTube(
        [fx, 0, fz, x + Math.cos(a) * 0.2, 0.9, z + Math.sin(a) * 0.2],
        [0.025, 0.02],
        iron,
      );
    }
    builder.addCylinder([x, 0.93, z], 0.32, 0.07, 'y', iron, 0, 16);
    /* The coals: emissive, so they glow at night and are dark iron-red by day. */
    builder.addCylinder([x, 1.0, z], 0.27, 0.02, 'y', [0.55, 0.12, 0.03], 1, 16);
  }
  return builder.build();
}

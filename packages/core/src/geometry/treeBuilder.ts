import { MeshBuilder } from './meshBuilder.ts';
import type { MeshData } from '../render/mesh.ts';
import type { Vec3 } from '../math/color.ts';

/**
 * Procedural trees from parameters and a seeded RNG.
 *
 * Game-agnostic: it takes numbers and a random source and knows nothing about
 * days, palettes or where a tree is going to stand.
 *
 * The geometry comes back in two pieces, and the split is structural rather
 * than a convenience. The trunk is *solid* — merged into static world geometry
 * and paired with a collider, so it must never deform, or it would visibly
 * separate from the thing you collide with. The canopy is *flexible* — drawn as
 * instanced scatter that bends in the wind, which merging into the static world
 * would make impossible. A tree that is one mesh can be collidable or animated,
 * not both.
 */
export interface TreeParams {
  height: number;
  trunkRadius: number;
  /** How much narrower the trunk is at the top, 0..1. */
  taper: number;
  canopyRadius: number;
  canopyClusters: number;
  trunkColor: Vec3;
  canopyColor: Vec3;
}

export interface TreeGeometry {
  /** Trunk and limbs: collidable, never deformed. */
  solid: MeshData;
  /** Canopy: instanced and wind-bent, never collidable. */
  flexible: MeshData;
  /** Trunk radius at the base, so a caller can build a matching collider. */
  colliderRadius: number;
  /** Height of the solid part, likewise. */
  colliderHeight: number;
}

const TRUNK_SEGMENTS = 3;

export function buildTree(params: TreeParams, rand: () => number): TreeGeometry {
  if (params.height <= 0 || params.trunkRadius <= 0) {
    throw new Error('Tree height and trunk radius must be positive.');
  }

  const solid = new MeshBuilder();
  const flexible = new MeshBuilder();

  /*
   * Trunk as stacked tapering sections rather than one cylinder: a real trunk
   * narrows, and the taper is what stops a tree reading as a post with leaves
   * balanced on it.
   */
  const sectionHeight = params.height / TRUNK_SEGMENTS;
  for (let i = 0; i < TRUNK_SEGMENTS; i++) {
    const t = i / TRUNK_SEGMENTS;
    const radius = params.trunkRadius * (1 - params.taper * t);
    const lean = (rand() - 0.5) * 0.12 * params.height;
    solid.addCylinder(
      [lean * t, sectionHeight * (i + 0.5), lean * t],
      Math.max(radius, 0.02),
      sectionHeight * 0.5,
      'y',
      params.trunkColor,
      0,
      7,
    );
  }

  /*
   * No separate limbs. `MeshBuilder` only produces axis-aligned boxes and
   * cylinders, so a "branch" here can only be a vertical stub offset sideways —
   * which reads as a post floating beside the trunk, not as a limb. The
   * clustered canopy below carries the silhouette instead. Real branches want
   * oriented primitives, which is a builder change rather than a tree change.
   */

  /*
   * Canopy as overlapping clusters, not one sphere. A single blob reads as a
   * lollipop from any angle; clusters give a silhouette that changes as you run
   * past, which is most of what makes a tree look like a tree at speed.
   */
  const canopyBase = params.height * 0.62;
  for (let i = 0; i < params.canopyClusters; i++) {
    const angle = rand() * Math.PI * 2;
    /*
     * Spread and size are budgeted together so the furthest corner of the
     * furthest cluster stays inside `canopyRadius` with margin. The placer
     * keeps trees off the route using that number, so a canopy that quietly
     * overruns it pokes through geometry it was placed clear of.
     */
    const spread = params.canopyRadius * (0.12 + rand() * 0.4);
    const size = params.canopyRadius * (0.2 + rand() * 0.16);
    flexible.addBox(
      [
        Math.cos(angle) * spread,
        canopyBase + rand() * (params.height - canopyBase) * 0.9,
        Math.sin(angle) * spread,
      ],
      [size, size * (0.62 + rand() * 0.3), size],
      params.canopyColor,
      0,
    );
  }

  return {
    solid: solid.build(),
    flexible: flexible.build(),
    colliderRadius: params.trunkRadius,
    colliderHeight: params.height * 0.62,
  };
}

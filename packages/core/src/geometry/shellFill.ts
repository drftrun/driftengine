/**
 * Closing the inside of a model that is only a surface.
 *
 * **The problem is common and it is not a defect in any one asset.** A great many bought models
 * are exterior shells: a car with no cabin, a building with no rooms, a figure that is skin and
 * nothing under it. Drawn on their own they are correct, and the moment a viewer can see through
 * an opening in them — a grille, a vent, a window aperture, a doorway — they look straight
 * through the object and out the far side. It reads as a rendering fault and is not one.
 *
 * Two pieces are needed and neither replaces the other, which is the whole design here:
 *
 * - **A copy of the model, drawn inside itself.** It follows every curve exactly, because it *is*
 *   every curve, so it backs each panel with no tuning and no knowledge of what the model is. It
 *   cannot help with an opening, because a copy of a shell has the same hole in the same place.
 * - **A generated solid, behind it.** It has no holes, so it is what a viewer sees through one.
 *   It cannot follow a surface, so it is held well inside and never asked to.
 *
 * **Everything here takes sizes and numbers.** What a subject looks like is the caller's to state,
 * through `profile`: this module knows about bounds and fractions and nothing about cars.
 */

import type { MeshData } from '../render/mesh.ts';
import type { Vec3 } from '../math/color.ts';
import { MeshBuilder } from './meshBuilder.ts';

/**
 * One station along the model, from one end to the other.
 *
 * Every value is a fraction, so a profile is a shape rather than a size and the same one fits a
 * model of any dimensions. `width` and `roofWidth` are of the half width; `waist` and `top` are
 * of the height.
 */
export interface ShellStation {
  /** Where along the long axis this station sits, 0 at one end and 1 at the other. */
  readonly at: number;
  /** Half width of the lower mass here. */
  readonly width: number;
  /** Where the lower mass stops and the upper one begins. Equal to `top` for a single mass. */
  readonly waist: number;
  /** Half width of the upper mass. Zero where there is none. */
  readonly roofWidth: number;
  /** The top of the upper mass, or of the lower one where there is no upper. */
  readonly top: number;
}

/**
 * A plain inset block, which is the safe answer for a shape nothing is known about.
 *
 * Deliberately not clever. A profile that guessed at a silhouette would be wrong for most models
 * and wrong in the one direction that shows: standing out through the surface it is meant to sit
 * behind. A caller that knows what its subject looks like passes a better one.
 */
export const DEFAULT_SHELL_PROFILE: readonly ShellStation[] = [
  { at: 0, width: 0.7, waist: 0.8, roofWidth: 0, top: 0.8 },
  { at: 0.2, width: 1, waist: 0.95, roofWidth: 0, top: 0.95 },
  { at: 0.8, width: 1, waist: 0.95, roofWidth: 0, top: 0.95 },
  { at: 1, width: 0.7, waist: 0.8, roofWidth: 0, top: 0.8 },
];

export interface ShellFillOptions {
  /** Near black by default, because a fill is read as the absence of a hole rather than as a thing. */
  readonly color?: Vec3;
  /**
   * How far inside the model's own width and height the solid sits, 0 to 1.
   *
   * **Well inside, and the default says so.** A stack of boxes is a bounding volume and most
   * models are curved, so a solid sized to touch the surface stands through it somewhere. It does
   * not need to reach: the copy of the model backs the surface, and this only has to sit behind
   * the openings.
   */
  readonly inset?: number;
  /** The same, along the long axis, where a shape usually tapers hardest. */
  readonly lengthInset?: number;
  /** How many boxes the solid is built from. More follows a profile more closely. */
  readonly slices?: number;
  /** What the subject looks like from the side. See `ShellStation`. */
  readonly profile?: readonly ShellStation[];
  /** Lifts the solid off the model's floor, as a fraction of height. */
  readonly floor?: number;
}

const DEFAULT_COLOR: Vec3 = [0.012, 0.012, 0.014];

/** The profile between its stations, so the slice count and the shape stay independent. */
function stationAt(profile: readonly ShellStation[], t: number): ShellStation {
  for (let i = 1; i < profile.length; i++) {
    const b = profile[i] as ShellStation;
    if (t > b.at) continue;
    const a = profile[i - 1] as ShellStation;
    const span = b.at - a.at;
    const k = span <= 0 ? 0 : (t - a.at) / span;
    const mix = (from: number, to: number): number => from + (to - from) * k;
    return {
      at: t,
      width: mix(a.width, b.width),
      waist: mix(a.waist, b.waist),
      /*
       * Between a station with an upper mass and one without, the narrower wins rather than the
       * average: half an upper mass standing out of the surface is worse than a little less fill.
       */
      roofWidth: a.roofWidth === 0 || b.roofWidth === 0 ? 0 : mix(a.roofWidth, b.roofWidth),
      top: mix(a.top, b.top),
    };
  }
  return profile[profile.length - 1] as ShellStation;
}

/**
 * One box, with every face emitted twice so it is solid from either side.
 *
 * A box is only opaque from outside it: its faces point away from its centre, so a camera within
 * one has every face turned away and sees nothing at all. Reversing the corner order reverses
 * which side is drawn, and emitting both is what closes the volume from any position.
 */
function addSolidBox(builder: MeshBuilder, min: Vec3, max: Vec3, color: Vec3): void {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const faces: readonly (readonly [Vec3, Vec3, Vec3, Vec3])[] = [
    [
      [x0, y0, z1],
      [x1, y0, z1],
      [x1, y1, z1],
      [x0, y1, z1],
    ],
    [
      [x1, y0, z0],
      [x0, y0, z0],
      [x0, y1, z0],
      [x1, y1, z0],
    ],
    [
      [x1, y0, z1],
      [x1, y0, z0],
      [x1, y1, z0],
      [x1, y1, z1],
    ],
    [
      [x0, y0, z0],
      [x0, y0, z1],
      [x0, y1, z1],
      [x0, y1, z0],
    ],
    [
      [x0, y1, z1],
      [x1, y1, z1],
      [x1, y1, z0],
      [x0, y1, z0],
    ],
    [
      [x0, y0, z0],
      [x1, y0, z0],
      [x1, y0, z1],
      [x0, y0, z1],
    ],
  ];
  for (const [a, b, c, d] of faces) {
    builder.addQuad(a, b, c, d, color, 0, 0.05);
    builder.addQuad(d, c, b, a, color, 0, 0.05);
  }
}

/**
 * A solid to stand inside a hollow model, sized from the space it has to fill.
 *
 * `size` is the model's own extent in metres and `baseY` where its underside sits, which is all
 * this needs: the solid is centred on the origin in x and z, as a fitted model is.
 */
export function buildShellFill(
  size: { readonly x: number; readonly y: number; readonly z: number },
  baseY: number,
  options: ShellFillOptions = {},
): MeshData {
  const color = options.color ?? DEFAULT_COLOR;
  const inset = options.inset ?? 0.78;
  const lengthInset = options.lengthInset ?? 0.86;
  const slices = Math.max(1, Math.floor(options.slices ?? 24));
  const profile = options.profile ?? DEFAULT_SHELL_PROFILE;

  const builder = new MeshBuilder();
  builder.setRoughness(0.95);
  const halfWidth = (size.x / 2) * inset;
  const bottom = baseY + size.y * (options.floor ?? 0.1);
  const usableZ = size.z * lengthInset;
  const step = usableZ / slices;

  for (let i = 0; i < slices; i++) {
    /* Sampled at the slice's middle, so its box is the profile there rather than at an edge. */
    const t = (i + 0.5) / slices;
    const shape = stationAt(profile, t);
    const centreZ = -usableZ / 2 + (i + 0.5) * step;
    /* Half a step of overlap each side, so neighbouring slices leave no seam to see through. */
    const halfZ = step * 0.6;
    const waist = baseY + size.y * shape.waist * inset;
    if (waist > bottom) {
      const halfX = halfWidth * shape.width;
      addSolidBox(
        builder,
        [-halfX, bottom, centreZ - halfZ],
        [halfX, waist, centreZ + halfZ],
        color,
      );
    }
    const top = baseY + size.y * shape.top * inset;
    if (shape.roofWidth > 0.02 && top > waist) {
      const halfX = halfWidth * shape.roofWidth;
      addSolidBox(builder, [-halfX, waist, centreZ - halfZ], [halfX, top, centreZ + halfZ], color);
    }
  }
  return builder.build();
}

/**
 * The same surface, in one flat colour and facing both ways.
 *
 * This is the half that follows the model exactly. Drawn slightly smaller and inside the original
 * it backs every panel with no tuning at all, and it is given a single colour because otherwise
 * an opening shows the model's own brightwork through it, which is what it exists to hide.
 *
 * Both windings are emitted for the reason `addSolidBox` emits both: a shell is opaque only from
 * the side its triangles face, and this one is looked at from inside as often as out. Normals are
 * negated with the reversed copy, or the inward face is shaded as though lit from within.
 */
export function shellSkin(mesh: MeshData, color: Vec3 = DEFAULT_COLOR): MeshData {
  const vertices = mesh.positions.length / 3;
  const count = mesh.indices.length;
  const positions = new Float32Array(mesh.positions.length * 2);
  positions.set(mesh.positions, 0);
  positions.set(mesh.positions, mesh.positions.length);
  const normals = new Float32Array(mesh.normals.length * 2);
  normals.set(mesh.normals, 0);
  for (let i = 0; i < mesh.normals.length; i++) {
    normals[mesh.normals.length + i] = -(mesh.normals[i] as number);
  }
  const colors = new Float32Array(vertices * 2 * 3);
  for (let i = 0; i < vertices * 2; i++) {
    colors[i * 3] = color[0];
    colors[i * 3 + 1] = color[1];
    colors[i * 3 + 2] = color[2];
  }
  const indices = new Uint32Array(count * 2);
  indices.set(mesh.indices, 0);
  for (let i = 0; i + 2 < count; i += 3) {
    indices[count + i] = mesh.indices[i] as number;
    indices[count + i + 1] = mesh.indices[i + 2] as number;
    indices[count + i + 2] = mesh.indices[i + 1] as number;
  }
  return { positions, normals, colors, indices, emissive: new Float32Array(vertices * 2) };
}

/**
 * A uniform scale about a height, for drawing a skin just inside the model it came from.
 *
 * The translation column is what keeps the shrink centred on the model rather than on the world
 * origin: scaling about zero would drop it through whatever it stands on by a fraction of its own
 * height, which is small enough to look like a shadow fault rather than like this.
 */
export function shellFillMatrix(scale: number, centreY: number, out: Float32Array): Float32Array {
  out.fill(0);
  out[0] = scale;
  out[5] = scale;
  out[10] = scale;
  out[13] = centreY * (1 - scale);
  out[15] = 1;
  return out;
}

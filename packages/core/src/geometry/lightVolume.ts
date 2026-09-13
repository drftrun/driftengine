/**
 * The hull a volume of light is drawn on: a beam, a shaft through a window, the cone under
 * a lamp.
 *
 * **It exists because the geometry and the draw call have to agree, and nothing enforced
 * it.** `Renderer.drawLightVolume` fades the light to nothing at a length and an aperture
 * it is *told*, and those two numbers are read in the geometry's own space. A caller who
 * builds the shape by hand therefore states each of them twice, in two files, and the
 * failure when the copies disagree is silent both ways: a length longer than the geometry
 * draws a beam that stops at a bright polygon edge, and an aperture wider than the
 * geometry's own flare draws a hard-edged wedge. Two demo scenes here wrote the same loop,
 * and a consumer outside this repository shipped stubs in two worlds — no beam at all
 * through two captures, then hard white wedges through a third — because the numbers a beam
 * needs are three and the ones that are obviously wrong when mistaken are zero.
 *
 * **What this builds changed in 0.35.0, and a mesh built before it must be rebuilt.** It
 * used to emit a few flat panes crossing the axis, which is what the pass rasterised and
 * weighted. The pass now walks the view ray instead, so what it needs from geometry is only
 * a closed hull deciding which pixels run: a cone frustum with its two caps. Panes handed to
 * the new pass light only the sliver of screen the panes themselves cover. Anything that
 * calls this function is already correct; anything that hand-rolled its own is not.
 *
 * Textureless and engine-generic: a length, an aperture and a colour. It does not know
 * whether it is a lighthouse or a window.
 */
import type { MeshData } from '../render/mesh.ts';
import { MeshBuilder } from './meshBuilder.ts';
import type { Vec3 } from '../math/color.ts';

export interface LightVolumeOptions {
  /**
   * How far the light reaches along the volume's own +Z, in the units the panes are
   * built in — which are the units of whatever `model` matrix places them.
   *
   * **Pass this same number to `drawLightVolume` as its `length`.** The panes end exactly
   * here, so the light reaches zero at the last row of vertices and no edge is ever in the
   * picture.
   */
  lengthM: number;
  /**
   * Half-width over distance: the tangent of the cone's half-angle.
   *
   * **Pass this same number to `drawLightVolume` as its `spread`.** The panes are built a
   * shade wider than it, so the fade lands inside the polygon rather than at its rim.
   */
  spread: number;
  color: Vec3;
  /**
   * Where the volume starts, along the same +Z. Zero for a beam that begins at its source.
   *
   * A shaft of daylight through an opening is a slice taken far down a very wide cone —
   * the apex sits above the roof, and only the part below the opening is drawn. That is
   * what this is for, and it is why the near end is a parameter rather than the origin.
   */
  nearM?: number;
  /**
   * How many sides the hull has. Rounded up to an even number, because the caps are quads.
   *
   * It decides the silhouette and nothing else: the light inside is the ray march's, so a
   * coarse hull is a polygonal *outline* around a volume that is still round. Twelve is
   * indistinguishable from a circle at the size a beam usually occupies; drop it for a
   * volume that is always distant, raise it for one that fills the frame.
   */
  sides?: number;
}

/**
 * How far past the aperture the hull reaches.
 *
 * The march's own falloff is what should end the beam, so the hull has to outlast it or the
 * silhouette becomes a cut rather than a fade. Fifteen percent is enough that no edge is
 * visible at any angle and little enough that the hull is not mostly empty margin.
 */
const EDGE_MARGIN = 1.15;

/** Sides when a caller does not say. Round enough for a beam at any distance it is legible at. */
const DEFAULT_SIDES = 12;

/**
 * The hull's radius at its near end when the volume starts at its own apex.
 *
 * A beam that begins at its source begins at a point, and `addQuad` refuses a degenerate
 * corner pair rather than emit a normal it cannot compute. A thousandth of the far radius
 * reads as an apex and lies where the march's across-axis falloff is 1 anyway.
 */
const APEX_WIDTH_FRACTION = 1e-3;

/**
 * Build the hull for a volume of light, in the volume's own space, opening along +Z.
 *
 * A closed cone frustum, wound outward so the renderer can cull whichever half it needs: it
 * draws the front faces from outside and the back faces from inside, which is what lets a
 * camera walk into a beam without the beam vanishing. The caps matter more than they look —
 * without the near one, a viewer looking straight up a vertical shaft finds a hole through
 * the middle of it exactly where the volume should be at its most solid.
 *
 * Nothing here shapes the light. The hull says which pixels to run on and the pass decides
 * what they are worth, so a coarser hull is a coarser outline and never a coarser beam.
 */
export function buildLightVolume(options: LightVolumeOptions): MeshData {
  const near = options.nearM ?? 0;
  const far = options.lengthM;
  if (!(far > near)) {
    throw new Error(`buildLightVolume: lengthM (${far}) must be beyond nearM (${near})`);
  }

  /* Even, because each cap is built from quads spanning two segments at a time. */
  const sides = Math.max(4, Math.round((options.sides ?? DEFAULT_SIDES) / 2) * 2);
  const farRadius = far * options.spread * EDGE_MARGIN;
  const nearRadius =
    near > 0 ? near * options.spread * EDGE_MARGIN : farRadius * APEX_WIDTH_FRACTION;

  const builder = new MeshBuilder();
  builder.setEmissiveColor(options.color);
  builder.setRoughness(null);
  builder.setGrain(0);

  const ring = (i: number, radius: number, z: number): Vec3 => {
    const turn = ((i % sides) / sides) * Math.PI * 2;
    return [Math.cos(turn) * radius, Math.sin(turn) * radius, z];
  };

  /* The lateral surface. Wound so the face normal points away from the axis. */
  for (let i = 0; i < sides; i++) {
    builder.addQuad(
      ring(i, nearRadius, near),
      ring(i + 1, nearRadius, near),
      ring(i + 1, farRadius, far),
      ring(i, farRadius, far),
      options.color,
      1,
    );
  }

  /*
   * The caps, as a fan of quads from the centre rather than triangles, because `MeshBuilder`
   * has no triangle and a quad with a repeated corner has no normal to compute. Two segments
   * per quad is why the side count is forced even.
   */
  for (let i = 0; i < sides; i += 2) {
    builder.addQuad(
      [0, 0, far],
      ring(i, farRadius, far),
      ring(i + 1, farRadius, far),
      ring(i + 2, farRadius, far),
      options.color,
      1,
    );
    builder.addQuad(
      [0, 0, near],
      ring(i + 2, nearRadius, near),
      ring(i + 1, nearRadius, near),
      ring(i, nearRadius, near),
      options.color,
      1,
    );
  }

  builder.setEmissiveColor(null);
  return builder.build();
}

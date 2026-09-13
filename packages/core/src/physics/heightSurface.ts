import { CompositeSurface } from './compositeSurface.ts';
import type { GroundSurface, SurfaceHit } from './ribbonSurface.ts';

/**
 * Any function that answers "how high is the ground at this column?", as a `GroundSurface`.
 *
 * **The hundred lines every consumer with terrain writes, written once.** A world that is not flat
 * has to answer that question somewhere, and the two things that already implement `GroundSurface`
 * answer different ones: `RibbonSurface` is a route with a width and a bank, and `BoxSurface` is a
 * set of flat pads. Neither is a hillside, a ditch, a heightmap or a dune. A consumer with one of
 * those has a `heightAt(x, z)` of their own within an afternoon, and then spends the rest of the
 * week turning it into a surface: a normal by differences, a band query, the route fields nothing
 * asked for, and finally the discovery that the character controller and everything else that
 * stands on ground each need their own copy of the wiring.
 *
 * That was reported from outside as "there is no terrain height a controller can ask about", beside
 * a note that the answer they wrote is a hundred lines and that every consumer with a road will
 * write it again.
 *
 * **This is a seam and not terrain.** It renders nothing, stores nothing, and has no level of
 * detail: `heightAt` is the consumer's, and what this adds is the surface contract around it, so
 * one object can be handed to a character controller, to a vehicle, and to whatever places props —
 * and the floor is one thing rather than three copies of it. Terrain proper is its own track.
 *
 * **A `heightAt` that returns a non-finite number means there is no ground in that column**, and
 * that is the contract a layered world is built out of: a bridge deck answers its height over the
 * span and `NaN` everywhere else, so it is a floor exactly where it is drawn and nothing anywhere
 * else. Until 2026-08-30 this was said only in a private comment inside this file, which is no use
 * to somebody deciding how to model a flyover.
 */
export interface HeightSurfaceOptions {
  /**
   * How far apart the two samples that measure the slope are, metres.
   *
   * **This is the scale the ground is measured at, and it is a real choice.** The normal comes from
   * a central difference, so a feature narrower than twice this is smoothed away — a kerb sampled
   * at half a metre is a gentle ramp — while a step far below the resolution of `heightAt` measures
   * its rounding rather than its slope. Five centimetres suits ground a person walks on.
   *
   * A caller who can differentiate their own field should pass `normalAt` instead and pay nothing.
   */
  readonly stepM?: number;
  /**
   * Where the surface exists at all. Outside it, there is no ground and a query says so.
   *
   * Absent means everywhere, which is right for a field defined by arithmetic and wrong for one
   * backed by a finite array — a sample off the end of a heightmap is not ground at height zero.
   */
  readonly bounds?: {
    readonly minX: number;
    readonly maxX: number;
    readonly minZ: number;
    readonly maxZ: number;
  };
  /**
   * The exact unit normal, when the caller has one.
   *
   * An analytic profile — a trapezoid ditch, a cone, a sine dune — knows its own derivative, and
   * four extra calls to `heightAt` a tick to rediscover it numerically is both slower and less
   * accurate. Must be unit length: nothing normalises it afterwards, and a controller compares it
   * against a slope cosine.
   */
  normalAt?(x: number, z: number, out: { x: number; y: number; z: number }): void;
}

/** Scratch for `normalAt`, at module scope because sampling runs every tick. */
const NORMAL = { x: 0, y: 1, z: 0 };

/** A field of one height per column: the consumer's own `(x, z) -> y`. */
export type HeightField = (x: number, z: number) => number;

/**
 * One field, or several stacked in the same world.
 *
 * **Several is how a road passes under a road.** A single field has exactly one height per column,
 * and no arrangement of it holds both a deck and the carriageway beneath it; two fields do, and the
 * surface picks the one under the body's feet using the height every caller already passes. Order
 * carries no meaning — the rule is nearness to the asker, not position in the list.
 *
 * Each layer answers `NaN` where it is not there, so a deck is a floor over its span and nothing at
 * all beside it.
 */
export function heightSurface(
  heightAt: HeightField | readonly HeightField[],
  options: HeightSurfaceOptions = {},
): GroundSurface {
  /*
   * **Layers compose through `CompositeSurface` rather than through a rule written twice.** That
   * class already scores candidates by nearness to the asker and breaks ties toward the surface
   * below, which is exactly what a flyover needs and is the rule `RibbonSurface` already uses
   * between its own passes. A second implementation here would be a second thing to get wrong.
   */
  /* `typeof` and not `Array.isArray`, which does not narrow a `readonly` array out of a union. */
  if (typeof heightAt !== 'function') {
    const layers = heightAt;
    if (layers.length === 0) {
      throw new Error(
        'heightSurface: an empty list of layers is a world with no ground anywhere, which is ' +
          'almost certainly not what was meant. Pass at least one height field.',
      );
    }
    if (layers.length === 1) return heightSurface(layers[0] as HeightField, options);
    /* One surface per layer, each single-valued and each knowing where it is not. */
    return new CompositeSurface(layers.map((layer) => heightSurface(layer, options)));
  }

  const single = heightAt;
  const step = options.stepM ?? 0.05;
  if (!(step > 0)) throw new Error(`heightSurface: stepM must be positive, got ${step}`);
  const bounds = options.bounds;
  const normalAt = options.normalAt;

  /**
   * Fill `out` for this column, or answer false where there is no ground.
   *
   * **A non-finite height is treated as absence rather than passed on**, because a field defined by
   * arithmetic reports the edge of its domain that way — a square root going negative, a division
   * at a pole — and a `NaN` written into a surface hit becomes a `NaN` position two frames later,
   * where nothing points back here.
   */
  const fill = (x: number, z: number, out: SurfaceHit): boolean => {
    if (bounds !== undefined) {
      if (x < bounds.minX || x > bounds.maxX || z < bounds.minZ || z > bounds.maxZ) return false;
    }
    const y = single(x, z);
    if (!Number.isFinite(y)) return false;
    out.y = y;

    if (normalAt !== undefined) {
      normalAt(x, z, NORMAL);
      out.normalX = NORMAL.x;
      out.normalY = NORMAL.y;
      out.normalZ = NORMAL.z;
    } else {
      /*
       * A central difference, falling back to a one-sided one at the edge of the domain. Without
       * that fallback the last step of a bounded field has no normal at all, which is where a
       * character walks off the map and the ground turns vertical under them.
       */
      const east = sided(single, x + step, z, y);
      const west = sided(single, x - step, z, y);
      const south = sided(single, x, z + step, y);
      const north = sided(single, x, z - step, y);
      const dx = (east - west) / (step * 2);
      const dz = (south - north) / (step * 2);
      const length = Math.sqrt(dx * dx + 1 + dz * dz);
      out.normalX = -dx / length;
      out.normalY = 1 / length;
      out.normalZ = -dz / length;
    }

    /*
     * A height function has no route, so the fields that describe one say nothing rather than
     * something invented. `tilt` is the exception and it is not an exception at all: the surface
     * looks exactly as it collides, which is the same reason `BoxSurface` sets it from the lid.
     */
    out.tiltX = out.normalX;
    out.tiltY = out.normalY;
    out.tiltZ = out.normalZ;
    out.tangentX = 1;
    out.tangentY = 0;
    out.tangentZ = 0;
    out.distanceM = 0;
    out.lateralM = 0;
    out.bankRad = 0;
    /* Room before the edge, which for a bounded field is a real distance and otherwise is none. */
    out.halfWidthM =
      bounds === undefined
        ? Infinity
        : Math.min(x - bounds.minX, bounds.maxX - x, z - bounds.minZ, bounds.maxZ - z);
    return true;
  };

  return {
    /**
     * `atY` is ignored, and that is a property of the representation and not a shortcut: **one**
     * function of `x` and `z` has exactly one height per column, so there is no deck above or below
     * to choose between.
     *
     * A world with a bridge over a road passes a **list** of fields instead, and then `atY`
     * decides. This comment used to send that reader to `CompositeSurface`, which was true and was
     * the wrong shape of answer: a consumer with 276 km of road and six flyovers read it as "a
     * height field cannot do this" and built the deck into the single field, where the only way
     * through a crossing is over it.
     */
    sample(x: number, z: number, out: SurfaceHit): boolean {
      return fill(x, z, out);
    },
    sampleBand(x: number, z: number, out: SurfaceHit, loY: number, hiY: number): boolean {
      if (!fill(x, z, out)) return false;
      /* Half-open, as the interface says: a face at head height is one a body passes under. */
      return out.y >= loY && out.y < hiY;
    },
  };
}

/** One neighbouring sample, or the centre's own height where the field does not answer. */
function sided(field: HeightField, x: number, z: number, centre: number): number {
  const y = field(x, z);
  return Number.isFinite(y) ? y : centre;
}

/**
 * Whether anything solid stands over this column, between two heights.
 *
 * **The general question, of which "should rain fall here" is one caller.** A surface answers three
 * things and only two of them had names: where the ground is, whether a floor is in the way, and —
 * the one this is — whether the sky is visible from a point. That third question is asked by more
 * than weather, and it is asked constantly: rain and snow that stop under a canopy, a puddle that
 * only forms where the sky reaches, a shaft of sun that should not appear indoors, an agent
 * deciding whether it is worth taking shelter, a plant that grows toward light. Every one of those
 * is `sampleBand` over the column above you, and every consumer that wants one would otherwise
 * discover that for themselves.
 *
 * **A hole is a hole, for free.** This is the property worth stating, because it is what usually
 * separates a convincing effect from a stamped-on one: the answer comes from whether the surface
 * has a *face* in that column, so a roof with a gap in it, a `RibbonSurface` with a stretch of
 * `holes`, a run of pads with air between them, or a bounded heightfield past its own edge all let
 * the sky through in exactly the places they look like they should. Nothing describes the opening
 * twice and nothing can disagree with the geometry it was cut from.
 *
 * `toY` is where the caller stops caring — a cloud base, the top of a level. Half-open like
 * `sampleBand`, so a face exactly at `toY` is above the question rather than in it.
 */
export function coveredAbove(
  surface: GroundSurface,
  x: number,
  z: number,
  fromY: number,
  toY: number,
  scratch: SurfaceHit,
): boolean {
  return surface.sampleBand(x, z, scratch, fromY, toY);
}

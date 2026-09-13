import { createSurfaceHit } from './ribbonSurface.ts';
import type { GroundSurface, SurfaceHit } from './ribbonSurface.ts';

/**
 * Several surfaces answering as one.
 *
 * A route that forks has two floors in the same column, and a query has to pick
 * one. It picks the **highest surface at or below the asking height**, which is
 * the same rule a lift shaft or a flyover needs: what you are standing on is
 * the nearest thing under your feet, not the nearest thing full stop.
 *
 * Falling back to the highest surface overall when nothing is below keeps a
 * character who has dropped beneath everything from reporting no ground at all —
 * they are still over the track, just under it, and the caller decides what
 * that means.
 */
/** How much a surface above the asker is penalised when two are equally near. */
const TIE_BREAK = 0.4;

export class CompositeSurface implements GroundSurface {
  private readonly candidate = createSurfaceHit();

  constructor(private readonly surfaces: readonly GroundSurface[]) {}

  /**
   * The floors this is made of.
   *
   * Exposed because "two of my floors are in the same column" is a question only
   * the parts can answer, and it is one a consumer has to be able to ask. Two
   * walkable surfaces overlapping with millimetres between them is invisible to
   * every gameplay check — `sample` picks one and both readings look sane — while
   * on screen the depth buffer cannot separate them and the pair flickers against
   * each other as the camera turns. Composed, that information is gone.
   */
  get parts(): readonly GroundSurface[] {
    return this.surfaces;
  }

  /**
   * Ask every part and keep the best answer.
   *
   * `atY` is what makes this correct rather than arbitrary. Without a reference
   * height the only available rule is "highest wins", which teleports a character
   * on the low line of a split up onto the high one the moment the two overlap.
   */
  sample(x: number, z: number, out: SurfaceHit, atY = Infinity): boolean {
    // See `RibbonSurface`: without a height to measure from, the highest wins.
    const located = Number.isFinite(atY);
    let best = Infinity;
    let found = false;

    for (const part of this.surfaces) {
      if (!part.sample(x, z, this.candidate, atY)) continue;
      /*
       * Nearest to the asker's height, ties broken toward the surface below.
       *
       * The same rule `RibbonSurface` uses between its own passes, and for the
       * same reason: "highest at or below" is written for a flyover and wrong for
       * two decks at similar heights, where it can hand a character a surface just
       * far enough beneath their feet that they cannot snap to it and fall
       * through ground that is directly under them.
       */
      const score = located
        ? Math.abs(this.candidate.y - atY) + (this.candidate.y > atY ? TIE_BREAK : 0)
        : -this.candidate.y;
      if (score < best) {
        best = score;
        copyHit(this.candidate, out);
        found = true;
      }
    }
    return found;
  }

  /**
   * See `GroundSurface.sampleBand`: the highest floor any part puts in the band.
   *
   * The one query where composing surfaces costs nothing in fidelity — a band is
   * a filter, so asking every part and keeping the highest answer is the same
   * answer a single surface holding all of them would give.
   */
  sampleBand(x: number, z: number, out: SurfaceHit, loY: number, hiY: number): boolean {
    let bestY = -Infinity;
    let found = false;
    for (const part of this.surfaces) {
      if (!part.sampleBand(x, z, this.candidate, loY, hiY)) continue;
      if (this.candidate.y <= bestY) continue;
      bestY = this.candidate.y;
      copyHit(this.candidate, out);
      found = true;
    }
    return found;
  }
}

function copyHit(from: SurfaceHit, to: SurfaceHit): void {
  to.y = from.y;
  to.normalX = from.normalX;
  to.normalY = from.normalY;
  to.normalZ = from.normalZ;
  to.tangentX = from.tangentX;
  to.tangentY = from.tangentY;
  to.tangentZ = from.tangentZ;
  to.distanceM = from.distanceM;
  to.lateralM = from.lateralM;
  to.halfWidthM = from.halfWidthM;
  to.bankRad = from.bankRad;
  to.tiltX = from.tiltX;
  to.tiltY = from.tiltY;
  to.tiltZ = from.tiltZ;
}

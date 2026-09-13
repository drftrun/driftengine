import type { ReadonlyMat4, ReadonlyVec3 } from 'gl-matrix';

/**
 * A decal evaluated at render time: a box, the depth buffer, and whatever surface is inside it.
 *
 * **`projectDecal` is the other half of this and neither replaces the other.** That one clips the
 * receiving surface's own triangles to a projector box and lifts them off along their normals, so
 * the mark *is* the surface: it follows every curve and bump exactly, it is lit as the surface is
 * lit, and it costs nothing per frame. What it cannot do is change afterwards. The clip happens
 * once, against the mesh as it stood, so a mark on something that later deforms rides the old
 * shape, and a mark on something that streams in later cannot be made at all because there was
 * nothing to clip.
 *
 * **This is the projector kept alive instead.** Nothing is clipped and no mesh is built: the pass
 * reads the depth the frame has already drawn, turns each pixel back into the world point it
 * stands for, and asks whether that point is inside the box. A surface that deforms, streams in,
 * or is drawn by something with no CPU-side geometry at all — a heightfield, a skinned mesh, an
 * instanced crowd — is marked on the frame it is drawn, because the mark is decided from the
 * picture rather than from the mesh.
 *
 * **What it costs, and it is the honest half of the trade.** The mark is applied to the finished
 * pixel rather than to the surface's albedo, so it multiplies what is already there: it can
 * darken, stain and tint, and it cannot brighten or add a highlight. It has no geometry of its
 * own, so it takes the receiver's lighting exactly — which is the *reason* to multiply rather
 * than an accident of it — and a purely diffuse receiver is shaded as though the albedo had been
 * marked before the light was applied. And it knows only what the depth buffer knows: anything
 * that drew without writing depth, a beam or a particle, is in front of the mark and is darkened
 * with it.
 *
 * The shape is procedural — an ellipse across the box's face with a soft edge, faded where the
 * surface turns away from the projector. A textured mark is what it does not do yet, and
 * `docs/CAPABILITIES.md` says so where it says the rest.
 */

/** The box a projector occupies. Every field is world space. */
export interface DecalBox {
  /** Middle of the projector box. */
  readonly center: ReadonlyVec3;
  /** Half-size across, up, and along the projection. The third is how deep the box reaches. */
  readonly halfExtents: ReadonlyVec3;
  /**
   * The direction the decal is projected *along* — for a mark on the ground, straight down.
   *
   * A surface is marked when it faces back along this. Need not be normalised.
   */
  readonly forward: ReadonlyVec3;
  /** Which way is up in the decal's own image, so a mark can be turned. Need not be normalised. */
  readonly up: ReadonlyVec3;
}

export interface DecalProjectorOptions extends DecalBox {
  /** What the mark multiplies the surface by. White marks nothing; black is a hole. */
  readonly color?: ReadonlyVec3;
  /** How much of that colour lands, 0 to 1. */
  readonly opacity?: number;
  /**
   * How far from facing the projector a surface may be turned and still be marked, as a cosine.
   *
   * **The stretch this prevents is the classic failure of a projected decal.** A wall standing
   * edge-on to the projector occupies one pixel of depth per metre of wall, so a mark aimed at the
   * floor smears the full depth of the box up it in a long streak. `projectDecal` has the same
   * number for the same reason, and this one is read from the depth buffer's own derivatives
   * rather than from a vertex normal.
   */
  readonly facingCos?: number;
  /** How much of the mark's radius is edge, 0 for a hard ellipse and 1 for all falloff. */
  readonly softness?: number;
}

/** Scratch for the orthonormal frame, so building a matrix allocates nothing. */
const RIGHT = new Float64Array(3);
const UP = new Float64Array(3);
const FORWARD = new Float64Array(3);
/** The eight corners of the box, projected, for the scissor bound. */
const CORNER = new Float64Array(4);

function frame(box: DecalBox): void {
  const f = box.forward;
  const length = Math.hypot(f[0] ?? 0, f[1] ?? 0, f[2] ?? 0);
  if (length === 0) throw new Error('DecalProjector: forward has no direction');
  FORWARD[0] = (f[0] ?? 0) / length;
  FORWARD[1] = (f[1] ?? 0) / length;
  FORWARD[2] = (f[2] ?? 0) / length;

  const u = box.up;
  /* right = up x forward, which is the frame `projectDecal` builds and the one a caller's `up`
     therefore already means. */
  RIGHT[0] = (u[1] ?? 0) * FORWARD[2] - (u[2] ?? 0) * FORWARD[1];
  RIGHT[1] = (u[2] ?? 0) * FORWARD[0] - (u[0] ?? 0) * FORWARD[2];
  RIGHT[2] = (u[0] ?? 0) * FORWARD[1] - (u[1] ?? 0) * FORWARD[0];
  const across = Math.hypot(RIGHT[0], RIGHT[1], RIGHT[2]);
  if (across === 0) {
    throw new Error('DecalProjector: up is parallel to forward, so the box has no orientation');
  }
  RIGHT[0] /= across;
  RIGHT[1] /= across;
  RIGHT[2] /= across;

  /* Re-derived so the frame is orthonormal even where the caller's up was not perpendicular —
     which is what a caller aiming a projector by hand hands in, and what shears the mark if it is
     taken as given. */
  UP[0] = FORWARD[1] * RIGHT[2] - FORWARD[2] * RIGHT[1];
  UP[1] = FORWARD[2] * RIGHT[0] - FORWARD[0] * RIGHT[2];
  UP[2] = FORWARD[0] * RIGHT[1] - FORWARD[1] * RIGHT[0];
}

/** `-0` back to `0`, and anything else through untouched — including a NaN, which `|| 0` would eat. */
function zeroed(value: number): number {
  return value === 0 ? 0 : value;
}

function extents(box: DecalBox): [number, number, number] {
  const hx = box.halfExtents[0] ?? 0;
  const hy = box.halfExtents[1] ?? 0;
  const hz = box.halfExtents[2] ?? 0;
  if (!(hx > 0 && hy > 0 && hz > 0)) {
    throw new Error(`DecalProjector: halfExtents must be positive, got ${hx}, ${hy}, ${hz}`);
  }
  return [hx, hy, hz];
}

/**
 * World space into the projector's unit box, column major.
 *
 * The box is `[-1, 1]` on every axis: x across the mark, y up it, z along the projection. A
 * fragment is inside the projector exactly when all three come back within one, which is the whole
 * of the test the shader runs.
 */
export function worldToDecalMatrix(out: Float32Array, box: DecalBox): Float32Array {
  frame(box);
  const [hx, hy, hz] = extents(box);
  const c = box.center;
  const cx = c[0] ?? 0;
  const cy = c[1] ?? 0;
  const cz = c[2] ?? 0;

  /* The rows are the axes divided by their half-extent, and the translation is the centre run
     through them and negated: an orthonormal frame's inverse is its transpose, so this is the
     inverse of `decalToWorldMatrix` written out rather than computed.

     The translations go through `zeroed` because negating a centre on an axis produces `-0`, which
     is equal to zero in every arithmetic use and not under `Object.is` — so two projectors alike in
     every way a GPU can see would compare unequal. `depthOffsetForLayer` records the same trap. */
  out[0] = RIGHT[0] / hx;
  out[4] = RIGHT[1] / hx;
  out[8] = RIGHT[2] / hx;
  out[12] = zeroed(-(RIGHT[0] * cx + RIGHT[1] * cy + RIGHT[2] * cz) / hx);

  out[1] = UP[0] / hy;
  out[5] = UP[1] / hy;
  out[9] = UP[2] / hy;
  out[13] = zeroed(-(UP[0] * cx + UP[1] * cy + UP[2] * cz) / hy);

  out[2] = FORWARD[0] / hz;
  out[6] = FORWARD[1] / hz;
  out[10] = FORWARD[2] / hz;
  out[14] = zeroed(-(FORWARD[0] * cx + FORWARD[1] * cy + FORWARD[2] * cz) / hz);

  out[3] = 0;
  out[7] = 0;
  out[11] = 0;
  out[15] = 1;
  return out;
}

/**
 * The unit box back out into the world, column major.
 *
 * Only the scissor needs this — it projects the eight corners to find what part of the screen the
 * box can possibly cover — but it is written here beside its inverse so the two cannot drift, and
 * a test asserts they round-trip.
 */
export function decalToWorldMatrix(out: Float32Array, box: DecalBox): Float32Array {
  frame(box);
  const [hx, hy, hz] = extents(box);
  const c = box.center;

  out[0] = RIGHT[0] * hx;
  out[1] = RIGHT[1] * hx;
  out[2] = RIGHT[2] * hx;
  out[3] = 0;

  out[4] = UP[0] * hy;
  out[5] = UP[1] * hy;
  out[6] = UP[2] * hy;
  out[7] = 0;

  out[8] = FORWARD[0] * hz;
  out[9] = FORWARD[1] * hz;
  out[10] = FORWARD[2] * hz;
  out[11] = 0;

  out[12] = c[0] ?? 0;
  out[13] = c[1] ?? 0;
  out[14] = c[2] ?? 0;
  out[15] = 1;
  return out;
}

/** One pixel of slack, because the frame may be jittered and a bound is rounded. */
const SCISSOR_PAD = 1;

/**
 * The part of the screen a projector can possibly mark, as a scissor rectangle.
 *
 * **This is what stands in for drawing the box as geometry**, and the trade is deliberate. A box
 * submitted as a mesh covers its own silhouette exactly, and costs a vertex buffer, an index
 * buffer, a choice between front and back faces depending on whether the camera is inside it, and
 * a near-plane case where the front faces are clipped away. A rectangle around the same eight
 * corners costs none of those and over-covers by the difference between a silhouette and its
 * bounding box — at worst about twice the fragments, each of them one depth fetch and one matrix
 * multiply before it decides it is outside the box. For a pass that is otherwise two textures and
 * a blend state, that is the cheaper half.
 *
 * **A corner behind the camera is the trap, and it does not look like one.** Dividing clip space
 * by a negative `w` mirrors the point through the origin, so a box the camera stands inside
 * produces eight perfectly ordinary screen positions describing a rectangle that is nowhere near
 * the truth — the mark then appears in a patch of the frame it has nothing to do with, and the
 * rest of it silently does not draw. So a box with any corner at or behind the eye is scissored to
 * the whole viewport, which is always correct and merely costs more, and one with *every* corner
 * behind is skipped entirely.
 *
 * `yDown` is which way the caller's framebuffer counts rows: false for WebGL2's `gl.scissor`,
 * whose origin is the bottom left, and true for WebGPU's `setScissorRect`, whose origin is the top
 * left. Both describe the same pixels, and the pair is here rather than in either backend for the
 * reason `DEPTH_01_TO_CLIP_Y_DOWN` gives at length: a convention held in two places is a pass that
 * marks the mirror image of what it should on one backend and nothing raises.
 *
 * Returns false when there is nothing to draw, and fills `out` with `[x, y, width, height]` when
 * there is.
 */
export function decalScissor(
  viewProjection: ReadonlyMat4,
  decalToWorld: ReadonlyMat4,
  width: number,
  height: number,
  yDown: boolean,
  out: Int32Array,
): boolean {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let behind = 0;

  for (let corner = 0; corner < 8; corner++) {
    const bx = (corner & 1) === 0 ? -1 : 1;
    const by = (corner & 2) === 0 ? -1 : 1;
    const bz = (corner & 4) === 0 ? -1 : 1;

    /* Box space to world, then world to clip, without a scratch matrix: two transforms of one
       point is less work than the 4x4 multiply that would fuse them, and this runs per decal. */
    for (let row = 0; row < 4; row++) {
      CORNER[row] =
        (decalToWorld[row] ?? 0) * bx +
        (decalToWorld[4 + row] ?? 0) * by +
        (decalToWorld[8 + row] ?? 0) * bz +
        (decalToWorld[12 + row] ?? 0);
    }
    const wx = CORNER[0] ?? 0;
    const wy = CORNER[1] ?? 0;
    const wz = CORNER[2] ?? 0;
    const clipX =
      (viewProjection[0] ?? 0) * wx +
      (viewProjection[4] ?? 0) * wy +
      (viewProjection[8] ?? 0) * wz +
      (viewProjection[12] ?? 0);
    const clipY =
      (viewProjection[1] ?? 0) * wx +
      (viewProjection[5] ?? 0) * wy +
      (viewProjection[9] ?? 0) * wz +
      (viewProjection[13] ?? 0);
    const clipW =
      (viewProjection[3] ?? 0) * wx +
      (viewProjection[7] ?? 0) * wy +
      (viewProjection[11] ?? 0) * wz +
      (viewProjection[15] ?? 0);

    if (clipW <= 1e-6) {
      behind++;
      continue;
    }
    const ndcX = clipX / clipW;
    const ndcY = clipY / clipW;
    if (ndcX < minX) minX = ndcX;
    if (ndcX > maxX) maxX = ndcX;
    if (ndcY < minY) minY = ndcY;
    if (ndcY > maxY) maxY = ndcY;
  }

  if (behind === 8) return false;
  if (behind > 0) {
    out[0] = 0;
    out[1] = 0;
    out[2] = width;
    out[3] = height;
    return true;
  }

  const left = Math.max(0, Math.floor(((minX + 1) / 2) * width) - SCISSOR_PAD);
  const right = Math.min(width, Math.ceil(((maxX + 1) / 2) * width) + SCISSOR_PAD);
  const bottom = Math.max(0, Math.floor(((minY + 1) / 2) * height) - SCISSOR_PAD);
  const top = Math.min(height, Math.ceil(((maxY + 1) / 2) * height) + SCISSOR_PAD);
  if (right <= left || top <= bottom) return false;

  out[0] = left;
  out[1] = yDown ? height - top : bottom;
  out[2] = right - left;
  out[3] = top - bottom;
  return true;
}

/**
 * A projector a consumer holds and moves.
 *
 * **Held rather than passed per call**, because that is what the row is for: a mark that follows
 * something is a pose written every frame, and rebuilding two matrices from four vectors is the
 * whole of that. Both matrices live in the object and are rewritten in place, so a scene with a
 * hundred marks allocates on the frame it creates them and never again.
 */
export class DecalProjector {
  /** World space into the unit box. Rewritten in place by `setPose` and `setSize`. */
  readonly worldToDecal = new Float32Array(16);
  /** The unit box back into the world, for the scissor bound. */
  readonly decalToWorld = new Float32Array(16);
  /** The projection axis, normalised, which the facing test compares a surface normal against. */
  readonly axis = new Float32Array(3);
  /** What the mark multiplies the surface by. */
  readonly color = new Float32Array(3);

  opacity: number;
  facingCos: number;
  softness: number;

  private readonly box: {
    center: Float32Array;
    halfExtents: Float32Array;
    forward: Float32Array;
    up: Float32Array;
  };

  constructor(options: DecalProjectorOptions) {
    this.box = {
      center: Float32Array.from(options.center as ArrayLike<number>),
      halfExtents: Float32Array.from(options.halfExtents as ArrayLike<number>),
      forward: Float32Array.from(options.forward as ArrayLike<number>),
      up: Float32Array.from(options.up as ArrayLike<number>),
    };
    this.color.set(options.color === undefined ? [1, 1, 1] : (options.color as ArrayLike<number>));
    this.opacity = options.opacity ?? 1;
    /* The same 0.1 `projectDecal` defaults to, which keeps everything within about 84 degrees of
       facing — and for the same reason, stated there. */
    this.facingCos = options.facingCos ?? 0.1;
    /* A quarter of the radius as edge. A hard ellipse reads as a decal that was cut out with
       scissors, and a mark with no texture has nothing else to soften it. */
    this.softness = options.softness ?? 0.25;
    this.rebuild();
  }

  /** Move the projector. Allocation-free, so a mark may follow something every frame. */
  setPose(center: ReadonlyVec3, forward: ReadonlyVec3, up: ReadonlyVec3): void {
    this.box.center.set(center as ArrayLike<number>);
    this.box.forward.set(forward as ArrayLike<number>);
    this.box.up.set(up as ArrayLike<number>);
    this.rebuild();
  }

  /** Resize the box, on the same terms. */
  setSize(halfExtents: ReadonlyVec3): void {
    this.box.halfExtents.set(halfExtents as ArrayLike<number>);
    this.rebuild();
  }

  setColor(color: ReadonlyVec3): void {
    this.color.set(color as ArrayLike<number>);
  }

  private rebuild(): void {
    worldToDecalMatrix(this.worldToDecal, this.box);
    decalToWorldMatrix(this.decalToWorld, this.box);
    /* `frame` left the normalised axis in its scratch, and reading it back here would couple this
       to the order those two ran in. Normalised again instead: it is three multiplies once per
       pose, against a coupling that would break silently. */
    const f = this.box.forward;
    const length = Math.hypot(f[0] ?? 0, f[1] ?? 0, f[2] ?? 0);
    this.axis[0] = (f[0] ?? 0) / length;
    this.axis[1] = (f[1] ?? 0) / length;
    this.axis[2] = (f[2] ?? 0) / length;
  }
}

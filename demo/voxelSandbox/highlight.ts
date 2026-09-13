/**
 * The outline around the block under the crosshair.
 *
 * The reference builds a slightly inflated box mesh with its own pulsing shader. This is twelve
 * strokes with a width in metres, which is what `drawLines` is for and what `examples/lines/`
 * exists to demonstrate — no shader, and an antialiased edge for free.
 *
 * **The buffer is written in place and never reallocated.** `show` runs whenever the crosshair
 * moves to a different block, which is often, and `examples/lines/` is explicit that a line
 * buffer is sized once and rewritten.
 */
import {
  createLineSegments,
  type Camera,
  type Environment,
  type LineHandle,
  type LineSegments,
  type RendererApi,
  type Vec3,
} from '../../packages/core/src/index';

/** The twelve edges of a unit cube, as pairs of corners. */
const EDGES: readonly (readonly [number, number, number, number, number, number])[] = [
  [0, 0, 0, 1, 0, 0],
  [1, 0, 0, 1, 1, 0],
  [1, 1, 0, 0, 1, 0],
  [0, 1, 0, 0, 0, 0],
  [0, 0, 1, 1, 0, 1],
  [1, 0, 1, 1, 1, 1],
  [1, 1, 1, 0, 1, 1],
  [0, 1, 1, 0, 0, 1],
  [0, 0, 0, 0, 0, 1],
  [1, 0, 0, 1, 0, 1],
  [1, 1, 0, 1, 1, 1],
  [0, 1, 0, 0, 1, 1],
];

/**
 * How far outside the block the outline sits, in metres.
 *
 * Without it the strokes are coplanar with the faces they trace and z-fighting makes the outline
 * flicker as the camera moves. This is the first number to raise if it ever shimmers.
 */
const INFLATE_M = 0.003;

/**
 * Cyan-white, as the reference's is.
 *
 * Its outline is an additively blended glow with a soft falloff halo and a slow pulse, drawn by
 * its own shader. `drawLines` is a flat fogged colour with a clean edge, so this gets as close as
 * the standard path allows: a wide soft stroke for the halo and a narrow bright one over it, both
 * pulsing. See `GAPS.md` for what additive blending would have added.
 */
const GLOW: Vec3 = [0.55, 0.95, 1.0];

/** The crisp inner line, and the wider soft one under it. */
const CORE_WIDTH_M = 0.008;
const HALO_WIDTH_M = 0.03;
/** How far the antialiased edge is feathered inward, as a fraction of the half-width. */
const HALO_SOFTNESS = 0.9;

/** The reference pulses at 4.5 radians a second between 0.78 and 1. */
const PULSE_RATE = 4.5;

/**
 * The floor that keeps a distant stroke above a pixel, as a width per metre of distance.
 *
 * The engine's own default for the same parameter on `drawBolts` is 0.004, which is the scale
 * this wants. It is not a pixel count: at reach distance a value of 0.6 is a four-metre slab.
 */
const MIN_WIDTH_PER_METRE = 0.004;

/** No transform: the segments are written in world space each time the selection moves. */
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export class Highlight {
  private readonly renderer: RendererApi;
  private readonly batch: LineHandle;
  /* Two handles, not one reused: on WebGPU every draw against a handle in a frame reads
     whichever write landed last, so one handle drawn twice is one shape drawn twice. Here the
     geometry is identical for both passes, which is the case the docs say is fine — but the
     widths differ, and keeping them apart costs nothing and cannot be got wrong later. */
  private readonly haloBatch: LineHandle;
  private readonly segments: LineSegments = createLineSegments(EDGES.length);
  private visible = false;
  private elapsed = 0;
  private disposed = false;

  constructor(renderer: RendererApi) {
    this.renderer = renderer;
    this.batch = renderer.createLines(EDGES.length, 'voxel-highlight');
    this.haloBatch = renderer.createLines(EDGES.length, 'voxel-highlight-halo');
  }

  /** Point the outline at a block. Rewrites the buffer; allocates nothing. */
  show(bx: number, by: number, bz: number): void {
    const { from, to } = this.segments;
    const lo = -INFLATE_M;
    const hi = 1 + INFLATE_M;
    for (let i = 0; i < EDGES.length; i++) {
      const e = EDGES[i]!;
      const at = i * 3;
      from[at] = bx + (e[0] === 0 ? lo : hi);
      from[at + 1] = by + (e[1] === 0 ? lo : hi);
      from[at + 2] = bz + (e[2] === 0 ? lo : hi);
      to[at] = bx + (e[3] === 0 ? lo : hi);
      to[at + 1] = by + (e[4] === 0 ? lo : hi);
      to[at + 2] = bz + (e[5] === 0 ? lo : hi);
    }
    this.segments.count = EDGES.length;
    this.visible = true;
  }

  /** Stop drawing it. Frees nothing: the next `show` reuses the same buffer. */
  hide(): void {
    this.visible = false;
  }

  /** Advance the pulse. Separate from `draw` so a paused scene does not throb. */
  update(dtSec: number): void {
    this.elapsed += dtSec;
  }

  draw(camera: Camera, env: Environment): void {
    if (!this.visible) return;
    const pulse = 0.78 + 0.22 * Math.sin(this.elapsed * PULSE_RATE);

    /* The halo first and wider, then the core over it. */
    this.renderer.drawLines(
      this.haloBatch,
      this.segments,
      IDENTITY,
      camera,
      env,
      GLOW,
      HALO_WIDTH_M,
      0.32 * pulse,
      HALO_SOFTNESS,
      MIN_WIDTH_PER_METRE,
    );
    this.renderer.drawLines(
      this.batch,
      this.segments,
      IDENTITY,
      camera,
      env,
      GLOW,
      CORE_WIDTH_M,
      pulse,
      0,
      /*
       * The floor that stops a far segment falling under a pixel and strobing. It is a width
       * *per metre of distance*, so it is tiny: 0.6 was passed here once and drew a four-metre
       * black slab across the screen at reach distance.
       */
      MIN_WIDTH_PER_METRE,
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.disposeLines(this.batch);
    this.renderer.disposeLines(this.haloBatch);
  }
}

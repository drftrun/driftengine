/**
 * A top-down picture of the layout, drawn the way the reference's own city map is: +z up and −x to
 * the right, so the two lie side by side unchanged.
 *
 * It is an instrument, not an asset: blocks tinted by district and kind, roads at their true
 * widths, the diagonal and the elevated road, and whatever later stages add, so a layout decision
 * can be judged against the reference's map by eye.
 */
import { encodePng } from '../../../../packages/core/scripts/png.mjs';
import type { Vec2 } from './plane.ts';

export type Colour = readonly [number, number, number];

export class Plot {
  readonly rgba: Uint8Array;

  /** A `size`-pixel square picture of the ground within `half` metres of the origin. */
  constructor(
    readonly size: number,
    readonly half: number,
    background: Colour,
  ) {
    this.rgba = new Uint8Array(size * size * 4);
    for (let i = 0; i < size * size; i += 1) {
      this.rgba.set([background[0], background[1], background[2], 255], i * 4);
    }
  }

  /** World (x, z) to pixel (column, row). */
  pixel(x: number, z: number): Vec2 {
    const scale = this.size / (2 * this.half);
    return [(this.half - x) * scale, (this.half - z) * scale];
  }

  /** A convex outline, filled; `alpha` blends it over what is there. */
  fill(outline: readonly Vec2[], colour: Colour, alpha = 1): void {
    const pts = outline.map(([x, z]) => this.pixel(x, z));
    let top = Infinity;
    let bottom = -Infinity;
    for (const [, y] of pts) {
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
    for (
      let row = Math.max(0, Math.ceil(top - 0.5));
      row <= Math.min(this.size - 1, bottom - 0.5);
      row += 1
    ) {
      const y = row + 0.5;
      let left = Infinity;
      let right = -Infinity;
      for (let i = 0; i < pts.length; i += 1) {
        const p = pts[i] as Vec2;
        const q = pts[(i + 1) % pts.length] as Vec2;
        if ((p[1] <= y && q[1] > y) || (q[1] <= y && p[1] > y)) {
          const x = p[0] + ((y - p[1]) / (q[1] - p[1])) * (q[0] - p[0]);
          left = Math.min(left, x);
          right = Math.max(right, x);
        }
      }
      for (
        let col = Math.max(0, Math.ceil(left - 0.5));
        col <= Math.min(this.size - 1, right - 0.5);
        col += 1
      ) {
        const at = (row * this.size + col) * 4;
        for (let k = 0; k < 3; k += 1) {
          const was = this.rgba[at + k] as number;
          this.rgba[at + k] = Math.round(was + ((colour[k] as number) - was) * alpha);
        }
      }
    }
  }

  /** A polyline `width` metres wide, as a quad a segment. */
  line(points: readonly Vec2[], width: number, colour: Colour, alpha = 1): void {
    for (let i = 0; i + 1 < points.length; i += 1) {
      const a = points[i] as Vec2;
      const b = points[i + 1] as Vec2;
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (length === 0) continue;
      const nx = (-(b[1] - a[1]) / length) * (width / 2);
      const nz = ((b[0] - a[0]) / length) * (width / 2);
      this.fill(
        [
          [a[0] - nx, a[1] - nz],
          [b[0] - nx, b[1] - nz],
          [b[0] + nx, b[1] + nz],
          [a[0] + nx, a[1] + nz],
        ],
        colour,
        alpha,
      );
    }
  }

  png(): Buffer {
    return encodePng(this.size, this.size, this.rgba);
  }
}

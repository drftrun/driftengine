/**
 * The accumulator every solid primitive writes through: a vertex at a time, a triangle or a quad at
 * a time, finished into a `Solid`.
 *
 * Internal to the geometry modules and not in the barrel — a caller building geometry of its own
 * wants `MeshBuilder` or typed arrays, and this exists so the primitives share one place that
 * decides how a vertex is laid out.
 */
import { GrowableF32, GrowableU32 } from './growable.ts';
import type { Solid } from './solid.ts';

export class SolidWriter {
  private readonly positions = new GrowableF32();
  private readonly normals = new GrowableF32();
  private readonly uvs = new GrowableF32();
  private readonly indices = new GrowableU32();
  private count = 0;

  /** Add one vertex and return its index. The normal is taken as given; pass it unit length. */
  vertex(
    px: number,
    py: number,
    pz: number,
    nx: number,
    ny: number,
    nz: number,
    u: number,
    v: number,
  ): number {
    this.positions.push(px, py, pz);
    this.normals.push(nx, ny, nz);
    this.uvs.push(u, v);
    return this.count++;
  }

  triangle(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }

  /** Two triangles over a counter-clockwise quad `a b c d`. */
  quad(a: number, b: number, c: number, d: number): void {
    this.indices.push(a, b, c, a, c, d);
  }

  /** How many vertices so far, which is the index the next `vertex` returns. */
  get vertexCount(): number {
    return this.count;
  }

  finish(): Solid {
    return {
      positions: this.positions.toTyped(),
      normals: this.normals.toTyped(),
      uvs: this.uvs.toTyped(),
      indices: this.indices.toTyped(),
    };
  }
}

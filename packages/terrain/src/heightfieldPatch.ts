import type { MeshData } from '@driftengine/drft';
import type { ReadonlyVec3 } from 'gl-matrix';

import type { Terrain } from './heightfield.ts';
import type { TerrainMaterials } from './terrainMaterials.ts';

/**
 * One square of a heightfield, as geometry, at a level of detail — and matched to its neighbours.
 *
 * **A patch is the unit of detail, and the seam between two of them is the whole problem.** A
 * heightfield drawn at one resolution is either too coarse underfoot or too fine at the horizon, so
 * it is drawn in squares and the distant squares skip samples. Where a square that skips none meets
 * one that skips every other, the fine edge has vertices the coarse edge does not — and those
 * vertices sit *on the field* while the coarse edge cuts the chord beneath them. The gap between
 * the two is a crack, and a crack in terrain is a hole through to the sky.
 *
 * **Matched rather than hidden.** The usual remedy is a skirt: a vertical curtain dropped from
 * every patch edge, which fills the hole with something the wrong colour and lit the wrong way, and
 * costs geometry along every boundary in the world for ever. What this does instead is move the
 * fine edge's odd vertices onto the coarse edge's own straight segment, so the two edges are the
 * same polyline and there is nothing to fill. It costs one interpolation per boundary vertex, at
 * build time, and no geometry at all.
 *
 * **The cost of matching, stated because it is real**: along a matched edge the drawn surface is
 * the coarse chord rather than the field, so `Terrain.heightAt` and the picture differ there by up
 * to the sag of one coarse cell. That is the same error the coarse patch itself carries over its
 * whole area, arriving one cell early — which is why it is the right trade and why it is written
 * down rather than left to be discovered.
 */

export interface HeightfieldPatchOptions {
  /** Grid index of the patch's first sample, along x. */
  readonly x: number;
  /** Grid index of the patch's first sample, along z. */
  readonly z: number;
  /** How many field cells the patch spans. */
  readonly cells: number;
  /**
   * How many field cells one drawn cell spans. 1 is full resolution.
   *
   * Must divide `cells`, since a patch that does not come out whole would leave a strip of the
   * field undrawn — a crack that no neighbour can match because nothing is there to match.
   */
  readonly step?: number;
  /**
   * The step each neighbouring patch is drawn at, where it is coarser than this one.
   *
   * Only the coarser side needs naming: the finer patch is the one that moves. A neighbour at the
   * same step or a finer one changes nothing, so a caller may pass what it knows and leave the
   * rest out.
   */
  readonly neighbours?: {
    readonly minusX?: number;
    readonly plusX?: number;
    readonly minusZ?: number;
    readonly plusZ?: number;
  };
  /**
   * One colour for the whole patch. Ignored where `materials` is given.
   *
   * Two ways to say the same thing would be a mistake, and this is not one: a patch with a single
   * colour is what a caller writes before they have a weight map, and a map is what they write once
   * they have several materials. The second wins where both are present, said here so it is not
   * discovered.
   */
  readonly color?: ReadonlyVec3;
  readonly emissive?: number;
  /**
   * Several materials blended across the *field*, rather than one colour for this patch.
   *
   * **Read in the field's own coordinates and never the patch's**, which is what makes two patches
   * agree along the edge they share. Shading from a patch-local coordinate would restart the blend
   * at every boundary and draw a grid of squares over the world.
   */
  readonly materials?: TerrainMaterials;
}

/** How far along an edge a vertex sits on the coarse lattice, and the two coarse heights round it. */
function chord(low: number, high: number, at: number, height: (index: number) => number): number {
  if (high === low) return height(low);
  const t = (at - low) / (high - low);
  return height(low) * (1 - t) + height(high) * t;
}

export function heightfieldPatch(terrain: Terrain, options: HeightfieldPatchOptions): MeshData {
  const step = Math.round(options.step ?? 1);
  const cells = Math.round(options.cells);
  if (!(step >= 1)) throw new Error(`heightfieldPatch: step must be at least 1, got ${step}`);
  if (cells % step !== 0) {
    throw new Error(
      `heightfieldPatch: a step of ${step} does not divide ${cells} cells, so a strip would go undrawn`,
    );
  }
  if (
    options.x < 0 ||
    options.z < 0 ||
    options.x + cells > terrain.width - 1 ||
    options.z + cells > terrain.depth - 1
  ) {
    throw new Error(
      `heightfieldPatch: a patch at ${options.x}, ${options.z} of ${cells} cells runs off a field ` +
        `of ${terrain.width} by ${terrain.depth}`,
    );
  }

  const neighbours = options.neighbours ?? {};
  for (const [side, theirs] of Object.entries(neighbours)) {
    if (theirs === undefined) continue;
    if (theirs % step !== 0) {
      throw new Error(
        `heightfieldPatch: a neighbour on ${side} drawn at ${theirs} cannot be matched by a patch ` +
          `drawn at ${step}, since one does not divide the other`,
      );
    }
  }

  const across = cells / step;
  const vertices = (across + 1) * (across + 1);
  const spacing = terrain.spacingM;
  const originX = (terrain.origin[0] ?? 0) + options.x * spacing;
  const originZ = (terrain.origin[2] ?? 0) + options.z * spacing;
  const materials = options.materials;
  const colour = options.color ?? [0.42, 0.45, 0.36];
  const emissive = options.emissive ?? 0;

  const positions = new Float32Array(vertices * 3);
  const normals = new Float32Array(vertices * 3);
  const colors = new Float32Array(vertices * 3);
  const emissives = new Float32Array(vertices);
  /* Allocated only where something shines, which is the promise `MeshData.specular` makes: geometry
     that does not shine produces exactly the mesh it produced before the attribute existed. */
  const speculars = materials?.shines === true ? new Float32Array(vertices) : null;
  const indices = new Uint32Array(across * across * 6);
  const normal = new Float32Array(3);
  const shade = new Float32Array(3);

  for (let row = 0; row <= across; row++) {
    for (let column = 0; column <= across; column++) {
      const at = (row * (across + 1) + column) * 3;
      const x = originX + column * step * spacing;
      const z = originZ + row * step * spacing;

      /*
       * The field's own height, unless this vertex is on an edge whose neighbour is coarser — in
       * which case it takes that neighbour's chord instead, and the two patches then share one
       * polyline. A corner sits on two edges and is a multiple of every step, so it is never moved
       * and the two rules cannot disagree about it.
       */
      let y = terrain.heightAt(x, z);
      const onMinusX = column === 0;
      const onPlusX = column === across;
      const onMinusZ = row === 0;
      const onPlusZ = row === across;

      if (onMinusX && neighbours.minusX !== undefined) {
        y = matched(row, neighbours.minusX, (index) =>
          terrain.heightAt(x, originZ + index * spacing),
        );
      } else if (onPlusX && neighbours.plusX !== undefined) {
        y = matched(row, neighbours.plusX, (index) =>
          terrain.heightAt(x, originZ + index * spacing),
        );
      } else if (onMinusZ && neighbours.minusZ !== undefined) {
        y = matched(column, neighbours.minusZ, (index) =>
          terrain.heightAt(originX + index * spacing, z),
        );
      } else if (onPlusZ && neighbours.plusZ !== undefined) {
        y = matched(column, neighbours.plusZ, (index) =>
          terrain.heightAt(originX + index * spacing, z),
        );
      }

      positions[at] = x;
      positions[at + 1] = y;
      positions[at + 2] = z;

      /* The field's normal and never the patch's, so two patches shade identically along the edge
         they share. `heightfield.ts` argues that where the query is defined. */
      terrain.normalAt(x, z, normal);
      normals[at] = normal[0] ?? 0;
      normals[at + 1] = normal[1] ?? 1;
      normals[at + 2] = normal[2] ?? 0;

      if (materials === undefined) {
        colors[at] = colour[0] ?? 1;
        colors[at + 1] = colour[1] ?? 1;
        colors[at + 2] = colour[2] ?? 1;
        emissives[row * (across + 1) + column] = emissive;
      } else {
        /* The field's own extent, so the blend is continuous across every patch boundary. */
        const u = terrain.extentX === 0 ? 0 : (x - (terrain.origin[0] ?? 0)) / terrain.extentX;
        const w = terrain.extentZ === 0 ? 0 : (z - (terrain.origin[2] ?? 0)) / terrain.extentZ;
        materials.colorAt(u, w, shade);
        colors[at] = shade[0] ?? 1;
        colors[at + 1] = shade[1] ?? 1;
        colors[at + 2] = shade[2] ?? 1;
        emissives[row * (across + 1) + column] = materials.emissiveAt(u, w);
        if (speculars !== null) {
          speculars[row * (across + 1) + column] = materials.specularAt(u, w);
        }
      }
    }
  }

  /**
   * Where a vertex on a matched edge actually sits.
   *
   * `index` counts drawn cells along the edge and `theirs` is the neighbour's step in field cells,
   * so `theirs / step` drawn vertices span one of the neighbour's. A vertex on that lattice keeps
   * the field; one between two of them takes the chord.
   */
  function matched(index: number, theirs: number, height: (fieldCell: number) => number): number {
    const ratio = theirs / step;
    const low = Math.floor(index / ratio) * ratio;
    const high = Math.min(across, low + ratio);
    return chord(low * step, high * step, index * step, height);
  }

  let at = 0;
  for (let row = 0; row < across; row++) {
    for (let column = 0; column < across; column++) {
      const a = row * (across + 1) + column;
      const b = a + 1;
      const d = a + (across + 1);
      const c = d + 1;
      /*
       * **Split along `a`-`c`, which is the diagonal `Terrain.heightAt` reads.** The two surfaces
       * are the same surface or a query answers a place the picture does not have.
       *
       * This said `a, d, b` and `b, d, c` until 2026-09-02, which is the *other* diagonal — the
       * mesh was split one way and the query read the other, so the two disagreed by up to the
       * height of the cell everywhere except along the anti-diagonal itself. **Nothing caught it
       * for two rows**: every vertex lies on both triangulations, so a per-vertex assertion passes
       * either way, and the test fields were of the form `f(x) + g(z)` — separable, and for a
       * separable field both diagonals give the identical surface. It surfaced when a cross term
       * went into the field and a ray cast against the mesh landed 11.6 mm off the query.
       *
       * Wound so the face normal points up either way: with x to the right and z away, `a, d, c`
       * and `a, c, b` both cross upward.
       */
      indices[at++] = a;
      indices[at++] = d;
      indices[at++] = c;
      indices[at++] = a;
      indices[at++] = c;
      indices[at++] = b;
    }
  }

  return {
    positions,
    normals,
    colors,
    emissive: emissives,
    ...(speculars === null ? {} : { specular: speculars }),
    indices,
  };
}

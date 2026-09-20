/**
 * A segmentation model's masks brought onto the mesh, and a detector's names brought onto the masks.
 *
 * **Where a region comes from when weights are loaded.** A prompt lattice asks the model what is in
 * the frame, the masks that come back are voted onto the mesh across every view that saw a
 * triangle, and a detector's boxes put names to the mask indices. Nothing here runs a model: masks
 * and detections arrive as data, so this module is the same code whether they were produced on a
 * device, on a native host, or by hand in a test.
 *
 * **Voting rather than taking the best view**, because a mask boundary is where a model is least
 * sure and every view puts it somewhere slightly different — and **a triangle no view claimed is
 * left unassigned**, which is what keeps an unlabelled region unlabelled rather than absorbed.
 */
import type { MeshData } from '@driftengine/drft';

const DEFAULT_OVERLAP = 0.25;

import type { Owlv2Detection } from './models/owlv2Detect.ts';
import { planeOf, regionOf, type Region } from './segment.ts';

/** Where a model is prompted, and what came back for each prompt. */
export interface MaskView {
  /** One mask index per pixel, or −1 where the model claimed nothing. */
  readonly mask: Int32Array;
  readonly width: number;
  readonly height: number;
  /** 3 × 4 row-major world-to-camera. */
  readonly worldToCamera: Float64Array;
  /** `fx`, `fy`, `cx`, `cy`. */
  readonly intrinsics: readonly [number, number, number, number];
}

/**
 * A lattice of prompt points over an image, seeded.
 *
 * **A lattice rather than a scatter**, because a scatter leaves gaps a small object falls into and
 * a lattice does not; the seeded jitter is there so that a repeated object does not land on the
 * same part of every instance, which is how a grid misses the same feature twice. Two per pixel
 * pair — `x` then `y` — in reading order, which is the order a model's masks come back in.
 */
export function promptGrid(
  width: number,
  height: number,
  across: number,
  down: number,
  random: () => number,
): Float32Array {
  const out = new Float32Array(across * down * 2);
  for (let j = 0; j < down; j += 1) {
    for (let i = 0; i < across; i += 1) {
      const at = (j * across + i) * 2;
      const cellX = (width * (i + 0.5)) / across;
      const cellY = (height * (j + 0.5)) / down;
      /*
       * A sixth of a cell either way. A centre sits half a cell from each of its edges, so a point
       * cannot leave the cell it belongs to however the seed falls — which is what keeps this a
       * lattice, and is why nothing here clamps to the frame.
       */
      const jitterX = ((random() - 0.5) * width) / across / 3;
      const jitterY = ((random() - 0.5) * height) / down / 3;
      out[at] = cellX + jitterX;
      out[at + 1] = cellY + jitterY;
    }
  }
  return out;
}

/**
 * Masks from several views lifted onto the mesh, by what most of the views that saw a triangle say.
 *
 * **Voting rather than taking the best view**, because a mask boundary is where a model is least
 * sure and every view puts it somewhere slightly different. A triangle no view claimed is left
 * unassigned rather than given to its neighbour, which is what keeps an unlabelled region
 * unlabelled.
 */
export function liftMasks(
  views: readonly MaskView[],
  mesh: MeshData,
  labels: readonly string[],
): Region[] {
  const triangles = mesh.indices.length / 3;
  const planes = new Float64Array(triangles * 4);
  const areas = new Float64Array(triangles);
  for (let face = 0; face < triangles; face += 1) planeOf(mesh, face, planes, areas);

  const votes: Map<number, number>[] = [];
  for (let face = 0; face < triangles; face += 1) votes.push(new Map());
  const middle = new Float64Array(3);
  for (const view of views) {
    const [fx, fy, cx, cy] = view.intrinsics;
    const m = view.worldToCamera;
    for (let face = 0; face < triangles; face += 1) {
      centroid(mesh, face, middle);
      let x = m[3] as number;
      let y = m[7] as number;
      let z = m[11] as number;
      for (let k = 0; k < 3; k += 1) {
        x += (m[k] as number) * (middle[k] as number);
        y += (m[4 + k] as number) * (middle[k] as number);
        z += (m[8 + k] as number) * (middle[k] as number);
      }
      if (!(z > 0)) continue;
      const px = Math.floor((fx * x) / z + cx);
      const py = Math.floor((fy * y) / z + cy);
      if (px < 0 || px >= view.width || py < 0 || py >= view.height) continue;
      const mask = view.mask[py * view.width + px] as number;
      if (mask < 0) continue;
      const held = votes[face] as Map<number, number>;
      held.set(mask, (held.get(mask) ?? 0) + 1);
    }
  }

  const members = new Map<number, number[]>();
  for (let face = 0; face < triangles; face += 1) {
    const held = votes[face] as Map<number, number>;
    let best = -1;
    let most = 0;
    /* Ties go to the lower mask index, so two views disagreeing give the same answer every run. */
    for (const [mask, count] of [...held.entries()].sort((a, b) => a[0] - b[0])) {
      if (count > most) {
        most = count;
        best = mask;
      }
    }
    if (best < 0) continue;
    const list = members.get(best);
    if (list === undefined) members.set(best, [face]);
    else list.push(face);
  }

  const out: Region[] = [];
  for (const mask of [...members.keys()].sort((a, b) => a - b)) {
    const region = regionOf(mesh, members.get(mask) as number[], planes, areas);
    out.push({ ...region, label: labels[mask] ?? null });
  }
  return out;
}

/**
 * A name for each mask index, from a detector's boxes.
 *
 * **The join between the two models a capture runs**: one says *where the things are* and the other
 * says *what they are called*, and neither can do the other's half. A mask takes the name of the
 * detection it agrees with most, measured as intersection over union between the mask's own pixels
 * and the box — the mask's pixels rather than the box around them, because the box around an
 * L-shaped mask is mostly not the mask.
 *
 * **A mask that agrees with nothing gets no name, and that is a result.** `null` here reaches
 * `proposeEntities` as scenery, which is the safe answer; a name taken from the nearest box
 * whatever the overlap is how a chair becomes a table. `overlap` is where a caller draws that line.
 */
export function labelMasks(
  view: MaskView,
  detections: readonly Owlv2Detection[],
  queries: readonly string[],
  overlap = DEFAULT_OVERLAP,
): (string | null)[] {
  let masks = 0;
  for (const mask of view.mask) if (mask + 1 > masks) masks = mask + 1;
  const out = new Array<string | null>(masks).fill(null);
  const counts = new Int32Array(masks);
  for (const mask of view.mask) if (mask >= 0) counts[mask] = (counts[mask] as number) + 1;

  /* The best agreement each mask has found so far, so a tie keeps the earlier detection. */
  const best = new Float64Array(masks);
  const inside = new Int32Array(masks);
  for (let at = 0; at < detections.length; at += 1) {
    const box = (detections[at] as Owlv2Detection).box;
    inside.fill(0);
    for (let y = 0; y < view.height; y += 1) {
      for (let x = 0; x < view.width; x += 1) {
        const mask = view.mask[y * view.width + x] as number;
        if (mask < 0) continue;
        if (x + 0.5 < (box[0] as number) || x + 0.5 >= (box[2] as number)) continue;
        if (y + 0.5 < (box[1] as number) || y + 0.5 >= (box[3] as number)) continue;
        inside[mask] = (inside[mask] as number) + 1;
      }
    }
    const area =
      ((box[2] as number) - (box[0] as number)) * ((box[3] as number) - (box[1] as number));
    for (let mask = 0; mask < masks; mask += 1) {
      const met = inside[mask] as number;
      const union = (counts[mask] as number) + area - met;
      const score = union > 0 ? met / union : 0;
      if (score < overlap || score <= (best[mask] as number)) continue;
      best[mask] = score;
      out[mask] = queries[(detections[at] as Owlv2Detection).label] ?? null;
    }
  }
  return out;
}

function centroid(mesh: MeshData, face: number, out: Float64Array): void {
  for (let k = 0; k < 3; k += 1) out[k] = 0;
  for (let slot = 0; slot < 3; slot += 1) {
    const vertex = mesh.indices[face * 3 + slot] as number;
    for (let k = 0; k < 3; k += 1) {
      out[k] = (out[k] as number) + (mesh.positions[vertex * 3 + k] as number) / 3;
    }
  }
}

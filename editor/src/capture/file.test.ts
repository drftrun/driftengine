import { captureFile, proposeEntities, segmentGeometry } from '@driftengine/capture';
import type { MeshData } from '@driftengine/drft';
import { expect, test } from 'vitest';

import { decideProposal, createCaptureModel, setProposals } from '../panels/capture.ts';
import {
  SURFACE_ENTITY,
  captureSceneModel,
  captureShellScene,
  openCapture,
  saveCapture,
} from './file.ts';

/**
 * **A `.drft` opened through the host's seam appears in the tree and in the viewport, and what a
 * person decided about it is written back.**
 *
 * The file in this test is a real one: built by `@driftengine/capture`, written by its own writer,
 * read by the container's reader. What is under test is the editor's half — that a region in the
 * file becomes one entity with one number in three places, and that saving writes the decisions
 * rather than the proposals.
 */

/** A floor and one wall, as two quads with their own vertices. Small, and enough to segment. */
function room(): MeshData {
  const positions: number[] = [];
  const indices: number[] = [];
  const quad = (corners: readonly (readonly [number, number, number])[]): void => {
    const base = positions.length / 3;
    for (const [x, y, z] of corners) positions.push(x, y, z);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  quad([
    [-2, 0, -2],
    [-2, 0, 2],
    [2, 0, 2],
    [2, 0, -2],
  ]);
  quad([
    [-2, 0, -2],
    [2, 0, -2],
    [2, 3, -2],
    [-2, 3, -2],
  ]);
  return {
    positions: Float32Array.from(positions),
    normals: new Float32Array(positions.length),
    colors: new Float32Array(positions.length).fill(1),
    emissive: new Float32Array(positions.length / 3),
    indices: Uint32Array.from(indices),
  };
}

function captured(): ArrayBuffer {
  const mesh = room();
  return captureFile({ mesh, proposals: proposeEntities(segmentGeometry(mesh)) });
}

test('A CAPTURE OPENS INTO THE TREE AND THE VIEWPORT AS ONE LIST OF THINGS', () => {
  const opened = openCapture(captured());
  expect(opened.triangles).toBe(4);
  expect(opened.proposals.length).toBe(2);

  /* The surface, and one entity per region — the same numbers the tree and the scene use. */
  expect(opened.entities.length).toBe(3);
  expect(opened.entities[0]?.entity).toBe(SURFACE_ENTITY);

  const tree = captureSceneModel(opened);
  expect(tree.ids.length).toBe(3);
  expect(tree.parentOf(1)).toBe(SURFACE_ENTITY);
  /*
   * **Named for what is known**, which for a region nobody labelled is its number. A capture that
   * called them `object` would be asserting it had recognised something.
   */
  expect(tree.nameOf(1)).toMatch(/^region \d+$/);

  const scene = captureShellScene(opened);
  expect(scene.entities()).toEqual([0, 1, 2]);
  const at = new Float32Array(3);
  expect(scene.positionOf(1, at)).toBe(true);
  /*
   * **A marker stands on its region rather than inside it**, and is the size it is drawn at.
   *
   * The floor spans four metres, so its marker is 0.4 across — a twentieth of the span, clamped —
   * and it sits at the top of the bounds plus its own radius, which for a floor at y = 0 is 0.4.
   * Both numbers were something else: the position was the middle of the bounds, which put a
   * floor's marker inside the floor and out of sight, and the radius was half the region's longest
   * side, which is what a *pick* used — so a click in empty space several markers away selected
   * one. One number for drawing and picking, or the two disagree where it matters most.
   */
  expect(scene.radiusOf(1)).toBeCloseTo(0.4, 6);
  expect(at[1]).toBeCloseTo(0.4, 6);
  expect(scene.nameOf(99)).toBe('');
});

test('SAVING WRITES WHAT WAS ACCEPTED, AND A REJECTION IS NOT WRITTEN AT ALL', () => {
  const opened = openCapture(captured());
  const model = createCaptureModel();
  setProposals(model, opened.proposals);

  const first = opened.proposals[0]?.region ?? 0;
  const second = opened.proposals[1]?.region ?? 1;
  decideProposal(model, first, true).apply();
  decideProposal(model, second, false).apply();

  const again = openCapture(saveCapture(opened, model.decided));
  expect(again.proposals.length).toBe(1);
  expect(again.proposals[0]?.region).toBe(0);
  /* The expensive half is still there: geometry is not a thing a decision drops. */
  expect(again.triangles).toBe(4);
});

test('a capture nobody has decided anything about still saves its geometry', () => {
  /*
   * **What was decided is not the same as what was captured.** A file written before anybody got
   * to the proposals must still carry the surface, or a person who opened a capture, looked at it
   * and saved it has thrown away the hour that produced it.
   */
  const opened = openCapture(captured());
  const again = openCapture(saveCapture(opened, new Map()));
  expect(again.triangles).toBe(4);
  expect(again.proposals.length).toBe(0);
});

test('a file with no proposals in it opens as a surface and nothing else', () => {
  const opened = openCapture(captureFile({ mesh: room() }));
  expect(opened.proposals.length).toBe(0);
  expect(opened.entities.length).toBe(1);
  expect(captureSceneModel(opened).ids).toEqual([SURFACE_ENTITY]);
});

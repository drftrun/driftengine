import { mat4 } from 'gl-matrix';
import { expect, test } from 'vitest';

import { boundsOfPositions, createBounds } from '../math/bounds.ts';
import { createFrustum, frustumFromViewProjection } from '../math/frustum.ts';
import { SceneNode } from './node.ts';
import { createVisitResult, visitVisible } from './visit.ts';

const unitSphere = boundsOfPositions(
  new Float32Array([1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1]),
  createBounds(),
);

/** A camera at the origin looking down -Z. */
function ahead() {
  const projection = mat4.perspective(mat4.create(), Math.PI / 2, 1, 1, 500);
  const view = mat4.lookAt(mat4.create(), [0, 0, 0], [0, 0, -1], [0, 1, 0]);
  return frustumFromViewProjection(
    mat4.multiply(mat4.create(), projection, view) as Float32Array,
    createFrustum(),
  );
}

/**
 * The claim the whole hierarchy is for, as one assertion.
 *
 * A hundred leaves behind the camera cost one test, not a hundred: their parent's sphere encloses
 * all of them, so rejecting it rejects them. Without the union in `SceneNode.worldBounds` this
 * walk would have to visit every one to find out.
 */
test('a subtree outside the frustum is skipped whole', () => {
  const root = new SceneNode();
  const behind = new SceneNode();
  behind.setPosition(0, 0, 400);
  for (let i = 0; i < 100; i += 1) {
    const leaf = new SceneNode();
    leaf.setBounds(unitSphere);
    leaf.setPosition(i * 0.1, 0, 0);
    behind.attachChild(leaf);
  }
  root.attachChild(behind);
  root.updateWorld();

  const seen: SceneNode[] = [];
  const result = visitVisible(root, ahead(), (node) => seen.push(node), createVisitResult());

  expect(seen.length, 'a hundred leaves behind the camera, visited none').toBe(0);
  expect(result.pruned, 'and discarded as one subtree').toBe(1);
  /*
   * **One test for a hundred and two nodes.** The root's own bounds are the union of everything
   * beneath it, so a world entirely behind the camera is rejected at the root and nothing under
   * it is reached at all. Written expecting two — the root, then the group — which is what a
   * hierarchy whose parents did not enclose their children would produce.
   */
  expect(result.tested).toBe(1);
});

test('a visible leaf inside a visible parent is visited', () => {
  const root = new SceneNode();
  const leaf = new SceneNode();
  leaf.setBounds(unitSphere);
  leaf.setPosition(0, 0, -10);
  root.attachChild(leaf);
  root.updateWorld();

  const seen: SceneNode[] = [];
  const result = visitVisible(root, ahead(), (node) => seen.push(node), createVisitResult());
  expect(seen).toEqual([leaf]);
  expect(result.pruned).toBe(0);
});

/** A group is scaffolding; handing one over gives a caller something with nothing to draw. */
test('a node with no geometry is not visited, but its children are', () => {
  const root = new SceneNode();
  const group = new SceneNode();
  const leaf = new SceneNode();
  leaf.setBounds(unitSphere);
  leaf.setPosition(0, 0, -10);
  group.attachChild(leaf);
  root.attachChild(group);
  root.updateWorld();

  const seen: SceneNode[] = [];
  visitVisible(root, ahead(), (node) => seen.push(node), createVisitResult());
  expect(seen, 'the leaf, and neither the root nor the group').toEqual([leaf]);
});

test('half a world in front and half behind visits half and prunes the rest', () => {
  const root = new SceneNode();
  const front = new SceneNode();
  const back = new SceneNode();
  front.setPosition(0, 0, -20);
  back.setPosition(0, 0, 400);
  for (let i = 0; i < 10; i += 1) {
    const a = new SceneNode();
    a.setBounds(unitSphere);
    a.setPosition(i * 0.5, 0, 0);
    front.attachChild(a);
    const b = new SceneNode();
    b.setBounds(unitSphere);
    b.setPosition(i * 0.5, 0, 0);
    back.attachChild(b);
  }
  root.attachChild(front);
  root.attachChild(back);
  root.updateWorld();

  const result = visitVisible(root, ahead(), () => {}, createVisitResult());
  expect(result.visited, 'the ten in front').toBe(10);
  expect(result.pruned, 'the group behind, rejected once').toBe(1);
});

/** A visitor is called for a node, so a caller can read the world matrix it was placed by. */
test('the visitor is handed the node, world matrix and all', () => {
  const root = new SceneNode();
  const leaf = new SceneNode();
  leaf.setBounds(unitSphere);
  leaf.setPosition(2, 0, -10);
  root.attachChild(leaf);
  root.updateWorld();

  let placedAt = 0;
  visitVisible(
    root,
    ahead(),
    (node) => {
      placedAt = node.worldMatrix[12] ?? 0;
    },
    createVisitResult(),
  );
  expect(placedAt).toBeCloseTo(2, 5);
});

test('a result object is refilled rather than replaced', () => {
  const root = new SceneNode();
  root.updateWorld();
  const out = createVisitResult();
  out.visited = 99;
  expect(visitVisible(root, ahead(), () => {}, out)).toBe(out);
  expect(out.visited, 'last run left behind nothing').toBe(0);
});

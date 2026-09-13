import { expect, test } from 'vitest';

import { boundsOfPositions, createBounds } from '../math/bounds.ts';
import { SceneNode } from './node.ts';

/** The translation column of a column-major 4x4. */
const translationOf = (m: Float32Array): number[] => Array.from(m.subarray(12, 15));

test('a node with no parent has its local transform as its world one', () => {
  const node = new SceneNode();
  node.setPosition(1, 2, 3);
  node.updateWorld();
  expect(translationOf(node.worldMatrix)).toEqual([1, 2, 3]);
});

test('a child is placed by its parent', () => {
  const parent = new SceneNode();
  const child = new SceneNode();
  parent.attachChild(child);
  parent.setPosition(10, 0, 0);
  child.setPosition(1, 0, 0);
  parent.updateWorld();
  expect(translationOf(child.worldMatrix)).toEqual([11, 0, 0]);
});

test("a parent's scale reaches its child's position", () => {
  const parent = new SceneNode();
  const child = new SceneNode();
  parent.attachChild(child);
  parent.setScale(2, 2, 2);
  child.setPosition(3, 0, 0);
  parent.updateWorld();
  expect(translationOf(child.worldMatrix)).toEqual([6, 0, 0]);
});

test("a parent's rotation carries its child around", () => {
  const parent = new SceneNode();
  const child = new SceneNode();
  parent.attachChild(child);
  /* A quarter turn about Y takes +X to -Z. */
  parent.setRotationAxisAngle(0, 1, 0, Math.PI / 2);
  child.setPosition(1, 0, 0);
  parent.updateWorld();

  const [x, y, z] = translationOf(child.worldMatrix);
  expect(x ?? 0).toBeCloseTo(0, 5);
  expect(y ?? 0).toBeCloseTo(0, 5);
  expect(z ?? 0).toBeCloseTo(-1, 5);
});

/**
 * The whole reason this is a class rather than a matrix multiply at the call site.
 *
 * A hierarchy that recomputes every world matrix every frame is slower than the callers it
 * replaces, which already keep matrices they touch only when something moves.
 */
test('a clean subtree is not recomputed', () => {
  const parent = new SceneNode();
  const child = new SceneNode();
  parent.attachChild(child);
  parent.updateWorld();

  const before = child.worldRevision;
  parent.updateWorld();
  expect(child.worldRevision, 'nothing moved, so nothing was recomputed').toBe(before);

  parent.setPosition(1, 0, 0);
  parent.updateWorld();
  expect(child.worldRevision, 'the parent moved, so the child moved with it').not.toBe(before);
});

test('a sibling of a moved node is left alone', () => {
  const parent = new SceneNode();
  const moved = new SceneNode();
  const still = new SceneNode();
  parent.attachChild(moved);
  parent.attachChild(still);
  parent.updateWorld();

  const before = still.worldRevision;
  moved.setPosition(1, 0, 0);
  parent.updateWorld();
  expect(still.worldRevision, 'its sibling moved, not it').toBe(before);
});

test('a detached child stops being placed by its old parent', () => {
  const parent = new SceneNode();
  const child = new SceneNode();
  parent.attachChild(child);
  parent.setPosition(10, 0, 0);
  parent.updateWorld();
  expect(translationOf(child.worldMatrix)).toEqual([10, 0, 0]);

  parent.detachChild(child);
  child.updateWorld();
  expect(
    translationOf(child.worldMatrix),
    'on its own it is where its own transform puts it',
  ).toEqual([0, 0, 0]);
});

test('attaching a child twice does not place it twice', () => {
  const parent = new SceneNode();
  const child = new SceneNode();
  parent.attachChild(child);
  parent.attachChild(child);
  expect(parent.children.length).toBe(1);
});

test('attaching a child that has a parent moves it rather than sharing it', () => {
  const first = new SceneNode();
  const second = new SceneNode();
  const child = new SceneNode();
  first.attachChild(child);
  second.attachChild(child);

  expect(first.children.length, 'gone from the first').toBe(0);
  expect(second.children.length, 'and under the second').toBe(1);
  expect(child.parent).toBe(second);
});

/**
 * A node cannot become its own ancestor.
 *
 * Discovering it while walking is a hang rather than an error, and a hang inside a frame loop is
 * the one failure mode `AGENTS.md` says never to ship: the tab stops, with no stack to read.
 */
test('a cycle is refused rather than discovered while walking', () => {
  const parent = new SceneNode();
  const child = new SceneNode();
  parent.attachChild(child);
  expect(() => child.attachChild(parent)).toThrow(/cycle/i);
});

test('a node cannot be attached to itself', () => {
  const node = new SceneNode();
  expect(() => node.attachChild(node)).toThrow(/cycle/i);
});

/**
 * Updating a branch after moving something above it must not use the stale placement.
 *
 * The first version composed against whatever the parent's world matrix currently held, which
 * for a parent that had moved and not been updated is the *previous* frame's — so the branch
 * landed somewhere plausible and wrong, with no error anywhere.
 */
test('updating from a child brings its ancestors up to date first', () => {
  const parent = new SceneNode();
  const child = new SceneNode();
  parent.attachChild(child);
  parent.setPosition(10, 0, 0);
  child.updateWorld();
  expect(translationOf(child.worldMatrix), 'placed by where its parent now is').toEqual([10, 0, 0]);
});

test('updating from a child leaves a sibling subtree alone', () => {
  const parent = new SceneNode();
  const asked = new SceneNode();
  const other = new SceneNode();
  parent.attachChild(asked);
  parent.attachChild(other);
  parent.updateWorld();

  const before = other.worldRevision;
  parent.setPosition(5, 0, 0);
  asked.updateWorld();
  expect(other.worldRevision, 'nobody asked about it').toBe(before);

  parent.updateWorld();
  expect(other.worldRevision, 'and asking at the root does reach it').not.toBe(before);
});

/** Geometry whose vertices all sit one unit from its own centre. */
const unitSphere = boundsOfPositions(
  new Float32Array([1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1]),
  createBounds(),
);

/**
 * A parent's sphere encloses its children, which is what makes the traversal a partition.
 *
 * A parent covering only its own geometry answers for nothing, and a walk has to visit every node
 * to find out what is visible — the linear scan the hierarchy was supposed to replace.
 */
test('a parent encloses its children', () => {
  const parent = new SceneNode();
  parent.setBounds(unitSphere);
  const child = new SceneNode();
  child.setBounds(unitSphere);
  child.setPosition(10, 0, 0);
  parent.attachChild(child);
  parent.updateWorld();

  expect(
    parent.worldBounds.radius,
    'from its own geometry out to the far side of a child ten away',
  ).toBeGreaterThanOrEqual(5.5);
  /* And it really contains both: every point of each sphere is within the parent's. */
  const c = parent.worldBounds.centre;
  const reaches = (x: number, r: number): boolean =>
    Math.abs(x - (c[0] ?? 0)) + r <= parent.worldBounds.radius + 1e-4;
  expect(reaches(0, 1), 'its own geometry').toBe(true);
  expect(reaches(10, 1), 'and the child').toBe(true);
});

test('a node with no geometry still encloses its children', () => {
  const group = new SceneNode();
  const child = new SceneNode();
  child.setBounds(unitSphere);
  child.setPosition(5, 0, 0);
  group.attachChild(child);
  group.updateWorld();

  expect(group.worldBounds.radius, 'a group is as big as what is in it').toBeCloseTo(1, 4);
  expect(group.worldBounds.centre[0] ?? 0, 'and sits where that is').toBeCloseTo(5, 4);
});

test('an empty node is a point rather than everywhere', () => {
  const node = new SceneNode();
  node.updateWorld();
  expect(node.worldBounds.radius).toBe(0);
});

/**
 * A child moving is noticed even though its parent did not move.
 *
 * The parent has geometry of its own here on purpose: a group with a single child *is* that
 * child's sphere wherever it goes, so a version of this test without it asserts nothing. What is
 * under test is that the union runs at all when only a descendant is dirty.
 */
test("a child moving grows its parent's bounds", () => {
  const parent = new SceneNode();
  parent.setBounds(unitSphere);
  const child = new SceneNode();
  child.setBounds(unitSphere);
  parent.attachChild(child);
  parent.updateWorld();
  const near = parent.worldBounds.radius;
  expect(near, 'both spheres are at the origin, so the union is one of them').toBeCloseTo(1, 4);

  child.setPosition(50, 0, 0);
  parent.updateWorld();
  expect(
    parent.worldBounds.radius,
    'the parent did not move and still has to cover a child fifty away',
  ).toBeCloseTo(26, 4);
});

test("a node's scale reaches its world radius", () => {
  const node = new SceneNode();
  node.setBounds(unitSphere);
  node.setScale(7, 7, 7);
  node.updateWorld();
  expect(node.worldBounds.radius).toBeCloseTo(7, 4);
});

/** Two children the same distance either side leave the parent centred between them. */
test('a parent sits between its children rather than on one of them', () => {
  const parent = new SceneNode();
  const left = new SceneNode();
  const right = new SceneNode();
  left.setBounds(unitSphere);
  right.setBounds(unitSphere);
  left.setPosition(-10, 0, 0);
  right.setPosition(10, 0, 0);
  parent.attachChild(left);
  parent.attachChild(right);
  parent.updateWorld();

  expect(parent.worldBounds.centre[0] ?? 0).toBeCloseTo(0, 4);
  expect(parent.worldBounds.radius).toBeCloseTo(11, 4);
});

/** A sphere already inside another must not grow it. */
test('a child well inside its parent does not grow it', () => {
  const parent = new SceneNode();
  parent.setBounds(unitSphere);
  parent.setScale(100, 100, 100);
  const child = new SceneNode();
  child.setBounds(unitSphere);
  parent.attachChild(child);
  parent.updateWorld();

  expect(parent.worldBounds.radius).toBeCloseTo(100, 4);
});

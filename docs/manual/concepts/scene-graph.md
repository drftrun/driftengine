---
title: The scene graph
description: Nodes, parents and world matrices, bounds that enclose a whole subtree, culling by frustum and by occluder, and levels of detail chosen by apparent size.
packages: ['@driftengine/core']
areas: ['scene']
---

# The scene graph

A `SceneNode` holds a position, a rotation and a scale, and works out a world matrix from them and
from its parent's. That's all the scene graph is: the engine has no scene object that owns your
meshes. You keep nodes where you like, give each mesh draw a node's `worldMatrix`, and use the
hierarchy where it helps, for things that move together and for culling whole groups at once.

## Nodes and parents

```ts sample=snippets/scene.ts#hierarchy
/** A tower of blocks under one root: move the root and every block moves with it. */
export function buildTower(renderer: RendererApi): { root: SceneNode; block: MeshHandle } {
  const block = renderer.createMesh(
    new MeshBuilder().addBox([0, 0, 0], [0.5, 0.5, 0.5], [0.7, 0.7, 0.75]).build(),
  );
  const root = new SceneNode();
  for (let level = 0; level < 10; level += 1) {
    const node = new SceneNode();
    node.setPosition(0, level + 0.5, 0);
    // The mesh's bounds were measured when it was uploaded; the node only says it holds them.
    node.setBounds(block.bounds);
    root.attachChild(node);
  }
  root.setPosition(4, 0, -6);
  root.updateWorld();
  return { root, block };
}
```

`attachChild` puts a node under another, taking it from wherever it was before; a cycle is refused
when you make it, not discovered later as a stack overflow inside a frame. `updateWorld` brings a
node and everything under it up to date, and only recomputes what moved: a node whose own transform
and whose ancestors are unchanged keeps its matrix.

`setPosition`, `setScale` and `setRotationAxisAngle` mark the node as moved. `position`, `rotation`
and `scale` are also plain typed arrays you may write in place, which is the allocation-free path for
animation. When you do, call `markMoved`, because the node cannot see the write.

Rotation is a quaternion, so two rotations interpolate cleanly, which Euler angles do not.

## Bounds

A node's `worldBounds` is a sphere that encloses its own geometry **and every descendant's**. That
union is what makes the hierarchy useful for culling: a parent whose sphere is out of view answers
for everything beneath it in one test.

A node learns its own geometry's size from `setBounds`. The renderer measures every mesh when you
upload it, so `mesh.bounds` is ready to hand over. A node with no geometry only groups others.

## Culling by frustum

```ts sample=snippets/scene.ts#visit
const frustum = createFrustum();
const counts = createVisitResult();

/** Draw only what the camera can see. A rejected parent rejects its whole subtree in one test. */
export function drawVisible(
  renderer: RendererApi,
  camera: Camera,
  env: Environment,
  root: SceneNode,
  block: MeshHandle,
): void {
  frustumFromViewProjection(camera.viewProjection, frustum);
  renderer.bindMeshPass(camera, env);
  visitVisible(root, frustum, (node) => renderer.drawMesh(block, node.worldMatrix), counts);
  // counts.visited, counts.pruned and counts.tested say what the walk saved.
}
```

`frustumFromViewProjection` reads the six planes of the camera's view. `visitVisible` walks the
hierarchy, skipping any subtree the frustum rejects, and hands you each visible node with geometry.
It doesn't draw, so the order things are drawn in stays yours. The counts it fills say what the walk
saved: nodes visited, subtrees pruned, and how many tests that took.

Separately, the renderer can skip any single `drawMesh` whose bounds are outside the view. That is
the `cullDraws` quality option. It costs a sphere test per draw and needs nothing from you.

For instanced batches, `cullInstances` keeps only the instances whose spheres meet a frustum,
compacted in place. [Instancing](../rendering/instancing.md) covers batches that cull themselves.

## Levels of detail

```ts sample=snippets/scene.ts#lod
/** Apparent sizes, in radians, at which each level stops being good enough. */
const THRESHOLDS = [0.2, 0.06, 0.015];

/** The finest level a thing has earned, from how big it looks, not how far away it is. */
export function levelFor(node: SceneNode, camera: Camera): number {
  const eye = camera.position;
  return lodForBounds(node.worldBounds, node.worldMatrix, eye[0], eye[1], eye[2], THRESHOLDS);
}
```

`lodForBounds` picks a level from how large an object looks from the eye, as an angle, never from
its distance. A distance threshold makes a cathedral and a doorknob change detail at the same range,
so one of them always looks wrong; apparent size gets both right with one set of thresholds. The
thresholds are in descending order, and the function returns the first level the object is still
large enough for.

For whole regions of a large world, [hierarchical detail](../worlds/hierarchical-detail.md) picks
each region's level from its error on screen and crossfades between levels for you.

## Culling by occluder

The renderer can also hide what is behind something large. You declare the occluders, the few big
things a scene is really hidden by, such as walls, buildings and slabs of ground, and the renderer
rasterises them into a small depth buffer on the CPU and tests each object against it.

```ts sample=snippets/scene.ts#occlusion
const WALL_MIN = [-6, 0, -0.5];
const WALL_MAX = [6, 8, 0.5];
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * Hide what a wall hides. Needs `occlusionCulling` set in the quality profile, the width of the
 * occlusion buffer in texels; without it `addOccluder` does nothing and `occluded` answers false.
 */
export function drawBehindWall(
  renderer: RendererApi,
  camera: Camera,
  env: Environment,
  wall: MeshHandle,
  crates: readonly SceneNode[],
  crate: MeshHandle,
): void {
  renderer.bindMeshPass(camera, env);
  // After binding the pass and before the first draw: the first test freezes the buffer.
  renderer.addOccluder(WALL_MIN, WALL_MAX, IDENTITY);
  renderer.drawMesh(wall, IDENTITY);
  for (const node of crates) {
    if (!renderer.occluded(crate.bounds, node.worldMatrix))
      renderer.drawMesh(crate, node.worldMatrix);
  }
}
```

The buffer is sized by the `occlusionCulling` quality option, its width in texels; 256 is a good
start. With the option off, `addOccluder` does nothing and `occluded` answers false, so the same code
runs either way.

Everything in it errs toward drawing. It holds the depth of an occluder's far side, shrinks its
coverage by a texel at every edge, and hides an object only when every texel the object touches is
nearer. A wrong cull is a hole in the world, so it is never traded for a faster frame.

Declare the box you may be hidden _by_, never a larger one: an occluder bigger than its solid hides
things a player can see. And small things never occlude: a crowd does not hide what is behind it.
That is the trade the design makes for running on both backends, with no frame of latency and no
GPU read-back.

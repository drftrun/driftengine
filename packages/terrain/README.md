# @driftengine/terrain

A heightfield, the geometry it draws, and the same answer to both.

**Cost: 1.4 KB gzipped on top of core.** Measured by `scripts/size-gate.test.mjs`, which fails if it
drifts more than 3% — the number is derived from the same floors that gate asserts, so a README
quoting a stale one is a red suite rather than a thing somebody notices.

## What it is

```ts
import { Terrain, heightfieldPatch } from '@driftengine/terrain';

const terrain = new Terrain({
  width: 257,
  depth: 257,
  spacingM: 2,
  heights, // 257 * 257 metres, row-major, x fastest
  origin: [-256, 0, -256],
});

const near = renderer.createMesh(heightfieldPatch(terrain, { x: 0, z: 0, cells: 32 }));
const far = renderer.createMesh(
  heightfieldPatch(terrain, { x: 32, z: 0, cells: 32, step: 4, neighbours: { minusX: 1 } }),
);
```

**It imports no renderer.** What comes back is `MeshData`, which goes to `createMesh` like any other
geometry, so terrain is drawn by the pass that already exists. That is why this is a package rather
than a part of core: a world with no terrain pays nothing, and a world with terrain pays for
arithmetic.

## The query answers the surface that is drawn

`terrain.heightAt(x, z)` reads the **triangle** the point falls in, not a bilinear patch through the
four samples around it. Those are different surfaces — they agree only at the corners and along the
diagonal they share — and the bilinear one is the obvious thing to write.

Writing it puts a character above the ground over half of every cell and below it over the other
half, by up to a quarter of that cell's height range, everywhere, for ever. There is no screenshot
that shows it and no test that fails. So the query reads the triangulation, `heightfieldPatch` emits
that same triangulation, and a test asserts every vertex of a patch against the query.

`terrain.normalAt(x, z, out)` is the other way round on purpose: a central difference over the
samples, so it is continuous across every cell boundary. A face normal jumps at every edge, which
makes terrain faceted and — worse — makes two patches shade differently along the edge they share,
which reads as a crack in geometry that has none. A caller who wants the plane a wheel rests on
takes three `heightAt` samples; a caller orienting a character takes this.

## The seam between two levels of detail is matched, not hidden

A heightfield drawn at one resolution is either too coarse underfoot or too fine at the horizon, so
it is drawn in patches and the distant ones skip samples with `step`. Where a patch that skips none
meets one that skips every other, the fine edge has vertices the coarse edge does not — and those
sit on the field while the coarse edge cuts the chord beneath them. **The gap is a crack, and a
crack in terrain is a hole through to the sky.**

The usual remedy is a skirt: a vertical curtain dropped from every patch edge, which fills the hole
with something the wrong colour, lit the wrong way, and costs geometry along every boundary in the
world for ever.

`neighbours` does it exactly instead. Name the step of any neighbour that is **coarser** than this
patch, and the fine edge's odd vertices move onto the coarse edge's own straight segment, so the two
edges are one polyline and there is nothing to fill:

```ts
heightfieldPatch(terrain, { x: 32, z: 0, cells: 32, step: 1, neighbours: { plusX: 4 } });
```

Only the coarser side needs naming — the finer patch is the one that moves — so a caller passes what
it knows and leaves the rest out.

**What it costs, stated because it is real:** along a matched edge the drawn surface is the coarse
chord rather than the field, so `heightAt` and the picture differ there by up to the sag of one
coarse cell. That is the same error the coarse patch carries over its whole area, arriving one cell
early.

## Several materials across one field

```ts
const materials = new TerrainMaterials({
  materials: [{ color: [0.3, 0.5, 0.2] }, { color: [0.5, 0.5, 0.5], specular: 0.3 }],
  width: 64,
  depth: 64,
  weights, // 64 * 64 * 2, row-major, material fastest
});

heightfieldPatch(terrain, { x: 0, z: 0, cells: 32, materials });
```

**A weight map baked into vertex colour, and that is the idiomatic answer here rather than a
compromise.** This engine's colour _is_ vertex data — it is what makes the world one flat-shaded
draw call. A splat map read by a shader would mean a texture bound on every terrain draw and a
branch in `flatFrag`, which Track D measured at 19.8 KB gzipped for a capability generated into
sixteen fragment permutations. This costs nothing at runtime: the blend happens once, where the
patch is built.

**What that gives up**: the blend is only as sharp as the mesh. A material boundary inside a cell is
drawn as a gradient across it, and a patch at a quarter detail blends four times as coarsely. A
consumer who wants a sharp line — a road edge, a cliff base — draws that patch at full detail, which
is the same dial the geometry already uses.

**The weights are read bilinearly, which is the opposite of how a height is read**, and both
decisions are written down because the contrast is the point. A height is read as the _triangle_
because the surface is drawn as triangles and the query has to agree with the picture. A weight is
not drawn at all: it decides a vertex colour, and the vertex is wherever the mesh put it. Reading a
weight map as triangles would put a visible crease along every cell diagonal for nothing.

Weights are normalised and a sample that weighs nothing falls back to the first material, because an
unpainted corner of a map should not be a black patch.

## It collides, through the mesh the picture is made of

```ts
import { meshShape, BODY_STATIC } from '@driftengine/physics';

const patch = heightfieldPatch(terrain, { x: 0, z: 0, cells: 32 });
world.addBody({ type: BODY_STATIC, shape: meshShape(patch.positions, patch.indices) });
```

There is no terrain-shaped collider and none is needed for terrain to collide: `meshShape` takes
exactly the two arrays a patch hands back, so **the geometry you draw is the geometry you collide
with**, with nothing authored twice. `terrainCollision.test.ts` asserts the three surfaces are one:
a ray cast against that body lands where `heightAt` says the ground is, at forty points off the
lattice.

That test is also what found a real defect in the first version of this package — the mesh was split
along one diagonal while the query read the other, which every per-vertex assertion passed because a
vertex lies on both.

**A patch drawn coarse collides coarse**, which is the right answer: colliding against the field
while drawing a chord would let a character walk through ground they can see.

## From a script

`drift/terrain` is bound: `heightAt`, `normalX`/`normalY`/`normalZ`, `slopeAt`, `covers`,
`extentX` and `extentZ`, all deterministic reads, so a `@deterministic` system may ask where the
ground is. The field reaches a script through `uses`, the way a `NavGraph` does.

## Or as a heightfield, carrying no triangles at all

```ts
import { heightfieldShape, BODY_STATIC } from '@driftengine/physics';

world.addBody({ type: BODY_STATIC, shape: heightfieldShape(terrain) });
```

**A `Terrain` _is_ a `Heightfield`** — same names, same meanings — so this type-checks with no
import in either direction. That is the boundary doing its work rather than being worked around:
`@driftengine/physics` imports no other engine package, and a shape is not a dependency.

The collider indexes the cell under a body straight from its x and z and holds the heights it was
handed: no vertex buffer, no index buffer, no tree. At a 129-square field a mesh collider's
positions and indices alone are **more than five times** the bytes of the heights, before the tree
over them is counted.

**It is not a second narrow phase.** `meshContact.ts` still owns every contact rule — many
manifolds rather than one, one-sided triangles, the interior-edge filter that stops a box stumbling
on a flat seam — and a field only changes _where triangles come from_. The proof is differential:
both colliders over one field, a box walked across it, and identical normals, counts and
separations at every pose.

**Which to use.** The mesh path when the collider must be the patch you drew, chords and all — a
coarse patch collides coarse, and a character then walks on what they can see. The heightfield path
when the field is the truth and the patches are only how it is drawn, which is the usual case for a
large world, and the only one of the two whose cost does not grow with the triangles.

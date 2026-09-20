# @driftengine/editor

The model of a scene editor: what exists, what is selected, and what play mode does to a world.

**Cost: 10.4 KB gzipped standalone.** Measured by `scripts/size-gate.test.mjs`, which fails if it
drifts more than 3% — the number comes from the same floors that gate asserts, so a README quoting a
stale one is a red suite rather than a thing somebody notices.

**Standalone rather than "over core", and that is a measurement.** `Gizmo` is the only value this
package imports from core; everything else is a type. A bundle of it is 31.8 KB raw against core's
2.79 MB, and `createRenderer`, `WebGL2RenderingContext` and every shader string are absent from the
output. A game that opens an editor pays about ten kilobytes for it; a game that never does pays
nothing.

## What it is not

**It is not a panel and it draws nothing.** Nothing here writes to the document or issues a draw
call. `buildTreePanel` and `buildInspectorPanel` produce `@driftengine/ui2d` nodes, which the
consumer lays out, routes and draws — the same shape `DebugLines` has against `drawLines`, one level
up. How a row looks is a decision about a consumer's palette rather than about an editor.

**It is not a second scene graph.** The hierarchy is `SceneNode`'s and the components are
`@driftengine/entities`'. This holds a _view_ of them.

**It is not an undo system.** `play()` and `stop()` are one coarse step: a snapshot and a restore. A
command history is a real feature and is not this one.

## The tree

```ts
import { SceneTree, buildTreePanel, rowIndexOf, TREE_ROW_PREFIX } from '@driftengine/editor';

const tree = new SceneTree();
tree.setName(lampNode, 'lamp');
tree.rebuild(sceneRoot); // flattens, honouring collapse; allocates nothing after warmup

for (const row of tree.rows) {
  // row.node, row.depth, row.hasChildren, row.expanded, row.name
}
```

**The names live here and not on `SceneNode`.** A string on every node would be paid by every game,
in every serialised scene and every node allocation, to serve an editor most of them never open. A
map in the tree is paid by whoever builds one.

**Reparenting answers rather than throws.** `SceneNode.attachChild` already refuses a self-parent and
any ancestor; `tree.reparent(child, parent)` returns `false` where it would, because the caller is a
drag inside a frame and an exception there takes down the frame somebody is dragging in.

## The inspector

```ts
import { Inspector } from '@driftengine/editor';

const inspector = new Inspector();
inspector.showEntity(world, entity, [Health, Mood]);

for (const field of inspector.fields) {
  // field.group, field.label, field.type, field.kind, field.enumName, field.optional, field.value
}
inspector.set(0, 55); // false where the value is the wrong shape
inspector.refresh(); // re-read the values, keep the list
```

**It is reflection and nothing else.** A component already describes itself —
`ComponentType.schema.fields` is `{ id, name, type }`, and `World.read`/`World.write` take a field by
name — so this is a walk of that schema. There is no registry, no decorator and no code per
component, which is what makes it work for a component a `.drs` file declared and this package has
never heard of.

**The kind comes from the declared type, because a read cannot answer it.** `bool` arrives as 0 or 1,
an enum discriminant as an integer, an `Entity` as a number: every one of them is a number by the
time it reaches you, and only the declaration says whether to draw a checkbox, a stepper or a menu.
An option is spelled `option:f32` — a prefix, not a `?` suffix, because a field type is a key a
migration compares for equality.

**The value is what the store holds.** A boolean field reads back as 0 or 1, not as `false`;
converting it here would make `field.value` disagree with `world.read` for one type out of thirteen,
which is a worse surprise than the number. `formatValue` shows it as a word.

**A node's transform is written through the setters.** Writing `node.position` directly leaves
`worldMatrix` describing where the node once was, with no error and a plausible matrix.

## Play-in-editor

```ts
import { EditorHost } from '@driftengine/editor';

const host = new EditorHost({ world, types: [Health, Mood] });
startLoop({ simulate, render, shouldSimulate: host.shouldSimulate });

host.play(); // snapshots first
host.pause();
host.step(); // exactly one tick, then paused
host.stop(); // clears, restores, and re-finds the selection
```

**The loop already had the seam.** `LoopHooks.shouldSimulate` exists so a paused game keeps rendering
— the world stays on screen behind the menu instead of freezing — and that is exactly what an editor
wants.

**`stop()` clears before it loads, and this is the part that is easy to get wrong.**
`deserializeWorld` _creates_ entities; it does not replace a world's contents. A stop that only loads
leaves the world holding both what was authored and what play produced, and the duplication grows
every time somebody presses stop.

**Every entity handle changes across a stop**, because the restored entities are new ones. A
selection held as a handle is stale the moment play ends — pointing at nothing, or at whatever reused
the slot, which is worse because it looks like it worked. So a selection is remembered by its index
in the snapshot, the only identity that survives, and an entity that play _created_ has no index and
the selection is emptied rather than moved to a stranger.

**A snapshot covers the component types it was given and nothing else** — not the node hierarchy, not
a physics world, not an audio graph. `serializeWorld` makes the same point: a scene is a decision
about what to save.

## Wiring a pointer to a row

```ts
import { rowIndexOf, TREE_ROW_PREFIX } from '@driftengine/editor';

const activated = routeUiPointer(input, panel, x, y, down);
const at = rowIndexOf(activated, TREE_ROW_PREFIX);
if (at >= 0) host.select(tree.rows[at].node);
```

Every row carries a name of `row:<index>` or `field:<index>`, so the node the router hands back
parses straight to the row — one parse rather than a node-to-row map that has to be kept in step.

## DriftScript

`drift/editor` is bound, under the `editor` effect, which is outside `DETERMINISTIC_EFFECTS`: a gizmo
and a selection hold a person's pointer part way through moving something, so a `@deterministic`
system reading one would replay differently. It is the effect `@editor` was designed to pair with.

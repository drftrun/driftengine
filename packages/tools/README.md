# `@driftengine/tools`

The editor's panels, as something a shipped game can carry: an inspector, a console, a profiler and
a network panel, with the command stack that makes their edits undoable, and the overlay that puts
them on screen on a key.

**5,391 bytes gzipped**, measured by `scripts/size-gate.test.mjs` against
`scripts/fixtures/size/tools-only.ts`. Optional — nothing in `@driftengine/core` imports it, so a
game that never asks for these pays nothing.

## Why four panels and not seven

The editor has seven. Three of them stayed behind, and the line between them is what a panel needs
rather than what it shows.

A **scene tree** and an **asset browser** need a project: a hierarchy somebody is authoring and a
directory of source files. A shipped game has neither — its scene is whatever was baked and its
assets are inside a `.drft` container. A **graph editor** is the same, one level further out.

An **inspector**, a **console**, a **profiler** and a **network panel** need only the running world.
That is exactly the situation a tester is in on somebody else's machine, or a developer is in on a
console devkit where no debugger will attach, or anyone is in when the bug happens in a build. This
package is the four that work there.

## The panels mutate through commands, so an in-game edit is undoable

`Panel.route` returns a `Command` or nothing. It is a signature rather than a convention: a panel is
handed the world `Readonly` and given no other way to change it, so "everything goes through the
undo stack" has no worst offender. A game carrying these panels carries that rule, and gets undo for
nothing extra.

```ts
import { createUndoStack, inspectorPanel, createInspectorView } from '@driftengine/tools';

const undo = createUndoStack(200);
const view = createInspectorView({});
const command = inspectorPanel.route(world, view, event);
if (command !== null) undo.push(command);
```

## The overlay, because a panel that nothing mounts is a tree nobody sees

Every panel above builds a `UiNode` tree and stops there. For 4.0.0 the half that turns a tree into
something a person can look at — geometry, event routing, painting — lived only in the editor
application, which is private and ships to nobody, so a game wanting an in-game inspector had to
write it again. `createToolsOverlay` is that half.

A **column rather than a dock**: nobody arranges a debug overlay, they press a key, read a number
and press it again, so the panels stack down one edge in the order they are given.

The **painter is supplied**. Four calls — a rectangle, a line of text, a clip and its close — which
is every operation the overlay makes. A host with a 2D context writes four lines; a host drawing
through `@driftengine/ui2d` writes them over a sprite batch; a host with no screen writes them into
an array, which is what this package's own tests do. Nothing here needs a graphics device, which is
what makes the whole of it assertable.

```ts
import { bindPanel, createToolsOverlay, paintOverlay, profilerPanel } from '@driftengine/tools';

const overlay = createToolsOverlay({
  panels: [bindPanel(profilerPanel, () => profilerWorld, profilerView)],
  key: 'F3',
});

// once, and whenever the surface changes size
overlay.resize(canvas.width, canvas.height);

// every frame, after the scene
overlay.invalidate();
overlay.frame(now);
paintOverlay(painter, overlay);

// wherever input arrives; true means the overlay took it and the game should not
if (overlay.route(keyEvent(event.key, event.shiftKey, event.ctrlKey))) event.preventDefault();
```

While it is closed `frame` returns before it builds anything and `route` refuses every event but the
one that opens it, so a game that never presses the key pays for a boolean.

## Two adapters, because every consumer was about to write the same ones

A panel needs its world in the shape the panel reads. Two of those shapes are the same in every
game that has the thing behind them, so they are here rather than in each of them.

`entitiesInspectable(world, types)` turns an entity world into an `InspectableWorld`: the inspector
addresses a component by name because that is what a row carries, and a world addresses it by the
type object because that is what indexes its stores. A name with no type behind it does nothing
rather than guessing, so a row built from a stale schema cannot write a field into a component the
world does not have and report success.

`createSessionRecorder` plus `observeSession` and `sessionReadout` turn a lockstep session into a
`NetworkReadout`. The watching is the part worth having written once: `session.desync` is **latched
rather than an event**, so it keeps answering with the same disagreement every frame until the next
one arrives, and a recorder that appended what it read would turn one divergence into sixty a
second. `snapshotBytes` is the caller's, because `RewindLoop` is generic over the state it
snapshots and cannot know the size of one.

**Both are typed structurally**, the way `@driftengine/drft` takes DTEX types that
`@driftengine/texture` satisfies, so this package depends on nothing new and anything shaped right
can be read — including a consumer whose state is not an entity world at all.

## Building it in or leaving it out

Import it and it is in the bundle; do not and it is not. There is no flag, because a flag would be a
second mechanism doing what a module graph already does — and the size gate is what says so: the
floors for every other package are unchanged by this one existing.

A game that wants the tools in a development build and not in a shipping one imports them behind the
bundler's own dead-code elimination, the same way it would any other optional dependency.

## What is not here

The timeline scrubber. It belongs to the editor's play-in-editor session, which needs snapshots of
the authored world to put back — a shipped game has no authored world to return to. The pieces
underneath it (`@driftengine/network`'s `Snapshotter`, `RewindLoop` and input log) are available to
a game directly.

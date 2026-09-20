# `@driftengine/tools`

The editor's panels, as something a shipped game can carry: an inspector, a console, a profiler and
a network panel, with the command stack that makes their edits undoable.

**3,395 bytes gzipped**, measured by `scripts/size-gate.test.mjs` against
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

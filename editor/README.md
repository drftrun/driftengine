# The DriftEngine editor

A product built on the engine's public surface, deliberately not a package. It consumes
`@driftengine/core`, `ui2d`, `tools`, `entities`, `network` and `texture` exactly as anybody else
would; anything it needs a private hook for is a hole in the engine, and gets fixed in the engine.

```sh
npm run editor     # http://localhost:5173
```

## What it does today

A menu bar that opens, a viewport the engine draws, and three docked panel regions with eleven
panels between them. Click a prop to select it, shift-click to add to the selection, `Ctrl+Z` and
`Ctrl+Shift+Z` to take it back and put it forward, `Ctrl+K` for the command palette, `Ctrl+A` to
select all. `Ctrl+O` opens a `.drft` and `Ctrl+S` saves one.

**Every panel is docked and bound to what the editor is holding**, and `View` — or the palette —
shows any of them: the capture's stages and proposals, the scene tree, an inspector over the
selection's transforms, a profiler on the frame history, a console of what you have done, an asset
list of what this session opened, the script view, and one graph panel per vocabulary with its
compiled artefact beside it.

**A region shows one panel at a time.** The dock is splits and leaves with no tabs in it, so seven
panels visible at once would be seven slivers; `View` swaps what a region shows.

**The editor opens on a capture, and makes one when nobody hands it a file.** `?capture=none` opens
it with nothing. One scene shape is what makes `Delete` honest: it used to open on a demo scene
that can delete and then put a capture underneath it, which cannot — and a capability read once at
startup is how `Delete` comes to be offered for something it cannot do.

**`Delete` appears only where the scene can delete.** A capture's regions cannot be removed from
the file, so the key does nothing there and the menu greys the item — rather than clearing your
selection and removing nothing, which is what it used to do.

## What it does not do yet, said plainly

This list is not the author's guess. **Somebody who had not written it was put in front of it on
2026-09-20**, told to select a thing, move it and undo — Wave 2C's step 3, the one a test cannot
replace — and what follows is their list, minus the four things that were fixed the same day
(picking the thing under the cursor, `Delete`, the palette, and the menu bar being decoration).

**There is no way to move anything.** The gizmo is reachable and tested —
`editor/src/viewport/gizmo.ts` turns a handle drag into merged undo entries — but nothing paints
the arms, so there is no handle to grab. The reader tried 160 drags at every offset and modifier
around a selected prop, swept every letter and digit, and read the whole command list: there is no
Move, and nothing on screen says so. **Selecting an object is the end of the road**, and that is
the single largest gap in the product.

**Nothing reacts to the pointer until you click.** No hover highlight on a prop, a menu title or a
panel row, and no cursor change. Every first click is a guess about whether the thing under the
pointer is a thing at all.

**The camera does not move.** No orbit on drag, no zoom on wheel, so an object can only be seen
from the one angle the scene opens at — which is also how you would normally confirm that a move
had happened.

**A row in the capture panel edits on a single click.** Clicking a region accepts it; the rows
above it, which look identical, do nothing. There is no button chrome and no confirmation. It is
undoable, and the readout names the undo, but nothing marks it as an action before you take it.

**The splitter between panels does not drag**, so the three regions are the sizes they open at,
and **a region shows one panel with no tabs** — so reading the console while watching the profiler
is not possible.

**The panels show and mostly do not edit.** The inspector reads the selection's transform and has
no field widgets wired in; the script view is a text view with no keyboard focus behind it; the
graph panels draw, pan and select but nothing saves a graph. Each says so where it stands rather
than presenting an editor that swallows keys.

**Two more were found by photographing the running product**, not by reading it, and both had been
true for as long as the code existed:

- **The accessibility mirror was visible.** Every node it published carried its label as ordinary
  text in an ordinary box over the canvas, so the whole interface appeared twice, the second copy
  a menu bar higher than the first. It was invisible only while nothing had a label — the day the
  panels were docked it drew everything. The mirror is transparent now, and offset to where the
  application's tree actually starts. What a reader gets is still only the mirror: the canvases
  themselves carry no label.
- **`npm run editor` ran a different engine from the one in this checkout.** There was no bundler
  configuration, so `editor/src/**` was served live while every `@driftengine/*` it imports came
  from whatever `npm run build` last left in `dist`. A fix made in a package simply did not appear.
  `editor/vite.config.ts` is the resolution `demo/dev` has carried since the same thing happened
  there.

`window.editorDebug` is the handle the visual gate drives the product through, since an editor's
state is a menu open and a panel shown rather than a query string.

**The readout in the corner is the only feedback channel.** It is good — it names the pending undo
— but it says how many props are selected and never which, and it is small text in a corner.

## How it is arranged

| Path                        | What it is                                                              |
| --------------------------- | ----------------------------------------------------------------------- |
| `src/app.ts`                | The shell: dock geometry, panel routing, layout, the accessibility tree |
| `src/shell.ts`              | The product: menu bar, viewport, palette, selection, gizmo, commands    |
| `src/main.ts`               | The browser entry, and the only file outside `host/browser/` that       |
|                             | names a browser global                                                  |
| `src/host/browser/`         | The browser's text and accessibility services, behind ui2d's seams      |
| `src/dock/`, `src/widgets/` | Docking and the widget set                                              |
| `src/panels/`               | The panels, and `docked.ts` — which opens where, bound to what          |
| `vite.config.ts`            | Resolves `@driftengine/*` to source, so the page runs this checkout     |
| `src/graph/`                | One node-graph canvas over three vocabularies                           |
| `src/pie/`                  | Play in editor: sessions, timeline, scrubbing, divergence               |
| `src/viewport/`             | Picking by ray, and gizmo drags as commands                             |

`src/host/browser/` is the only directory that may name a browser global, so Wave 5A's native host
replaces that directory and `main.ts` and edits nothing above them.

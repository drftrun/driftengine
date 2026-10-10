---
title: Interfaces
description: Menus and heads-up displays as a retained tree: layout without coordinates, focus, routing, clipping and scrolling, themes, text, and scripts.
packages: ['@driftengine/ui2d']
plain: ['UiTree']
---

# Interfaces

A menu, a heads-up display or a settings screen in `@driftengine/ui2d` is a tree of nodes built
once and changed as the game runs. The tree is laid out, pointed at and drawn by the engine, as one
[sprite pass](sprites.md), and the text on it is drawn by the pixel font or by distance-field text,
whichever the game uses.

The example is a pause menu and an options screen over a scene that keeps running behind them.
`menu.drs` routes the pointer and the keys to the tree, answers what was activated and paints each
button from its own state. Options opens a second panel whose toggles change the scene, and its
list scrolls inside its own box. The mouse, the keyboard and a gamepad all reach it, and the
switches move the menu and change its theme.

<!-- run: interface -->

## A tree of nodes

```ts sample=interface/main.ts#tree
/* The interface as nodes: a root that fills the screen, the pause menu, and the options panel with
   its toggles and a list that clips and scrolls. Sizes are numbers, `fit` or `grow`; nothing is
   placed by hand. */
const BUTTON: UiNodeOptions = { width: 260, height: 34, interactive: true, focusable: true };
const root = createUiNode({
  direction: 'column',
  width: 'grow',
  height: 'grow',
  justify: 'center',
  padding: 40,
});
const add = (parent: UiNode, options: UiNodeOptions): UiNode =>
  addUiChild(parent, createUiNode(options));
const menu = add(root, {
  direction: 'column',
  padding: 18,
  gap: 8,
  name: 'menu',
  background: [0, 0, 0, 1],
});
add(menu, { width: 260, height: 36, text: 'PAUSED', name: 'title' });
add(menu, { ...BUTTON, text: 'RESUME', name: 'resume' });
add(menu, { ...BUTTON, text: 'OPTIONS', name: 'options' });
add(menu, { ...BUTTON, text: 'RESTART', name: 'restart' });
const options = add(root, {
  direction: 'column',
  padding: 18,
  gap: 8,
  name: 'optionsPanel',
  hidden: true,
  background: [0, 0, 0, 1],
});
add(options, { width: 260, height: 36, text: 'OPTIONS', name: 'optionsTitle' });
add(options, { ...BUTTON, text: 'SPIN  ON', name: 'spin' });
add(options, { ...BUTTON, text: 'SHADOWS  ON', name: 'shadows' });
const help = add(options, {
  direction: 'column',
  width: 260,
  height: 112,
  padding: 8,
  gap: 6,
  clip: true,
  name: 'help',
  background: [0, 0, 0, 1],
});
for (const line of [
  'THE WHEEL SCROLLS IT',
  'TAB OR ARROWS MOVE',
  'ENTER OR SPACE PRESS',
  'ESCAPE GOES BACK',
  'A PAD: D-PAD AND A',
  'START PAUSES',
  'THE LIST CLIPS ROWS',
  'AND SCROLLS IN PLACE',
]) {
  add(help, { width: 'grow', height: 16, text: line });
}
add(options, { ...BUTTON, text: 'BACK', name: 'back' });
```

`createUiNode(options)` makes a node and `addUiChild(parent, child)` hangs it under another;
`removeUiChild` takes one off and `uiNodeNamed(root, name)` finds one. A node has a `direction`, row
or column, for its children, a `width` and `height`, `padding` and a `gap` between children, and
`align` and `justify` for where they sit across and along. It can be `hidden`, `interactive` to take
the pointer, `focusable` to take the keyboard, and carry a `background` colour, an image from a
`texture` slot and `frame`, a `tint`, and `text`. `absolute` with `x` and `y` takes a node out of the
flow, for a badge in a corner.

A size is one of three things: a number of CSS pixels, `fit`, the size of what is inside, or `grow`,
a share of what the parent has left. There are no percentages, because a percentage of a parent
sized to fit its children is a cycle. `layoutUiTree(root, x, y, width, height)` lays the whole tree
out in two passes, measuring every node bottom-up and then placing it top-down, into the `rect` each
node already owns, so it allocates nothing and can run every frame. The box it is given is what is
available, so the same call lays out a full-screen menu and a tooltip.

## Pointing, focus and keys

`routeUiPointer(input, root, x, y, down)` hit tests the tree, last drawn first so it agrees with the
picture, sets `hovered` and `pressed` on the nodes, and answers the node activated, which is a press
and a release on the same node, so somebody who pressed the wrong button can slide off it. A node
that is not interactive does not block what is behind it: a backdrop that swallowed clicks would
make every button under it dead. `routeUiKey(input, root, key, shift)` moves the focus with Tab and
activates with Enter and Space, and leaves every other key to you. Focus follows tree order, and
`uiFocusNext`, `uiFocusPrevious`, `uiFocusOrder` and `setUiFocus` move it directly. `createUiInput()`
is the routing state and `uiHitTest` the bare hit test. Dragging and pointer capture, so a slider
keeps the pointer when it leaves the track, are `capturePointer`, `pointerTarget`, `beginDrag`,
`dropTarget` and `endDrag`.

## Clipping and scrolling

A node made with `clip: true` bounds its descendants: they draw and take the pointer only inside it.
Its `scrollX` and `scrollY` move them under it at layout, so hit testing and focus need no notion of
scrolling, and `routeScrollWheel(root, x, y, dx, dy)` scrolls the clipping node under the pointer,
`scrollBy` and `clampScroll` within its `scrollExtent`. `clipRectFor(root, node, out)` answers how
much of a node a clip leaves. A list of thousands of rows builds only the ones in view:
`visibleRange` and `visibleRangeVariable` give the window of rows a scroll position shows.

## Themes

```ts sample=interface/main.ts#theme
/* Colours by name, packed as 0xRRGGBBAA. The light theme is the dark one with four overrides. */
const DARK = createTheme({
  panel: 0x14161dee,
  well: 0x0b0c10ff,
  text: 0xe6e8eeff,
  title: 0xf0b45cff,
});
const LIGHT = deriveTheme(DARK, {
  panel: 0xf2f3f6ee,
  well: 0xdfe2e8ff,
  text: 0x1a1c22ff,
  title: 0xb4602aff,
});
let theme = flag('theme', 'dark') === 'light' ? LIGHT : DARK;
const textColour = new Float32Array(4);
let bodyStyle: TextStyle = DEFAULT_TEXT_STYLE;
let titleStyle: TextStyle = DEFAULT_TEXT_STYLE;
/* Written into the nodes' own colours, and the label styles built here, once a change of theme. */
function applyTheme(): void {
  themeRgba(theme, 'panel', 0x000000ff, menu.background as Float32Array);
  themeRgba(theme, 'panel', 0x000000ff, options.background as Float32Array);
  themeRgba(theme, 'well', 0x000000ff, help.background as Float32Array);
  themeRgba(theme, 'text', 0xffffffff, textColour);
  bodyStyle = {
    ...DEFAULT_TEXT_STYLE,
    cellSize: 2,
    color: [textColour[0] ?? 1, textColour[1] ?? 1, textColour[2] ?? 1],
  };
  themeRgba(theme, 'title', 0xffffffff, textColour);
  titleStyle = {
    ...DEFAULT_TEXT_STYLE,
    cellSize: 3,
    color: [textColour[0] ?? 1, textColour[1] ?? 1, textColour[2] ?? 1],
  };
}
applyTheme();
```

A theme is colours and sizes by name. `createTheme(values)` makes one and `deriveTheme(base,
overrides)` another from it, flattened when it is derived so a lookup is one property access.
`themeColour` and `themeSize` read a token, and `themeRgba` unpacks a colour token straight into a
node's `background` or `tint`, decoded from the sRGB a hex colour is written in to the linear light a
node holds, so a token comes out on screen exactly as written. The example's light theme is the dark
one with four colours changed.

## Drawing it

```ts sample=interface/main.ts#draw
/* One sprite pass for the panels and buttons, and the pixel font over them: the tree says where
   each label goes and how much of it a clip leaves, and the page draws it. */
const pass = createSpritePass({ capacity: 256, slots: 1, label: 'interface' });
const handle = renderer.registerPass(pass);
const affine = createAffine2D();
const labels = new Map<UiNode, TextHandle>();
const queued: UiNode[] = [];
const sink = {
  content(node: UiNode, visible: UiRect): void {
    /* A label in a row a clip has cut is left out, rather than drawn over the list's edge. */
    if (visible.h < node.rect.h) return;
    queued.push(node);
  },
};
function drawLabels(width: number, height: number, time: number): void {
  for (const node of queued) {
    let label = labels.get(node);
    if (label === undefined) {
      label = renderer.createText();
      labels.set(node, label);
    }
    renderer.setText(label, node.text);
    const big = node.name === 'title' || node.name === 'optionsTitle';
    const style = big ? titleStyle : bodyStyle;
    const cell = big ? 3 : 2;
    const x = node.rect.x + (node.interactive ? 12 : 4);
    const baseline = node.rect.y + node.rect.h / 2 + (cell * 7) / 2;
    renderer.drawText(label, width, height, x, baseline, style, time);
  }
  queued.length = 0;
}
```

`drawUiTree(batch, root, white, sink)` draws the tree into a sprite batch, parents before children so
a child lands on top, a background on the white slot and an image over it. Under a clip each quad is
cut to what the clip leaves. Text is yours: the sink is handed every node with text, at its laid-out
box and with the part of it visible, and draws it with core's `drawText` or `drawSdfText`. The
example leaves out a label its clip has cut, rather than drawing it over the list's edge.

Beyond the tree there is more for an interface to need. `sliceInto` cuts a panel image into nine
cells so its corners keep their size as it stretches. `createTextModel` is an editable line of text,
with `insertText`, `deleteBackward`, `moveCaret`, `selectAll` and the rest, a caret that steps over
characters made of two code units, and a `TextHost` for composition and the clipboard where there is
a page to have them. `runsFor` splits text into styled runs. `layerOrder` orders a tree by inherited
layers, for a dropdown that must cover the panel its control sits in. `createDirtyTracker` and
`diffTree` find the region that changed since the last frame, a node that vanished included, so an
interface can repaint only that.
And `a11yTree` produces the tree's accessibility nodes for an `A11yHost` to publish to a screen
reader.

## From DriftScript

`drift/ui` reads and changes a tree the host hands a script as a `UiTree`, addressing its nodes by
the names they were built with. `layout` lays it out and `draw` draws it; `has`, `left`, `top`,
`width`, `height` and `visible` read a node; `show`, `setText` and `tint` change one; `hovered`,
`pressed` and `focused` are its state; and `point`, `key`, `activated` and `focus` route input to it.
The menu routes the frame's pointer and key, and answers what each activated:

```drs sample=interface/menu.drs#route
// Lay the tree out in the space it has, then give it the pointer and the key pressed this frame,
// and answer whatever either of them activated. Arrow keys move the focus as Tab does.
fn update(menu: mut Menu, tree: UiTree, width: f32, height: f32, px: f32, py: f32, down: bool, pressedKey: String) {
    ui.layout(tree, 0, 0, width, height)
    if pressedKey == "Escape" {
        if menu.inOptions {
            leaveOptions(menu, tree)
        } else {
            toggle(menu, tree)
        }
    }
    if !menu.open {
        return
    }
    ui.point(tree, px, py, down)
    respond(menu, tree)
    if pressedKey == "ArrowDown" {
        ui.key(tree, "Tab", false)
    } else if pressedKey == "ArrowUp" {
        ui.key(tree, "Tab", true)
    } else if pressedKey == "Enter" || pressedKey == " " || pressedKey == "Tab" {
        ui.key(tree, pressedKey, false)
    }
    respond(menu, tree)
    paint(menu, tree, "resume")
    paint(menu, tree, "options")
    paint(menu, tree, "restart")
    paint(menu, tree, "spin")
    paint(menu, tree, "shadows")
    paint(menu, tree, "back")
}
```

```drs sample=interface/menu.drs#respond
fn respond(menu: mut Menu, tree: UiTree) {
    if ui.activated(tree, "resume") {
        toggle(menu, tree)
    }
    if ui.activated(tree, "options") {
        menu.inOptions = true
        ui.show(tree, "menu", false)
        ui.show(tree, "optionsPanel", true)
        ui.focus(tree, "spin")
    }
    if ui.activated(tree, "back") {
        leaveOptions(menu, tree)
    }
    if ui.activated(tree, "restart") {
        menu.restarts += 1
    }
    if ui.activated(tree, "spin") {
        menu.spin = !menu.spin
        label(tree, "spin", menu.spin, "SPIN  ON", "SPIN  OFF")
    }
    if ui.activated(tree, "shadows") {
        menu.shadows = !menu.shadows
        label(tree, "shadows", menu.shadows, "SHADOWS  ON", "SHADOWS  OFF")
    }
}
```

A button paints itself from its own state:

```drs sample=interface/menu.drs#paint
// A button paints itself from its own state: held down, under the pointer or holding the keyboard,
// or at rest, in the colours of the theme the page is showing.
fn paint(menu: Menu, tree: UiTree, name: String) {
    if ui.pressed(tree, name) {
        ui.tint(tree, name, 0.9, 0.5, 0.25, 1)
    } else if ui.hovered(tree, name) || ui.focused(tree, name) {
        if menu.light {
            ui.tint(tree, name, 0.95, 0.75, 0.45, 1)
        } else {
            ui.tint(tree, name, 0.85, 0.55, 0.3, 1)
        }
    } else if menu.light {
        ui.tint(tree, name, 0.86, 0.87, 0.9, 1)
    } else {
        ui.tint(tree, name, 0.17, 0.19, 0.24, 1)
    }
}
```

Reading a laid-out box is a read of the scene, inside the fixed step; whether a node is hovered or
pressed is input, outside it, so a `@deterministic` system cannot ask where the pointer is. The
page collects the pointer, the wheel, one key a frame and a pad's buttons, and hands them over:

```ts sample=interface/main.ts#devices
/* The pointer in CSS pixels, the wheel, the one key pressed this frame, and a pad's buttons named
   as the keys they stand for. The script is handed all of it and routes it to the tree. */
const pointer = { x: -1, y: -1, down: false };
let pressedKey = '';
const ROUTED = new Set(['Escape', 'ArrowDown', 'ArrowUp', 'Enter', ' ', 'Tab']);
canvas.addEventListener('pointermove', (event) => {
  pointer.x = event.offsetX;
  pointer.y = event.offsetY;
});
canvas.addEventListener('pointerdown', () => {
  pointer.down = true;
});
addEventListener('pointerup', () => {
  pointer.down = false;
});
canvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    routeScrollWheel(root, event.offsetX, event.offsetY, event.deltaX, event.deltaY);
  },
  { passive: false },
);
addEventListener('keydown', (event) => {
  if (!ROUTED.has(event.key)) return;
  event.preventDefault();
  pressedKey = event.key;
});
const input = new InputSource(canvas);
function padKey(): string {
  const pad = input.pad(0);
  if (pad === null) return '';
  if (pad.pressed('dpadDown')) return 'ArrowDown';
  if (pad.pressed('dpadUp')) return 'ArrowUp';
  if (pad.pressed('faceDown')) return 'Enter';
  if (pad.pressed('faceRight') || pad.pressed('start')) return 'Escape';
  return '';
}
```

```ts sample=interface/main.ts#script
const script = hostScript(menuScript);
interface Menu {
  open: boolean;
  spin: boolean;
  shadows: boolean;
  light: boolean;
  restarts: number;
}
const state = exported<() => Menu>(script, 'createMenu')();
state.light = theme === LIGHT;
exported<(tree: UiNode) => void>(script, 'begin')(root);
type Update = (
  menu: Menu,
  tree: UiNode,
  width: number,
  height: number,
  x: number,
  y: number,
  down: boolean,
  key: string,
) => void;
if (import.meta.hot) {
  import.meta.hot.accept('./menu.drs', (next) => {
    if (next !== undefined) patchModule(script, next as Record<string, unknown>, { Menu: [state] });
  });
}
```

```ts sample=interface/main.ts#frame
const key = pressedKey !== '' ? pressedKey : padKey();
pressedKey = '';
exported<Update>(script, 'update')(
  state,
  root,
  width,
  height,
  pointer.x,
  pointer.y,
  pointer.down,
  key,
);
pass.reset();
pass.setTransform(screenToNdc(width, height, affine));
drawUiTree(pass.batch, root, pass.white, sink);
```

# @driftengine/ui2d

The 2D layer: quads with a texture on them, batched, in the order you drew them.

**Cost: 8.8 KB gzipped on top of core.** Measured by `scripts/size-gate.test.mjs`, which fails if it
drifts more than 3% — the number is derived from the same floors that gate asserts, so a README
quoting a stale one is a red suite rather than a thing somebody notices.

## What it is

```ts
import { createAffine2D, createSpritePass, drawSprite, screenToNdc } from '@driftengine/ui2d';

const sprites = createSpritePass({ capacity: 4096 });
sprites.setTexture(0, await createImageBitmap(sheetImage));
const handle = renderer.registerPass(sprites);

const affine = createAffine2D();

function frame(): void {
  sprites.reset();
  sprites.setTransform(screenToNdc(canvas.clientWidth, canvas.clientHeight, affine));
  drawSprite(sprites.batch, 0, { x: 24, y: 24, w: 64, h: 64 }, null, null);

  renderer.beginFrame(clear);
  renderer.bindMeshPass(camera, env);
  renderer.drawMesh(ground, model);
  renderer.drawPass(handle); // wherever in the frame you want the 2D layer
  renderer.endFrame();
}
```

**It draws through `registerPass`, not through a verb on the renderer.** That is what lets it be a
package at all: the renderer's verb surface is fixed and nothing outside `render/` can add to it, so
this owns its own program on both backends and the caller decides where in the frame it lands.
`pass.ts` in core names this package as one of the three that mechanism exists for.

## Two coordinate systems, and they count y opposite ways

`screenToNdc(width, height, out)` is **CSS pixels from the top-left** — the convention `InsetRect`
and `fillPanel` already use, and the one a caller laying out an overlay already has.

`worldToNdc(camera, width, height, out)` is a **2D world seen through a camera**, and there y counts
**up**. A caller placing a platform above a floor should not have to subtract, and a 2D world is a
world. The two are different enough that sharing one convention would make every caller wrong half
the time, so they are named separately and each says which it is.

A `Camera2D` is where it is, how far in (`zoom`, in pixels per world unit) and which way up
(`rotation`, radians, anticlockwise). Turning the camera turns the world the other way.

## Order is the layering

There is no depth here, on purpose: a sprite writes no depth and tests none, so **the order sprites
were submitted in is the order they are drawn**. That is the same decision the rest of the engine
takes about pass ordering — `ROADMAP.md` records gate 1.2 withdrawing dependency ordering because
the API is immediate-mode and the caller's draw order is already the semantic one.

## One batch, many textures, runs between them

`drawSprite` names a texture slot. Consecutive sprites on the same slot are one **run** and one
draw; a slot change starts a new run, and going back to the first slot starts a third rather than
regrouping — regrouping would reorder the picture.

This is the shape `AGENTS.md` asks for: _the number to hold down is material changes, not draws_. A
tilemap over one sheet is one run however many thousand tiles it is.

A batch has a fixed capacity and does not grow. Past it, `drawSprite` counts into `batch.dropped`
rather than allocating under a frame — a caller drawing more than it planned for wants counting,
not absorbing.

## Sheets

A sheet is the rectangles of one texture that each hold a picture. `gridSheet` cuts it into equal
cells, row-major; `namedSheet` takes whatever rectangles a packer put where. Both answer a frame by
index, and `frameOf` turns a name into one.

```ts
const sheet = gridSheet(0, 256, 128, 32, 32); // slot 0, 8 x 4 cells
const frame = createSpriteFrame(); // reused; reading one allocates nothing
drawSprite(batch, sheet.texture, place, sheetFrame(sheet, frameOf(sheet, '5'), frame), null);
```

**A cell that would run off the edge is not emitted.** A sheet 70 texels wide cut into sixteens has
four whole cells and six texels of margin, and a fifth cell reading into that margin is a frame with
a stripe of nothing down one side — which reads as a rendering bug rather than as a badly measured
atlas.

**A frame index the sheet does not have reads as the whole texture rather than throwing**, because
this is called per sprite per frame and nothing may throw in the frame loop. What a caller then sees
is the entire atlas drawn where one picture should be, which is unmistakable.

## Tilemaps

```ts
const map = createTilemap(1000, 1000, 32, 32);
setTile(map, 4, 7, frameOf(sheet, 'grass'));
const drawn = drawTilemap(batch, map, sheet, { x: camX, y: camY, w: 1280, h: 720 }, null);
```

**The cost is the view rather than the map.** The visible span is arithmetic on four numbers, so a
million-cell map costs the few hundred cells on screen — measured at 25 drawn from a 1,000 by 1,000
map. A walk over every cell testing each against the view draws exactly the same picture and is
unusable at the size a tilemap exists for.

**Which way the rows run is the affine's business, not the map's.** A cell's corner is
`y + row * tileHeight`, so in screen space — where y counts down — row 0 is the top row, and in a 2D
world it is the bottom. That is the same rule `SpritePlacement` states about its own corner, and one
rule rather than a flag is what keeps the two agreeing.

## Textures

`setTexture(slot, source, options)` takes an `ImageBitmap`, an `HTMLCanvasElement` or an
`OffscreenCanvas` — narrower than `TexImageSource` because that is the union both backends take
without a conversion. An `<img>` reaches it through one `createImageBitmap`, which is also where the
decode's own orientation and premultiply options live.

`colorSpace` defaults to `srgb`, which is right for anything painted to be looked at; the sampler
decodes and the pass's own output transform re-encodes, so the blend happens in linear light.
`filter` defaults to `nearest`, because a sheet is usually pixel art and linear filtering is the
thing that makes pixel art look wrong.

### Type in an atlas wants `mipmap: true`

`mipmap` defaults to false, which is right for pixel art: a chain is memory nothing samples, and at
a distance it dissolves art whose whole point is the pixel. **A glyph page is the sheet where that
default is wrong.** Bake one page at 96 px, draw body copy at 11, and that is a 7x minification:
`linear` reads four texels out of a footprint covering dozens, so a `t` crossbar two texels tall
lands on about a quarter of a pixel and survives or not depending on where the sample falls. A
player reported it as `Step-In Uppercut` reading `Slep-In Uppercul`, with the same letter surviving
in one word and not the next, so the line looked unevenly spaced as well as misread.

```ts
sprites.setTexture(0, glyphPage, { filter: 'linear', mipmap: true });
```

Measured on `demo/dev/glyphMip.ts`, twelve copies of one glyph at different subpixel offsets: the
ink varies between copies with a standard deviation of **0.0130** plain and **0.0020** mipmapped, so
**6.6x less** copy-to-copy disagreement, identical on both backends. `scripts/glyph-mip-check.mjs`
is that measurement as a gate.

With `filter: 'linear'` this is trilinear. With `filter: 'nearest'` the levels are still blended,
because that is minification and `filter` is about magnification.

**Pad the cells yourself.** A lower level mixes texels the packer put next to each other, so a sheet
whose frames touch shows its neighbours once the chain is deep enough to reach them. How much
padding depends on how far down the sheet is ever sampled, which is a fact about the sheet rather
than about the sampler — the engine cannot size it for you.

**Neither backend flips the image.** `surfaceTexture.ts` in core carries the whole argument and the
bug it came from: WebGL2 ignores `UNPACK_FLIP_Y_WEBGL` for an `ImageBitmap` and honours it for a
canvas, so a pipeline checked with one source type is half checked. `scripts/sprite-check.mjs`
checks both.

## The retained interface tree

```ts
const root = createUiNode({ direction: 'column', width: 'grow', height: 'grow', justify: 'end' });
const bar = addUiChild(root, createUiNode({ direction: 'row', padding: 10, gap: 10, name: 'bar' }));
addUiChild(bar, createUiNode({ width: 60, height: 40, interactive: true, name: 'start' }));

layoutUiTree(root, 0, 0, canvas.clientWidth, canvas.clientHeight);
routeUiPointer(input, root, pointerX, pointerY, pointerDown);
drawUiTree(sprites.batch, root, sprites.white, null);
```

**`layoutUiTree` is two passes and no third**: measure what every node comes to on its own,
bottom-up, then place what got a size, top-down. A `fit` that depended on the space it was given
would need a rule for when to stop, which is where a layout engine stops being explicable.

Three size cases — a number, `fit`, `grow` — rather than percentages or flex weights. A percentage
of a parent that is itself `fit` is a cycle. A `grow` child measures as `fit`, which is what lets a
menu sized to its contents hold a row that fills it.

**It allocates nothing.** Every number lands in a `UiRect` the node already owns, which is why a
node is an object with mutable fields rather than a description that gets resolved into one: an
interface tree is tens of nodes built once and mutated, not thousands rebuilt per frame.

The box you give it is what is _available_ — the root resolves its own size against it, so the same
call lays out a full-screen HUD and a tooltip.

## Hit testing, focus and routing

`uiHitTest` searches **last-drawn first**, so it agrees with the picture. **A node that is not
`interactive` does not block what is behind it**: a backdrop that swallowed clicks makes every
button under a plate dead, which no screenshot shows. A modal that wants to swallow them says so by
being interactive.

`routeUiPointer` activates on **a press and a release on the same node**, so somebody who pressed
the wrong button can slide off it and let go. It sets `hovered` and `pressed` on the nodes
themselves, so a caller paints a button from its own state.

`routeUiKey` handles three keys — Tab both ways, Enter and space — and reports everything else
unhandled, so a caller can have it. Focus order is tree order rather than a declared index, and a
node hidden since it was focused does not take the keyboard with it.

**Text is the caller's.** This package draws quads; core already draws two kinds of text. Pass a
`UiContentSink` to `drawUiTree` and it hands you every node with text at its resolved rect, in the
order it was drawn.

## From DriftScript

**`drift/ui` is bound**: eighteen capabilities over the tree, addressed by the names its nodes were
built with. A host builds the tree and hands the root to a script through `uses`, the way a
`Terrain` arrives.

```
import { layout, hovered, show } from "drift/ui"

fn menu(tree: UiTree) {
    ui.layout(tree, 0, 0, 1280, 720)
    ui.show(tree, "start", ui.hovered(tree, "start"))
}
```

Reading a laid-out box is `scene.read` and inside the fixed step; `hovered` and `pressed` are
`input.read` and outside it, so a `@deterministic` system cannot ask where the pointer is.

**`drift/2d` is bound too**, and it is why DriftScript has import aliases. A module's namespace was
the last segment of its path, so a call would have been `2d.sprite(...)` — a number followed by an
identifier the lexer refuses — and the binding was written, wired, found uncallable and withdrawn
rather than shipped. DriftScript 1.11.0 answered it at the import, so the namespace is written out:

```
import { sprite, tilemap } from "drift/2d" as sprites

fn hud(batch: SpriteBatch) {
    sprites.sprite(batch, 0, 10, 10, 32, 32)
}
```

Twelve capabilities over a batch, a sheet and a tilemap. A draw is `scene.write` and outside the
fixed step; reading a sheet or a cell is `scene.read` and inside it, so a `@deterministic` system may
ask what is in a cell and may not draw it. `dropped` is exposed for the same reason it exists: a
batch that overflows drops draws, and a script with no way to read the count finds out by noticing
something missing from a corner of the screen.

## What it is checked by

`scripts/sprite-check.mjs`, on a real GPU, on both backends. Every sheet in it is two texels by two
with four different colours, so a sprite's four quadrants say which corner is which — an assertion a
mirror fails and a bounding box cannot, since a mirror preserves every count and every box. The
control is submission order: the same two sprites are drawn both ways round and the overlap changes
colour.

It found a real defect on its first run. A contributed pass inherits whatever cull state the last
scene draw left on, and a screen-space quad's winding is not the scene's — so WebGL2 drew **nothing
at all** while WebGPU, whose pipeline states its own cull mode, was pixel-perfect. No error on
either side.

`scripts/ui-check.mjs` does the same for the tree, and it asserts the one thing a unit test cannot:
the page publishes **the boxes the layout computed** and **the bounding boxes of the colours they
were drawn in**, and the two must agree. A bar sized by its own contents lands at 530, 660, 220 by
60 on both backends, to **0.0 px**, with the frame byte-identical in all three pointer states. The
control is the pointer: the middle button paints itself from its own `hovered` and `pressed` flags,
so routing is a colour in the frame rather than the router's own return value read back.

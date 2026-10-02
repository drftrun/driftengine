---
title: Installation
description: Add DriftEngine to a project, set up the page and TypeScript, pick a backend for testing, and know what the licence asks of you.
packages: ['@driftengine/core']
---

# Installation

DriftEngine is published to npm as separate packages under the `@driftengine` scope. Every game
needs `@driftengine/core`; the rest you add when you reach for them.

```sh
npm install @driftengine/core
```

## What it needs

- **A browser with WebGL2**, which is every current desktop and mobile browser. The engine uses
  WebGPU where the browser offers a device that can draw, and WebGL2 everywhere else.
- **Node 22.12 or newer** for your toolchain. Nothing in the engine runs in Node at play time; Node
  is what builds and serves your game.
- **An ES module bundler.** The examples in this manual use Vite, and webpack 5 and Parcel work the
  same way. The engine starts its workers with `new Worker(new URL('./worker.ts', import.meta.url))`,
  which those three bundle without configuration.

## A new project

The quickest start is Vite's TypeScript template, with the engine added to it:

```sh
npm create vite@latest my-game -- --template vanilla-ts
cd my-game
npm install @driftengine/core
npm run dev
```

Replace the template's `index.html` with a page that holds one canvas. The engine reads the canvas's
CSS size and sizes its drawing buffer to match, so the canvas only needs to be laid out.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>My game</title>
    <style>
      html,
      body {
        margin: 0;
        height: 100%;
        background: #0d0e12;
      }
      canvas {
        display: block;
        width: 100%;
        height: 100%;
      }
    </style>
  </head>
  <body>
    <canvas id="stage"></canvas>
    <script type="module" src="./src/main.ts"></script>
  </body>
</html>
```

Then write `src/main.ts`. [Hello world](hello-world.md) is the whole of a first one.

## TypeScript

The template's settings are fine. What the engine relies on is a target that allows top-level
`await`, since creating a renderer is asynchronous, and the DOM library:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noEmit": true
  }
}
```

The packages ship compiled JavaScript with declaration files, so nothing else is needed to get
types.

## Choosing a backend while you test

`createRenderer` picks the backend. You can force one from the address bar, which is the quickest
way to check that a game looks the same on both:

```text
http://localhost:5173/?backend=webgl2
http://localhost:5173/?backend=webgpu
```

`createRenderer` returns which backend it built and a `reason` in words. Show both somewhere while
you develop: the first question about any picture is what drew it.

## Headers

None are required. A plain static host serves a DriftEngine game.

One feature asks for more: solving physics islands on worker threads needs `SharedArrayBuffer`,
which browsers only offer to a cross-origin isolated page. If you turn that on, serve the page with
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. Without
them physics still runs, on the main thread, and the world says why it didn't start the workers.

## Working against a checkout of the engine

If you're changing the engine itself, or tracking its `main` branch, depend on it by path and npm
will link it:

```json
{
  "dependencies": {
    "@driftengine/core": "file:../driftengine/packages/core"
  }
}
```

Add the `drift-source` condition to your bundler so it reads the engine's TypeScript, and an edit to
the engine is live in your game with no build in between. In Vite, spread the defaults back in,
because setting `resolve.conditions` replaces them:

```js
import { defaultClientConditions, defineConfig } from 'vite';

export default defineConfig({
  resolve: { conditions: ['drift-source', ...defaultClientConditions] },
});
```

Reading the source also needs `"allowImportingTsExtensions": true` in the tsconfig that checks your
project, because the engine's own imports name their `.ts` files.

## The engine badge

`createRenderer` shows a small DriftEngine badge over the page while the game boots, and holds it
for three seconds after the first frame reaches the screen. The fixed-step loop is held for that
time too, so an intro or a music cue doesn't play behind it.

**Keeping it is a request, and the licence doesn't require it.** Pass `{ splash: false }` as the
third argument to `createRenderer` to turn it off, which is the right choice for anything that isn't a game booting:
a canvas that is one section of a web page, a tool, a product page. `?splash=0` turns it off from the
address bar without a code change.

## Licence

Apache-2.0. You can use the engine for anything, including commercial games, and modify it.

What the licence asks is that you reproduce the contents of the engine's `NOTICE` file somewhere a
person can read it: in your source, your documentation, or a screen the game shows, such as a
credits or licences page. Every package's entry point already carries that notice in a comment
minifiers keep, so a bundled game includes it without any work on your part.

Only one dependency anywhere in the engine is copyleft, and it reaches only the native host, which
ships it as a separate, replaceable file. [Shipping to the web](shipping-to-the-web.md) covers what
goes into a web build.

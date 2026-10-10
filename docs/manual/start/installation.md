---
title: Installation
description: Add DriftEngine to a project, set up the page, TypeScript and DriftScript, pick a backend for testing, and know what the licence asks of you.
packages: ['@driftengine/core', '@driftengine/script']
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

The quickest start is a project made for the engine, ready to run:

```sh
npm create @driftengine@latest my-game
cd my-game
npm install
npm run dev
```

It is a Vite and TypeScript project with the engine, DriftScript and the page below already set up,
a test runner, and a command that looks at the game on both backends. It is also set up for a coding
agent to work in, which [Working with a coding agent](with-an-agent.md) describes.

To add the engine to a project of your own instead, start from Vite's TypeScript template:

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

## DriftScript

A game's rules are written in DriftScript, the engine's scripting language, and a project needs two
packages beside the engine for it:

```sh
npm install @driftengine/script driftscript
```

`driftscript` is the language: its compiler, its runtime and the Vite plugin. `@driftengine/script`
is what connects it to the engine. The plugin goes in the Vite config:

```ts sample=starter/vite.config.ts#plugin
import { fileURLToPath } from 'node:url';
import { driftScript } from 'driftscript/vite';
import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  plugins: [
    driftScript({
      /* The engine's capabilities, as data: every `drift/*` function, its types and its effects. */
      capabilities: fileURLToPath(import.meta.resolve('@driftengine/script/capabilities.json')),
      /* The engine modules a script in this game may import. Add one here when a script needs it;
         an import of a module not named is refused when the file compiles, naming the module. */
      manifest: { name: 'my-game', provides: ['drift/random', 'drift/scene', 'drift/input'] },
      /* `vite build` compiles for shipping: the editor's metadata stays out of the bundle. */
      mode: command === 'build' ? 'production' : 'development',
    }),
  ],
  build: {
    target: 'es2022',
    /* Just above the engine's WebGPU renderer, one module of about 2,100 kB minified that loads only
       where WebGPU does. Vite warns past 500 kB by default; anything larger than the renderer still
       warns. */
    chunkSizeWarningLimit: 2200,
  },
}));
```

`capabilities` is the engine's description of every function a script can call, as data, which is
what the compiler checks a call and infers its effects against. `manifest.provides` names the engine
modules this game's scripts may import; a script that imports one not named is refused when it
compiles, and the error names the module. [What a script can reach](../scripting/reach.md) lists
them all.

TypeScript resolves a `.drs` import through one declaration file anywhere in the project:

```ts sample=starter/drs.d.ts#types
/// <reference types="driftscript/drs" />
```

The editor extension for VS Code, `DriftTech.driftscript-vscode` on the marketplace, highlights
`.drs` files and reports the build's own errors as you type. [Setting up scripts](../scripting/setting-up.md)
covers loading, binding and hot reload.

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
a canvas that is one section of a web page, an embed, a tool, a product page, a benchmark. `?splash=0` turns it off from the
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

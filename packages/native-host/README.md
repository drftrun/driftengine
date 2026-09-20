# `@driftengine/native-host`

The engine on a native window and a native WebGPU device, with no browser between them.

A game built on the engine runs here unchanged. The host is Node, Dawn — the WebGPU implementation
Chrome runs — through `@kmamal/gpu`, SDL through `@kmamal/sdl` for the window, input and
controllers, and Web Audio from `node-web-audio-api`. Around the canvas it supplies the page a game
expects: `window`, `document`, animation frames, the browser's input events in the order Chrome
sends them, pointer lock, fullscreen, gamepads, `matchMedia`, and the desktop shell's bridge
(`__driftHost`) for storage, window modes and quit.

**A game installs it and the packager ships it.** `npm install @driftengine/native-host` in the
game, at the engine's version, and `drift-package build --target=native-linux-x64` bundles the game
with it into an archive that carries its own Node. The packager names no range on this package and
resolves it from the game's own tree, so a game that builds only for the browser or for Electron
never downloads a native binary.

**A game's contract with it is one export.** In a browser a page finds its canvas in its markup;
here there is no markup, so the manifest's `native.entry` names a module exporting
`mount(canvas)`, and the host calls it with its canvas once it has started. A game that already
mounts onto a canvas it is given needs a file of one line:

```ts
export { mount } from './game.ts';
```

`runGame` is that start, and what the packager's generated entry calls; `startHost` is the same
start without a game, for a tool that draws its own frames. `tileFiles(dir)` is the one thing a
page has no equivalent of: the texture streamer's tiles read from a directory on disk, for a
native entry to hand its streamer where a page would fetch them.

## What it is measured against

Every published scene is drawn by this host and by Chrome and compared pixel for pixel on the same
machine (`npm run native:gate` in the engine's repository). The engine's reference mix is compared
against Chrome's too. Each behaviour a page reads — an event's order, a refusal's wording, a double
click's timing — is Chrome's, measured over the DevTools protocol where it can be, and asserted by a
test beside the module that implements it.

## What it gives up

- Linux x64 is the platform it has been measured on, and the one the packager builds for. Windows
  and macOS come after 4.0.0: the three bindings publish binaries for both, and what each still
  needs is a launcher, its signing, and the same measurements against Chrome on its own GPU.
- There is no DOM beyond the canvas: `document.createElement` refuses by name, so a game's own
  HTML interface does not come with it.
- WebGL2 is not offered; the engine runs on WebGPU here.
- Clip export, `navigator.share` and WebXR are absent, and the engine says so where it asks.
- The engine's badge is not drawn, and there is no store: `steam.appId` does nothing here, which
  `drift-package doctor` says for a manifest that sets it.
- Pipelines are compiled on every start, because the binding exposes no cache for them: most of
  the start of a small program, 355 ms of 750 measured on 2026-09-19.

Apache-2.0. Dawn, SDL, Node and the Web Audio engine carry their own licences, which a packaged game
ships in its `licenses/` with every other part's. **One of them is the LGPL**: the Opus decoder
reads Ogg pages with `codec-parser`, which is LGPL-3.0, so a packaged game carries it as a file of
its own that a person can replace rather than inside the bundle, with the GPL's text beside it —
`licenses/GPL-3.0.txt` in this package, which that licence asks to accompany it.

---
title: Shipping to the web
description: Build a DriftEngine game into static files, host it anywhere, test it on a phone, and know what a web build carries and why.
packages: ['@driftengine/core']
---

# Shipping to the web

A DriftEngine game is static files. There is no server component to run and nothing to install on
the host: build the game, upload the output, and it plays in a browser.

```sh
npm run build
```

With Vite that writes `dist/`, an `index.html` beside a folder of hashed scripts and assets. Upload
that folder to any static host, a CDN bucket or a plain web server.

## What a build carries

Only what you import. Every package is tree-shaken, and each package's README states its measured
gzipped cost, checked on every change to the engine. A game that imports only `@driftengine/core` ships without the audio package, the physics workers or
the model readers.

Features that run off the main thread are separate files. The bundler finds each
`new Worker(new URL(...))` the engine uses and emits the worker beside your scripts, and it is only
fetched when the feature that owns it starts.

## Paths

If the game is served from a subfolder of a site instead of the root, tell the bundler. In Vite
that is `base`:

```js
import { defineConfig } from 'vite';

export default defineConfig({ base: '/games/arena/' });
```

Anything your own code fetches by an absolute path needs the same treatment. Audio slots are a common
case: the helper that lists a sound's candidate files defaults to `/audio`, and takes a second
argument for the folder they really live in.

## Testing on a phone

Serve the development build on your network and open it on the phone:

```sh
npm run dev -- --host
```

> [!NOTE]
> Browsers only offer WebGPU on a secure origin: `https://`, or `localhost` on the machine itself.
> A phone opening `http://192.168.1.20:5173` gets WebGL2, which is correct behaviour and a good test of
> the fallback. To test WebGPU on the phone, serve the development build over HTTPS or tunnel it to
> the phone's own `localhost`.

The quality profile you give `createRenderer` is where a phone is won or lost. `maxDevicePixelRatio`
is the first setting to lower: a phone's screen is dense, and drawing every physical pixel is the
largest single cost in most frames.

## Before you publish

- **Show the backend and the reason** somewhere a tester can see them, at least in builds you hand
  out for testing. Every report about a picture starts with which backend drew it.
- **Decide about the badge.** The engine shows its badge for three seconds after the first frame
  unless you pass `{ splash: false }`. It's a request, and turning it off is fine.
- **Reproduce the `NOTICE`.** The licence asks for it somewhere a person can read it, and the engine's
  entry points already carry it into your bundle. A credits page that repeats it is the simplest way
  to be sure.
- **Serve with compression.** Most hosts gzip or Brotli-compress scripts by default; check yours does,
  since a game's scripts compress well.

The same build can also become an installed app on Linux, Windows, macOS and Android, from one
manifest, which the shipping section of this manual covers.

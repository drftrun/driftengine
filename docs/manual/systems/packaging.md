---
title: Packaging an application
description: Turning a web build into a desktop, mobile or native application with drift-package, and the one host a game writes its settings and its exit against.
packages: ['@driftengine/package', '@driftengine/native-host']
areas: ['package']
covers: ['Packaging']
plain: ['APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_ID', 'APPLE_TEAM_ID', 'CSC_KEY_PASSWORD', 'CSC_LINK', 'DRIFT_ANDROID_KEY_ALIAS', 'DRIFT_ANDROID_KEYSTORE', 'DRIFT_ANDROID_KEYSTORE_PASSWORD', 'ELECTRON_RUN_AS_NODE', 'WIN_CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WKWebView']
---

# Packaging an application

A DriftEngine game is a web page, and [Shipping to the web](../start/shipping-to-the-web.md) puts it
on a server. `@driftengine/package` turns the same build into an installable application: a
desktop app for Linux, Windows and macOS, an Android APK, an iOS project, and on Linux a native
build that runs the engine on Node, Dawn and SDL with no browser at all. The engine never learns
which it is in. The game asks one host what it can do, and the packager supplies the right one.

## The commands

```sh
npx drift-package init                                   # the two scripts a project has to own
npx drift-package doctor                                 # is this packageable, and how would it be signed
npx drift-package run                                    # the real shell, from source, no installer
npx drift-package build --target=native-linux-x64        # an artifact
npx drift-package verify --contains=<a string from your diff>
```

`init` writes `scripts/package.mjs`, a stable entry point, and `scripts/build-windows.ps1`, which
starts Node on a Windows machine, and refuses to overwrite either once it is yours. `doctor` says what
this machine can build, how each build would be signed and what is missing, with the command that
fixes each. `verify` looks inside a finished artifact for a string you just changed, which is how to
know the build carries your edit.

## The manifest

`drift.package.json`, beside `package.json` in the project that makes the web build:

```json
{
  "id": "dev.example.title",
  "name": "Title",
  "entry": "dist/index.html",
  "publisher": "Example",
  "icon": "art/icon.png",
  "window": { "width": 1280, "height": 720, "mode": "windowed", "resizable": true },
  "backend": { "webgpu": "prefer", "allowSoftwareRenderer": false },
  "features": { "clipExport": false, "gamepad": true },
  "splash": { "show": true, "minMs": 1400 },
  "targets": ["linux-x64", "win-x64", "mac-arm64"],
  "steam": { "appId": null },
  "android": { "permissions": [], "cleartextTraffic": false }
}
```

`id`, `name`, `entry` and `targets` are required, and a refusal names the field it is about. `icon`
is a 1024 by 1024 PNG and defaults to the engine's mark. `window.mode` is what the window is created
as, `borderless` for a frameless one, and is not the mode a settings screen changes later.

## One host on every platform

```ts sample=snippets/package.ts#host
/**
 * Every capability, picked for wherever the build is running: the browser's in a tab, the shell's
 * in a desktop or mobile build. A game writes one settings screen against it and ships it to all.
 */
export async function settings(canvas: HTMLCanvasElement) {
  const host = createHost(canvas);
  await host.display.setMode('fullscreen');
  if (host.display.canSetSize()) await host.display.setSize(1920, 1080);
  /* A file beside the application in a shell, localStorage in a tab, Steam Cloud where the
     manifest names an app. The game writes the same line in all three. */
  host.store.write('settings.volume', '0.8');
  return host;
}
```

`createHost(canvas)` answers every capability [Display and the host](display.md) describes, picked
for wherever the build is running: the browser's own in a tab, and the shell's in a packaged build,
where `setSize` works, `displays()` lists the screens the shell can see, and `store` is a file beside
the application. A game writes one settings screen against it. `host.native` says which it
got, for the rare decision that needs to know. Render resolution is not the window's: a game that
wants fewer pixels lowers `resolutionScale` in its [quality](../concepts/quality.md) settings.

## Leaving the game

```ts sample=snippets/package.ts#leave
/** An exit button only where one does something, and a chance to keep the player first. */
export function leaving(canvas: HTMLCanvasElement, menu: { addExit(leave: () => void): void }) {
  const host = createHost(canvas);
  if (host.lifecycle.canQuit) menu.addExit(() => host.lifecycle.requestQuit());
  host.lifecycle.onQuitRequest(() => {
    /* A window's close button, or Android's back gesture: pause, ask, then go. */
    if (confirm('Leave the run?')) host.lifecycle.requestQuit();
  });
}
```

`canQuit` is false in a tab and on iOS, true in a desktop or Android build, and an exit button is
drawn from it. `onQuitRequest` is called before the shell closes anything. On Android the back
gesture goes to the game first: to a quit handler if there is one, otherwise as an Escape key,
since a game with no handler usually has a pause menu on Escape, and only then to closing, which
takes two presses within two seconds. A single gesture never ends a run.

## Where each artifact is built

| Target                 | Built on                           | How                                               |
| ---------------------- | ---------------------------------- | ------------------------------------------------- |
| `native-linux-x64`     | Linux on x64                       | `build --target=native-linux-x64`                 |
| `linux-x64`            | Linux                              | `build --target=linux-x64`                        |
| `win-x64`              | Windows, a virtual machine is fine | the `scripts/build-windows.ps1` that `init` wrote |
| `mac-arm64`, `mac-x64` | macOS, or Linux                    | `build --target=mac-arm64`                        |
| `android`              | anywhere                           | `build --target=android`                          |
| `ios`                  | macOS with Xcode                   | `build --target=ios`                              |

`build` refuses a target this machine cannot honestly produce. A Mac build from Linux is file
copying and an ad-hoc signature, since Apple Silicon refuses an unsigned binary outright, and comes
out as a `.zip` that should be opened on a Mac before anyone else gets it. `npx drift-package
bootstrap` fetches each target's toolchain into `~/.cache/driftengine/toolchain`, installing nothing
system-wide.

## Signing

| Mode    | When                                                 | What the player sees                                          |
| ------- | ---------------------------------------------------- | ------------------------------------------------------------- |
| `none`  | no identity, and the target does not need one        | Linux nothing; Windows warns on first run                     |
| `adhoc` | no identity, and the target needs a signature to run | macOS runs locally; a download is refused until unquarantined |
| `real`  | an identity is in the environment                    | nothing: the artifact is trusted                              |

Signing material comes from the environment, never from the manifest, which is committed:
`CSC_LINK` and `CSC_KEY_PASSWORD`, `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`, and `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` for notarisation. A Steam depot needs none of it,
because the client that delivers it is signed.

## The native target

```ts sample=snippets/package.ts#native
/**
 * The native host has no page to find a canvas in, so the manifest's `native.entry` names a module
 * that exports `mount`, and the host calls it with the canvas it made. A game that already mounts
 * onto a canvas it is given needs nothing more than this.
 */
export function mount(canvas: HTMLCanvasElement): void {
  void settings(canvas);
}
```

On Linux x64, `native-linux-x64` runs the game on `@driftengine/native-host`: Node, Dawn (the
WebGPU implementation Chrome uses) and SDL for the window, input and controllers, with the browser's
events, animation frames, pointer lock, fullscreen and gamepads supplied around the canvas. A game
installs the host at the engine's version and names a module exporting `mount(canvas)` as
`native.entry`, since there is no page to find a canvas in. The archive carries its own Node, the
bundled game, its web build for the game's own `fetch`, and every package's licence.

Measured on one machine with the starter packaged both ways, the native archive was 61 MB against
Electron's 122, built in 7 seconds against 3 minutes, and reached its first frame in 750 ms on
WebGPU, most of it compiling pipelines, which the binding cannot cache. It leaves out what a browser
adds around the canvas: the rest of the DOM, WebGL2, clip export, WebXR, the badge and a store.
Every published scene is drawn by the host and by Chrome and compared pixel for pixel by `npm run
native:gate`.

The Electron targets stay as the compatibility build: on Windows and macOS, where there is no native
host yet, and on Linux for a game that needs what the host lacks.

## Steam

```jsonc
"steam": { "appId": 480 }
```

```sh
npm install steamworks.js
npx drift-package build --target=linux-x64
npx drift-package steam --target=linux-x64    # the two files steamcmd uploads with
```

```ts sample=snippets/package.ts#store
/** Achievements, where a store build was launched by its store; null everywhere else. */
export function finishedTheGame(canvas: HTMLCanvasElement): void {
  const host = createHost(canvas);
  host.services?.unlockAchievement('FINISHED');
  host.services?.setRichPresence('Watching the credits');
}
```

With an app id in the manifest, saves go to Steam Cloud through the same `host.store`, read from the
cloud first at boot so a player on a new machine finds their settings. `host.services` carries
achievements and presence, and is `null` in a browser, where no app is named, and when the build was
started outside Steam, which is every run during development. `steamworks.js` is installed in the
game, so a game that never ships on Steam carries no SDK. The upload files set nothing live: a build
waits in Steam's admin for a person.

## Android

```sh
npx drift-package bootstrap --target=android
npx drift-package build --target=android
adb install "out/android/<Game>-<version>.apk"
```

One activity holding the platform's WebView, serving the game from an https origin so modules,
workers and `crossOriginIsolated` work, with the same host bridge the desktop has. The renderer is
the device's WebView, which is why the APK is about 20 MB, and why WebGL2 is the baseline there.

An APK asks for no permissions until the manifest does. A game that talks to a server needs
`"permissions": ["INTERNET"]`: without it every connection fails and neither end says why.
`cleartextTraffic` allows a `ws://` relay on a LAN, which cannot hold a certificate, and should stay
false for a public one.

Android refuses an unsigned APK, so without a keystore the packager generates one under
`~/.cache/driftengine/toolchain/keystores/` and says so on every build. **Back that file up.** It
is the application's identity: a phone refuses an update signed by a different key, and the only way
past is uninstalling, which deletes the player's saves. A second machine silently generates a second
key. `DRIFT_ANDROID_KEYSTORE`, `DRIFT_ANDROID_KEYSTORE_PASSWORD` and `DRIFT_ANDROID_KEY_ALIAS` take
over once there is a real one.

## iOS

```sh
npx drift-package bootstrap --target=ios
npx drift-package build --target=ios
```

A `WKWebView` serving the game over a custom scheme, with WebKit as the renderer because Apple
requires it. A clip goes to the share sheet, since there is no Downloads folder. The build is
unsigned unless `APPLE_TEAM_ID` is set. This target has not yet been built on a Mac: the bridge it
shares with Android is tested, and the Swift and the project are written against Apple's
documentation.

## What a device says about itself

```text
…/index.html?report=1
```

Draws the renderer string, whether WebGPU is offered, the secure-context answer, the platform and
the WebView build over the running game, on every platform. It matters most on a phone, where a
shader that compiled on every desktop browser can fail on WebKit alone.

## Three things that bite

- **A network drive refuses the first copy.** A share that invents file identities makes Node's
  copy believe it is copying a folder into itself. `doctor` refuses this before a build starts;
  `--out=/a/local/disk` puts the build somewhere it cannot happen.
- **`ELECTRON_RUN_AS_NODE`.** An editor's integrated terminal often exports it, and a packaged game
  that inherits it starts as plain Node and dies. The generated scripts and `drift-package run` unset
  it.
- **A fresh `npm ci` may skip the Electron binary.** `node node_modules/electron/install.js` fetches
  it, and `bootstrap` does the same.

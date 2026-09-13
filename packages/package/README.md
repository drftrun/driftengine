# `@driftengine/package`

Turns a game built on this engine into an installable application, without the engine ever
learning what a shell is.

```sh
npx drift-package init                   # writes the two scripts your repository has to own
npx drift-package doctor                 # is this project packageable, and how would it be signed
npx drift-package run                    # the real shell, from source, no installer
npx drift-package build --target=linux-x64
npx drift-package verify --contains=<a string from your diff>
```

## Start here: `drift-package init`

It writes two files into your project and nothing else:

|                             | why it cannot live in the packager                                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/build-windows.ps1` | Something has to start Node on the Windows machine, and that something cannot be a Node program                                           |
| `scripts/package.mjs`       | A stable entry point, and the one that works when the engine is vendored instead of installed, where `npx drift-package` resolves nothing |

Both refuse to be overwritten without `--force`, because once you have edited one it is yours.

**They are short on purpose, and that is the whole design.** The first project to ship on three
platforms wrote **421 lines** of wrapper before this existed, and almost none of it was about their
game: it stripped `ELECTRON_RUN_AS_NODE`, launched a binary without `npx`, read an error field
`spawnSync` does not throw, asked whether the filesystem could tell a file from a directory,
checked an exit code PowerShell ignores, fetched a runtime npm had declined to fetch, and relocated
a build off a network drive. **All of that is now in `drift-package` itself**, which is why what it
writes for you is the part that genuinely has to be a file in your repository.

What the generated PowerShell carries that a hand-written one usually does not:

- Every native command through a step that checks `$LASTEXITCODE`. `$ErrorActionPreference = 'Stop'`
  governs cmdlets and not `npm`, and PowerShell 5.1 — what a fresh Windows machine runs — has no
  `$PSNativeCommandUseErrorActionPreference`. Unchecked, a failing `npm ci` arrives as a complaint
  about a missing output directory with the real error scrolled off.
- Relocation off a mapped or network drive, **and the copy back**. Forgetting the second half is a
  fix that creates the next problem: the build succeeds, says so, lists its files, and `out/` in
  your checkout is empty.
- Pure ASCII, asserted by `scripts/packaging.test.mjs`. PowerShell 5.1 reads a BOM-less `.ps1` in
  the system ANSI codepage, so one typographic character in a comment takes the _parser_ with it.

## `drift.package.json`

Beside your `package.json`, in the project that produces the web build:

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

`id`, `name`, `entry` and `targets` are required; every rejection names the field it is about.
`icon` is a 1024x1024 PNG and defaults to the engine's own mark, because the alternative default is
Electron's logo. `window.mode` is what the window is _created_ as — `borderless` makes it
frameless — and is a different thing from the runtime mode a settings screen changes.

## Settings a game drives itself

`createHost` hands back every capability the engine takes, picked for wherever the build is
running. A game writes one settings screen and ships it to both:

```ts
import { createHost } from '@driftengine/package';

const host = createHost(canvas);

await host.display.setMode('fullscreen'); // false in a browser outside a gesture
if (host.display.canSetSize()) {
  // false in a browser, and while fullscreen
  await host.display.setSize(1920, 1080);
}
for (const screen of host.display.displays()) {
  console.log(screen.label, screen.width, screen.height, screen.refreshHz);
}
host.store.write('settings.volume', '0.8'); // a file in the shell, localStorage in a tab
```

Every call that a platform cannot perform answers `false` or `null` rather than doing nothing
quietly, so a settings screen can grey the control instead of offering one that does not work.
**And it can ask before it draws**: `canSetSize()` answers the same question `setSize` answers by
performing it, which until 2026-08-28 was the only way to learn it — reported from outside, where a
screen that wanted to decide whether to draw a resolution control at all had to resize the window to
find out, with a no-op probe at boot and a paragraph explaining that it is not what it looks like. It
is read on each call rather than a constant, because a shell that can resize a window cannot resize
one that is covering a display; in a shell the question and the refusal are decided by one function,
so a greyed control cannot be one that would have worked.
**Render resolution is not here**: covering a display never changes the display's mode, so a game
that wants fewer pixels changes `RenderQuality.resolutionScale`, which is the engine's business.

On a phone, `host.screen` carries what a window does not have — orientation, safe-area insets and
the wake lock — and each of those can be refused too. iOS refuses an orientation lock outright.

## Leaving the game

A game decides how it is left, on every platform, through two members of `Lifecycle` and one
property that says whether an exit button belongs on screen at all.

```ts
const host = createHost(canvas);

// Draw an Exit button only where one would do something: false in a browser tab, false on iOS.
if (host.lifecycle.canQuit) menu.addExitButton(() => host.lifecycle.requestQuit());

// Asked before the shell closes anything — a window's close button, or Android's back gesture.
host.lifecycle.onQuitRequest(() => {
  pause();
  confirm('Leave the run?').then((yes) => {
    if (yes) host.lifecycle.requestQuit();
  });
});
```

**On Android the back gesture goes to the game first**, in this order: a registered
`onQuitRequest` handler if there is one; failing that, a synthesised **Escape** keydown and keyup,
because a game with no quit handler almost always has a pause menu bound to that key — and
`preventDefault` is the page saying the keystroke was its own. Only if neither happens does the
host consider closing, and then it asks twice: two back presses inside two seconds with a line on
screen between them. A single gesture never ends a run.

So a game that does nothing at all still behaves: back opens its pause menu if Escape does, and
otherwise takes two presses to leave.

## Signing

Chosen from the environment and printed on every build. `doctor` says what a build would do before
it does it.

| mode    | when                                                           | what the player sees                                                                          |
| ------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `none`  | no identity, and the target does not require one               | Linux: nothing. Windows: SmartScreen warns on first run                                       |
| `adhoc` | no identity, and the target requires a signature to run at all | macOS: runs locally; from a download, Gatekeeper refuses until the quarantine flag is cleared |
| `real`  | an identity is in the environment                              | nothing: the artifact is trusted                                                              |

macOS with no certificate is `adhoc` rather than unsigned because Apple Silicon's **loader**
refuses an unsigned binary — that is not Gatekeeper, and no user gesture works around it.

Signing material is read from the environment and never from `drift.package.json`, which is
committed. The names are electron-builder's own: `CSC_LINK`, `CSC_KEY_PASSWORD`, `WIN_CSC_LINK`,
`WIN_CSC_KEY_PASSWORD`, and `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` for
notarisation.

**A Steam depot needs none of it**: the client delivering it is signed, so an unsigned Windows
build inside one raises no warning. A certificate buys direct downloads from a website.

## Steam

```jsonc
"steam": { "appId": 480 }
```

```sh
npm install steamworks.js            # in the game, not here: a game that never ships on Steam ships no SDK
npx drift-package build --target=linux-x64
npx drift-package steam --target=linux-x64   # writes the two files steamcmd uploads with
```

Three things happen once the manifest names an app.

**Saves go to Steam Cloud** and a game changes nothing to get them. `host.store` is the same
`KeyValueStore` it always was; whether those bytes land in a file beside the application or in the
cloud is the main process's decision, and the cloud is read first at boot so a player who changed
machines finds their settings. Cloud off for the title or the account degrades to the local file.

**Achievements and presence arrive** as `host.services`, which is `null` everywhere else — in a
browser, where the manifest named no app, and when the copy was launched outside Steam. That last
one is every run during development, so a game checks for null once rather than calling into
something that quietly does nothing.

**The SDK lives in the main process**, and it has to: `steamworks.js` is a native Node module and
the renderer runs sandboxed with no Node at all. The packager copies it out of the game's own
`node_modules` into the artifact and unpacks it from the asar archive, because a `.node` binary
inside one fails to load with a message about a missing path. If it is not installed, the build
says so and produces an artifact with no store rather than one whose achievements do nothing.

`drift-package steam` writes `app_build_<appid>.vdf` and `depot_build_<depotid>.vdf` beside the
artifacts, with **nothing set live** — an upload waits in Steam's admin for a person, which is
Valve's own default and the line people delete by accident. `--branch=beta` publishes to a branch;
`--depot=` overrides the depot, which otherwise defaults to the app id plus one.

## What a device says about itself

```
…/index.html?report=1
```

Draws the renderer string, whether WebGPU is offered, the secure-context answer, the platform and
the WebView build **over** the running game. It is on every platform and it is deliberately not a
secret gesture: a tester who has to be told one reports the wrong thing.

It matters most on a phone. A pinned desktop Chromium cannot see the class of failure that tier
exists to catch — WebKit enforces a sixteen-byte uniform array stride that Dawn does not, so the
shaders that draw everything compiled on every desktop browser and on no iPhone. Every value is
what the device said, and one that could not be read is shown as `—` rather than filled in.

## Getting the toolchain, on any machine

```sh
npx drift-package bootstrap                    # for the targets in drift.package.json
npx drift-package bootstrap --target=android   # or one of them
```

Nothing is installed system-wide and nothing asks for a password. Everything lands under
`~/.cache/driftengine/toolchain` (`DRIFT_TOOLCHAIN_HOME` moves it), and a machine that already has
a working `JAVA_HOME` or `ANDROID_HOME` is used as it is rather than duplicated.

| target                          | what bootstrap fetches                                                                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `linux-x64`, `win-x64`, `mac-*` | the Electron runtime, which an `npm install` with scripts disabled leaves out                                                                 |
| `android`                       | Temurin JDK 21, Google's command-line tools, the SDK licences, `platform-tools`, `platforms;android-35`, `build-tools;35.0.0`, and Gradle 8.9 |
| `ios`                           | nothing, and it says so: Xcode is an App Store install on a Mac                                                                               |

Versions are pinned in `src/toolchain.ts`. Moving one is a commit with a reason in it, because a
build that quietly changed its build tools is a build whose output changed for no recorded reason.

`doctor` tells you which targets this machine is not ready for, and prints the command that fixes
each one.

## Android

```sh
npx drift-package bootstrap --target=android
npx drift-package build --target=android
adb install "out/android/<Game>-<version>.apk"
```

The host is one activity holding a WebView, serving the game from
`https://appassets.androidplatform.net/` — an https origin, so a secure context, so ES modules,
workers and `crossOriginIsolated` all work without a loopback server listening inside a game. The
bridge is injected before the game's own scripts through `addDocumentStartJavaScript`, which is the
mobile equivalent of the desktop preload, so `createHost` finds the same `__driftHost` it finds on
the desktop.

### An APK asks for nothing until a game says so

The manifest template declares one activity and **no permissions**, which is the right default: a
permission is visible in the store listing, and a packager that granted the network to every game
it ever built would be asking on behalf of games that never use it. A game that needs the network
says so:

```json
"android": { "permissions": ["INTERNET"], "cleartextTraffic": false }
```

`"INTERNET"` and `"android.permission.INTERNET"` are both accepted, and the elements are written
into the copied Gradle project before Gradle runs — the same copy the icon is written into, so
nothing in this repository is touched by a consumer's build. `drift-package doctor` prints what was
asked for, and `aapt2 dump permissions <apk>` is how to confirm it landed.

**Without it every connection fails and nothing says why.** The process is not permitted to open a
socket, so the game reports that it could not connect and the server logs nothing at all, because
no packet leaves the phone. That is the same silence on both ends, and it is indistinguishable from
a wrong address.

### Reaching a relay that has no certificate

`cleartextTraffic` is the second half, and it is false by default. The game is served from an https
origin, so a WebView will not open `ws://` from it: a WebView defaults to `MIXED_CONTENT_NEVER_ALLOW`,
which is stricter than a browser tab, where the same connection succeeds with a deprecation warning
(measured on Chrome 151 against a LAN address). Setting it true writes
`android:usesCleartextTraffic="true"` **and** is what `MainActivity` reads back at runtime, through
`NetworkSecurityPolicy`, to allow mixed content in the WebView. One switch, so the platform and the
renderer cannot disagree — which they would if only the manifest moved.

Set it only for the case it exists for: a relay on a LAN, which cannot hold a certificate for an
address that is not a name. A public relay should be `wss://` and this should stay false.

**Signing is not optional here and there is no unsigned option to offer**: Android refuses to
install an unsigned APK at all. Without a keystore the packager generates one and says so on every
build. That APK installs on a device with developer mode on; it cannot go to the Play Store.

**The generated key is in the toolchain cache, and it is the application's permanent identity:**

```
~/.cache/driftengine/toolchain/keystores/<your app id>.jks    alias drift, password driftengine
```

Not beside the artifact — this page said that until 2026-08-29 and it was wrong, which matters
because of what the file is. A device refuses an upgrade signed with a _different_ key, reading it
as a different application wearing the same name, and the only way out on the phone is to
uninstall, which throws away the player's save. Three things follow, and the first is the one to
act on today:

- **Back it up.** It lives under `~/.cache`, a directory whose entire purpose is being safe to
  delete. Losing it means everybody who installed a build has to uninstall before they can install
  the next one.

  ```sh
  cp ~/.cache/driftengine/toolchain/keystores/<your app id>.jks ~/wherever-you-keep-things/
  ```

- **A second machine makes a second key, silently.** Build somewhere else and the packager finds no
  keystore for that application id and generates a fresh one: a valid APK, signed by a stranger as
  far as any phone holding the first is concerned. A game that will ever be built on two machines
  needs an owned key, not the generated one.

- **Check before you send.** `doctor` says which key a build would use before it spends the minutes,
  and the build prints it again on the way past. To verify an APK you are about to hand somebody:

  ```sh
  ~/.cache/driftengine/toolchain/android-sdk/build-tools/35.0.0/apksigner \
    verify --print-certs out/android/<your game>.apk
  ```

  If the digest is not the one you expect, **do not send that file** to anybody who already has a
  build installed: it will not install over the top, and the message the phone shows says nothing
  about signing.

`DRIFT_ANDROID_KEYSTORE`, `DRIFT_ANDROID_KEYSTORE_PASSWORD` and `DRIFT_ANDROID_KEY_ALIAS` take over
the moment there is a real one, through the environment and never through `drift.package.json`,
which is committed.

**The renderer is the platform's WebView, not a bundled Chromium.** That is the whole reason a
mobile build is 20 MB rather than 200, and it is also why WebGL2 is the baseline there: what the
device offers is what the game gets, and the acceptance probe decides.

## Where each artifact is built

An artifact is built on the platform it targets, with one exception, and `build` refuses the ones
this machine cannot honestly produce.

| target                 | built on                        | how                                                                                     |
| ---------------------- | ------------------------------- | --------------------------------------------------------------------------------------- |
| `linux-x64`            | Linux                           | `npx drift-package build --target=linux-x64`                                            |
| `win-x64`              | Windows, a VM is fine           | `drift-package init` writes `scripts/build-windows.ps1` into your project; run it there |
| `mac-arm64`, `mac-x64` | macOS, **or Linux**             | [`scripts/build-macos.sh`](scripts/build-macos.sh), or `build --target=mac-arm64`       |
| `android`              | anywhere, the toolchain is Java | `npx drift-package build --target=android`                                              |
| `ios`                  | macOS with Xcode                | `npx drift-package build --target=ios`                                                  |

**macOS is the exception, and only from Linux.** Nothing in a Mac build is compiled: Electron ships
a prebuilt darwin runtime, so packing one is file copying and a plist. What stopped it was never
the artifact but the signature — electron-builder skips signing anywhere but a Mac, and Apple
Silicon's loader refuses an unsigned binary outright — so a cross-build applies an ad-hoc signature
with `rcodesign`, which `bootstrap` fetches. Two things a Linux host cannot do are named rather
than worked around: there is no `.dmg`, because that is `hdiutil`, so the artifact is a `.zip`; and
only the machine it runs on can prove it launches, so open one on a Mac before it reaches anybody
else. A Developer ID in `CSC_LINK` is **refused** here rather than ignored, because a build that
came out ad-hoc while reporting a certificate is the one that gets sent to strangers by mistake.

Windows deliberately does not go through Wine: the NSIS target can be cross-built and the signing
step cannot reach a Windows certificate store, so the platform whose warnings are hardest to shake
would be the one built with no way to sign it.

### `--out=<dir>`, for a project on a filesystem that misreports itself

Everything lands in `out/<target>/` inside the project unless `--out=` says otherwise:

```sh
npx drift-package build --target=win-x64 --out=C:\drift-out
```

The layout under the root is the same, so that gives `C:\drift-out\win-x64\stage`. An absolute
path is used as it stands; a relative one resolves against wherever you ran the command, which is
not necessarily `--project=`.

**It exists because a staging copy can refuse itself.** Node's `fs.cp` will not copy a thing into
itself and decides that by walking the destination's ancestors comparing `dev` and `ino` against
the source. On a normal disk this never fires. Measured by a consumer on a Windows VM with the
project on a drive mapped to a folder on a Linux machine, `drift.package.json` and `out/` both
answered `dev=66313 ino=-112686486700016` — one identity for a file and a directory — and the very
first copy of the build failed with a sentence about copying a file into a subdirectory of itself,
which is the one thing that was not happening. Point `--out=` at a local disk and the condition
cannot arise.

## iOS

```sh
npx drift-package bootstrap --target=ios    # fetches XcodeGen; Xcode is an App Store install
npx drift-package build --target=ios
```

One view controller holding a `WKWebView`, serving the game over a custom scheme through
`WKURLSchemeHandler` — `file://` is not an origin, and a game loaded from one fails to import its
own modules. The renderer is WebKit and there is no choice about that: Apple requires it, which is
why the engine's WebGL2 baseline matters here and why the acceptance probe decides whether WebGPU
is among what the device offers.

**The synchronous problem is worse than Android's.** A `WKScriptMessageHandler` is one-way and
there is no synchronous return from native code to JavaScript at all — so everything the engine
must read synchronously is _injected_ as a literal before the page's first line of script, and only
the mutations are messages. `WKScriptMessageHandlerWithReply` is what lets a save report whether it
worked, and it is why the deployment target is iOS 15.

Saving goes to the share sheet, because there is no Downloads folder on this platform: a clip is
written to the temporary directory and handed to `UIActivityViewController`, so the player sends it
to Photos, Files or a message.

**Unsigned unless `APPLE_TEAM_ID` is set.** Apple's free tier signs a build for your own device for
seven days at a time through Xcode's own interface rather than through anything a script can drive,
so the default output is an archive and an unsigned `.ipa` — the shape a sideloading tool re-signs.

**Not yet run on a Mac.** The Swift, the project spec and the build step are written against
Apple's documented behaviour and nothing here has compiled them. What is not guessed is the bridge,
which is shared with Android and tested, and the containment rule in the scheme handler, which
mirrors the desktop shell's. **One question still gates the tier**: whether WebKit treats a custom
scheme as a secure context. If it does not, `crossOriginIsolated` is false and the answer is a
loopback server — `SchemeHandler.swift` is the only file that changes, and
`drift://localhost/__drift/originProbe.html` answers it in one look on a device. The host must be
`localhost`, since that is what makes the origin trustworthy at all, and the shell's own assets
live under `__drift/` rather than behind a second host for the same reason.

## Three things that will bite

**A network share refuses the first copy of a build, and blames itself.** `fs.cp` walks the
destination's parents and compares each one's `dev` and `ino` with the source's, to avoid copying
something into itself. A redirector that gets no file index from the server invents a constant one,
and on Windows `dev` is already the volume's serial number — so a file and a folder on the same
share compare identical and a perfectly legitimate copy is refused, with `cannot copy … to a
subdirectory of self …` ten minutes into a build, about the thing furthest from the cause.

**`drift-package` already refuses this before a build starts, so you do not need to check for it.**
`doctor` refuses it first, which is where it belongs for a person's time — a build that cannot
succeed should stop before it downloads a runtime — and `stageApp` refuses it again immediately
before its first copy, which is where it belongs for correctness. The second one is not redundant:
this package's `exports` map is `"./*": "./*"`, so staging is importable directly and a route that
never passes through `doctor` would otherwise get the `cp` message. It also runs before the previous
stage directory is removed, so a refused build keeps its last good output.

What it prints names the volume, both witnesses with their `dev` and `ino`, and the remedy —
`drift-package build --out=/a/local/disk`, which is cheaper than moving a project with tens of
gigabytes of assets. If your launcher carries a copy of this check, it can go.

**`ELECTRON_RUN_AS_NODE`.** Any Electron-based terminal — an editor's integrated one is the common
case — exports this for the processes it spawns, and it turns Electron into plain Node. A packaged
game inheriting it prints a Node banner and dies on `Cannot find module 'electron'`. Both scripts
above unset it and so does `drift-package run`.

**A fresh `npm ci` may not fetch the Electron binary.** The package installs; its postinstall,
which downloads the runtime, is skipped by some environments. `node node_modules/electron/install.js`
fetches it.

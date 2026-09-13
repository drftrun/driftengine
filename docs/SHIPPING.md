# Shipping the game

**Written 2026-08-27, against engine 3.12.0.** The route from _a game that runs in a browser tab_
to _a game somebody installs_, in the order it has to be done.

[`packages/package/README.md`](../packages/package/README.md) is the operational reference for
`drift-package`: every manifest field, every signing mode, what `bootstrap` fetches, how the Android
and iOS hosts differ. **Read it before changing anything.** What this document adds is the part it
does not carry: the order, what a consumer has to own for itself, and the handful of decisions that
are cheap now and expensive in six months.

Everything below is a path that has been walked: a production game ships from one manifest as a web
build and as five packaged targets, the packager was built against that route, and the artifacts in
[`README.md`](../README.md)'s packaging row are the ones it produced.

---

## 1. What has to be true before you start

Packaging wraps a web build. It does not change one and it cannot rescue one, so the game has to be
a finished static build first.

| Requirement                                                             | Why                                                                                                                                                                                                               |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The project sits beside this repository                                 | Every engine dependency is a `file:` path, and the packager is invoked from the engine checkout. `DRIFT_ENGINE` overrides the location                                                                            |
| `npm run build` produces a directory with an `index.html` in it         | That directory is copied into the artifact whole                                                                                                                                                                  |
| Assets resolve from the site root                                       | The shell serves the build from `drift://app/` on the desktop and from an `https://` origin on Android, both roots. A bundler's default absolute base is correct, and a relative one is neither needed nor tested |
| Nothing in the build reaches an origin that only exists on your machine | An absolute `https://` call still works inside a shell. A relative call to something only a dev server proxies does not                                                                                           |
| The game asks the host rather than assuming a browser                   | See §5. A shell has no address bar, no tab to close, and a back gesture that means something else                                                                                                                 |

---

## 2. The three files a consumer adds

A shipping consumer adds exactly three things. Nothing else in its repository needs to know that
packaging exists.

### `drift.package.json`, at the project root

Everything an artifact contains is decided here:

```json
{
  "id": "app.example.title",
  "name": "Title",
  "entry": "packages/game/dist/index.html",
  "publisher": "Example",
  "icon": "packages/game/public/icon-1024.png",
  "window": { "width": 1600, "height": 900, "mode": "windowed", "resizable": true },
  "backend": { "webgpu": "prefer", "allowSoftwareRenderer": false },
  "features": { "clipExport": true, "gamepad": true },
  "splash": { "show": true, "minMs": 1400 },
  "targets": ["linux-x64", "win-x64", "mac-arm64", "android"],
  "steam": { "appId": null }
}
```

Four fields decide things that are painful to change later:

- **`id`** is reverse-DNS and is the application's identity on every platform at once. It picks the
  directory saves are written to, and on Android it is half of what makes an upgrade an upgrade
  rather than a different application. Changing it after anybody has installed the game orphans
  their saves, silently.
- **`entry`** is the _built_ `index.html`, and its directory is what gets copied. Pointing it at the
  source one packages the sources.
- **`icon`** wants a 1024x1024 PNG. Left out, the artifact carries the engine's own mark, which is
  better than the runtime's default logo and is still not yours.
- **`targets`** is the list `bootstrap` and the all-targets build work from. Naming a target nobody
  has built is how an unproven tier gets claimed; §8 says what that costs.

`backend.webgpu: "prefer"` is what every shipping target wants: WebGPU where the device gives a
working one, WebGL2 underneath, decided by drawing with the device rather than by asking whether it
exists.

### A thin wrapper script

Twenty lines that answer two questions and no others: _where is the engine_, and _can this machine
honestly build that target_. Everything deciding what an artifact contains stays in the manifest,
so the same commands work on a laptop, a borrowed Mac and a Windows VM without three sets of
instructions.

```js
const ENGINE = process.env.DRIFT_ENGINE ?? resolve(ROOT, '..', 'driftengine');
const CLI = join(ENGINE, 'packages', 'package', 'src', 'cli.ts');

spawnSync('npx', ['tsx', CLI, ...args, `--project=${ROOT}`], {
  stdio: 'inherit',
  cwd: ENGINE,
  // An Electron-based terminal exports this for everything it spawns, and it turns the
  // packaged artifact into one that dies on a missing module. See §8.
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
});
```

The reference consumer's copy adds one thing worth taking with it: a table of which target builds on
which host, so an impossible target is refused with a sentence instead of producing an artifact that
will not launch.

### The npm scripts

```json
"package:doctor": "node scripts/package.mjs doctor",
"package:bootstrap": "node scripts/package.mjs bootstrap",
"package:linux": "npm run build && node scripts/package.mjs build --target=linux-x64",
"package:windows": "npm run build && node scripts/package.mjs build --target=win-x64",
"package:mac": "npm run build && node scripts/package.mjs build --target=mac-arm64",
"package:android": "npm run build && node scripts/package.mjs build --target=android",
"package:all": "npm run build && node scripts/package.mjs all"
```

Each one builds the web bundle first, on purpose. A packaged artifact around a stale build directory
is the failure that looks finished and ships last week's game.

---

## 3. The first run, in order

```sh
npm run build             # the web bundle, which everything else wraps
npm run package:doctor    # what is configured, how each target would sign, what is missing
npm run package:bootstrap # fetch the toolchains doctor named
npm run package:linux     # or whichever target this machine can honestly produce
```

`doctor` is the step people skip and should not. It prints the manifest as the packager read it, the
signing mode each target would use _and why_, and, for anything this machine is not ready for, the
exact `bootstrap` command that fixes it. It costs a second, and it moves a Gradle failure from
twenty minutes into a build to before one.

`bootstrap` installs nothing system-wide and asks for no password. Everything lands under
`~/.cache/driftengine/toolchain` (`DRIFT_TOOLCHAIN_HOME` moves it): a Temurin JDK, the command-line
tools, the SDK licences and Gradle for Android; `rcodesign` when a Mac target is built off a Mac;
the Electron runtime for the desktop. A machine that already has a working `JAVA_HOME` or
`ANDROID_HOME` is used as it is. Xcode is the one thing it cannot fetch, and it says so.

There is a fourth command worth knowing before you need it:

```sh
npx drift-package run    # the real shell, from source, with no installer
```

It stages exactly what a build stages and starts the shell on it, so the window, the flags, the
`drift://` origin and the badge are the ones that will ship. It is the fastest way to find out that
the game does something a tab tolerated and a shell does not.

---

## 4. Where each artifact is built

An artifact is built on the platform it targets, with one exception, and `build` refuses the ones a
machine cannot honestly produce rather than making something that will not launch.

| target      | built on                        | result                                                   |
| ----------- | ------------------------------- | -------------------------------------------------------- |
| `linux-x64` | Linux                           | an AppImage and a tarball                                |
| `android`   | anywhere, the toolchain is Java | a signed APK                                             |
| `mac-arm64` | a Mac, **or Linux**             | a `.dmg` and a `.zip` on a Mac; a `.zip` only from Linux |
| `win-x64`   | Windows, a VM is fine           | an installer                                             |
| `ios`       | a Mac with Xcode                | an archive and an unsigned `.ipa`                        |

An all-targets build makes what this machine can and **names what it skipped**, because a silent
skip reads as a build that covered everything.

**macOS from Linux is the exception, and it is worth understanding rather than trusting.** Nothing
in a Mac build is compiled: the runtime ships a prebuilt darwin binary, so packing one is file
copying and a plist. What blocked it was always the signature, since the builder skips signing
anywhere but a Mac and Apple Silicon's _loader_ refuses an unsigned binary outright. The packager
applies an ad-hoc signature with `rcodesign` instead. Two things a Linux host still cannot do, both
named rather than worked around:

- **No `.dmg`.** That is `hdiutil`, which is macOS. The artifact is a `.zip`.
- **No proof it launches.** Only the machine it runs on can tell you that. Open one on a Mac before
  it reaches anybody, and move the `.zip` itself rather than an unpacked bundle: a macOS bundle is
  built out of symlinks, and a FAT or exFAT stick destroys them along with the executable bits.

A Developer ID certificate in `CSC_LINK` is **refused** on a Linux host rather than ignored, which is
correct: a build that came out ad-hoc while reporting a certificate is the one that gets sent to
strangers by mistake.

**Windows deliberately does not go through Wine.** The installer target can be cross-built and the
signing step cannot reach a Windows certificate store, so the platform whose warnings are hardest to
shake would be the one built with no way to sign it.

---

## 5. What the game itself has to implement

This is the half that is not configuration, and the half a consumer usually underestimates. The
engine names no shell: it takes host capabilities as parameters, so the same game runs in a tab and
inside an application, and the game asks rather than assumes.

```ts
import { createHost } from '@driftengine/package';

const host = createHost(canvas);
```

**A settings screen is built from what the host answers**: window mode, surface size, the display
list and its refresh rates, orientation and safe areas on a phone, file dialogs, and store services.
Every call a platform cannot perform answers `false` or `null` rather than doing nothing quietly,
which is what lets a menu grey a control out instead of offering one that misleads. Render
resolution is _not_ here: covering a display never changes the display's mode, so a game that wants
fewer pixels moves `RenderQuality.resolutionScale`, which is the engine's business.

**Leaving the game is the one a browser never made you think about.**

```ts
if (host.lifecycle.canQuit) menu.addExitButton(() => host.lifecycle.requestQuit());

host.lifecycle.onQuitRequest(() => {
  pause();
  confirm('Leave?').then((yes) => {
    if (yes) host.lifecycle.requestQuit();
  });
});
```

`canQuit` is false in a tab and on iOS, so a button drawn from it appears only where it does
something. On Android the back gesture reaches the game first: a registered handler if there is one,
otherwise a synthesised Escape keydown and keyup, on the assumption that a game with no quit handler
almost always has a pause menu bound to that key. Only if neither happens does the host consider
closing, and then it asks twice. **A game that implements none of this still behaves**, which is the
point, and a game that implements the handler behaves the way it chose.

**Saving goes through `host.store`**, a `KeyValueStore` wherever it runs: `localStorage` in a tab, a
file beside the application in a shell, and Steam Cloud once the manifest names an app id, with the
game changing nothing to get the last one.

**`?report=1` is on every platform and is deliberately not a secret gesture.** It draws the renderer
string, whether WebGPU was offered, the secure-context answer, the platform and the WebView build
over the running game. Tell testers about it. It matters most on a phone, where a pinned desktop
browser cannot see the class of failure that tier exists to catch.

---

## 6. Signing, and the two things you can lose

Signing material is read from the environment and never from `drift.package.json`, which is
committed. Every build prints which mode it used and why. What a player sees:

| mode    | when                                           | what happens to them                                                               |
| ------- | ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| `none`  | no identity, target does not need one          | Linux: nothing. Windows: a warning on first run                                    |
| `adhoc` | no identity, target refuses to run without one | macOS: runs locally; from a download, refused until the quarantine flag is cleared |
| `real`  | an identity is in the environment              | nothing at all                                                                     |

**A store depot needs none of it.** The client delivering the build is signed, so an unsigned Windows
build inside one raises no warning. A certificate buys direct downloads from a website, which is a
different product decision from a store listing.

Two secrets are unrecoverable, and only one of them is obvious:

1. **The Android signing key.** Android identifies an application by its key, so a device refuses an
   upgrade signed with a different one, as an impostor. Without a keystore the packager generates
   one, **keeps** it under `~/.cache/driftengine/toolchain/keystores/` keyed by application id, and
   says so on every build. That directory is outside the project and nothing backs it up. Lose it
   and every player has to uninstall, which loses their saves. Back it up the day the first APK
   leaves the machine, and move to `DRIFT_ANDROID_KEYSTORE` and its two companions once there is a
   real one.
2. **The Apple identity**, for the reason everybody already knows.

---

## 7. Verifying a build before it reaches anybody

An artifact that exists is not an artifact that is current. The packager ships the check:

```sh
npx drift-package verify --contains="<a string from your diff>"
```

It looks for that string in every file under the entry's directory and fails if it finds none, which
is what a build that did not rerun looks like. Use a string from the change you just made, never a
filename and never a hash: an asset hash moving proves a rebuild happened, not that it contains your
work.

Before an artifact goes to anybody who is not you:

- [ ] `doctor` is clean, and the signing line for the target says what you expect.
- [ ] The build was made after the last commit you care about, proved by `verify --contains=`.
- [ ] The artifact was launched on the platform it targets. For a Mac build made on Linux this is
      not optional, because the host that built it cannot tell you it starts.
- [ ] `?report=1` on the real device shows the backend and the secure-context answer you expected.
- [ ] A save was written, the application was closed and reopened, and the save came back.
- [ ] The quit path was used, once through the exit control and once through the window button or
      the back gesture.

---

## 8. The traps, each of which has cost a day

- **`ELECTRON_RUN_AS_NODE`.** Any Electron-based terminal, which includes an editor's integrated
  one, exports this for every process it spawns, and it turns Electron into plain Node. An artifact
  built under it dies on a missing module. The engine's CLI unsets it for the app it launches and
  the wrapper in §2 unsets it for the build, which is why that wrapper is not two lines shorter.
- **WebGPU and clip export on Linux, together.** The flags that turn WebGPU on once encode canvas
  frames as all-zero green video, silently, while every API reported success. The packager moved to
  `ForceEnableWebGpuInterop`, which composites WebGPU through GL rather than moving ANGLE onto
  Vulkan, and both hold now, measured. A green clip out of a packaged build is that neighbourhood
  rather than your encoder.
- **A stale build directory.** Covered by building first in every script, and it still happens when
  somebody runs `drift-package build` directly. §7 is the answer.
- **A macOS bundle moved as a folder.** Symlinks and executable bits, gone. Move the `.zip`.
- **An APK that installs on a phone and cannot go to a store.** That is the generated debug key doing
  exactly what it says. Fine for testing, and it is not a route to a listing.
- **iOS, which is written and has never been compiled.** The Swift host, the scheme handler, the
  project spec and the build step all exist and no machine has run them. Expect to fix something on
  the first run: that is the honest expectation rather than a worry. The one open question is
  whether WebKit treats the custom scheme as a secure context. Load
  `drift://localhost/__drift/originProbe.html` on the first device and read the table: the host has
  to be `localhost`, because that is what makes the origin trustworthy, and the shell's own assets
  are served under `__drift/` for the same reason. If the answer is no, the fallback is a loopback
  server and one file changes.

---

## 9. Steam, when there is one

```jsonc
"steam": { "appId": 480 }
```

```sh
npm install steamworks.js                     # in the game, not in the engine
npx drift-package build --target=linux-x64
npx drift-package steam --target=linux-x64    # writes the two files steamcmd uploads
```

Naming an app id does three things. Saves move to Steam Cloud with the game changing nothing, since
`host.store` was always the seam. `host.services` appears for achievements and presence, and is
`null` everywhere else, including every development run outside the client, so check for null once
rather than calling into something that quietly does nothing. And the SDK is copied into the main
process out of the game's own `node_modules`, because it is a native module and the renderer runs
sandboxed with no Node at all.

`drift-package steam` writes the app and depot files beside the artifacts with **nothing set live**,
so an upload waits in the store's admin for a person. That is the platform's own default and the
line people delete by accident.

---

## 10. What the reference consumer does that you need not copy

Not everything in a shipping project is packaging, and a second game inheriting all of it would be
inheriting a shape rather than a route.

- **Its web deploy.** Serving a build is one thing and packaging one is another; they share only the
  build step. Each project owns its own hosting.
- **Its asset and release-notes build steps.** They run before a build because that game generates
  audio and publishes notes, not because a packaged build needs either.
- **Five targets.** Start with the two that need no borrowed hardware, `linux-x64` and `android`,
  and add the rest as machines become available.

---

## 11. When the engine changes underneath you

A consuming project symlinks this working tree, so there is no version gate between a commit here
and a build there. That is the whole reason the split was affordable, and it is also why a packaged
build is worth remaking after an engine change that touched a hot path, the public barrel, or
`packages/package/` itself.

`packages/package/README.md` is the document that moves when the packager does. If something here
contradicts it, that one is right and this one needs a commit.

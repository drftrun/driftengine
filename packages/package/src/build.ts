import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildAndroid } from './android.ts';
import { buildIos } from './ios.ts';
import { crossSignMacApp, zipMacApp } from './macCrossSign.ts';
import type { PackageManifest, Target } from './manifest.ts';
import { buildNative } from './native.ts';
import { outFor } from './outDir.ts';
import { resourceFile } from './resources.ts';
import { ensureElectronRuntime } from './runtime.ts';
import type { ResourceOptions } from './resources.ts';
import { planSigning } from './signing.ts';
import { consumerVersion, stageApp } from './stage.ts';
import { findRcodesign } from './toolchain.ts';

/**
 * An installable artifact per target.
 *
 * **The builder configuration is derived, not authored.** Every value it needs is already in
 * `drift.package.json`, and a second configuration file would be a second place for the
 * application id to be wrong — which is the failure that is silent until saves land in a directory
 * nobody looks in.
 *
 * **Linux gets a native artifact and that is a Steam Deck decision**, recorded here because it
 * looks like an ordinary target otherwise: a Windows build under Proton is the default assumption
 * and it carries a known regression — gamepads undetected in Electron under Proton after 26.6.10,
 * where the same build works natively. Valve's own guidance points the same way.
 *
 * **A target is refused where this machine cannot honestly produce it**, and the interesting word
 * is *honestly*: the danger was never a build error, it is an artifact that looks finished and
 * will not launch, or one that cannot be signed. `scripts/` carries the Windows and macOS hosts.
 *
 * **macOS is the one target that moved off that rule, and only from Linux.** Nothing in a Mac
 * build is compiled — Electron ships a prebuilt darwin runtime and packing it is file copying and
 * a plist — so the artifact itself was never the problem. The signature was: electron-builder
 * skips signing off darwin, and an unsigned binary is refused by Apple Silicon's loader. With
 * `rcodesign` putting an ad-hoc signature on afterwards, the two things a Linux host still cannot
 * do are named rather than worked around — there is no `.dmg`, because that is `hdiutil`, and
 * there is no proof it launches, because that needs the machine it runs on. See `macCrossSign.ts`.
 */
const HOST_FOR: Readonly<Record<Target, NodeJS.Platform | null>> = {
  'win-x64': 'win32',
  'mac-arm64': 'darwin',
  'mac-x64': 'darwin',
  'linux-x64': 'linux',
  /* The native host ships the Node that runs the build and the binaries installed beside it;
     `native.ts` refuses the machine itself, architecture included. */
  'native-linux-x64': 'linux',
  /* Android's toolchain is Java and it runs anywhere; iOS needs Xcode, which is a Mac. */
  android: null,
  ios: 'darwin',
};

/**
 * Why this machine cannot build that target, or null.
 *
 * A Mac target is allowed from Linux and still refused from Windows — that second refusal is
 * electron-builder's own and would fire a few seconds later anyway, so it is stated here where
 * the reason can be given.
 */
function refuseHost(target: Target, platform: NodeJS.Platform): string | null {
  const host = HOST_FOR[target];
  if (host === null || platform === host) return null;

  if ((target === 'mac-arm64' || target === 'mac-x64') && platform === 'linux') return null;

  if (target === 'mac-arm64' || target === 'mac-x64') {
    return (
      `${target} is cross-built from Linux and built natively on a Mac, and this is ${platform}. ` +
      'electron-builder refuses a Mac target on Windows outright, so there is nothing to work ' +
      'around here.'
    );
  }

  return (
    `${target} is built on ${String(host)}, and this is ${platform}. ` +
    'See packages/package/scripts for the Windows and macOS hosts; cross-building under ' +
    'Wine cannot reach a certificate store, which is the one platform where that matters.'
  );
}

export async function build(
  manifest: PackageManifest,
  cwd: string,
  targets: readonly Target[],
  options: ResourceOptions = {},
): Promise<void> {
  for (const target of targets) {
    if (target === 'android') {
      await buildAndroid(manifest, cwd, outFor(cwd, target, options), options);
      continue;
    }
    if (target === 'ios') {
      await buildIos(manifest, cwd, outFor(cwd, target, options), options);
      continue;
    }
    if (target === 'native-linux-x64') {
      await buildNative(manifest, cwd, outFor(cwd, target, options));
      continue;
    }
    const refusal = refuseHost(target, process.platform);
    if (refusal !== null) throw new Error(refusal);

    /*
     * **Electron's builder and version are read here, for an Electron target**, rather than before
     * the loop: a build of the native target alone needs neither.
     *
     * One artifact per target, and the architecture is named rather than inherited: a build on an
     * Apple Silicon machine defaults to arm64, so `mac-x64` asked for on one would quietly produce
     * the wrong slice.
     */
    const { build: run, Arch, Platform } = await import('electron-builder');
    const targetFor = (name: Target): ReturnType<typeof Platform.LINUX.createTarget> =>
      name === 'win-x64'
        ? Platform.WINDOWS.createTarget(undefined, Arch.x64)
        : name === 'linux-x64'
          ? Platform.LINUX.createTarget(undefined, Arch.x64)
          : Platform.MAC.createTarget(undefined, name === 'mac-x64' ? Arch.x64 : Arch.arm64);
    const electronVersion = await installedElectronVersion();

    /*
     * **The runtime, before anything is staged.** `installedElectronVersion` below reads a version
     * out of `electron/package.json`, which is in the npm tarball — so it answers even when the
     * postinstall that downloads the actual binary never finished, and electron-builder then finds
     * nothing to package several steps and several minutes later. Measured in this repository on
     * 2026-08-29: a version of 43.4.1 against no `dist`. See `runtime.ts`.
     */
    await ensureElectronRuntime();

    const signing = planSigning(target, process.env, process.platform);
    if (signing.refusal !== null) throw new Error(`${target}: ${signing.refusal}`);
    console.log(`[drift-package] ${target}: signing ${signing.mode} — ${signing.reason}`);

    /*
     * **Looked up before anything is staged.** Signing is the last step of a build that takes
     * minutes, and a missing signer discovered there costs the whole thing — so the tool is
     * resolved while the failure is still cheap.
     */
    const rcodesign = signing.crossSign ? await findRcodesign() : null;
    if (signing.crossSign && rcodesign === null) {
      throw new Error(
        `${target} is signed here by rcodesign, and there is none on this machine. ` +
          `Run \`drift-package bootstrap --target=${target}\`, which fetches it into a cache.`,
      );
    }

    const outDir = outFor(cwd, target, options);
    const stageDir = join(outDir, 'stage');
    await stageApp(manifest, cwd, stageDir, { development: false, ...options });

    /* Where the signing step found the `.app`, so the archive below does not have to guess at
       electron-builder's own naming for the packed directory. */
    const signed: { app: string | null } = { app: null };

    await run({
      targets: targetFor(target),
      /*
       * **The staged directory is the project, not just the application.** Pointed at the
       * consumer's own directory instead, electron-builder looks for *their* `package.json`,
       * tries to install *their* dependencies into the artifact, and fails on a project that
       * has neither — which a game built by any other toolchain may well not.
       */
      projectDir: stageDir,
      config: {
        appId: manifest.id,
        productName: manifest.name,
        electronVersion,
        /* One 1024px PNG for all three platforms: electron-builder derives an `.ico` and an
           `.icns` from it, and a game that supplies its own replaces exactly this line. */
        icon:
          manifest.icon === null
            ? await resourceFile('assets', 'icon.png', options.resourceRoot)
            : resolve(cwd, manifest.icon),
        directories: { output: outDir },
        /* The staged directory is the application, whole. Nothing is filtered here because
           nothing that should not ship was put there: see `stage.ts` for what it contains. */
        files: ['**/*'],
        /*
         * **A native module cannot be loaded from inside an asar archive.** `steamworks.js` is a
         * `.node` binary, and one packed into the archive fails at `require` with a message about
         * a path that does not exist — which reads as a missing dependency rather than as a
         * packing decision. Unpacked, and only it.
         */
        asarUnpack: ['**/node_modules/steamworks.js/**'],
        /*
         * **The signature goes on between packing and archiving, and that ordering is the whole
         * point.** `afterPack` runs once the `.app` is complete and before any target wraps it, so
         * the signed bundle is the one that ends up inside the `.zip`. Signing afterwards would
         * leave the artifact people download carrying the unsigned copy.
         */
        afterPack: rcodesign === null ? undefined : macSignStep(rcodesign, target, signed),
        mac: {
          hardenedRuntime: signing.mode === 'real',
          category: 'public.app-category.games',
          /*
           * `'-'` is `codesign`'s own spelling of an ad-hoc identity. `null` means *do not sign*,
           * which on Apple Silicon means *does not run* — and is exactly right when this build
           * signs the app itself a few lines below, because electron-builder would otherwise log
           * a warning about skipping a step that is not being skipped.
           */
          identity: signing.crossSign ? null : signing.mode === 'adhoc' ? '-' : undefined,
          notarize: signing.notarise,
          /*
           * **Both of electron-builder's Mac archives are macOS-only, for different reasons.** A
           * `.dmg` is built by `hdiutil`, which exists nowhere else. Its `.zip` is worse than
           * unavailable: it is produced by 7-Zip off darwin, which dereferences the symlinks every
           * `.framework` is made of, and the result is a corrupt bundle rather than an error.
           *
           * So a cross-build asks for `dir` — pack the `.app` and stop — and the archive is made
           * afterwards by `zipMacApp`, which keeps the links.
           */
          target: signing.crossSign ? ['dir'] : ['dmg', 'zip'],
        },
        win: {
          target: ['nsis', 'zip'],
          /* Nothing is named here: electron-builder reads `WIN_CSC_LINK`/`CSC_LINK` from the
             environment itself, and repeating them is a second place for them to be wrong. */
        },
        linux: { target: ['AppImage', 'tar.gz'], category: 'Game' },
      },
    });

    /*
     * **The archive, for a cross-build only.** electron-builder was asked for `dir` above because
     * neither of its Mac archives can be produced correctly off a Mac, so the artifact somebody
     * downloads is made here — see `zipMacApp` for what 7-Zip does to a framework.
     *
     * The name matches what electron-builder would have written, so a Mac-built release and a
     * Linux-built one are the same file under the same name.
     */
    if (signed.app !== null) {
      const version = await consumerVersion(cwd);
      const arch = target === 'mac-x64' ? 'x64' : 'arm64';
      await zipMacApp(signed.app, join(outDir, `${manifest.name}-${version}-${arch}-mac.zip`));
    }
  }
}

/**
 * The `afterPack` hook that ad-hoc signs a cross-built `.app`, or nothing on a Mac.
 *
 * A factory rather than an inline closure so the resolved signer is a `string` inside it: the
 * lookup and the refusal happen once, before a build starts, and this cannot be reached without
 * one. `electronPlatformName` is checked because the hook is called for whatever is being packed.
 */
function macSignStep(
  rcodesign: string,
  target: Target,
  signed: { app: string | null },
): (context: {
  readonly appOutDir: string;
  readonly electronPlatformName: string;
}) => Promise<void> {
  return async (context) => {
    if (context.electronPlatformName !== 'darwin') return;
    const app = await packedApp(context.appOutDir);
    console.log(`[drift-package] ad-hoc signing ${app} with rcodesign`);
    await crossSignMacApp({
      app,
      rcodesign,
      arch: target === 'mac-x64' ? 'x64' : 'arm64',
    });
    console.log('[drift-package] signed, and every nested bundle checked');
    signed.app = app;
  };
}

/** The `.app` electron-builder just wrote, found rather than named after the product. */
async function packedApp(appOutDir: string): Promise<string> {
  const { readdir } = await import('node:fs/promises');
  const found = (await readdir(appOutDir)).filter((entry) => entry.endsWith('.app'));
  if (found.length !== 1) {
    throw new Error(
      `expected one .app in ${appOutDir} and found ${found.length ? found.join(', ') : 'none'}`,
    );
  }
  return join(appOutDir, found[0] as string);
}

/**
 * The Electron the artifact will carry, read from what is installed rather than declared.
 *
 * The staged application has no dependencies of its own — both entry points are bundled — so
 * electron-builder has nothing to infer a version from and would refuse. Reading the installed
 * one keeps the artifact and this repository on the same runtime by construction.
 */
export async function installedElectronVersion(): Promise<string> {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve('electron/package.json');
  const raw: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
  const version = (raw as { version?: unknown }).version;
  if (typeof version !== 'string') throw new Error('electron is installed without a version');
  return version;
}

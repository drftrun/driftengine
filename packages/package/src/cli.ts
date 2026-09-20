#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { bootstrap } from './bootstrap.ts';
import { build, installedElectronVersion } from './build.ts';
import { planFlags } from './flags.ts';
import { refuseLyingFilesystem } from './identity.ts';
import { init } from './init.ts';
import { outFor } from './outDir.ts';
import { parseManifest } from './manifest.ts';
import type { PackageManifest, Target } from './manifest.ts';
import { executableName, nativeHost, nativeNotes, packagerVersion } from './native.ts';
import { planSigning } from './signing.ts';
import { electronMajor } from './runtimeVersion.ts';
import { depotScripts } from './steam/depot.ts';
import { androidToolchain, findRcodesign, needsRcodesign, requirementsFor } from './toolchain.ts';
import { stageApp } from './stage.ts';
import { resourceDir } from './resources.ts';
import type { ResourceOptions } from './resources.ts';

/*
 * **`ELECTRON_RUN_AS_NODE` is removed from this process before anything else happens.**
 *
 * Any terminal that is itself an Electron application — an editor's built-in one is the ordinary
 * case, and a developer's own shell had it set — exports the variable to everything it spawns.
 * Inherited, it turns Electron into plain Node: a packaged build dies on `Cannot find module
 * 'electron'` under a Node banner, which looks nothing like its cause, and in that mode the
 * built-in module genuinely is not there.
 *
 * **It used to be removed for `run` alone**, in `launchEnv` below, which left `build` and every
 * other subcommand inheriting it — and `build` is the one that spends twenty minutes before
 * anything can go wrong. Deleted rather than set empty: Electron treats the variable as set
 * whatever its value.
 */
delete process.env.ELECTRON_RUN_AS_NODE;

/**
 * `drift-package` — the command a consumer runs to get an installable application.
 *
 * Seven subcommands, and `verify` is the one that is not obvious. An artifact that was never
 * rebuilt is byte-identical in every respect a build log can see, so the only honest check is to
 * look inside the shipped thing for a string from the change. This repository already learned that
 * about deploys: an asset hash proves nothing.
 *
 * Every failure exits non-zero with the reason on stderr. A packaging command that prints a
 * complaint and exits 0 is a command that passes in a script.
 */
function loadManifest(cwd: string): PackageManifest {
  const path = join(cwd, 'drift.package.json');
  try {
    return parseManifest(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  } catch (cause) {
    throw new Error(`could not read ${path}: ${String(cause)}`);
  }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

async function doctor(cwd: string, options: ResourceOptions = {}): Promise<PackageManifest> {
  /*
   * **Before anything is read, downloaded or staged**, because the failure it replaces arrives ten
   * minutes in and talks about copying a file into a subdirectory of itself. See `identity.ts`:
   * a share that invents a file index makes Node refuse a copy that is perfectly legitimate.
   */
  refuseLyingFilesystem(cwd, options.outRoot);
  const manifest = loadManifest(cwd);
  /*
   * **The packager's own three directories, checked here rather than met mid-build.** `assets/`
   * becomes every desktop artifact's `drift://shell/` origin, and a copy of the engine that
   * flattened its packages has moved all three out of reach — which used to arrive as `ENOENT` on a
   * path that is not in the project, after esbuild had already run. `doctor` is where this file
   * already refuses what a build cannot do, before anything is downloaded or staged.
   *
   * `assets` alone: it is the one every target needs, and naming `android/` or `ios/` on a machine
   * building for Linux would refuse a build that was never going to touch them. The two mobile
   * builders check their own.
   */
  await resourceDir('assets', options.resourceRoot);
  /*
   * **Against the Electron this machine would actually package**, not the one the package declares.
   * A switch written for one Chromium and applied to another is ignored without a word, so doctor
   * is where a runtime too old for it is named — before a build spends its minutes and ships a
   * game that silently has no WebGPU.
   */
  const electron = electronMajor(await installedElectronVersion().catch(() => null));
  for (const target of manifest.targets) {
    const plan = planFlags(manifest, target, electron);
    if (plan.refusal !== null) throw new Error(`${target}: ${plan.refusal}`);
    for (const note of plan.notes) console.log(`  ${target}: ${note}`);
  }
  console.log(`ok: ${manifest.name} (${manifest.id}) for ${manifest.targets.join(', ')}`);
  for (const target of manifest.targets) {
    const signing = planSigning(target, process.env, process.platform);
    console.log(`  ${target}: signing ${signing.mode} — ${signing.reason}`);
  }
  console.log(
    `  splash: ${manifest.splash.show ? `the engine badge, held ${manifest.splash.minMs} ms` : 'off'}`,
  );
  /*
   * **Printed the way the signing mode is, and for the same reason.** An APK's permissions are the
   * difference between a game that can reach a relay and one whose every connection fails with
   * nothing logged at either end, and they are invisible until somebody runs `aapt2` on the built
   * artifact. Saying it here puts it in front of whoever is about to build.
   */
  if (manifest.targets.includes('android')) {
    const asked = manifest.android.permissions;
    console.log(
      `  android: permissions ${asked.length > 0 ? asked.join(', ') : 'none — the APK cannot open a socket'}`,
    );
    console.log(
      `  android: cleartext ${
        manifest.android.cleartextTraffic
          ? 'permitted — http:// and ws:// are allowed, and mixed content with them'
          : 'refused — a relay must be wss://'
      }`,
    );
  }

  /*
   * **What each target still needs, and the command that fetches it.** A `doctor` that only
   * validated a manifest would pass on a machine with no Java and no SDK, and the failure would
   * arrive twenty minutes later from Gradle.
   */
  for (const target of manifest.targets) {
    /*
     * **The native target asks nothing of the machine and one thing of the game**: it ships the
     * Node running this, and it needs the host installed beside the game, which `bootstrap` cannot
     * do because it prepares a machine rather than a project.
     */
    if (target === 'native-linux-x64') {
      for (const note of nativeNotes(manifest)) console.log(`  ${target}: ${note}`);
      try {
        nativeHost(cwd, packagerVersion());
      } catch (cause) {
        console.log(`  ${target}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      continue;
    }
    const ready = await toolchainReady(target);
    if (ready) continue;
    console.log(
      `  ${target}: needs ${requirementsFor(target).join(', ')} — ` +
        `run \`drift-package bootstrap --target=${target}\``,
    );
  }
  return manifest;
}

/**
 * **The native target is looked at in its own bundle**, because the build makes that from the game's
 * source rather than copying the web build: the web build inside it, `public/`, and the copied
 * modules are left out, so a fresh web build cannot vouch for a stale native one.
 */
function verify(
  cwd: string,
  needle: string,
  target: Target | null,
  options: ResourceOptions,
): void {
  const manifest = loadManifest(cwd);
  let root = join(cwd, dirname(manifest.entry));
  let files: string[];
  if (target === 'native-linux-x64') {
    root = join(outFor(cwd, target, options), executableName(manifest), 'app');
    if (!existsSync(root)) {
      throw new Error(
        `verify: there is no native build at ${root}; \`drift-package build ` +
          '--target=native-linux-x64` makes one.',
      );
    }
    const skip = new Set([join(root, 'public'), join(root, 'node_modules')]);
    files = walk(root).filter((file) => ![...skip].some((dir) => file.startsWith(`${dir}/`)));
  } else {
    files = walk(root);
  }
  const found = files.some((file) => readFileSync(file, 'utf8').includes(needle));
  if (!found) {
    throw new Error(
      `verify: "${needle}" is in no file under ${root}. That is what a build that did not rerun ` +
        'looks like — the artifact exists and is stale.',
    );
  }
  console.log(`ok: "${needle}" is in the built bundle`);
}

/**
 * The packaged application, run from source without producing an installer.
 *
 * **The whole point is that it is the same code path.** It stages exactly what a build stages and
 * starts Electron on it, so the window, the flags, the `drift://` origin and the badge are the
 * ones that will ship. A `run` that took a shortcut would be a rehearsal of something else.
 */
async function run(cwd: string, options: ResourceOptions): Promise<number> {
  const manifest = await doctor(cwd, options);
  const stageDir = mkdtempSync(join(tmpdir(), 'drift-run-'));
  /* A development run: developer tools open, warnings forwarded. `build` stages the other kind. */
  await stageApp(manifest, cwd, stageDir, { development: true, ...options });
  const electron = await import('electron');
  const binary = electron.default as unknown as string;
  console.log(`[drift-package] running from ${stageDir}`);
  return new Promise((resolve) => {
    const child = spawn(binary, [stageDir], { stdio: 'inherit', env: launchEnv() });
    child.on('close', (code) => {
      /* The staging directory holds a whole copy of the game's build — tens of megabytes for a
         real one — and a `run` per iteration would leave one of each in the temp directory. */
      rmSync(stageDir, { recursive: true, force: true });
      resolve(code ?? 0);
    });
  });
}

/**
 * The environment Electron is started in, with one variable removed.
 *
 * **`ELECTRON_RUN_AS_NODE` turns Electron into plain Node**, and any Electron-based terminal sets
 * it for the processes it spawns — an editor's integrated terminal is the common case, and this
 * workspace's own shell had it set. Inherited, it produces a failure that looks nothing like its
 * cause: the binary starts, prints a Node banner and dies on `Cannot find module 'electron'`,
 * because in that mode the built-in module genuinely is not there.
 *
 * Deleted rather than overridden with an empty string: Electron treats the variable as set
 * whatever its value.
 *
 * **This is now the second place it is removed** and it stays: the top of this file clears it for
 * the whole process, and this clears it for the child. The reason is written twice because it is
 * the reason somebody will come here looking for, and a copy of `process.env` taken elsewhere
 * would not inherit the first deletion.
 */
function launchEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/**
 * Whether this machine can build that target today.
 *
 * Desktop targets need the Electron runtime, which is present unless an install skipped its
 * postinstall; Android needs a whole toolchain; iOS needs Xcode, which nothing here can check for
 * beyond the platform it would have to be on.
 */
async function toolchainReady(target: Target): Promise<boolean> {
  if (target === 'android') return (await androidToolchain()) !== null;
  if (target === 'ios') return process.platform === 'darwin';
  /* A Mac target built anywhere else is signed by rcodesign, and an unsigned .app will not
     launch — so a machine without it is not ready for that target, however well it packs. */
  if (needsRcodesign(target)) return (await findRcodesign()) !== null;
  return true;
}

/**
 * The two files `steamcmd` uploads a build with, written beside the artifacts they describe.
 *
 * A separate command rather than part of `build`, because uploading is a decision: the scripts
 * name an app id that costs money to get wrong, and a build is often made several times before one
 * of them is the one that ships.
 */
async function writeSteamScripts(
  cwd: string,
  args: readonly string[],
  options: ResourceOptions,
): Promise<void> {
  const manifest = loadManifest(cwd);
  if (manifest.steam.appId === null) {
    throw new Error(
      'steam: `steam.appId` is null in drift.package.json. Set it to the app id Valve gave you; ' +
        "a depot script with the wrong one uploads into somebody else's game.",
    );
  }
  const target = (
    args.find((entry) => entry.startsWith('--target=')) ?? '--target=linux-x64'
  ).slice('--target='.length) as Target;
  const depotArg = args.find((entry) => entry.startsWith('--depot='));
  /* A first depot is conventionally the app id plus one, which is how Valve numbers them. */
  const depotId =
    depotArg === undefined ? manifest.steam.appId + 1 : Number.parseInt(depotArg.slice(8), 10);
  const branchArg = args.find((entry) => entry.startsWith('--branch='));

  const outDir = outFor(cwd, target, options);
  const content =
    target === 'native-linux-x64'
      ? executableName(manifest)
      : target === 'linux-x64'
        ? 'linux-unpacked'
        : target === 'win-x64'
          ? 'win-unpacked'
          : 'mac';
  const scripts = depotScripts({
    appId: manifest.steam.appId,
    depotId,
    description: `${manifest.name} ${target}`,
    contentRoot: content,
    branch: branchArg === undefined ? null : branchArg.slice('--branch='.length),
  });

  await writeFile(join(outDir, scripts.appFileName), scripts.app, 'utf8');
  await writeFile(join(outDir, scripts.depotFileName), scripts.depot, 'utf8');
  console.log(`ok: ${join(outDir, scripts.appFileName)}`);
  console.log(`ok: ${join(outDir, scripts.depotFileName)}`);
  console.log(
    `  upload with: steamcmd +login <user> +run_app_build "${join(outDir, scripts.appFileName)}" +quit`,
  );
  console.log("  nothing is set live: the build waits in Steam's admin for a person");
}

/** What this machine builds for itself, used when nothing has said otherwise. */
function hostTarget(): Target {
  if (process.platform === 'win32') return 'win-x64';
  if (process.platform === 'darwin') return process.arch === 'x64' ? 'mac-x64' : 'mac-arm64';
  return 'linux-x64';
}

function targetsFrom(manifest: PackageManifest, args: readonly string[]): readonly Target[] {
  const asked = args.find((entry) => entry.startsWith('--target='));
  if (asked === undefined) return manifest.targets;
  const name = asked.slice('--target='.length);
  const found = manifest.targets.find((target) => target === name);
  if (found === undefined) {
    throw new Error(
      `--target=${name} is not in this manifest's targets (${manifest.targets.join(', ')})`,
    );
  }
  return [found];
}

const [command, ...rest] = process.argv.slice(2);

/**
 * The project being packaged, which is the working directory unless `--project=` says otherwise.
 *
 * **Because the packager and the game are often not the same repository.** A game that keeps its
 * `drift.package.json` and nothing else — no Electron, no electron-builder, no Android SDK in its
 * own `node_modules` — is packaged by pointing this at it from wherever the tool lives, and that
 * is the arrangement most consumers actually want: half a gigabyte of build tooling does not
 * belong in a game's dependency tree.
 */
const projectFlag = rest.find((entry) => entry.startsWith('--project='));
const cwd =
  projectFlag === undefined
    ? process.cwd()
    : resolve(process.cwd(), projectFlag.slice('--project='.length));

/**
 * Where the packager's own `assets/`, `android/` and `ios/` are, if not beside its sources.
 *
 * **For a consumer that vendors engine source** rather than installing it: such a vendor copies
 * `packages/<name>/src/**` to `<name>/**` and the flattening moves
 * the three out of reach of anything this package can compute. Reported from outside, where the
 * workaround was a layout exception in the vendor script for this one package. See `resources.ts`
 * for why this is a flag rather than an environment variable.
 */
const resourcesFlag = rest.find((entry) => entry.startsWith('--resources='));

/**
 * Where builds write, if not `out/` inside the project.
 *
 * **For a project on a filesystem that misreports file identity**, where the first staging copy
 * of a build refuses itself: `fs.cp` compares `dev` and `ino` up the destination's ancestors, and
 * a shared or network folder can answer the same pair for a file and a directory. `outDir.ts`
 * carries the measurement. Absolute here, or relative to wherever the command was run, which is
 * not necessarily `--project=`.
 */
const outFlag = rest.find((entry) => entry.startsWith('--out='));
const resources: ResourceOptions = {
  ...(resourcesFlag === undefined
    ? {}
    : { resourceRoot: resourcesFlag.slice('--resources='.length) }),
  ...(outFlag === undefined ? {} : { outRoot: outFlag.slice('--out='.length) }),
};

try {
  if (command === 'doctor') {
    await doctor(cwd, resources);
  } else if (command === 'verify') {
    const arg = rest.find((entry) => entry.startsWith('--contains='));
    if (arg === undefined) throw new Error('verify needs --contains=<string>');
    const asked = rest.find((entry) => entry.startsWith('--target='));
    const target = asked === undefined ? null : (asked.slice('--target='.length) as Target);
    verify(cwd, arg.slice('--contains='.length), target, resources);
  } else if (command === 'run') {
    process.exitCode = await run(cwd, resources);
  } else if (command === 'bootstrap') {
    /* Deliberately does not need a manifest: a machine is prepared before a project exists on it,
       and `--target=` names what to prepare for. */
    const asked = rest.find((entry) => entry.startsWith('--target='));
    const targets =
      asked === undefined
        ? ((): readonly Target[] => {
            try {
              return loadManifest(cwd).targets;
            } catch {
              /* No manifest here: prepare for this desktop, which is the useful default on a
                 machine somebody is setting up. */
              return [hostTarget()];
            }
          })()
        : [asked.slice('--target='.length) as Target];
    await bootstrap(targets);
  } else if (command === 'init') {
    /*
     * Scaffolds a *project*, where `bootstrap` prepares a *machine*. Two commands because a
     * machine is prepared once and a project once per project, and conflating them would make the
     * one that writes files into your repository the one you run to install a JDK.
     */
    await init(cwd, loadManifest(cwd), rest.includes('--force'));
  } else if (command === 'steam') {
    await writeSteamScripts(cwd, rest, resources);
  } else if (command === 'build') {
    /* Checked before anything is downloaded or staged: a build that would be refused must be
       refused first, not after twenty minutes of Electron. */
    const manifest = await doctor(cwd, resources);
    await build(manifest, cwd, targetsFrom(manifest, rest), resources);
  } else {
    throw new Error(
      'usage: drift-package <init|bootstrap|doctor|build|run|verify|steam> [--project=<dir>] ' +
        `[--target=<target>] [--resources=<dir>] [--out=<dir>] [--force] — got "${String(command)}"`,
    );
  }
} catch (cause) {
  console.error(String(cause instanceof Error ? cause.message : cause));
  process.exit(1);
}

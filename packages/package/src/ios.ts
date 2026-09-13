import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { build as esbuild } from 'esbuild';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { missingReferences } from './mobile/assetCheck.ts';
import { versionCodeFor } from './mobile/versionCode.ts';
import type { PackageManifest } from './manifest.ts';
import { resourceDir } from './resources.ts';
import type { ResourceOptions } from './resources.ts';
import { findXcodeGen } from './toolchain.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * An iOS application, from the same web build every other target uses.
 *
 * **Unsigned unless a team is named, and that is the useful default.** Apple's free tier signs a
 * build for your own device for seven days at a time and does it through Xcode's own UI rather
 * than through anything a script can drive. So this produces an archive and an unsigned `.ipa` —
 * the shape a sideloading tool re-signs — and takes the signed path only when `APPLE_TEAM_ID` is
 * in the environment, where automatic signing has something to work with.
 *
 * **Written, and not yet run.** No Mac has built this: the Swift, the spec and this file were
 * written against Apple's documented behaviour, and the first person to run it should expect to
 * fix something. What is *not* guessed is the shape of the bridge — that is shared with Android
 * and tested — and the containment rule in the scheme handler, which mirrors the desktop shell's.
 *
 * **One question is still open and it gates the whole tier**: whether WebKit treats a custom
 * scheme as a *secure context*. If it does not, `crossOriginIsolated` is false and the answer is a
 * loopback server instead — `SchemeHandler.swift` is the only file that changes.
 * `drift://localhost/__drift/originProbe.html` answers it in one look on a device. **That URL is
 * the answer as much as the page is**: the host has to be `localhost`, because that is the whole
 * of why the origin is trustworthy, and the shell's own assets are served under `__drift/`
 * rather than from a second host, because a second host would not be `localhost`. Every earlier
 * spelling of this in the documentation named the desktop shell's `drift://shell/` form, which
 * on this platform resolves against the game's bundle root and answers with nothing.
 */
export async function buildIos(
  manifest: PackageManifest,
  projectDir: string,
  outDir: string,
  options: ResourceOptions = {},
): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('ios is built on macOS: Xcode is not available anywhere else');
  }
  const xcodegen = await findXcodeGen();
  if (xcodegen === null) {
    throw new Error(
      'XcodeGen is not here. Run `drift-package bootstrap --target=ios`, which fetches it; ' +
        'Xcode itself comes from the App Store.',
    );
  }

  const projectRoot = join(outDir, 'project');
  await rm(projectRoot, { recursive: true, force: true });
  await mkdir(projectRoot, { recursive: true });
  await cp(await resourceDir('ios', options.resourceRoot), projectRoot, { recursive: true });

  /* The game keeps its own directory here, unlike Android: `SchemeHandler` resolves against a
     `www` root inside the bundle, so absolute references land where they point. */
  const distDir = resolve(projectDir, dirname(manifest.entry));
  await cp(distDir, join(projectRoot, 'www'), { recursive: true });
  await checkReferences(join(projectRoot, 'www'), basename(manifest.entry));
  /* Served under `drift://localhost/__drift/`, so the origin probe and the mark are reachable
     without a second host — which would not be `localhost`, and so would not be secure. */
  await cp(await resourceDir('assets', options.resourceRoot), join(projectRoot, 'shell'), {
    recursive: true,
  });

  await esbuild({
    stdin: {
      contents: `import { attachIosShim } from ${JSON.stringify(join(HERE, 'mobile', 'iosShim.ts'))};\nattachIosShim('__driftHost');\n`,
      resolveDir: HERE,
      loader: 'ts',
    },
    outfile: join(projectRoot, 'drift-shim.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    logLevel: 'warning',
  });

  const version = await consumerVersion(projectDir);
  const team = process.env.APPLE_TEAM_ID ?? '';
  const spec = (await readFile(join(projectRoot, 'project.yml'), 'utf8'))
    .replace(/__DRIFT_APP_NAME__/g, manifest.name)
    .replace(/__DRIFT_APP_ID__/g, manifest.id)
    .replace(/__DRIFT_VERSION_NAME__/g, version)
    .replace(/__DRIFT_VERSION_CODE__/g, String(versionCodeFor(version)))
    .replace(/__DRIFT_TEAM_ID__/g, team);
  await writeFile(join(projectRoot, 'project.yml'), spec, 'utf8');

  console.log(
    `[drift-package] ios: ${team === '' ? 'unsigned — a sideloading tool re-signs it' : `signing with team ${team}`}`,
  );

  await runTool(xcodegen, ['generate', '--spec', 'project.yml'], projectRoot);

  const archive = join(outDir, 'DriftHost.xcarchive');
  await runTool(
    'xcodebuild',
    [
      '-project',
      'DriftHost.xcodeproj',
      '-scheme',
      'DriftHost',
      '-configuration',
      'Release',
      '-destination',
      'generic/platform=iOS',
      '-archivePath',
      archive,
      'archive',
      ...(team === ''
        ? ['CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO', 'CODE_SIGN_IDENTITY=']
        : [`DEVELOPMENT_TEAM=${team}`]),
    ],
    projectRoot,
  );

  /*
   * An `.ipa` is a zip with the app inside a `Payload` directory, which is all `xcodebuild
   * -exportArchive` produces for a development build — and that step needs a provisioning profile
   * this may not have. Built by hand so an unsigned archive still leaves something installable by
   * a tool that signs it afterwards.
   */
  const payload = join(outDir, 'Payload');
  await rm(payload, { recursive: true, force: true });
  await mkdir(payload, { recursive: true });
  await cp(
    join(archive, 'Products', 'Applications', `${manifest.name}.app`),
    join(payload, `${manifest.name}.app`),
    { recursive: true },
  );
  const ipa = join(outDir, `${manifest.name.replace(/[^\w.-]+/g, '-')}-${version}.ipa`);
  await rm(ipa, { force: true });
  await runTool('zip', ['-qry', ipa, 'Payload'], outDir);
  await rm(payload, { recursive: true, force: true });
  console.log(`[drift-package] ios: ${ipa}`);
}

async function checkReferences(root: string, entryName: string): Promise<void> {
  const html = await readFile(join(root, entryName), 'utf8');
  const { readdir } = await import('node:fs/promises');
  const { relative } = await import('node:path');
  const walk = async (dir: string): Promise<string[]> => {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await walk(full)));
      else out.push(relative(root, full).split('\\').join('/'));
    }
    return out;
  };
  const missing = missingReferences(html, new Set(await walk(root)));
  if (missing.length === 0) return;
  throw new Error(
    `the entry page references ${missing.length} file(s) that are not in the bundle: ` +
      `${missing.slice(0, 5).join(', ')}.`,
  );
}

async function consumerVersion(projectDir: string): Promise<string> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(projectDir, 'package.json'), 'utf8'));
    const version = (raw as { version?: unknown }).version;
    return typeof version === 'string' && version.length > 0 ? version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function runTool(command: string, args: readonly string[], cwd: string): Promise<void> {
  await new Promise<void>((done, fail) => {
    const child = spawn(command, [...args], { stdio: 'inherit', cwd });
    child.on('error', fail);
    child.on('close', (code) =>
      code === 0 ? done() : fail(new Error(`${command} exited with ${String(code)}`)),
    );
  });
}

import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { build as esbuild } from 'esbuild';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PackageManifest } from './manifest.ts';
import { resourceDir } from './resources.ts';
import type { ResourceOptions } from './resources.ts';
import { missingReferences } from './mobile/assetCheck.ts';
import { withAndroidManifest } from './mobile/androidManifest.ts';
import { versionCodeFor } from './mobile/versionCode.ts';
import { androidToolchain, toolchainHome } from './toolchain.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * An installable APK, from the same web build the desktop shell runs.
 *
 * **The Gradle project is a template that is copied, never built in place.** A consumer's game is
 * tens of megabytes of assets; copying it into `packages/package/android/` would put it in this
 * repository's working tree, and a `git status` after one build would be unreadable. So the
 * template is staged into `out/android/project` and the build happens there.
 *
 * **Signed with a throwaway key, on purpose and stated loudly.** Android refuses to install an
 * unsigned APK at all, so there is no "unsigned" option to offer — the choice is between a key
 * this generates and a key a person owns. A generated one installs on a device with developer mode
 * on, which is what this is for; it cannot go to the Play Store, and an upgrade signed with a
 * *different* generated key is refused by the device as an impostor. `DRIFT_ANDROID_KEYSTORE` and
 * its two passwords take over the moment somebody has a real one.
 */
export async function buildAndroid(
  manifest: PackageManifest,
  projectDir: string,
  outDir: string,
  options: ResourceOptions = {},
): Promise<void> {
  const toolchain = await androidToolchain();
  if (toolchain === null) {
    throw new Error(
      'the Android toolchain is not here yet. Run `drift-package bootstrap --target=android`, ' +
        'which fetches a JDK, the SDK and Gradle into a cache; or set JAVA_HOME and ANDROID_HOME ' +
        'to ones you already have.',
    );
  }

  const projectRoot = join(outDir, 'project');
  await rm(projectRoot, { recursive: true, force: true });
  await mkdir(projectRoot, { recursive: true });
  await cp(await resourceDir('android', options.resourceRoot), projectRoot, { recursive: true });

  /*
   * **The game goes at the asset root**, because that is where its own absolute references point.
   * See the comment in `MainActivity.java`: a build served from a subdirectory loads its HTML and
   * nothing else.
   */
  const assets = join(projectRoot, 'app', 'src', 'main', 'assets');
  await mkdir(assets, { recursive: true });
  const distDir = resolve(projectDir, dirname(manifest.entry));
  await cp(distDir, assets, { recursive: true });
  await checkAssetReferences(assets, basename(manifest.entry));

  /*
   * The shim is bundled as an IIFE rather than a module: it is evaluated as a document-start
   * script by the WebView, which is a bare script rather than a module context.
   */
  await esbuild({
    stdin: {
      contents: `import { attachShim } from ${JSON.stringify(join(HERE, 'mobile', 'bridgeShim.ts'))};\nattachShim('__driftHost');\n`,
      resolveDir: HERE,
      loader: 'ts',
    },
    outfile: join(assets, 'drift-host', 'shim.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    logLevel: 'warning',
  });

  /*
   * **The manifest is rewritten in the copy, before Gradle reads it.** The same place and the same
   * reason as the icon below: the template is staged into `out/`, so a consumer's permissions never
   * touch this repository's tree. See `mobile/androidManifest.ts` for what an empty request does,
   * which is nothing at all.
   */
  const manifestPath = join(projectRoot, 'app', 'src', 'main', 'AndroidManifest.xml');
  const templateXml = await readFile(manifestPath, 'utf8');
  const withPermissions = withAndroidManifest(templateXml, manifest.android);
  if (withPermissions !== templateXml) {
    await writeFile(manifestPath, withPermissions, 'utf8');
  }
  if (manifest.android.permissions.length > 0) {
    console.log(`[drift-package] android: permissions ${manifest.android.permissions.join(', ')}`);
  }
  if (manifest.android.cleartextTraffic) {
    /*
     * Said out loud because it is a security posture rather than a setting: the build now permits
     * `http://` and `ws://`, and `MainActivity` reads the same flag to allow mixed content in the
     * WebView. A consumer who did not mean it should see it in the build log.
     */
    console.log('[drift-package] android: cleartext traffic permitted (http:// and ws:// allowed)');
  }

  if (manifest.icon !== null) {
    /* One PNG at one density: Android scales it for the rest, and a game that wants a full set
       supplies its own `res/` through its own build rather than through this. */
    await cp(
      resolve(projectDir, manifest.icon),
      join(projectRoot, 'app', 'src', 'main', 'res', 'mipmap-xxhdpi', 'ic_launcher.png'),
    );
  }

  const keystore = await ensureKeystore(manifest.id, toolchain.javaHome);
  await writeFile(join(projectRoot, 'local.properties'), `sdk.dir=${toolchain.sdkRoot}\n`, 'utf8');

  const version = await consumerVersion(projectDir);
  console.log(`[drift-package] android: building ${manifest.name} ${version}`);
  console.log(`[drift-package] android: signing ${keystore.describe}`);

  await gradle(toolchain, projectRoot, [
    'assembleRelease',
    `-PdriftAppId=${manifest.id}`,
    `-PdriftAppName=${manifest.name}`,
    `-PdriftVersionName=${version}`,
    `-PdriftVersionCode=${versionCodeFor(version)}`,
    `-PdriftKeystore=${keystore.path}`,
    `-PdriftKeystorePassword=${keystore.password}`,
    `-PdriftKeyAlias=${keystore.alias}`,
    `-PdriftKeyPassword=${keystore.password}`,
  ]);

  const apk = join(projectRoot, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
  const delivered = join(outDir, `${manifest.name.replace(/[^\w.-]+/g, '-')}-${version}.apk`);
  await cp(apk, delivered);
  console.log(`[drift-package] android: ${delivered}`);
}

interface Keystore {
  readonly path: string;
  readonly password: string;
  readonly alias: string;
  readonly describe: string;
}

/**
 * A signing key: the one in the environment, or a throwaway generated once and kept.
 *
 * **Kept, and kept outside the project.** Android identifies an application by its signing key: a
 * device refuses to upgrade an installed app whose new copy is signed with a different one, and
 * the only way out on the device is to uninstall and lose the saves. So a generated key lives in
 * the toolchain cache, keyed by application id — where `git clean` cannot reach it, where the
 * build output being gitignored cannot lose it, and where two games on one machine do not share
 * one identity.
 */
async function ensureKeystore(appId: string, javaHome: string): Promise<Keystore> {
  const real = process.env.DRIFT_ANDROID_KEYSTORE;
  if (typeof real === 'string' && real.length > 0) {
    return {
      path: real,
      password: process.env.DRIFT_ANDROID_KEYSTORE_PASSWORD ?? '',
      alias: process.env.DRIFT_ANDROID_KEY_ALIAS ?? 'drift',
      describe: `with the keystore in DRIFT_ANDROID_KEYSTORE`,
    };
  }

  const dir = join(toolchainHome(), 'keystores');
  const path = join(dir, `${appId}.jks`);
  const keystore: Keystore = {
    path,
    password: 'driftengine',
    alias: 'drift',
    describe:
      'with a generated throwaway key, kept in the toolchain cache — installable with developer ' +
      'mode on, not publishable, and an upgrade signed with a different key is refused by the ' +
      'device, which is why it is kept rather than made fresh',
  };
  try {
    await readFile(path);
    return keystore;
  } catch {
    /* Not there yet. */
  }
  await mkdir(dir, { recursive: true });
  await runTool(
    join(javaHome, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool'),
    [
      '-genkeypair',
      '-keystore',
      path,
      '-alias',
      keystore.alias,
      '-storepass',
      keystore.password,
      '-keypass',
      keystore.password,
      '-keyalg',
      'RSA',
      '-keysize',
      '2048',
      /* Twenty-seven years, which is what Google asks of an upload key, and long enough that a
         throwaway key is never the reason a build stops working. */
      '-validity',
      '10000',
      '-dname',
      'CN=DriftEngine, OU=Development, O=DriftEngine, C=GB',
    ],
    {},
  );
  return keystore;
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

async function gradle(
  toolchain: { gradle: string; javaHome: string; sdkRoot: string },
  projectRoot: string,
  args: readonly string[],
): Promise<void> {
  await runTool(toolchain.gradle, ['--project-dir', projectRoot, '--no-daemon', ...args], {
    JAVA_HOME: toolchain.javaHome,
    ANDROID_HOME: toolchain.sdkRoot,
    ANDROID_SDK_ROOT: toolchain.sdkRoot,
  });
}

async function runTool(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<void> {
  await new Promise<void>((done, fail) => {
    const child = spawn(command, [...args], {
      stdio: 'inherit',
      env: { ...process.env, ...env },
    });
    child.on('error', fail);
    child.on('close', (code) =>
      code === 0 ? done() : fail(new Error(`${command} exited with ${String(code)}`)),
    );
  });
}

/**
 * Refuse a build whose entry page points at files that will not be there.
 *
 * **The check that would have saved a device round trip.** A game whose HTML references
 * `/assets/index-abc.js` served from the wrong root loads its markup and none of its code, and
 * nothing in the build says so — the APK is valid, installs, launches, and shows unstyled text.
 * Here it is a build failure naming the first few references that do not resolve.
 */
async function checkAssetReferences(assetsRoot: string, entryName: string): Promise<void> {
  const html = await readFile(join(assetsRoot, entryName), 'utf8');
  const present = new Set(await listRelative(assetsRoot, assetsRoot));
  const missing = missingReferences(html, present);
  if (missing.length === 0) return;
  throw new Error(
    `the entry page references ${missing.length} file(s) that are not in the bundle: ` +
      `${missing.slice(0, 5).join(', ')}. Those are absolute paths, so they resolve from the root ` +
      'the game is served at — which is where the packager puts it. A game built with a `base` ' +
      'other than `/` needs that base to match, or a relative one.',
  );
}

async function listRelative(root: string, dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listRelative(root, full)));
    else out.push(relative(root, full).split('\\').join('/'));
  }
  return out;
}

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { chmod, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { Target } from './manifest.ts';
import {
  PINS,
  ensureDir,
  findAndroidSdk,
  findGradle,
  findJavaHome,
  findRcodesign,
  findXcodeGen,
  needsRcodesign,
  toolchainHome,
} from './toolchain.ts';

/**
 * Fetch everything a target needs to be built, so nobody has to install seven things by hand.
 *
 * **This is the command that makes the other ones work on a fresh machine.** A packaging toolchain
 * is a JDK, an Android SDK, a Gradle distribution and an Electron runtime, in pinned versions;
 * every one of those is a download and a licence prompt, and a README that lists them is a README
 * somebody follows wrongly at two in the morning.
 *
 * **Nothing is installed system-wide and nothing needs a password.** Everything lands under a
 * cache directory this owns, and a machine that already has a working toolchain — `JAVA_HOME`,
 * `ANDROID_HOME` — is used as it is rather than duplicated.
 *
 * **Only what is actually downloadable is downloaded.** Xcode is not: it is a sign-in and an App
 * Store install on a Mac, so the iOS branch prints what to get rather than pretending.
 */
export async function bootstrap(targets: readonly Target[]): Promise<void> {
  const wantsAndroid = targets.includes('android');
  const wantsIos = targets.includes('ios');
  const wantsDesktop = targets.some(
    (target) => target !== 'android' && target !== 'ios' && target !== 'native-linux-x64',
  );

  if (wantsDesktop) await bootstrapElectron();
  if (targets.includes('native-linux-x64')) {
    /* A machine is ready for it as it is: the artifact carries the Node running the build, and the
       host is a dependency of the game, which `npm install` there fetches. */
    console.log(
      'ok: native-linux-x64 needs nothing fetched for this machine — it ships the Node running the ' +
        "build — and the game needs @driftengine/native-host installed, at the packager's version",
    );
  }
  if (targets.some((target) => needsRcodesign(target))) await bootstrapRcodesign();
  if (wantsAndroid) await bootstrapAndroid();
  if (wantsIos) await bootstrapIos();
}

/**
 * `rcodesign`, which signs a Mac target on a machine that has no `codesign`.
 *
 * **Fetched only when a Mac target is asked for off a Mac**, because that is the only situation
 * where the platform's own signer is missing. On a Mac this is never downloaded: `codesign` ships
 * with the command line tools and electron-builder drives it directly.
 *
 * A single static musl binary, so unlike the JDK there is nothing to discover in the archive and
 * nothing that cares which distribution it lands on.
 */
async function bootstrapRcodesign(): Promise<void> {
  const existing = await findRcodesign();
  if (existing !== null) {
    console.log(`ok: rcodesign is present at ${existing}`);
    return;
  }

  const asset = rcodesignAsset();
  if (asset === null) {
    throw new Error(
      `there is no published rcodesign for ${process.platform}/${process.arch}. ` +
        '`cargo install apple-codesign` builds one, and the build will find it in ~/.cargo/bin',
    );
  }

  const home = toolchainHome();
  await ensureDir(home);
  console.log(`fetching ${PINS.rcodesign.label}…`);
  const archive = join(home, asset.archive);
  await download(
    'https://github.com/indygreg/apple-platform-rs/releases/download/' +
      `apple-codesign%2F${PINS.rcodesign.version}/${asset.archive}`,
    archive,
  );

  const staging = join(home, 'rcodesign-unpack');
  await rm(staging, { recursive: true, force: true });
  await ensureDir(staging);
  await extract(archive, staging);

  /* The archive unpacks one directory named for the triple, holding the binary and its licences.
     The binary is searched for rather than assumed at that path: the name of the wrapper
     directory is the one part of a release asset that has changed before. */
  const found = await findFile(
    staging,
    process.platform === 'win32' ? 'rcodesign.exe' : 'rcodesign',
  );
  if (found === null) throw new Error('the rcodesign archive did not contain a binary');

  const target = join(home, `rcodesign-${PINS.rcodesign.version}`);
  await rm(target, { recursive: true, force: true });
  await ensureDir(target);
  const binary = join(target, 'rcodesign');
  await rename(found, binary);
  await chmod(binary, 0o755).catch(() => undefined);
  await rm(staging, { recursive: true, force: true });
  await rm(archive, { force: true });
  console.log(`ok: rcodesign is at ${binary}`);
}

/** Which published rcodesign asset this machine can run, or null if the release page has none. */
function rcodesignAsset(): { readonly archive: string } | null {
  const version = PINS.rcodesign.version;
  if (process.platform === 'linux') {
    /* musl rather than gnu: the release publishes only the static build, which is the one that
       does not care about the host's glibc. */
    const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
    return { archive: `apple-codesign-${version}-${arch}-unknown-linux-musl.tar.gz` };
  }
  if (process.platform === 'win32') {
    return { archive: `apple-codesign-${version}-x86_64-pc-windows-msvc.zip` };
  }
  return null;
}

/** The first file with this name anywhere under a directory, or null. */
async function findFile(root: string, name: string): Promise<string | null> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFile(full, name);
      if (nested !== null) return nested;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}

/**
 * The Electron runtime, which npm sometimes does not fetch.
 *
 * Its binary arrives through a postinstall script, and an install run with scripts disabled —
 * which several sandboxes, CI images and corporate setups do by default — leaves the package
 * present and the runtime missing. The failure that produces is `Electron failed to install
 * correctly` at the moment somebody first tries to run a game.
 */
async function bootstrapElectron(): Promise<void> {
  const require = (await import('node:module')).createRequire(import.meta.url);
  let installer: string;
  try {
    installer = require.resolve('electron/install.js');
  } catch {
    throw new Error('electron is not installed; run npm install first');
  }
  const dist = join(installer, '..', 'dist');
  if (await pathExists(dist)) {
    console.log('ok: the Electron runtime is present');
    return;
  }
  console.log('fetching the Electron runtime…');
  await run(process.execPath, [installer], {});
  console.log('ok: the Electron runtime is present');
}

async function bootstrapAndroid(): Promise<void> {
  const home = toolchainHome();
  await ensureDir(home);

  const javaHome = (await findJavaHome()) ?? (await installJdk(home));
  const sdkRoot = (await findAndroidSdk()) ?? (await installAndroidSdk(home, javaHome));
  await installAndroidPackages(sdkRoot, javaHome);
  const gradle = (await findGradle()) ?? (await installGradle(home));

  console.log(`ok: android toolchain ready`);
  console.log(`  JDK:     ${javaHome}`);
  console.log(`  SDK:     ${sdkRoot}`);
  console.log(`  Gradle:  ${gradle}`);
}

async function bootstrapIos(): Promise<void> {
  if (process.platform !== 'darwin') {
    console.log('ios: this is not a Mac, and an iOS build needs one. Nothing to fetch here.');
    return;
  }

  const home = toolchainHome();
  await ensureDir(home);
  if ((await findXcodeGen()) === null) {
    console.log(`fetching ${PINS.xcodegen.label}…`);
    const archive = join(home, 'xcodegen.zip');
    await download(
      `https://github.com/yonaskolb/XcodeGen/releases/download/${PINS.xcodegen.version}/xcodegen.zip`,
      archive,
    );
    const target = join(home, `xcodegen-${PINS.xcodegen.version}`);
    await rm(target, { recursive: true, force: true });
    await ensureDir(target);
    await extract(archive, target);
    /* The archive unpacks a `xcodegen/` directory containing bin and share; flattened so the
       path this file resolves is the path `findXcodeGen` looks for. */
    const [inner] = await readdir(target);
    if (inner !== undefined && inner === 'xcodegen') {
      await rename(join(target, 'xcodegen', 'bin'), join(target, 'bin'));
      await rename(join(target, 'xcodegen', 'share'), join(target, 'share')).catch(() => undefined);
    }
    await chmod(join(target, 'bin', 'xcodegen'), 0o755).catch(() => undefined);
    await rm(archive, { force: true });
  }

  /* Xcode itself cannot be fetched, so it is checked for and named rather than installed. */
  try {
    await run('xcodebuild', ['-version'], { quiet: true });
    console.log('ok: Xcode is here, and so is XcodeGen');
  } catch {
    console.log('ios: XcodeGen is ready; Xcode is not.');
    console.log('  - install Xcode from the App Store, then `xcode-select --install`');
    console.log('  - a free Apple ID installs to your own device for seven days at a time;');
    console.log('    the paid Developer Program is what makes a build last and reach TestFlight');
  }
}

/** Temurin, from the Adoptium API, which redirects to the current build of the pinned feature. */
async function installJdk(home: string): Promise<string> {
  const os =
    process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
  const url =
    `https://api.adoptium.net/v3/binary/latest/${PINS.jdk.feature}/ga/${os}/${arch}` +
    '/jdk/hotspot/normal/eclipse';

  console.log(`fetching ${PINS.jdk.label}…`);
  const archive = join(home, os === 'windows' ? 'jdk.zip' : 'jdk.tar.gz');
  await download(url, archive);

  const staging = join(home, 'jdk-unpack');
  await rm(staging, { recursive: true, force: true });
  await ensureDir(staging);
  await extract(archive, staging);
  /* Every JDK archive unpacks into one versioned directory; the pin is on the feature release, so
     the exact name changes with each patch and is discovered rather than assumed. */
  const [inner] = await readdir(staging);
  if (inner === undefined) throw new Error('the JDK archive unpacked into nothing');
  const target = join(home, 'jdk');
  await rm(target, { recursive: true, force: true });
  await rename(join(staging, inner), target);
  await rm(staging, { recursive: true, force: true });
  await rm(archive, { force: true });
  return target;
}

async function installAndroidSdk(home: string, javaHome: string): Promise<string> {
  const os = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
  const url = `https://dl.google.com/android/repository/commandlinetools-${os}-${PINS.androidTools.build}_latest.zip`;

  console.log(`fetching ${PINS.androidTools.label}…`);
  const archive = join(home, 'cmdline-tools.zip');
  await download(url, archive);

  const sdkRoot = join(home, 'android-sdk');
  const staging = join(home, 'cmdline-unpack');
  await rm(staging, { recursive: true, force: true });
  await ensureDir(staging);
  await extract(archive, staging);
  /* sdkmanager insists on living at `cmdline-tools/latest/`, and the archive unpacks a directory
     called `cmdline-tools`. Getting this wrong produces a tool that refuses to run and blames the
     SDK root rather than its own location. */
  await ensureDir(join(sdkRoot, 'cmdline-tools'));
  await rm(join(sdkRoot, 'cmdline-tools', 'latest'), { recursive: true, force: true });
  await rename(join(staging, 'cmdline-tools'), join(sdkRoot, 'cmdline-tools', 'latest'));
  await rm(staging, { recursive: true, force: true });
  await rm(archive, { force: true });

  await acceptLicences(sdkRoot, javaHome);
  return sdkRoot;
}

/**
 * Accept the SDK licences, which is a prompt that cannot be skipped and can be answered.
 *
 * Google requires an explicit acceptance per licence before any package installs. Answering it by
 * piping `y` is what every CI image does; it is recorded here rather than hidden because accepting
 * a licence on somebody's behalf is a thing they should be able to see in a diff.
 */
async function acceptLicences(sdkRoot: string, javaHome: string): Promise<void> {
  console.log('accepting the Android SDK licences…');
  await run(sdkManager(sdkRoot), [`--sdk_root=${sdkRoot}`, '--licenses'], {
    env: { JAVA_HOME: javaHome },
    stdin: `${'y\n'.repeat(64)}`,
    quiet: true,
  });
}

async function installAndroidPackages(sdkRoot: string, javaHome: string): Promise<void> {
  console.log(`installing ${PINS.androidPackages.join(', ')}…`);
  await run(sdkManager(sdkRoot), [`--sdk_root=${sdkRoot}`, ...PINS.androidPackages], {
    env: { JAVA_HOME: javaHome },
    quiet: true,
  });
}

async function installGradle(home: string): Promise<string> {
  console.log(`fetching ${PINS.gradle.label}…`);
  const archive = join(home, 'gradle.zip');
  await download(
    `https://services.gradle.org/distributions/gradle-${PINS.gradle.version}-bin.zip`,
    archive,
  );
  await extract(archive, home);
  await rm(archive, { force: true });
  const binary = join(
    home,
    `gradle-${PINS.gradle.version}`,
    'bin',
    process.platform === 'win32' ? 'gradle.bat' : 'gradle',
  );
  if (!(await pathExists(binary))) throw new Error('the Gradle archive did not contain a launcher');
  return binary;
}

function sdkManager(sdkRoot: string): string {
  const name = process.platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager';
  return join(sdkRoot, 'cmdline-tools', 'latest', 'bin', name);
}

async function download(url: string, to: string): Promise<void> {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || response.body === null) {
    throw new Error(`could not download ${url}: ${response.status} ${response.statusText}`);
  }
  /* The DOM's `ReadableStream` and Node's are structurally the same and typed apart; the cast is
     at the one line where the two type worlds meet rather than spread through the signature. */
  await pipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(to),
  );
}

/**
 * Unpack an archive with whatever this machine has.
 *
 * `tar` handles both formats on macOS and on Windows, where it is bsdtar; GNU tar on Linux cannot
 * read a zip, so `unzip` is tried first for those. Two attempts rather than a dependency: an
 * archive extractor is a large amount of code to carry for a step that runs once per machine.
 */
async function extract(archive: string, into: string): Promise<void> {
  if (archive.endsWith('.zip')) {
    try {
      await run('unzip', ['-q', '-o', archive, '-d', into], { quiet: true });
      return;
    } catch {
      await run('tar', ['-xf', archive, '-C', into], { quiet: true });
      return;
    }
  }
  await run('tar', ['-xzf', archive, '-C', into], { quiet: true });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await (await import('node:fs/promises')).access(path);
    return true;
  } catch {
    return false;
  }
}

interface RunOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly quiet?: boolean;
}

async function run(command: string, args: readonly string[], options: RunOptions): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], {
      env: { ...process.env, ...options.env },
      stdio: [
        options.stdin === undefined ? 'ignore' : 'pipe',
        options.quiet === true ? 'ignore' : 'inherit',
        'inherit',
      ],
    });
    if (options.stdin !== undefined && child.stdin !== null) {
      child.stdin.write(options.stdin);
      child.stdin.end();
    }
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with ${String(code)}`)),
    );
  });
}

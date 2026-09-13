import { access, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Target } from './manifest.ts';

/**
 * Everything a build needs that is not a Node package, and where it goes.
 *
 * **Pinned, downloaded, and kept outside the repository.** A packaging toolchain is gigabytes of
 * Java, an Android SDK and a Gradle distribution; none of it belongs in a git tree, and none of it
 * should be a paragraph in a README telling somebody to install seven things by hand. `bootstrap`
 * fetches exactly these versions into a cache, and a machine that already has a working toolchain
 * is used as it is rather than duplicated.
 *
 * **Versions are pinned rather than tracked.** A build that quietly moved to a new Android build
 * tools release is a build whose output changed for a reason nobody recorded. Moving one of these
 * is a commit with a reason in it.
 */
export const PINS = {
  /** Temurin 21. AGP 8.7 needs 17 or newer; 21 is the current long-term release. */
  jdk: { feature: '21', label: 'Temurin JDK 21' },
  /** Google's command-line tools bundle, which is what installs the rest of the SDK. */
  androidTools: { build: '13114758', label: 'Android command-line tools' },
  /** What an APK is actually compiled against. */
  androidPackages: ['platform-tools', 'platforms;android-35', 'build-tools;35.0.0'] as const,
  /** AGP 8.7.3 requires Gradle 8.9 or newer. */
  gradle: { version: '8.9', label: 'Gradle 8.9' },
  /**
   * XcodeGen, which turns a spec into an `.xcodeproj`.
   *
   * A `.xcodeproj` is a generated artefact full of absolute paths and a merge conflict in every
   * pull request. Generating it means the repository holds a readable spec instead — and unlike
   * Xcode itself, this is a single binary that can be downloaded.
   */
  xcodegen: { version: '2.42.0', label: 'XcodeGen 2.42.0' },
  /**
   * `rcodesign`, which is what signs a Mac target built anywhere but a Mac.
   *
   * Apple's `codesign` is macOS only and electron-builder silently skips signing without it, so
   * without this a cross-built `.app` is unsigned and the loader on Apple Silicon refuses it.
   * This is the one implementation of Apple's code signature format that runs on Linux.
   *
   * The Linux asset is linked against musl and is a single static binary, so it does not care
   * which distribution it lands on and installs nothing system-wide.
   */
  rcodesign: { version: '0.29.0', label: 'rcodesign 0.29.0 (apple-codesign)' },
} as const;

/**
 * Where downloaded tools live.
 *
 * Outside the project on purpose: two games on one machine share one Android SDK, and a `git
 * clean` must not cost half a gigabyte of downloads.
 */
export function toolchainHome(): string {
  const override = process.env.DRIFT_TOOLCHAIN_HOME;
  if (typeof override === 'string' && override.length > 0) return override;
  const cache = process.env.XDG_CACHE_HOME;
  const base = typeof cache === 'string' && cache.length > 0 ? cache : join(homedir(), '.cache');
  return join(base, 'driftengine', 'toolchain');
}

export interface AndroidToolchain {
  readonly javaHome: string;
  readonly sdkRoot: string;
  /** The `gradle` executable to invoke. */
  readonly gradle: string;
  /** Whether these came from the machine rather than from the cache. */
  readonly system: boolean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The JDK this machine will use, preferring one it already has. */
export async function findJavaHome(): Promise<string | null> {
  const fromEnv = process.env.JAVA_HOME;
  if (
    typeof fromEnv === 'string' &&
    fromEnv.length > 0 &&
    (await exists(join(fromEnv, 'bin', javac())))
  ) {
    return fromEnv;
  }
  const cached = join(toolchainHome(), 'jdk');
  return (await exists(join(cached, 'bin', javac()))) ? cached : null;
}

/** The Android SDK this machine will use, preferring one it already has. */
export async function findAndroidSdk(): Promise<string | null> {
  for (const name of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
    const root = process.env[name];
    if (
      typeof root === 'string' &&
      root.length > 0 &&
      (await exists(join(root, 'platform-tools')))
    ) {
      return root;
    }
  }
  const cached = join(toolchainHome(), 'android-sdk');
  return (await exists(join(cached, 'platform-tools'))) ? cached : null;
}

/** The Gradle this machine will use. A system one is taken at whatever version it is. */
export async function findGradle(): Promise<string | null> {
  const cached = join(toolchainHome(), `gradle-${PINS.gradle.version}`, 'bin', gradleBinary());
  if (await exists(cached)) return cached;
  return null;
}

/** XcodeGen, from the cache or from the machine. */
export async function findXcodeGen(): Promise<string | null> {
  const cached = join(toolchainHome(), `xcodegen-${PINS.xcodegen.version}`, 'bin', 'xcodegen');
  if (await exists(cached)) return cached;
  /* Installed by Homebrew or Mint, which many Macs already have. */
  for (const path of ['/opt/homebrew/bin/xcodegen', '/usr/local/bin/xcodegen']) {
    if (await exists(path)) return path;
  }
  return null;
}

/**
 * The `rcodesign` this machine will use, from the cache or from the machine.
 *
 * A system one is taken at whatever version it is, the way Gradle and XcodeGen are: this signs
 * with a format Apple has not changed in years, and a person who installed it deliberately has a
 * reason. `cargo install apple-codesign` puts one in `~/.cargo/bin`, which is why that is looked
 * at — it is the route on an architecture the release page has no asset for.
 */
export async function findRcodesign(): Promise<string | null> {
  const cached = join(toolchainHome(), `rcodesign-${PINS.rcodesign.version}`, 'rcodesign');
  if (await exists(cached)) return cached;
  const home = process.env.HOME;
  const candidates = [
    '/usr/local/bin/rcodesign',
    '/usr/bin/rcodesign',
    '/opt/homebrew/bin/rcodesign',
    ...(typeof home === 'string' && home.length > 0
      ? [join(home, '.cargo', 'bin', 'rcodesign')]
      : []),
  ];
  for (const path of candidates) {
    if (await exists(path)) return path;
  }
  return null;
}

/**
 * Whether a target signs with `rcodesign` rather than with the host's own signer.
 *
 * The one condition is a Mac target that is not being built on a Mac. Kept here beside the tool
 * it decides about, so `doctor`, `bootstrap` and `build` cannot disagree about when it is needed.
 */
export function needsRcodesign(
  target: Target,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (target === 'mac-arm64' || target === 'mac-x64') && platform !== 'darwin';
}

export async function androidToolchain(): Promise<AndroidToolchain | null> {
  const javaHome = await findJavaHome();
  const sdkRoot = await findAndroidSdk();
  const gradle = await findGradle();
  if (javaHome === null || sdkRoot === null || gradle === null) return null;
  return {
    javaHome,
    sdkRoot,
    gradle,
    system: javaHome === process.env.JAVA_HOME || sdkRoot === process.env.ANDROID_HOME,
  };
}

/** Which of the pinned tools a target needs, in the words `doctor` prints. */
export function requirementsFor(target: Target): readonly string[] {
  switch (target) {
    case 'android':
      return [PINS.jdk.label, PINS.androidTools.label, ...PINS.androidPackages, PINS.gradle.label];
    case 'ios':
      /* XcodeGen is downloadable; Xcode is not, and pretending otherwise would be the lie this
         file exists to avoid — it is a sign-in and an App Store download, and only on a Mac. */
      return ['macOS', 'Xcode with the iOS SDK', PINS.xcodegen.label];
    default:
      return [
        'the Electron runtime for this platform',
        /* Only off a Mac, where the platform's own `codesign` is missing. */
        ...(needsRcodesign(target) ? [PINS.rcodesign.label] : []),
      ];
  }
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

function javac(): string {
  return process.platform === 'win32' ? 'javac.exe' : 'javac';
}

function gradleBinary(): string {
  return process.platform === 'win32' ? 'gradle.bat' : 'gradle';
}

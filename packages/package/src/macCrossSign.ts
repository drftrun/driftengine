import { spawn } from 'node:child_process';
import { open, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * The macOS code signature, applied from a machine that is not a Mac.
 *
 * **Why this exists at all.** electron-builder's own refusal to build a Mac target fires on
 * Windows and nowhere else, so a `.app` packs perfectly well on Linux — and then
 * `isSignAllowed()` returns false off darwin, one warning is logged, and the artifact is finished
 * and unsigned. Apple Silicon's loader refuses an unsigned binary outright, which is not
 * Gatekeeper and which no user gesture works around, so that artifact is one that looks complete
 * and cannot start. `rcodesign` is the one implementation of Apple's signature format that runs
 * anywhere, and this module is the step that puts a signature back on.
 *
 * **Everything here is checked rather than assumed, because nothing on this side can launch the
 * result.** A Mac is the only thing that can prove the app runs; what a Linux host *can* prove is
 * that every binary in the bundle carries a signature, that every nested bundle was sealed, and
 * that the slice inside is the architecture that was asked for. Those are the three ways this step
 * fails silently, and each one below is a refusal rather than a warning.
 */

/**
 * The line rcodesign prints when a nested bundle's main executable cannot be resolved.
 *
 * **Measured rather than guessed, and it is not cosmetic.** A stock Electron distribution ships
 * its helper apps with no `CFBundleExecutable` key; Apple's `codesign` infers the executable from
 * the bundle's own name and rcodesign does not. When it cannot resolve one, it signs the Mach-O
 * inside and then leaves that bundle out of the outer app's `CodeResources` — so the app's
 * signature does not cover its own helpers, and nothing about the build says so.
 *
 * electron-builder rewrites every helper plist with a `CFBundleExecutable` before this runs, which
 * is why a real build does not hit this. That is a fact about a dependency's current behaviour,
 * not a guarantee, so it is checked here instead of trusted.
 */
const UNRESOLVED_NESTED = 'could not find main executable of presumed nested bundle';

export interface CrossSignOptions {
  /** The `.app` directory, which is what rcodesign is pointed at. */
  readonly app: string;
  /** The rcodesign binary, from the cache or from the machine. */
  readonly rcodesign: string;
  /** The slice the artifact is supposed to carry, so a silently wrong one is caught here. */
  readonly arch: 'arm64' | 'x64';
}

/**
 * Ad-hoc sign a `.app` in place, then refuse it if the result is not what was asked for.
 *
 * Ad-hoc is the only mode offered: a Developer ID would need a certificate this host cannot use,
 * and `planSigning` refuses that combination before a build gets this far.
 */
export async function crossSignMacApp(options: CrossSignOptions): Promise<void> {
  /* No identity argument at all is rcodesign's spelling of an ad-hoc signature, and a bundle path
     is signed recursively: nested bundles and loose Mach-O binaries included. */
  const output = await run(options.rcodesign, ['sign', options.app]);

  if (output.includes(UNRESOLVED_NESTED)) {
    const bundles = output
      .split('\n')
      .filter((line) => line.includes(UNRESOLVED_NESTED))
      .map((line) => line.slice(line.indexOf(UNRESOLVED_NESTED) + UNRESOLVED_NESTED.length + 2))
      .join(', ');
    throw new Error(
      `rcodesign could not resolve the main executable of ${bundles}, so the app's signature ` +
        "does not cover it. That is a bundle whose Info.plist has no CFBundleExecutable: Apple's " +
        'codesign infers one from the bundle name and rcodesign does not. The artifact would ' +
        'look signed and fail validation on a Mac.',
    );
  }

  await assertEverySealed(options.app);
  await assertArch(options.app, options.arch);
}

/**
 * The `.zip` a cross-built Mac artifact ships as, archived here rather than by electron-builder.
 *
 * **electron-builder cannot produce this one correctly off a Mac, and says so in its own source**:
 * its archiver picks 7-Zip everywhere except macOS, guarded by a comment reading *"7zip
 * dereferences symlinks, corrupting .framework structure and breaking codesign"*. The guard is
 * written as `process.platform === "darwin"`, so on Linux it takes the 7-Zip path regardless.
 *
 * **A `.framework` is symlinks by construction.** `Electron Framework` points into
 * `Versions/Current`, which points at `Versions/A`. Dereferenced, the archive carries the
 * framework's 192 MB payload twice and no links at all, and macOS rejects that layout as
 * unrecognised — the signature that was correct on disk no longer validates against it. Measured
 * on this repository before this function existed: a 404 MB archive with zero symlink entries,
 * against 353 MB on disk.
 *
 * `zip -y` stores a symlink as a symlink, `-r` recurses, and Unix permission bits are kept, which
 * every executable inside the bundle depends on.
 */
export async function zipMacApp(app: string, into: string): Promise<void> {
  /* `zip` updates an existing archive in place rather than replacing it, so a rebuild would
     otherwise leave files from the previous one in the artifact. */
  await rm(into, { force: true });

  try {
    await run('zip', ['-y', '-r', '-q', into, basename(app)], { cwd: dirname(app) });
  } catch (cause) {
    throw new Error(
      `could not archive the app with \`zip\`: ${String(cause)}. This build needs it because ` +
        "electron-builder's own zip dereferences symlinks off a Mac, which corrupts every " +
        'framework in the bundle. Install it (`apt install zip`) and build again.',
    );
  }

  const symlinks = await countSymlinkEntries(into);
  if (symlinks === 0) {
    throw new Error(
      `${into} contains no symlinks, and a macOS app bundle is built out of them — every ` +
        'framework links its top level into `Versions/Current`. An archive without them holds ' +
        'each framework twice and is rejected by macOS as an unrecognised bundle format. That ' +
        'is what `zip` without `-y` produces.',
    );
  }
  console.log(`[drift-package] archived ${into} with ${String(symlinks)} symlinks preserved`);
}

/* The three fields of the zip format this needs, from APPNOTE.TXT. */
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
/** `S_IFLNK`, in the Unix mode that lives in the high half of the external attributes field. */
const S_IFMT = 0xf000;
const S_IFLNK = 0xa000;

/**
 * How many entries in an archive are symlinks, read from its central directory.
 *
 * **The archive is inspected rather than the tool trusted**, because the failure this guards
 * against is silent by nature: an archiver that dereferences links produces a larger file that
 * unpacks into something that looks complete. Reading the central directory is exact, needs no
 * `zipinfo` on the host, and answers the one question that matters.
 */
async function countSymlinkEntries(zip: string): Promise<number> {
  const handle = await open(zip, 'r');
  try {
    const { size } = await handle.stat();
    /* The end-of-central-directory record is last, after a comment of up to 64 KiB. */
    const tailLength = Math.min(size, 0x10000 + 22);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);

    let eocd = -1;
    for (let at = tail.length - 22; at >= 0; at -= 1) {
      if (tail.readUInt32LE(at) === EOCD_SIGNATURE) {
        eocd = at;
        break;
      }
    }
    if (eocd < 0) throw new Error(`${zip} has no end-of-central-directory record`);

    const entries = tail.readUInt16LE(eocd + 10);
    const directoryLength = tail.readUInt32LE(eocd + 12);
    const directoryStart = tail.readUInt32LE(eocd + 16);

    const directory = Buffer.alloc(directoryLength);
    await handle.read(directory, 0, directoryLength, directoryStart);

    let at = 0;
    let symlinks = 0;
    for (let index = 0; index < entries && at + 46 <= directory.length; index += 1) {
      if (directory.readUInt32LE(at) !== CENTRAL_SIGNATURE) break;
      /* The high half of the external attributes is the Unix mode, for an archive written on
         Unix — which is the only kind this function is ever pointed at. */
      const mode = directory.readUInt32LE(at + 38) >>> 16;
      if ((mode & S_IFMT) === S_IFLNK) symlinks += 1;
      at +=
        46 +
        directory.readUInt16LE(at + 28) +
        directory.readUInt16LE(at + 30) +
        directory.readUInt16LE(at + 32);
    }
    return symlinks;
  } finally {
    await handle.close();
  }
}

/**
 * Every bundle in the artifact carries its own signature.
 *
 * A signed bundle has a `_CodeSignature/CodeResources` beside its contents — the outer app under
 * `Contents/`, a framework under `Versions/A/`. Checking the directory rather than parsing the
 * seal is deliberate: this catches the failure that actually happens, which is a bundle rcodesign
 * walked past, and it does not pretend to be the validation only a Mac can do.
 */
async function assertEverySealed(app: string): Promise<void> {
  const missing: string[] = [];

  if (!(await exists(join(app, 'Contents', '_CodeSignature', 'CodeResources')))) {
    missing.push('the app itself');
  }

  const frameworks = join(app, 'Contents', 'Frameworks');
  for (const entry of await list(frameworks)) {
    const nested = join(frameworks, entry);
    /* A `.app` seals under `Contents/`; a `.framework` under the version it points `Current` at,
       which is `A` for everything Electron ships. */
    const seal = entry.endsWith('.framework')
      ? join(nested, 'Versions', 'A', '_CodeSignature', 'CodeResources')
      : join(nested, 'Contents', '_CodeSignature', 'CodeResources');
    if (entry.endsWith('.app') || entry.endsWith('.framework')) {
      if (!(await exists(seal))) missing.push(entry);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `these parts of the app were not signed: ${missing.join(', ')}. An unsigned binary inside ` +
        'a signed app is refused by the loader at the moment it is needed, which for a helper is ' +
        'the first window rather than the launch.',
    );
  }
}

/**
 * The artifact carries the slice it was asked for.
 *
 * **The failure this prevents is a build that produced the wrong architecture and said nothing.**
 * electron-builder picks the Electron distribution from the target's arch, so a `mac-x64` asked
 * for should never contain arm64 — but a cache with the wrong download in it, or a default that
 * inherited the host's arch, both end as an app that refuses to start on the machine it was made
 * for, with no error that names the cause.
 */
async function assertArch(app: string, expected: 'arm64' | 'x64'): Promise<void> {
  const executable = await mainExecutable(app);
  const found = await machoArch(executable);
  if (found === null) {
    throw new Error(`${executable} is not a Mach-O binary; the app did not pack correctly`);
  }
  if (found !== expected) {
    throw new Error(
      `this build asked for ${expected} and the binary inside is ${found}. That artifact does ` +
        'not run on the machine it was built for, and nothing about it says so until it is opened.',
    );
  }
}

/** The one file under `Contents/MacOS`, which is the app's entry point whatever it is named. */
async function mainExecutable(app: string): Promise<string> {
  const dir = join(app, 'Contents', 'MacOS');
  const [entry] = await list(dir);
  if (entry === undefined) throw new Error(`${dir} is empty; the app did not pack correctly`);
  return join(dir, entry);
}

/* Mach-O's own constants, from `mach-o/loader.h` and `mach/machine.h`. */
const MACHO_64_LE = 0xfeedfacf;
const FAT_BE = 0xcafebabe;
const CPU_X86_64 = 0x01000007;
const CPU_ARM64 = 0x0100000c;

/**
 * Which architecture a Mach-O binary holds, read from its header.
 *
 * Sixteen bytes of file rather than a tool: `file` and `lipo` both answer this and neither is on
 * a Linux host by default, and the header is four fields that have not moved in twenty years.
 * A universal binary answers with what it contains only when that is unambiguous — one slice.
 */
async function machoArch(path: string): Promise<'arm64' | 'x64' | null> {
  const handle = await open(path, 'r');
  try {
    const header = Buffer.alloc(8);
    await handle.read(header, 0, 8, 0);

    if (header.readUInt32LE(0) === MACHO_64_LE) return cpuName(header.readUInt32LE(4));

    if (header.readUInt32BE(0) === FAT_BE) {
      /* A fat header is a count and then 20-byte entries whose first field is the cpu type. */
      const count = header.readUInt32BE(4);
      const names = new Set<'arm64' | 'x64'>();
      for (let index = 0; index < count; index += 1) {
        const entry = Buffer.alloc(4);
        await handle.read(entry, 0, 4, 8 + index * 20);
        const name = cpuName(entry.readUInt32BE(0));
        if (name !== null) names.add(name);
      }
      return names.size === 1 ? [...names][0] : null;
    }

    return null;
  } finally {
    await handle.close();
  }
}

function cpuName(cpu: number): 'arm64' | 'x64' | null {
  if (cpu === CPU_ARM64) return 'arm64';
  if (cpu === CPU_X86_64) return 'x64';
  return null;
}

async function list(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await (await import('node:fs/promises')).access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a command and return everything it said, on both streams.
 *
 * rcodesign narrates to stderr and the warning this module refuses on arrives there, so the two
 * are merged rather than one being watched — a check that read only stdout would pass every time.
 */
async function run(
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(output)
        : reject(new Error(`${command} exited with ${String(code)}:\n${output}`)),
    );
  });
}

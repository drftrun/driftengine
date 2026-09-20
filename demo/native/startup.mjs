/**
 * The native host's start, measured the way a player meets it: one small program packaged for the
 * native target by the packager, launched, and timed from spawn to its first frame.
 *
 *     npm run native:startup [-- --electron] [--runs=5]
 *
 * It builds the packages first — the packager bundles the build, not the source, and a stale `dist`
 * would be measured without a word — then the program in `startup/`, then the artifact, into
 * `.startup/`. One launch warms the disk cache and is not counted; the median of the rest is the
 * number. `--electron` does the same for the desktop target, for the comparison.
 *
 * **The ceilings are the record, and a start or an archive past one fails.** Measured 2026-09-19 on
 * an RX 9070 XT under COSMIC: the native start 730 ms median (715–750) from spawn to first frame —
 * about 275 ms to reach the game's `mount`, 355 to build a WebGPU renderer, 85 to its first frame —
 * and the archive 61.3 MB. Of the renderer's 355 ms, the adapter and the device are 30; the rest is
 * its pipelines, which the binding has no cache for (Chrome builds the same renderer in 75 ms warm).
 * The ceilings leave room for that machine's variance and not for a regression: **what would change
 * them** is a pipeline cache, which lowers the first, or a new binding, which moves the second.
 *
 * **The desktop target is timed under XWayland**, `--ozone-platform=x11`: on this machine's Wayland
 * session Electron 43.4.1 never reaches `ready` — its main thread waits on the compositor's socket —
 * since the compositor changed on 2026-09-09. The host's SDL window is an X11 window too, so the two
 * are timed on the same display path. Under X11 Electron offers no WebGPU here, and draws WebGL2.
 *
 * Not a `*.test.mjs`: it needs a GPU and a display, and it opens a window per launch.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const PROGRAM = join(HERE, 'startup');
const OUT = join(HERE, '.startup');
const MARKER = '[startup] first frame';

const START_CEILING_MS = 1000;
const ARCHIVE_CEILING_MB = 70;

const args = process.argv.slice(2);
const runs = Number(args.find((a) => a.startsWith('--runs='))?.slice(7) ?? 5);

function step(label, command, commandArgs) {
  process.stdout.write(`${label}… `);
  const result = spawnSync(command, commandArgs, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) {
    console.log('failed');
    process.stdout.write(`${result.stdout ?? ''}${result.stderr ?? ''}`);
    process.exit(1);
  }
  console.log('done');
}

function bytes(path) {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((sum, entry) => sum + bytes(join(path, entry)), 0);
}

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

/** Spawn to the marker line, and the line; the whole process group is ended after it. */
function launch(command, launchArgs) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(command, launchArgs, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let seen = '';
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
      reject(new Error(`no first frame in 30 s from ${command}:\n${seen.slice(-2000)}`));
    }, 30_000);
    const listen = (chunk) => {
      seen += chunk;
      const at = seen.indexOf(MARKER);
      if (at < 0) return;
      const ms = performance.now() - started;
      clearTimeout(timer);
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {}
      child.once('exit', () =>
        setTimeout(() => resolve({ ms, line: seen.slice(at).split('\n')[0] }), 300),
      );
    };
    child.stdout.on('data', listen);
    child.stderr.on('data', listen);
    child.on('error', reject);
  });
}

async function time(label, command, launchArgs = []) {
  await launch(command, launchArgs);
  const times = [];
  let line = '';
  for (let i = 0; i < runs; i++) {
    const run = await launch(command, launchArgs);
    times.push(run.ms);
    line = run.line;
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  console.log(
    `${label}: ${median.toFixed(0)} ms median of ${runs} (${times[0].toFixed(0)}–` +
      `${times.at(-1).toFixed(0)}), the last saying: ${line}`,
  );
  return median;
}

step('building the packages', process.execPath, ['scripts/build.mjs']);
step('building the program', 'npx', [
  'vite',
  'build',
  PROGRAM,
  '--base',
  './',
  '--logLevel',
  'error',
]);
const packager = join(ROOT, 'packages', 'package', 'bin', 'drift-package.mjs');
const project = [`--project=${PROGRAM}`, `--out=${OUT}`];
step('packaging it for the native host', process.execPath, [
  packager,
  'build',
  ...project,
  '--target=native-linux-x64',
]);

const native = join(OUT, 'native-linux-x64');
const archive = readdirSync(native).find((file) => file.endsWith('.tar.gz'));
const archiveBytes = bytes(join(native, archive));
console.log(
  `native archive ${mb(archiveBytes)}, unpacked ${mb(bytes(join(native, 'startup')))}, ` +
    `of which Node ${mb(bytes(join(native, 'startup', 'runtime')))}`,
);
const start = await time('native start', join(native, 'startup', 'startup'));

if (args.includes('--electron')) {
  step('packaging it for the desktop target', process.execPath, [
    packager,
    'build',
    ...project,
    '--target=linux-x64',
  ]);
  const desktop = join(OUT, 'linux-x64');
  for (const file of readdirSync(desktop).filter((f) => /\.(tar\.gz|AppImage)$/.test(f))) {
    console.log(`desktop ${file}: ${mb(bytes(join(desktop, file)))}`);
  }
  console.log(`desktop unpacked ${mb(bytes(join(desktop, 'linux-unpacked')))}`);
  await time('desktop start under XWayland', join(desktop, 'linux-unpacked', 'startup'), [
    '--ozone-platform=x11',
  ]);
}

const failures = [];
if (start > START_CEILING_MS)
  failures.push(`the start, ${start.toFixed(0)} ms, is past ${START_CEILING_MS}`);
if (archiveBytes / 1e6 > ARCHIVE_CEILING_MB) {
  failures.push(`the archive, ${mb(archiveBytes)}, is past ${ARCHIVE_CEILING_MB} MB`);
}
for (const failure of failures) console.log(`FAILED: ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);

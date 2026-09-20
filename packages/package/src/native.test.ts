import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import type { PackageManifest } from './manifest.ts';
import {
  buildNative,
  nativeEntrySource,
  nativeHost,
  nativeMachineRefusal,
  nativeNotes,
} from './native.ts';

/**
 * **What this file is for: a game packaged for the native host that has everything it runs on
 * inside it.** The artifact is a Node, the game bundled with the host and the engine, the four
 * modules that cannot be bundled, the game's own files, a launcher and the licences — and a piece
 * missing from it is found on a player's machine, at launch, by the player. Nothing here runs the
 * game, which needs a GPU and a window; each piece is checked for being there and being loadable.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const NODE_LICENCE = 'Node.js is licensed for use as follows:\n\nthe text';
const offline = (url: string): Promise<string> => Promise.reject(new Error(`offline: ${url}`));

const MANIFEST: PackageManifest = {
  id: 'dev.example.title',
  name: 'Title Game',
  entry: 'dist/index.html',
  window: { width: 1024, height: 600, mode: 'borderless', resizable: false },
  backend: { webgpu: 'prefer', allowSoftwareRenderer: false },
  features: { clipExport: false, gamepad: true },
  targets: ['native-linux-x64'],
  native: { entry: 'src/native.mjs' },
  steam: { appId: null },
  android: { permissions: [], cleartextTraffic: false },
  splash: { show: true, minMs: 1400 },
  publisher: 'example',
  icon: null,
};

/* A build is a hundred megabytes, so every directory a test makes is removed after the file. */
const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'native-build-'));
  made.push(root);
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return root;
}

describe('the machine a native build runs on', () => {
  /* The artifact ships this machine's Node and the binaries installed beside it. */
  it('IS LINUX ON X64, because the artifact carries its own binaries', () => {
    expect(nativeMachineRefusal('linux', 'x64')).toBeNull();
    expect(nativeMachineRefusal('darwin', 'arm64')).toMatch(/on darwin/);
    expect(nativeMachineRefusal('linux', 'arm64')).toMatch(/on arm64/);
  });
});

describe('the host a native build takes from the game', () => {
  it('IS REFUSED WHEN THE GAME HAS NONE, naming the install', () => {
    const project = tree({ 'package.json': '{}' });
    expect(() => nativeHost(project, '3.63.0')).toThrow(
      /npm install @driftengine\/native-host@3\.63\.0/,
    );
  });

  /* The host is the engine's own code and moves with it; one release against another is two engines. */
  it('IS REFUSED AT ANOTHER VERSION THAN THE PACKAGER, naming both', () => {
    const project = tree({
      'node_modules/@driftengine/native-host/package.json': JSON.stringify({
        name: '@driftengine/native-host',
        version: '3.62.0',
      }),
    });
    expect(() => nativeHost(project, '3.63.0')).toThrow(/3\.62\.0.*3\.63\.0/s);
    expect(nativeHost(project, '3.62.0')).toBe(
      join(project, 'node_modules', '@driftengine', 'native-host'),
    );
  });
});

describe('the entry a native build writes', () => {
  /*
   * Run against a host that records what it was asked, so what is checked is what the entry does
   * rather than how its source reads.
   */
  async function run(report: string | undefined) {
    const dir = tree({
      'host.mjs':
        "export const configDirectory = () => '/config';\n" +
        'export async function runGame(options) { globalThis.__asked = options; }\n',
      'game.mjs': 'export function mount() {}\n',
    });
    const entry = join(dir, 'app', 'entry.mjs');
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(
      entry,
      nativeEntrySource(MANIFEST, pathToFileURL(join(dir, 'host.mjs')).href, join(dir, 'game.mjs')),
    );
    const before = process.env.DRIFT_STARTUP_REPORT;
    if (report === undefined) delete process.env.DRIFT_STARTUP_REPORT;
    else process.env.DRIFT_STARTUP_REPORT = report;
    try {
      await import(pathToFileURL(entry).href);
    } finally {
      if (before === undefined) delete process.env.DRIFT_STARTUP_REPORT;
      else process.env.DRIFT_STARTUP_REPORT = before;
    }
    const asked = (globalThis as { __asked?: Record<string, unknown> }).__asked ?? {};
    return { dir, asked };
  }

  it("RUNS THE GAME IN THE MANIFEST'S WINDOW, with its files beside it and its saves where the desktop shell keeps them", async () => {
    const { dir, asked } = await run(undefined);
    const { load, ...rest } = asked;
    expect(rest).toEqual({
      title: 'Title Game',
      width: 1024,
      height: 600,
      mode: 'borderless',
      resizable: false,
      publicDir: join(dir, 'app', 'public'),
      storePath: join('/config', 'Title Game', 'store.json'),
      startupReport: false,
    });
    const game = (await (load as () => Promise<{ mount?: unknown }>)()).mount;
    expect(typeof game).toBe('function');
  });

  it('REPORTS ITS FIRST FRAME ONLY WHEN ASKED, which is how its start is measured', async () => {
    expect((await run('1')).asked.startupReport).toBe(true);
    expect((await run('yes')).asked.startupReport).toBe(false);
  });
});

describe('what a native build says it will not do', () => {
  it('NAMES THE BADGE AND THE STORE, which the desktop shell has and the host does not', () => {
    expect(nativeNotes(MANIFEST)).toEqual([expect.stringMatching(/no engine badge/)]);
    expect(
      nativeNotes({ ...MANIFEST, splash: { show: false, minMs: 0 }, steam: { appId: 480 } }),
    ).toEqual([expect.stringMatching(/steam\.appId is 480.*no store/)]);
  });
});

describe('a native build, end to end', () => {
  /*
   * **A copyleft library bundled with the game is refused, not shipped.** The host's own is linked
   * (`LINKED_LIBRARIES`); one the game brings in is named, before anything is copied.
   */
  it('REFUSES TO BUNDLE A COPYLEFT LIBRARY, naming it', async () => {
    const project = tree({
      'package.json': JSON.stringify({ name: 'title', version: '1.2.3' }),
      'src/native.mjs': 'export { mount } from "./shared/index.mjs";\n',
      'src/shared/package.json': JSON.stringify({ name: 'shared', license: 'GPL-3.0-only' }),
      'src/shared/index.mjs': 'export function mount() {}\n',
      'dist/index.html': '<!doctype html>',
    });
    symlinkSync(join(REPO, 'node_modules'), join(project, 'node_modules'));
    const runtime = tree({ 'bin/node': '#!/bin/sh\n', LICENSE: NODE_LICENCE });
    await expect(
      buildNative(MANIFEST, project, join(project, 'out'), {
        conditions: ['drift-source'],
        node: { path: join(runtime, 'bin', 'node'), version: 'v22.23.2' },
        fetchText: offline,
      }),
    ).rejects.toThrow(/would bundle shared \(GPL-3\.0-only\)/);
  });

  it('LAYS OUT A RUNTIME, THE GAME, ITS MODULES, ITS FILES, A LAUNCHER AND THE LICENCES, and archives them', async () => {
    const project = tree({
      'package.json': JSON.stringify({ name: 'title', version: '1.2.3', license: 'UNLICENSED' }),
      'src/native.mjs': 'export function mount(canvas) { return canvas; }\n',
      'dist/index.html': '<!doctype html>',
      'dist/car.drft': 'model',
    });
    symlinkSync(join(REPO, 'node_modules'), join(project, 'node_modules'));
    const runtime = tree({ 'bin/node': '#!/bin/sh\n', LICENSE: NODE_LICENCE });
    const out = join(project, 'out', 'native-linux-x64');

    await buildNative(MANIFEST, project, out, {
      conditions: ['drift-source'],
      node: { path: join(runtime, 'bin', 'node'), version: 'v22.23.2' },
      fetchText: offline,
    });

    const root = join(out, 'title');
    const mode = (path: string) => statSync(join(root, path)).mode & 0o777;
    expect([mode('title'), mode('runtime/node')]).toEqual([0o755, 0o755]);
    expect(readFileSync(join(root, 'title'), 'utf8')).toContain(
      'exec "$here/runtime/node" "$here/app/game.mjs" "$@"',
    );
    expect(readFileSync(join(root, 'app', 'public', 'car.drft'), 'utf8')).toBe('model');
    expect(readdirSync(join(root, 'app', 'modules')).some((f) => f.startsWith('workerScope'))).toBe(
      true,
    );

    /* The bundle parses under Node, and names what it did not take in. */
    execFileSync(process.execPath, ['--check', join(root, 'app', 'game.mjs')]);

    /* Every copied module loads from where the bundle would load it, with what it imports. */
    const modules = readdirSync(join(root, 'app', 'node_modules'));
    expect(modules).toEqual(
      expect.arrayContaining(['@kmamal', 'node-web-audio-api', 'caller', 'codec-parser']),
    );
    expect(modules).not.toContain('tar');
    expect(modules).not.toContain('node-gyp');
    const probe = join(root, 'app', 'probe.mjs');
    const copied = [
      '@kmamal/gpu',
      '@kmamal/sdl',
      'node-web-audio-api',
      '@jsquash/jpeg',
      'codec-parser',
    ];
    writeFileSync(
      probe,
      `${copied.map((name) => `await import(${JSON.stringify(name)});`).join('\n')}\n` +
        "console.log('loaded');\n",
    );
    expect(execFileSync(process.execPath, [probe], { encoding: 'utf8' })).toContain('loaded');
    const binaries = readdirSync(join(root, 'app', 'node_modules', 'node-web-audio-api')).filter(
      (file) => file.endsWith('.node'),
    );
    expect(binaries).toEqual(['node-web-audio-api.linux-x64-gnu.node']);

    const index = readFileSync(join(root, 'licenses', 'INDEX.txt'), 'utf8');
    expect(readFileSync(join(root, 'licenses', 'node', 'LICENSE'), 'utf8')).toBe(NODE_LICENCE);
    for (const name of ['@driftengine/native-host', '@kmamal/gpu', 'node-web-audio-api']) {
      expect(index).toContain(`\n${name} `);
    }
    /* The game's own licence is the game's to state. */
    expect(index).not.toContain('\ntitle ');
    /* The LGPL library is its own file in node_modules, and the GPL it is written against goes too. */
    expect(readFileSync(join(root, 'app', 'game.mjs'), 'utf8')).toMatch(
      /from ["']codec-parser["']/,
    );
    expect(readFileSync(join(root, 'licenses', 'GPL-3.0.txt'), 'utf8')).toMatch(
      /^\s+GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/,
    );

    /*
     * **What the packager adds besides Node stays under 50 MB.** Measured 2026-09-19 at 44.1 MB for
     * this fixture: the four bindings and what they load, 39 MB — the Dawn binding 19, the Web Audio
     * engine's one Linux binary 7, SDL 2.6 — and the host and engine bundled, 4.3. A copied
     * install-only dependency, or every platform's binary, is tens of megabytes and lands here.
     *
     * The same day, one small program — the starter's lit cube — was packaged both ways on one
     * machine (an RX 9070 XT, COSMIC, XWayland for both): the native archive 61.3 MB and 170 MB
     * unpacked, 120 of them Node; the desktop target's 121.7 MB as a tarball, 128.5 MB as an
     * AppImage and 316 MB unpacked. `npm run native:startup` measures the start, which needs a GPU
     * and a window and so is not asserted here.
     */
    const added = (dir: string): number =>
      readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return path === join(root, 'runtime') ? sum : sum + added(path);
        return sum + statSync(path).size;
      }, 0);
    expect(added(root) / 1e6).toBeLessThan(50);

    const archive = join(out, `Title Game-1.2.3-linux-x64.tar.gz`);
    const listing = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8' });
    expect(listing).toMatch(/^-rwxr-xr-x .* title\/title$/m);
    expect(listing).toMatch(/ title\/app\/game\.mjs$/m);
    /* Owned by nobody in particular, so the archive does not carry the builder's account. */
    expect(listing).toMatch(/^-rwxr-xr-x 0\/0 /m);
  }, 120_000);
});

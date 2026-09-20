import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { BRIDGE_KEY, createHost } from '@driftengine/package';
import { nativeBridge } from './bridge.ts';
import type { BridgeDisplay, BridgeWindow } from './bridge.ts';
import { NativeCanvas } from './canvas.ts';
import { HostPage } from './page.ts';

/**
 * **What this file is for: a packaged game, on this host, unchanged.** A game reaches every
 * platform capability through `createHost()` from `@driftengine/package`, which takes the shell's
 * implementations when it finds a bridge on `globalThis.__driftHost` — the desktop shell's preload
 * puts one there. This host puts its own there, so the same call gives the game its store, its
 * window modes, its displays, focus and quit, and the engine's splash stands aside for a shell. The
 * tests go through `createHost`, because that is the call a game makes.
 */

function sdlWindow() {
  const window = Object.assign(new EventEmitter(), {
    width: 1280,
    height: 720,
    pixelWidth: 2560,
    pixelHeight: 1440,
    fullscreen: false,
    display: {
      name: 'Studio',
      frequency: 144,
      geometry: { x: 0, y: 0, width: 2560, height: 1440 },
    },
    setFullscreen(on: boolean) {
      window.fullscreen = on;
    },
    setSize(width: number, height: number) {
      window.width = width;
      window.height = height;
    },
  });
  return window;
}

const DISPLAYS: BridgeDisplay[] = [
  { name: 'Studio', frequency: 144, geometry: { x: 0, y: 0, width: 2560, height: 1440 } },
  { name: null, frequency: 0, geometry: { x: 2560, y: 0, width: 1920, height: 1080 } },
];

let undo: (() => void)[] = [];
afterEach(() => {
  for (const step of undo.reverse()) step();
  undo = [];
});

function setUp(existing?: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'drift-bridge-'));
  undo.push(() => rmSync(dir, { recursive: true, force: true }));
  const storePath = join(dir, 'store.json');
  if (existing !== undefined) writeFileSync(storePath, JSON.stringify(existing));
  const window = sdlWindow();
  let quit = 0;
  const bridge = nativeBridge({
    window: window as unknown as BridgeWindow,
    displays: () => DISPLAYS,
    storePath,
    quit: () => {
      quit += 1;
    },
  });
  const page = new HostPage();
  undo.push(page.install());
  const scope = globalThis as Record<string, unknown>;
  scope[BRIDGE_KEY] = bridge;
  undo.push(() => delete scope[BRIDGE_KEY]);
  const host = createHost(new NativeCanvas(4, 4) as unknown as HTMLElement);
  return { host, bridge, window, storePath, quits: () => quit };
}

describe('a packaged game on the native host', () => {
  test('IT IS TOLD IT IS IN A SHELL, and its store starts where the last session left it', () => {
    const { host } = setUp({ volume: '0.4' });
    expect(host.native).toBe(true);
    expect(host.store.read('volume')).toBe('0.4');
  });

  test('A WRITE LANDS ON DISK WHOLE, and the way out does not lose the last one', () => {
    const { host, bridge, storePath } = setUp();
    host.store.write('volume', '0.9');
    host.store.write('slot', 'forest');
    host.store.remove('slot');
    /* Not yet: writes are gathered, as the desktop shell's are. */
    expect(() => readFileSync(storePath, 'utf8')).toThrow();
    bridge.flushSync();
    expect(JSON.parse(readFileSync(storePath, 'utf8'))).toEqual({ volume: '0.9' });
  });

  test('FULLSCREEN IS THE WINDOW’S, read back rather than assumed, and a size is refused inside it', async () => {
    const { host, window } = setUp();
    expect(host.display.mode()).toBe('windowed');
    expect(host.display.canSetSize()).toBe(true);
    expect(await host.display.setSize(800, 600)).toBe(true);
    expect([window.width, window.height]).toEqual([800, 600]);
    expect(await host.display.setMode('fullscreen')).toBe(true);
    expect(host.display.isFullscreen()).toBe(true);
    expect(host.display.canSetSize()).toBe(false);
    expect(await host.display.setSize(640, 480)).toBe(false);
    expect(host.display.size()).toEqual({ width: 800, height: 600 });
  });

  test('A WINDOW MANAGER THAT REFUSES FULLSCREEN IS BELIEVED, not the request', async () => {
    const { host, window } = setUp();
    window.setFullscreen = () => undefined;
    expect(await host.display.setMode('fullscreen')).toBe(false);
    expect(host.display.mode()).toBe('windowed');
  });

  test('THE DISPLAYS ARE THE PLATFORM’S: a refresh rate where one is reported, a size where no name is', () => {
    const { host } = setUp();
    expect(host.display.refreshHz).toBe(144);
    expect(host.display.displays()).toEqual([
      {
        id: 'Studio@0,0',
        label: 'Studio',
        width: 2560,
        height: 1440,
        /* The window is on this one, so its density is measured: 2560 device pixels over 1280. */
        scale: 2,
        refreshHz: 144,
        primary: true,
      },
      {
        id: '@2560,0',
        label: '1920x1080',
        width: 1920,
        height: 1080,
        scale: 1,
        refreshHz: null,
        primary: false,
      },
    ]);
  });

  test('FOCUS IS TOLD, and a listener taken away hears nothing more', () => {
    const { host, window } = setUp();
    const told: boolean[] = [];
    const stop = host.lifecycle.onFocusChange((focused) => told.push(focused));
    window.emit('blur', {});
    window.emit('focus', {});
    stop();
    window.emit('blur', {});
    expect(told).toEqual([false, true]);
  });

  test('CLOSING ASKS A GAME THAT WANTS ASKING, and its answer quits with the store written', () => {
    const { host, window, storePath, quits } = setUp();
    let asked = 0;
    host.lifecycle.onQuitRequest(() => {
      asked += 1;
    });
    let prevented = false;
    window.emit('beforeClose', { prevent: () => (prevented = true) });
    expect([prevented, asked, quits()]).toEqual([true, 1, 0]);
    host.store.write('saved', 'yes');
    expect(host.lifecycle.canQuit).toBe(true);
    host.lifecycle.requestQuit();
    expect(quits()).toBe(1);
    expect(JSON.parse(readFileSync(storePath, 'utf8'))).toEqual({ saved: 'yes' });
  });

  test('A GAME THAT DID NOT ASK IS CLOSED AT ONCE', () => {
    const { window, quits } = setUp();
    let prevented = false;
    window.emit('beforeClose', { prevent: () => (prevented = true) });
    expect(prevented).toBe(false);
    expect(quits()).toBe(1);
  });
});

/**
 * A world in a few hundred numbers.
 *
 * The terrain is a pure function of the seed, so a save is the seed, the clock, where the player
 * is, and only what the player changed. Water floods and falling blocks are deliberately absent:
 * both re-derive from the terrain plus those edits, and recording them would put thousands of
 * regenerable cells into every file.
 *
 * **The encode and decode halves are pure, and that is a change from the reference.** It calls
 * `showSaveFilePicker` inline, which makes the format untestable; here the browser is behind
 * `FileDialogs`, so the interesting half runs in a test and the seam is the engine's.
 */
import type { FileDialogs, KeyValueStore } from '../../packages/core/src/index';

export interface SaveData {
  v: 1;
  seed: number;
  /** Time of day in `[0,1)`. */
  time: number;
  player: { x: number; y: number; z: number; yaw: number; pitch: number };
  /** Flat `[wx, wy, wz, id, …]`, exactly as `World.exportEdits` gives it. */
  edits: number[];
}

const SAVE_NAME = 'world.voxelsave.json';
const ACCEPT = ['.json'];
/** Where an autosave lives. Namespaced, because a store is shared with whatever else uses one. */
const STORE_KEY = 'voxel-sandbox/world';

/** The version this build writes and the only one it reads. */
const VERSION = 1;

export function encodeSave(data: SaveData): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(data));
}

/**
 * Bytes back into a world, or null.
 *
 * **Null rather than a throw**, because every caller is a click handler or a page load and
 * neither has anywhere to put an exception. A truncated file, a foreign file and a file from a
 * newer build all arrive the same way and are all reported the same way.
 */
export function decodeSave(bytes: Uint8Array): SaveData | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const data = parsed as Partial<SaveData>;
    if (data.v !== VERSION) return null;
    if (typeof data.seed !== 'number' || typeof data.time !== 'number') return null;
    if (!Array.isArray(data.edits)) return null;
    const p = data.player;
    if (
      typeof p !== 'object' ||
      p === null ||
      typeof p.x !== 'number' ||
      typeof p.y !== 'number' ||
      typeof p.z !== 'number' ||
      typeof p.yaw !== 'number' ||
      typeof p.pitch !== 'number'
    ) {
      return null;
    }
    return { v: VERSION, seed: data.seed, time: data.time, player: p, edits: data.edits };
  } catch {
    return null;
  }
}

export async function saveToFile(dialogs: FileDialogs, data: SaveData): Promise<boolean> {
  try {
    return await dialogs.saveFile(SAVE_NAME, encodeSave(data));
  } catch {
    return false;
  }
}

export async function loadFromFile(dialogs: FileDialogs): Promise<SaveData | null> {
  try {
    const opened = await dialogs.openFile(ACCEPT);
    if (opened === null) return null;
    return decodeSave(opened.bytes);
  } catch {
    return null;
  }
}

/**
 * Keep a copy where reloading the page finds it.
 *
 * The reference has no equivalent: it saves to a file or it loses the world. `BrowserStore` falls
 * back to memory where storage is unavailable, so this never throws in a private window — it just
 * quietly does not persist, which is the right failure for a convenience.
 */
export function autosave(store: KeyValueStore, data: SaveData): void {
  store.write(STORE_KEY, JSON.stringify(data));
}

export function restore(store: KeyValueStore): SaveData | null {
  const held = store.read(STORE_KEY);
  if (held === null) return null;
  return decodeSave(new TextEncoder().encode(held));
}

import type { KeyValueStore } from '@driftengine/core';

/**
 * Steam Cloud, behind the persistence seam the engine already had.
 *
 * **`KeyValueStore` needed no widening for this**, which is the point of the seam: the engine
 * reads preferences synchronously during boot, Steam's cloud API is synchronous, and the two fit
 * without an adapter. A game that keeps its saves here gets them on the player's other machine for
 * free, and nothing in the engine knows Steam exists.
 *
 * **Every call degrades rather than throws.** Cloud storage can be turned off per title or per
 * account, and the failure that produces is a game that will not start — on the first preference
 * read, before anything is on screen. So a throw falls back to memory, which is exactly what
 * `BrowserStore` does when `localStorage` is blocked: the settings last the session instead of
 * resetting between screens.
 */
export interface SteamCloud {
  readFile(name: string): string;
  writeFile(name: string, data: string): boolean;
  deleteFile(name: string): boolean;
  fileExists(name: string): boolean;
}

/**
 * A key is a file name on somebody's disk.
 *
 * Slashes, backslashes and dots would make one key reach another game's file, or none at all.
 * Replaced rather than rejected, because a game that has been writing `world.day.23` for a year
 * must not start losing saves the day this lands.
 */
function fileNameFor(key: string): string {
  return `${key.replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.\.+/g, '.')}.txt`;
}

export class SteamCloudStore implements KeyValueStore {
  /** What was read or written this session, so a blocked cloud still behaves like a store. */
  private readonly local = new Map<string, string>();

  constructor(private readonly cloud: SteamCloud) {}

  read(key: string): string | null {
    const cached = this.local.get(key);
    if (cached !== undefined) return cached;
    try {
      const name = fileNameFor(key);
      if (!this.cloud.fileExists(name)) return null;
      const value = this.cloud.readFile(name);
      if (typeof value !== 'string' || value.length === 0) return null;
      this.local.set(key, value);
      return value;
    } catch {
      return null;
    }
  }

  write(key: string, value: string): void {
    this.local.set(key, value);
    try {
      this.cloud.writeFile(fileNameFor(key), value);
    } catch {
      /* Off for this account or this title. The value is in memory and the game carries on. */
    }
  }

  remove(key: string): void {
    this.local.delete(key);
    try {
      this.cloud.deleteFile(fileNameFor(key));
    } catch {
      /* As above. */
    }
  }
}

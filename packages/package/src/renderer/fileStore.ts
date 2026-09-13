import type { KeyValueStore } from '@driftengine/core';

import type { DriftHostBridge } from '../preload/bridge.ts';

/**
 * The engine's persistence seam, backed by a file the shell owns.
 *
 * Reads come from a snapshot taken before the window opened and from this session's own writes;
 * writes go to the main process and do not block. That is precisely the arrangement
 * `KeyValueStore`'s own doc comment prescribes for an asynchronous backend — hydrate a cache
 * first, make `write` fire-and-forget — and it is why the interface never needed widening for
 * this.
 *
 * **What this costs**: a write that fails on disk is not reported here. The main process logs it;
 * the game continues with the value in memory, which is the same degradation `BrowserStore` makes
 * when `localStorage` throws. A preference is never worth failing a boot for.
 */
export class FileStore implements KeyValueStore {
  private readonly entries = new Map<string, string>();

  constructor(private readonly bridge: DriftHostBridge) {
    for (const [key, value] of Object.entries(bridge.storeSnapshot)) this.entries.set(key, value);
  }

  read(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  write(key: string, value: string): void {
    this.entries.set(key, value);
    this.bridge.writeKey(key, value);
  }

  remove(key: string): void {
    this.entries.delete(key);
    this.bridge.removeKey(key);
  }
}

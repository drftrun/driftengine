import { createRequire } from 'node:module';
import { join } from 'node:path';

import type { SteamCloud } from './cloudStore.ts';

/**
 * Steam, opened in the only process that can hold it.
 *
 * **`steamworks.js` is a native Node module and the renderer has no Node.** It runs sandboxed with
 * `contextIsolation` on, which is what keeps a game — and any third-party code, mod or shader it
 * loads — away from the filesystem. So the SDK lives here, in the main process, and reaches a game
 * through the same audited bridge as every other capability.
 *
 * **Every failure is `null`, and there are three ordinary ones**: the manifest named no app, the
 * module is not installed, or the copy was launched outside Steam. A game must run in all three —
 * that last one is every run during development — so none of them throws.
 *
 * `steamworks.js` rather than `greenworks`, whose own README describes itself as maintained on a
 * best-effort basis. A store integration on a release's critical path is the wrong place for that.
 */
export interface SteamRuntime {
  readonly cloud: SteamCloud;
  unlockAchievement(id: string): void;
  setRichPresence(text: string): void;
}

interface SteamClient {
  achievement: { activate(name: string): boolean };
  localplayer: { setRichPresence(key: string, value: string | undefined): void };
  cloud: SteamCloud;
}

export function openSteam(appId: number | null, appRoot: string): SteamRuntime | null {
  if (appId === null) return null;

  let client: SteamClient;
  try {
    /*
     * Resolved from the packaged application's own `node_modules`, which is where `stage.ts` puts
     * it — not from this file's location, which at run time is inside a bundle.
     */
    const require = createRequire(join(appRoot, 'package.json'));
    const steamworks = require('steamworks.js') as { init(appId: number): SteamClient };
    client = steamworks.init(appId);
  } catch (cause) {
    /* Named rather than silent: a developer who expected achievements and got none should be able
       to see which of the three ordinary reasons it was. */
    console.log(`[driftengine] Steam is not available: ${String(cause)}`);
    return null;
  }

  return {
    cloud: client.cloud,
    unlockAchievement: (id) => {
      try {
        client.achievement.activate(id);
      } catch {
        /* An achievement that fails to unlock is not a reason for a frame to stop. */
      }
    },
    setRichPresence: (text) => {
      try {
        client.localplayer.setRichPresence('steam_display', text);
      } catch {
        /* As above. */
      }
    },
  };
}

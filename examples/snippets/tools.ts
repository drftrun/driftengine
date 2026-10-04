/**
 * The two tools the tools example has no use for: the network panel, which needs a session, and
 * the contact probe, which needs colliders.
 *
 * A snippet, typechecked with the examples and quoted by the manual's in-game tools chapter.
 */
import { createContactReports, describeContacts } from '@driftengine/core';
import type { ContactReport } from '@driftengine/core';
import type { WorldSnapshot } from '@driftengine/entities';
import type { LockstepSession, RewindLoop } from '@driftengine/network';
import type { Aabb, ColliderSet } from '@driftengine/physics';
import {
  appendLog,
  bindPanel,
  createNetworkView,
  createSessionRecorder,
  networkPanel,
  observeSession,
  pushRollback,
  sessionReadout,
} from '@driftengine/tools';
import type { LogRing, PanelBinding } from '@driftengine/tools';

// #region network
/**
 * A lockstep session as the network panel reads it: handed over as it is. The loop the game made is
 * read beside it for how far each tick rewound, which the session does not count.
 */
export function networkTools(
  session: LockstepSession<WorldSnapshot>,
  loop: RewindLoop<WorldSnapshot>,
  snapshotBytes: number,
): { panel: PanelBinding; afterTick(): void } {
  const recorder = createSessionRecorder();
  const view = createNetworkView({});
  let replayed = loop.stats.replayedTicks;
  return {
    panel: bindPanel(
      networkPanel,
      () => ({ session: sessionReadout(session, recorder, snapshotBytes) }),
      view,
    ),
    /** Once a tick, after the session has advanced: any new disagreement, and how far it rewound. */
    afterTick() {
      observeSession(recorder, session);
      const now = loop.stats.replayedTicks;
      pushRollback(view.rollback, now - replayed);
      replayed = now;
    },
  };
}
// #endregion

// #region contacts
/**
 * What is around the player, into the console, when a key asks. The reports are filled in place,
 * so asking every frame allocates nothing but the text.
 */
const reports = createContactReports();
const scratch = new Int32Array(256);

export function logContacts(colliders: ColliderSet, player: Aabb, log: LogRing): void {
  const count = describeContacts(colliders, player, 0.25, scratch, reports);
  if (count === 0) appendLog(log, 'info', 'no collider within 25 cm');
  for (let at = 0; at < count; at += 1) {
    const near = reports[at] as ContactReport;
    /* Overlap on all three axes is inside, and the smallest is the way out. */
    const inside = near.depthX > 0 && near.depthY > 0 && near.depthZ > 0;
    const depth = Math.min(near.depthX, near.depthY, near.depthZ);
    appendLog(
      log,
      inside ? 'warn' : 'info',
      inside
        ? `collider ${near.index} is ${(depth * 100).toFixed(1)} cm inside`
        : `collider ${near.index} is ${(near.distanceM * 100).toFixed(1)} cm away`,
    );
  }
}
// #endregion

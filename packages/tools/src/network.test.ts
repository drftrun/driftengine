import { describe, expect, it } from 'vitest';
import { Fingerprint } from '@driftengine/network';
import { pointerEvent } from './panel.ts';
import {
  componentDivergence,
  createNetworkView,
  createRollbackHistory,
  networkPanel,
  pushRollback,
  rollbackValues,
  type NetworkReadout,
  createSessionRecorder,
  observeSession,
  sessionReadout,
} from './network.ts';

function readout(over: Partial<NetworkReadout> = {}): NetworkReadout {
  return {
    inputDelay: 2,
    participants: 2,
    snapshotBytes: 4_096,
    snapshotCount: 32,
    desyncs: [],
    componentHashes: null,
    ...over,
  };
}

describe('the network panel with no session', () => {
  it('says there is none rather than showing zeroes', () => {
    const view = createNetworkView({});
    networkPanel.build({ session: null }, view, view.root);
    expect(view.root.children.length).toBe(1);
    expect(view.root.children[0]?.text).toContain('No session');
  });

  /**
   * **Zeroes would be a claim.** A panel reading "0 rollbacks, 0 bytes, no divergence" is
   * indistinguishable from a healthy session, and somebody would conclude the network was fine
   * when in fact there was nothing there at all.
   */
  it('does not report agreement when there is nobody to agree with', () => {
    const view = createNetworkView({});
    networkPanel.build({ session: null }, view, view.root);
    expect(view.root.children.map((child) => child.text).join(' ')).not.toContain('agree');
  });
});

describe('the network panel with a session', () => {
  it('shows input delay, participants and snapshot memory', () => {
    const view = createNetworkView({});
    networkPanel.build({ session: readout() }, view, view.root);

    const text = view.root.children.map((child) => child.text).join('\n');
    expect(text).toContain('delay  2');
    expect(text).toContain('peers  2');
    expect(text).toContain('snapshots  32');
    expect(text, '4096 bytes times 32 slots').toContain('128.0 KB');
  });

  /**
   * **No divergence is stated explicitly.** An empty divergence list and a missing one must not
   * look the same: one says the peers agree, the other says nobody checked, and they are the two
   * answers somebody most needs to tell apart.
   */
  it('says the peers agree when they do', () => {
    const view = createNetworkView({});
    networkPanel.build({ session: readout() }, view, view.root);
    expect(view.root.children.map((child) => child.text).join('\n')).toContain('peers agree');
  });

  it('names the frame two peers stopped agreeing on', () => {
    const view = createNetworkView({});
    const session = readout({
      desyncs: [
        { tick: 812, peer: 7, ours: 'aaaa000000000000', theirs: 'bbbb000000000000' },
        { tick: 990, peer: 7, ours: 'cccc000000000000', theirs: 'dddd000000000000' },
      ],
    });
    networkPanel.build({ session }, view, view.root);

    const text = view.root.children.map((child) => child.text).join('\n');
    expect(text, 'the first one is the one that matters').toContain('812');
    /* A `PeerId` is a number. This said `'blue'` until the editor was brought inside the
       typechecker, and the panel would have printed whatever it was handed. */
    expect(text).toContain('against 7');
    expect(text).toContain('aaaa000000000000');
    expect(text).not.toContain('990');
  });

  it('shows the rollback depth of recent frames', () => {
    const view = createNetworkView({});
    for (const depth of [0, 3, 1]) pushRollback(view.rollback, depth);
    networkPanel.build({ session: readout() }, view, view.root);
    expect(view.root.children.map((child) => child.text).join('\n')).toContain('rollback  0 3 1');
  });

  it('emits no commands, because there is nothing here to change', () => {
    const view = createNetworkView({});
    const session = readout();
    networkPanel.build({ session }, view, view.root);
    expect(networkPanel.route({ session }, view, pointerEvent('up', 5, 5))).toBe(null);
    expect(
      networkPanel.route({ session }, view, {
        kind: 'key',
        key: 'Delete',
        shift: false,
        ctrl: false,
      }),
    ).toBe(null);
  });
});

describe('the rollback history', () => {
  it('holds a fixed window, oldest first', () => {
    const history = createRollbackHistory(3);
    for (const depth of [1, 2, 3, 4]) pushRollback(history, depth);
    expect(rollbackValues(history)).toEqual([2, 3, 4]);
  });

  it('is empty before anything has happened', () => {
    expect(rollbackValues(createRollbackHistory(4))).toEqual([]);
  });
});

/**
 * **Which component differs is answerable only where somebody hashed per component.**
 * `@driftengine/network` fingerprints a whole snapshot: `Desync` carries two sixteen-character
 * digests and nothing finer. So the panel reports the component where a caller supplied a
 * per-component breakdown, and says the breakdown is absent where it did not — rather than
 * guessing, or quietly showing nothing at all.
 */
describe('which component differs', () => {
  function hashOf(values: number[]): string {
    const print = new Fingerprint();
    for (const value of values) print.float(value);
    return print.digest();
  }

  it('names the components whose hashes disagree', () => {
    const ours = new Map([
      ['Transform', hashOf([1, 2, 3])],
      ['Health', hashOf([100])],
    ]);
    const theirs = new Map([
      ['Transform', hashOf([1, 2, 4])],
      ['Health', hashOf([100])],
    ]);
    expect(componentDivergence(ours, theirs)).toEqual(['Transform']);
  });

  it('reports a component only one side has', () => {
    const ours = new Map([['Transform', hashOf([1])]]);
    const theirs = new Map([
      ['Transform', hashOf([1])],
      ['Ghost', hashOf([0])],
    ]);
    expect(componentDivergence(ours, theirs)).toEqual(['Ghost']);
  });

  it('is empty where every component agrees', () => {
    const same = new Map([['Transform', hashOf([1])]]);
    expect(componentDivergence(same, new Map(same))).toEqual([]);
  });

  it('shows the component in the panel when the breakdown is there', () => {
    const view = createNetworkView({});
    const session = readout({
      desyncs: [{ tick: 812, peer: 7, ours: 'aaaa', theirs: 'bbbb' }],
      componentHashes: {
        ours: new Map([
          ['Transform', 'aa'],
          ['Health', 'cc'],
        ]),
        theirs: new Map([
          ['Transform', 'bb'],
          ['Health', 'cc'],
        ]),
      },
    });
    networkPanel.build({ session }, view, view.root);
    expect(view.root.children.map((child) => child.text).join('\n')).toContain('Transform');
  });

  it('says the breakdown is absent rather than showing nothing', () => {
    const view = createNetworkView({});
    const session = readout({
      desyncs: [{ tick: 812, peer: 7, ours: 'aaaa', theirs: 'bbbb' }],
    });
    networkPanel.build({ session }, view, view.root);
    const text = view.root.children.map((child) => child.text).join('\n');
    expect(text).toContain('no per-component hashes');
  });
});

/*
 * **The readout exists because a session does not hand one over.** `LockstepSession` carries the
 * participants, the input delay and the *current* desync, and the panel wants the history — so
 * somebody has to watch the session and keep what it saw. That watcher is the same in every
 * consumer with a session, which is why it is here rather than in each of them.
 *
 * Typed structurally, so this needs nothing from `@driftengine/network` at run time.
 */
describe('a lockstep session, as something the network panel can read', () => {
  const session = (over: Partial<Record<string, unknown>> = {}) => ({
    participants: 2,
    inputDelay: 3,
    desync: null as { tick: number; peer: number; ours: string; theirs: string } | null,
    loop: { depth: 12 },
    ...over,
  });

  it('carries what the session knows and the snapshot size the caller does', () => {
    const readout = sessionReadout(session(), createSessionRecorder(), 1216);
    expect(readout.participants).toBe(2);
    expect(readout.inputDelay).toBe(3);
    expect(readout.snapshotCount).toBe(12);
    expect(readout.snapshotBytes).toBe(1216);
    expect(readout.desyncs).toEqual([]);
    /* Absent rather than empty: nobody hashed per component here. */
    expect(readout.componentHashes).toBe(null);
  });

  /*
   * **`desync` is latched, not an event.** It keeps answering with the same disagreement every
   * frame until the next one, so a recorder that appended what it read would turn one divergence
   * into sixty a second and the panel would show a wall of the same tick.
   */
  it('records one disagreement once, however often it is observed', () => {
    const recorder = createSessionRecorder();
    const live = session({ desync: { tick: 40, peer: 1, ours: 'aaaa', theirs: 'bbbb' } });
    for (let frame = 0; frame < 5; frame += 1) observeSession(recorder, live);
    expect(sessionReadout(live, recorder, 0).desyncs).toHaveLength(1);
  });

  it('appends a later disagreement rather than replacing the first', () => {
    const recorder = createSessionRecorder();
    const live = session({ desync: { tick: 40, peer: 1, ours: 'aaaa', theirs: 'bbbb' } });
    observeSession(recorder, live);
    live.desync = { tick: 91, peer: 1, ours: 'cccc', theirs: 'dddd' };
    observeSession(recorder, live);
    expect(sessionReadout(live, recorder, 0).desyncs.map((d) => d.tick)).toEqual([40, 91]);
  });

  it('keeps the newest and drops the oldest past its limit', () => {
    const recorder = createSessionRecorder(2);
    const live = session();
    for (const tick of [1, 2, 3]) {
      live.desync = { tick, peer: 1, ours: 'a', theirs: 'b' };
      observeSession(recorder, live);
    }
    expect(sessionReadout(live, recorder, 0).desyncs.map((d) => d.tick)).toEqual([2, 3]);
  });

  it('passes a per-component breakdown through where the caller has one', () => {
    const hashes = { ours: new Map([['Health', 'aa']]), theirs: new Map([['Health', 'bb']]) };
    const readout = sessionReadout(session(), createSessionRecorder(), 0, hashes);
    expect(readout.componentHashes?.ours.get('Health')).toBe('aa');
  });
});

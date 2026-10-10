import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reapOrphanProfiles } from '../packages/core/scripts/browser.mjs';

/** A fake profile set: two owned by live processes, two by dead ones, one unreadable. */
function fixture() {
  const killed = [];
  const removed = [];
  return {
    killed,
    removed,
    options: {
      root: '/tmp',
      listProfiles: () => ['/tmp/p-live', '/tmp/p-dead', '/tmp/p-dead2', '/tmp/p-junk'],
      readOwner: (dir) => {
        if (dir === '/tmp/p-live') return { ownerPid: 100, chromePid: 101 };
        if (dir === '/tmp/p-dead') return { ownerPid: 200, chromePid: 201 };
        if (dir === '/tmp/p-dead2') return { ownerPid: 300, chromePid: 301 };
        return null;
      },
      isAlive: (pid) => pid === 100,
      killTree: (pid) => killed.push(pid),
      remove: (dir) => removed.push(dir),
    },
  };
}

test('a profile whose owner is still alive is left alone', () => {
  const { options, killed, removed } = fixture();
  reapOrphanProfiles(options);
  assert.ok(!killed.includes(101));
  assert.ok(!removed.includes('/tmp/p-live'));
});

test('a profile whose owner is gone has its browser killed and its directory removed', () => {
  const { options, killed, removed } = fixture();
  reapOrphanProfiles(options);
  assert.deepEqual(killed.sort(), [201, 301]);
  assert.ok(removed.includes('/tmp/p-dead'));
  assert.ok(removed.includes('/tmp/p-dead2'));
});

/*
 * A directory with no readable owner file is litter from a run that died between mkdtemp and
 * writing it, or from a version of this script that predates the file. Removing it is right and
 * killing nothing is right: there is no PID to aim at.
 */
test('a profile with no owner file is removed without killing anything', () => {
  const { options, killed, removed } = fixture();
  reapOrphanProfiles(options);
  assert.ok(removed.includes('/tmp/p-junk'));
  assert.equal(killed.length, 2);
});

test('the sweep reports how many it reaped', () => {
  const { options } = fixture();
  assert.equal(reapOrphanProfiles(options), 3);
});

/* One bad directory must not stop the sweep: the whole point is that it always runs to the end. */
test('a failure on one profile does not abandon the rest', () => {
  const { options, removed } = fixture();
  const failing = {
    ...options,
    remove: (dir) => {
      if (dir === '/tmp/p-dead') throw new Error('EBUSY');
      removed.push(dir);
    },
  };
  assert.doesNotThrow(() => reapOrphanProfiles(failing));
  assert.ok(removed.includes('/tmp/p-dead2'));
});

test('A BROWSER IS LOOKED FOR WHERE EACH SYSTEM INSTALLS ONE, AND EDGE IS THE LAST RESORT ON WINDOWS', async () => {
  const { browserCandidates } = await import('../packages/core/scripts/browser.mjs');
  const windows = browserCandidates('win32', {
    PROGRAMFILES: 'C:\\Program Files',
    'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local',
  });
  assert.deepEqual(windows, [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Users\\a\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe',
  ]);
  /* A variable the machine does not set is skipped, not joined into a relative path. */
  assert.equal(browserCandidates('win32', { LOCALAPPDATA: 'C:\\L' }).length, 2);
  const mac = browserCandidates('darwin', { HOME: '/Users/a' });
  assert.deepEqual(mac.slice(0, 2), [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Users/a/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]);
  assert.equal(
    mac.at(-1),
    '/Users/a/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  );
  assert.equal(browserCandidates('darwin', {}).length, 3);
  assert.equal(browserCandidates('linux')[0], '/opt/google/chrome/chrome');
});

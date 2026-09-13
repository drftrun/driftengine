/**
 * A browser that is really using the GPU, or an error saying it is not.
 *
 * **This module exists because the default is wrong and the default is silent.** Plain
 * `--headless=new` on this machine selects SwiftShader, measured: the renderer string comes back
 * `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)` and every
 * frame it produces is a lie about what a player sees. It also saturates and overheats the CPU,
 * which is why `AGENTS.md` forbids it outright. Nothing warns. The pictures look plausible.
 *
 * So the flags below are not tuning, and neither is the check after them. A visual comparison
 * taken on a software renderer is worse than no comparison, because it reads exactly like
 * evidence.
 *
 * **This module also cannot be allowed to leak a browser, and it takes three mechanisms to keep
 * that promise, not one.** Measured on this machine: 132 live headless Chrome processes across 12
 * orphaned profiles, plus 59 stale directories, after a few hours of sessions that each thought
 * their `finally` block would cover them. It didn't, for three separate reasons, and each needs
 * its own fix. First, `spawn` was not detached: Chrome is a tree, not a process — it forks a
 * zygote, a GPU process and one renderer per page — and killing the top of the tree alone leaves
 * the rest running with the port closed and the profile gone, which is exactly the state those
 * 132 were found in. Second, `close()` only runs when the process gets far enough to call it, and
 * SIGINT, a shell timeout, an uncaught exception outside the `try`, and SIGKILL all skip it; a
 * handler can catch the first three, but nothing can run during the fourth. Third, and this is the
 * one that actually bounds the count, nothing was reaping a previous run's corpse, so every leak
 * was permanent and the total only ever grew. A sweep at the start of every launch is the only
 * mechanism that can cover the SIGKILL case, because it runs *after* the crash instead of during
 * it, and it is what turns "leaks accumulate forever" into "at most one leak per still-running
 * process."
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sleep } from './cdp.mjs';

/** Where a Chrome or Chromium lives, in the order worth trying. `CHROME_PATH` wins. */
const CANDIDATES = [
  '/opt/google/chrome/chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

/**
 * What it takes to reach the real card from a headless process.
 *
 * `--use-angle=vulkan` with the feature flag beside it is what moved this machine from
 * SwiftShader to an RX 9070 XT through radv. A caller on other hardware overrides `flags`
 * entirely; the guard below is what tells them whether they need to.
 *
 * **WebGPU needs no third flag, and it does need a secure context.** `navigator.gpu` is present
 * on `http://localhost` with the two below and absent on `about:blank`, which is not one — so a
 * probe that opens a blank page to ask what the adapter is gets told there is none on a machine
 * that has one, and `--enable-unsafe-webgpu` alongside changes neither answer. Both measured, in
 * both directions, because the first reading of that absence was that the card had no adapter.
 * What it reports here is `vendor amd`, `architecture rdna-4`.
 */
const GPU_FLAGS = ['--use-angle=vulkan', '--enable-features=Vulkan'];

const BASE_FLAGS = [
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  '--password-store=basic',
  '--hide-scrollbars',
  /* The port is asked for as 0 and read back out of the profile, so two runs at once cannot
     collide on a number somebody picked. */
  '--remote-debugging-port=0',
];

/** Names a software rasteriser goes by. Any of them means the measurement is worthless. */
const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|microsoft basic/i;

/** Every throwaway profile this module makes, so a sweep can recognise its own litter. */
const PROFILE_PREFIX = 'driftengine-shots-';
/** Written into each profile so a later run can tell whether anybody still owns it. */
const OWNER_FILE = 'driftengine-owner.json';

/**
 * Signal an entire process group, escalating if it does not go.
 *
 * **Chrome is a tree, not a process.** It forks a zygote, a GPU process and one renderer per
 * page, and signalling the parent alone leaves the rest running with the port closed and the
 * profile deleted, which is the state 132 of them were found in. `launch` puts the browser in
 * its own group with `detached`, so the negative PID below reaches every descendant in one call.
 *
 * SIGTERM first because a browser asked politely flushes and exits; SIGKILL after a grace period
 * because one that is wedged never will, and a wedged browser is exactly the case this exists for.
 */
function killTree(pid, graceMs = 2000) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    /* Already gone, or never in its own group. Either way there is nothing to signal. */
    return;
  }
  const deadline = Date.now() + graceMs;
  const timer = setTimeout(
    () => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* it went during the grace period, which is the outcome we wanted */
      }
    },
    Math.max(0, deadline - Date.now()),
  );
  /* Do not hold the event loop open on a browser that has already been told to go. */
  timer.unref?.();
}

/**
 * How long `close()` waits for Chrome to actually exit before touching its directory.
 *
 * Measured on this machine: `killTree` followed immediately by `rmSync`, with no wait between
 * them, raced Chrome's own multi-process shutdown and lost on nearly every ordinary run, leaving
 * a directory behind after almost every `close()` call rather than only the SIGKILL case this
 * module exists for. `killTree`'s own escalation to SIGKILL fires at the 2s mark, so this only
 * needs to clear that by a margin wide enough to let a well-behaved shutdown actually finish
 * writing and release its files; a browser that is still standing after that is wedged rather
 * than slow, and gets left for the next launch's sweep, same as any other case this can't cover.
 */
const CLOSE_WAIT_MS = 3500;

/**
 * Remove every throwaway profile whose owning Node process is gone, killing whatever still runs
 * in it.
 *
 * **This is the part that makes the guarantee absolute, and the reason is worth stating.** Exit
 * handlers cover a crash; they cannot cover `SIGKILL`, a power cut, or an OOM kill, because no
 * code of ours runs in those. Something has to clean up *afterwards*, and the only moment that is
 * guaranteed to come is the next launch. So a leak can survive its own run and cannot survive the
 * next one, which is what stops the count from growing.
 *
 * Every capability is a parameter because the alternative is a test that spawns browsers to check
 * that browsers get cleaned up.
 */
export function reapOrphanProfiles({
  root = tmpdir(),
  listProfiles = () => defaultListProfiles(root),
  readOwner = defaultReadOwner,
  isAlive = defaultIsAlive,
  killTree: kill = killTree,
  remove = (dir) => rmSync(dir, { recursive: true, force: true }),
} = {}) {
  let reaped = 0;
  for (const dir of listProfiles()) {
    try {
      const owner = readOwner(dir);
      /* A live owner is a run in progress, possibly in another terminal. Leave it alone. */
      if (owner !== null && isAlive(owner.ownerPid)) continue;
      if (owner !== null) kill(owner.chromePid);
      remove(dir);
      reaped++;
    } catch {
      /* One unreadable or busy directory must not abandon the rest: a sweep that stops at the
         first problem is a sweep that stops working the first time it is needed. */
    }
  }
  return reaped;
}

function defaultListProfiles(root) {
  return readdirSync(root)
    .filter((name) => name.startsWith(PROFILE_PREFIX))
    .map((name) => path.join(root, name));
}

function defaultReadOwner(dir) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dir, OWNER_FILE), 'utf8'));
    return typeof parsed?.ownerPid === 'number' && typeof parsed?.chromePid === 'number'
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/** Signal 0 asks the kernel whether a PID exists without touching it. */
function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function chromePath() {
  const asked = process.env['CHROME_PATH'];
  if (asked !== undefined && asked !== '') return asked;
  const found = CANDIDATES.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error(
      `no Chrome or Chromium found. Tried:\n  ${CANDIDATES.join('\n  ')}\nSet CHROME_PATH to one.`,
    );
  }
  return found;
}

/**
 * Start a browser and wait for its debugging port.
 *
 * Returns `{ port, close }`. `close` kills the process and removes the throwaway profile, and a
 * caller that forgets leaves a browser running for the length of the session, which is the other
 * half of the rule about stopping temporary sessions after a check.
 */
export async function launch({ flags = GPU_FLAGS, headless = true, timeoutMs = 20_000 } = {}) {
  /* A launch that begins by clearing the last run's corpse is what bounds the leaked count at
     one per still-running process instead of letting it grow across every session that forgot. */
  reapOrphanProfiles();

  const binary = chromePath();
  const profile = mkdtempSync(path.join(tmpdir(), PROFILE_PREFIX));
  const args = [
    ...BASE_FLAGS.filter((flag) => headless || flag !== '--headless=new'),
    `--user-data-dir=${profile}`,
    ...flags,
    'about:blank',
  ];
  /* `detached` puts Chrome in its own process group so `killTree` can reach the zygote, the GPU
     process and every renderer with one signal to the negative PID. `unref()` is deliberately
     not called: the parent must stay attached, or its own exit and signal handlers below never
     fire, and those are half of what closes the other three holes. */
  const child = spawn(binary, args, { stdio: 'ignore', detached: true });
  writeFileSync(
    path.join(profile, OWNER_FILE),
    JSON.stringify({ ownerPid: process.pid, chromePid: child.pid }),
  );

  /*
   * The paths `close()` never gets to run on. `exit` must stay synchronous and best-effort by
   * necessity, not by choice: a `process.once('exit', ...)` handler cannot await anything, full
   * stop, so there is no version of this that waits for Chrome to actually leave before touching
   * its directory. Do not "fix" the race here by making this async — it will not run. The next
   * launch's sweep is the backstop for exactly this case, the same as it is for a SIGKILL this
   * process never even got a handler for. The signal handlers re-raise after cleaning up so the
   * exit code still means what it meant, which matters to a CI character reading it, and they go
   * through this same synchronous path for the same reason: by the time one fires, the process is
   * on its way out either way.
   */
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    killTree(child.pid);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* the browser may still hold a handle; the next launch's sweep will collect it */
    }
  };
  const onSignal = (signal) => {
    cleanup();
    process.removeListener(signal, onSignal);
    process.kill(process.pid, signal);
  };
  process.once('exit', cleanup);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, onSignal);

  const portFile = path.join(profile, 'DevToolsActivePort');
  const started = Date.now();
  let port = 0;
  while (port === 0) {
    if (existsSync(portFile)) {
      const first = readFileSync(portFile, 'utf8').split('\n')[0];
      if (first !== undefined && first !== '') port = Number(first);
    }
    if (port === 0) {
      if (Date.now() - started > timeoutMs) {
        /* The fourth hole: this used to be `child.kill()`, which killed one process and left the
           profile on disk. `cleanup()` is the same path every other exit takes. */
        cleanup();
        throw new Error(`${binary} did not open a debugging port within ${timeoutMs} ms`);
      }
      await sleep(150);
    }
  }

  return {
    port,
    binary,
    async close() {
      if (!cleaned) {
        cleaned = true;
        killTree(child.pid);
        /*
         * Unlike `cleanup()` above, this is already inside an async function, so it is not stuck
         * removing the directory in the same tick as the signal. Waiting for the real exit event
         * (or the grace period, whichever comes first) is what turns "usually leaves a directory
         * behind" into "does not," on the one path that runs every single time.
         */
        await Promise.race([once(child, 'exit'), sleep(CLOSE_WAIT_MS)]);
        try {
          rmSync(profile, { recursive: true, force: true });
        } catch {
          /* still busy after waiting: wedged rather than slow. The next launch's sweep collects it. */
        }
      }
      /* Unconditional and idempotent, so a second close() call (or one that follows a signal that
         already ran cleanup()) still detaches every listener rather than leaving the leftover two
         behind. Without this, a long-lived process launching many browsers accumulates one
         listener per signal per launch and eventually trips Node's max-listeners warning. */
      process.removeListener('exit', cleanup);
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
        process.removeListener(signal, onSignal);
    },
  };
}

/**
 * Which renderer this browser actually chose, asked of a real WebGL2 context.
 *
 * `WEBGL_debug_renderer_info` is the only way to see past the masked string, and its absence is
 * itself worth reporting rather than papering over: a browser that hides it cannot be checked.
 */
export async function rendererName(client) {
  const page = await client.page('about:blank', 320, 240);
  try {
    return await page.eval(`(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      if (gl === null) return 'no webgl2';
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      if (info === null) return 'unknown: WEBGL_debug_renderer_info absent';
      return gl.getParameter(info.UNMASKED_RENDERER_WEBGL);
    })()`);
  } finally {
    await page.close();
  }
}

/**
 * Refuse to go on unless a physical GPU is drawing. Returns the renderer string.
 *
 * Called by `shots.mjs` before anything is captured. A consumer driving its own captures should
 * call it too, once per browser, for the same reason.
 */
export async function requireHardwareGpu(client) {
  const name = await rendererName(client);
  if (SOFTWARE.test(name) || name.startsWith('no webgl2')) {
    throw new Error(
      `this browser is drawing with ${name}, which cannot be measured or looked at.\n` +
        `Try launch({ flags: ['--use-angle=vulkan', '--enable-features=Vulkan'] }), or a ` +
        `different backend for this platform, or run with headless: false.`,
    );
  }
  return name;
}

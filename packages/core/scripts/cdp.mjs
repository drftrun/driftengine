/**
 * A Chrome DevTools Protocol client, small enough to read in one sitting.
 *
 * **Why this is in the engine rather than in whatever needed it this week.** A renderer cannot be
 * judged from a unit test. Every claim this repository makes about a picture rests on
 * photographing that picture, and every consumer of a WebGL engine has the same problem the
 * moment it wants to know whether a change moved a pixel. This had been written from scratch
 * three times across two repositories, with a different set of traps found the hard way in each,
 * so it is now one thing that everybody gets.
 *
 * **No dependency, deliberately.** Node has had a global `WebSocket` since 21, which is the only
 * thing a CDP client actually needs, and the engine's rule about dependencies applies to its
 * tooling as much as to its runtime. Nothing here is imported by anything under `src/`.
 *
 * Pair it with `browser.mjs`, which owns launching a browser that is actually using the GPU.
 *
 *     import { launch } from '@driftengine/core/scripts/browser.mjs';
 *     import { connect } from '@driftengine/core/scripts/cdp.mjs';
 *
 *     const browser = await launch();
 *     const client = await connect(browser.port);
 *     const page = await client.page('http://localhost:5173/?scene=0&hold=420', 1280, 720);
 *     await page.settled();
 *     await page.screenshot('before.png');
 *     await page.close();
 *     client.close();
 *     await browser.close();
 */
import { writeFile } from 'node:fs/promises';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A phone, for `page()`'s `device` option.
 *
 * **A narrow `--width` is not a phone, and the difference is not cosmetic.** Real pages branch on
 * being touch-driven in more places than they branch on being narrow, and the two are separate
 * questions: `(pointer: coarse)` is what decides render scale, control sizes, whether a hover
 * affordance exists at all, and — in at least one consumer — which of two entrances to a scene is
 * built. A 390 px window driven by a mouse satisfies every `max-width` rule and none of those, so
 * it photographs a layout no phone will ever draw and reports it as the mobile view. This preset
 * exists so that trap is opted out of by name rather than rediscovered per consumer.
 *
 * Every field is overridable — `{ ...MOBILE_DEVICE, deviceScaleFactor: 3 }` — and the shape is
 * flat rather than a device catalogue on purpose: a catalogue is a maintenance surface, and the
 * three things that actually change a picture are the scale factor, whether touch is on, and
 * whether the user-agent says mobile.
 */
export const MOBILE_DEVICE = Object.freeze({
  mobile: true,
  /* 2 rather than a real phone's 3: it doubles the screenshot's pixels for the same layout, and
     the extra row of detail at 3 has never been what a capture was read for. Override for a
     genuine text-rendering question. */
  deviceScaleFactor: 2,
  touch: true,
  maxTouchPoints: 5,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
    '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  platform: 'iOS',
  platformVersion: '17.5',
  model: 'iPhone',
});

/** The desktop default, and the behaviour every existing caller already gets. */
const DESKTOP_DEVICE = Object.freeze({
  mobile: false,
  deviceScaleFactor: 1,
  touch: false,
  maxTouchPoints: 0,
  userAgent: null,
  platform: '',
  platformVersion: '',
  model: '',
});

/**
 * Open a session against a browser already listening on `port`.
 *
 * Returns `{ send, on, page, close }`. `send` is the raw protocol, for anything this file does
 * not wrap; `page` is what callers normally want.
 */
export async function connect(port, { timeoutMs = 10_000 } = {}) {
  const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const socket = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error(`no CDP socket on port ${port}`)), {
      once: true,
    });
  });

  let nextId = 1;
  const pending = new Map();
  const listeners = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      if (entry === undefined) return;
      pending.delete(message.id);
      if (message.error)
        entry.reject(new Error(`${message.method}: ${JSON.stringify(message.error)}`));
      else entry.resolve(message.result);
      return;
    }
    for (const listener of listeners) listener(message);
  });

  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} did not answer within ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  const on = (listener) => listeners.push(listener);

  /**
   * A tab at an exact size, with its console captured from before the page loads.
   *
   * **The size is set twice and both are load-bearing.** `Target.createTarget` only honours
   * `width` and `height` when `newWindow` is true, and a target left at its default can come up
   * zero by zero — which is not an error anywhere, it is a run of
   * `GL_INVALID_FRAMEBUFFER_OPERATION` and a black screenshot, so it reads as a renderer drawing
   * nothing. `Emulation.setDeviceMetricsOverride` then fixes the *viewport* the page lays out
   * against, which is a separate question from the window's own bounds.
   *
   * The related trap is on the page's side rather than here: a canvas sized from its layout
   * collapses to zero if a harness hides the surrounding interface with `display: none`. Use
   * `visibility: hidden`. Same black frame, different direction.
   *
   * `device` takes `MOBILE_DEVICE` (or any partial override of it) to photograph the page as a
   * phone rather than as a narrow desktop window — see that constant for why those are not the
   * same capture. Every override below goes on **before the first navigation**, which is the
   * whole reason they are here rather than something a caller can do afterwards with the `call`
   * it is handed back: `(pointer: coarse)` is read by framework state initialisers during the
   * first render, so touch emulation switched on after load is a phone the page has already
   * decided was a desktop.
   */
  const page = async (url, width = 1280, height = 720, { beforeLoad, device } = {}) => {
    const { targetId } = await send('Target.createTarget', {
      url: 'about:blank',
      width,
      height,
      newWindow: true,
    });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const call = (method, params) => send(method, params, sessionId);
    await call('Page.enable');
    await call('Runtime.enable');
    await call('Log.enable');

    const logs = [];
    on((message) => {
      if (message.sessionId !== sessionId) return;
      if (message.method === 'Log.entryAdded') {
        logs.push(`${message.params.entry.level}: ${message.params.entry.text}`);
      }
      if (message.method === 'Runtime.consoleAPICalled') {
        const text = message.params.args
          .map((arg) => arg.value ?? arg.description ?? arg.type)
          .join(' ');
        logs.push(`${message.params.type}: ${text}`);
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails;
        logs.push(`exception: ${details.text} ${details.exception?.description ?? ''}`);
      }
    });

    const metrics = { ...DESKTOP_DEVICE, ...(device ?? null) };

    await call('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: metrics.deviceScaleFactor,
      mobile: metrics.mobile,
      /* The viewport is the layout question; `screen.width`/`screen.height` are a separate one
         that pages read for their own reasons, and leaving them at the host monitor's size while
         claiming to be a phone is an inconsistency worth not shipping into a capture. */
      screenWidth: width,
      screenHeight: height,
      screenOrientation: metrics.mobile
        ? {
            type: width > height ? 'landscapePrimary' : 'portraitPrimary',
            angle: width > height ? 90 : 0,
          }
        : undefined,
    });

    /*
     * Touch and the user agent, both only when asked for. `setTouchEmulationEnabled` is what
     * moves `(pointer: coarse)` and `(hover: none)`; the user-agent override is what moves
     * `navigator.userAgent` and the client hints beside it. Neither implies the other, and a
     * page can read either, so `device` sets both together rather than leaving a capture that
     * feels like a phone to CSS and looks like a desktop to script.
     */
    if (metrics.touch) {
      await call('Emulation.setTouchEmulationEnabled', {
        enabled: true,
        maxTouchPoints: metrics.maxTouchPoints,
      });
    }
    if (metrics.userAgent !== null) {
      await call('Emulation.setUserAgentOverride', {
        userAgent: metrics.userAgent,
        userAgentMetadata: {
          brands: [],
          fullVersion: '',
          platform: metrics.platform,
          platformVersion: metrics.platformVersion,
          architecture: '',
          model: metrics.model,
          mobile: metrics.mobile,
        },
      });
    }

    /*
     * Anything that has to run before the page's own scripts do, and this is the seam that lets
     * the two-capture gate work against a page the harness does not own. A held clock is the case
     * it was added for: patching `requestAnimationFrame` from here needs no cooperation from the
     * page, so a consumer does not grow a dev-only hook on the path to production, and the
     * same call works against a deployed build. It re-runs on every navigation within the target,
     * which is what makes it survive a page that redirects itself.
     */
    if (beforeLoad !== undefined) {
      await call('Page.addScriptToEvaluateOnNewDocument', { source: beforeLoad });
    }
    if (url) await call('Page.navigate', { url });

    const evaluate = async (expression, options = {}) => {
      const result = await call('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        ...options,
      });
      if (result.exceptionDetails) {
        throw new Error(
          `${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`,
        );
      }
      return result.result.value;
    };

    return {
      call,
      logs,
      eval: evaluate,
      /**
       * Wait until the page says it is ready, by polling an expression *in the page*.
       *
       * Polling rather than a fixed sleep, because the two things worth waiting for take
       * wildly different times: a held clock reaches its frame in a second, and a scene that
       * streams a model can take twenty. A timeout that covers the second is dead time on
       * every run of the first.
       *
       * `settleMs` is the deliberate pause *after* the condition holds, for the frames a scene
       * draws between announcing itself and being finished.
       */
      async settled(expression = 'true', { timeoutMs: limit = 120_000, settleMs = 1500 } = {}) {
        const started = Date.now();
        for (;;) {
          if (await evaluate(`Boolean(${expression})`)) break;
          if (Date.now() - started > limit) throw new Error(`page never satisfied: ${expression}`);
          await sleep(250);
        }
        await sleep(settleMs);
      },
      /**
       * Wait `count` animation frames, which is what a picture needs rather than milliseconds.
       *
       * **A setting reaches a drawn pixel on the frame after the one that set it**, so anything
       * that changes what is on screen and then photographs it has to let frames pass. A sleep is
       * the wrong instrument for that: it is dead time when the card is quick and a race when it
       * is not, and which one you get depends on the machine. Asked for because a consumer had
       * written the same four lines and had got it wrong once first, which is the argument for it
       * living here rather than in each harness.
       */
      async frames(count = 2) {
        await evaluate(
          `new Promise((resolve) => {
             let left = ${Math.max(1, Math.floor(count))};
             const step = () => (left-- <= 0 ? resolve(true) : requestAnimationFrame(step));
             requestAnimationFrame(step);
           })`,
        );
      },
      /** Whatever the console holds that looks like trouble. Empty is the passing case. */
      complaints() {
        return logs.filter((line) => /error|exception|warning/i.test(line));
      },
      async screenshot(path) {
        const shot = await call('Page.captureScreenshot', { format: 'png' });
        await writeFile(path, Buffer.from(shot.data, 'base64'));
        return path;
      },
      async close() {
        await send('Target.closeTarget', { targetId });
      },
    };
  };

  return { send, on, page, close: () => socket.close() };
}

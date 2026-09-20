/**
 * The three nodes a host's page has — window, document and canvas, each the parent of the next —
 * and a browser's dispatch across them: capture from the window down, the target, then bubbling
 * back up.
 *
 * **Node's `EventTarget` has no tree**, so an event sent to each node in turn reaches a window's
 * capture listener last rather than first, tells a listener on the window that the window was its
 * target, and lets a passive listener cancel it. Each of those is a page behaving differently here
 * than in Chrome — the engine's own `requestFullscreenOnGesture` listens on the window in the
 * capture phase — so dispatch is the DOM's, for the one shape of tree this host has.
 *
 * **Event handler attributes are listeners**, as the HTML specification makes them: `onclick`
 * assigned is added to the list at that moment, keeps its place when reassigned, and a handler
 * returning `false` cancels the event. A page reached for them — `canvas.ondblclick` — and on a
 * bare `EventTarget` an assignment is a property nothing reads.
 *
 * What it gives up: no shadow roots, no `composed`, and no retargeting, none of which a canvas
 * with nothing inside it can need.
 */

/** The `on…` attributes for `Types`, as a class declares them for the checker. */
export type Handlers<Types extends string> = {
  [Type in Types as `on${Type}`]: ((event: Event) => unknown) | null;
};

interface Listener {
  readonly callback: EventListenerOrEventListenerObject;
  readonly capture: boolean;
  readonly once: boolean;
  readonly passive: boolean;
  removed: boolean;
}

const CAPTURING = 1;
const AT_TARGET = 2;
const BUBBLING = 3;

/** Set on an event while it is dispatched here, read back by the accessors defined on it. */
interface Dispatch {
  target: HostNode;
  current: HostNode | null;
  phase: number;
  path: HostNode[];
  stopped: boolean;
  stoppedNow: boolean;
}
const dispatches = new WeakMap<Event, Dispatch>();

function optionsOf(options: boolean | AddEventListenerOptions | undefined) {
  if (typeof options === 'boolean') return { capture: options, once: false, passive: false };
  return {
    capture: options?.capture === true,
    once: options?.once === true,
    passive: options?.passive === true,
    signal: options?.signal,
  };
}

/** Give `event` the accessors a dispatch answers, once; Node's own are read-only slots. */
function adopt(event: Event, dispatch: Dispatch): void {
  const known = dispatches.has(event);
  dispatches.set(event, dispatch);
  if (known) return;
  const own = (name: string, get: () => unknown) =>
    Object.defineProperty(event, name, { get, configurable: true });
  const now = () => dispatches.get(event) as Dispatch;
  own('target', () => now().target);
  own('srcElement', () => now().target);
  own('currentTarget', () => now().current);
  own('eventPhase', () => now().phase);
  Object.defineProperty(event, 'composedPath', {
    value: () => (now().current === null ? [] : [...now().path]),
    configurable: true,
  });
  const stop = event.stopPropagation.bind(event);
  const stopNow = event.stopImmediatePropagation.bind(event);
  Object.defineProperty(event, 'stopPropagation', {
    value: () => {
      now().stopped = true;
      stop();
    },
    configurable: true,
  });
  Object.defineProperty(event, 'stopImmediatePropagation', {
    value: () => {
      now().stopped = true;
      now().stoppedNow = true;
      stopNow();
    },
    configurable: true,
  });
}

export class HostNode implements EventTarget {
  parentNode: HostNode | null = null;
  private readonly listeners = new Map<string, Listener[]>();
  private readonly handlers = new Map<string, { value: unknown; listener: EventListener }>();

  addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (callback === null) return;
    const { capture, once, passive, signal } = optionsOf(options);
    if (signal?.aborted === true) return;
    const list = this.listeners.get(type) ?? [];
    if (list.some((l) => l.callback === callback && l.capture === capture)) return;
    list.push({ callback, capture, once, passive, removed: false });
    this.listeners.set(type, list);
    signal?.addEventListener('abort', () => this.removeEventListener(type, callback, capture));
  }

  removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    const capture = typeof options === 'boolean' ? options : options?.capture === true;
    const list = this.listeners.get(type);
    const at = list?.findIndex((l) => l.callback === callback && l.capture === capture) ?? -1;
    if (list === undefined || at < 0) return;
    (list[at] as Listener).removed = true;
    list.splice(at, 1);
  }

  dispatchEvent(event: Event): boolean {
    const path: HostNode[] = [];
    for (let node: HostNode | null = this; node !== null; node = node.parentNode) path.push(node);
    const dispatch: Dispatch = {
      target: this,
      current: null,
      phase: 0,
      path,
      stopped: false,
      stoppedNow: false,
    };
    adopt(event, dispatch);
    for (let at = path.length - 1; at > 0 && !dispatch.stopped; at -= 1) {
      (path[at] as HostNode).invoke(event, dispatch, CAPTURING, true);
    }
    if (!dispatch.stopped) this.invoke(event, dispatch, AT_TARGET, true);
    if (!dispatch.stopped) this.invoke(event, dispatch, AT_TARGET, false);
    for (let at = 1; at < path.length && event.bubbles && !dispatch.stopped; at += 1) {
      (path[at] as HostNode).invoke(event, dispatch, BUBBLING, false);
    }
    dispatch.current = null;
    dispatch.phase = 0;
    return !event.defaultPrevented;
  }

  /** `on<type>`, for each type given: a listener held in place, replaced by assignment. */
  protected static handles(prototype: object, types: readonly string[]): void {
    for (const type of types) {
      Object.defineProperty(prototype, `on${type}`, {
        configurable: true,
        get(this: HostNode) {
          return this.handlers.get(type)?.value ?? null;
        },
        set(this: HostNode, value: unknown) {
          const held = this.handlers.get(type);
          if (typeof value !== 'function') {
            if (held !== undefined) this.removeEventListener(type, held.listener);
            this.handlers.delete(type);
            return;
          }
          if (held !== undefined) {
            held.value = value;
            return;
          }
          const slot = {
            value,
            listener: (event: Event) => {
              const result = (slot.value as (e: Event) => unknown).call(this, event);
              if (result === false) event.preventDefault();
            },
          };
          this.handlers.set(type, slot);
          this.addEventListener(type, slot.listener);
        },
      });
    }
  }

  private invoke(event: Event, dispatch: Dispatch, phase: number, capture: boolean): void {
    const list = this.listeners.get(event.type);
    if (list === undefined) return;
    dispatch.current = this;
    dispatch.phase = phase;
    for (const listener of [...list]) {
      if (listener.removed || listener.capture !== capture) continue;
      if (listener.once) this.removeEventListener(event.type, listener.callback, capture);
      const passive = listener.passive;
      if (passive)
        Object.defineProperty(event, 'preventDefault', {
          value: () => undefined,
          configurable: true,
        });
      try {
        const { callback } = listener;
        if (typeof callback === 'function') callback.call(this, event);
        else callback.handleEvent(event);
      } catch (error) {
        /*
         * Reported, and the rest still run: a browser logs an uncaught error in a listener and
         * carries on dispatching, where a rethrow here would end the host's process.
         */
        console.error(error);
      } finally {
        if (passive) delete (event as { preventDefault?: unknown }).preventDefault;
      }
      if (dispatch.stoppedNow) return;
    }
  }
}

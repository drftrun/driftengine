/**
 * Which device the player is actually using, so a consumer can redraw its prompts.
 *
 * **The rule is use, never presence**, and that single word is most of the design. A controller
 * plugged in for something else, or left on a desk, must not change every prompt on screen while
 * the player is still on the keyboard — which is the bug this kind of feature usually ships with.
 * The browser helps: it does not report a gamepad at all until a button has been pressed on it.
 * This closes the rest.
 */

export type InputDevice = 'keyboard' | 'mouse' | 'touch' | 'gamepad';

/**
 * How far a cursor must travel, in pixels, before it counts as the player choosing the mouse.
 *
 * A tuning constant, so its value is not asserted anywhere — `AGENTS.md` forbids that, because a
 * decision that will change every feel pass produces a test that fails on intent.
 */
export const MOUSE_MOVE_THRESHOLD_PX = 32;

export class ActiveDevice {
  /**
   * The keyboard to begin with.
   *
   * Something has to be answered before anything has been touched, and a prompt is more often
   * wanted on a desktop than not. It is corrected by the first real input either way, and no
   * device is *reported* as connected by this — only as used.
   */
  private device: InputDevice = 'keyboard';

  /**
   * Travel accumulated since a device other than the mouse was last used.
   *
   * **A threshold rather than a flip on the first event, and the mouse alone needs one.** A
   * keydown and a touchstart are intentional; a mousemove is not necessarily anything at all — an
   * unlocked cursor drifts, a desk gets bumped, and a window manager can deliver motion nobody
   * caused. Accumulating rather than testing one delta means a slow deliberate movement counts
   * while a single stray pixel does not.
   *
   * **What it costs:** a drift of a pixel at a time does eventually cross it, in about thirty
   * moves. **What would make it wrong:** a pointing device whose ordinary use produces less travel
   * than this — a trackpoint or an eye tracker — where the answer is a smaller threshold rather
   * than none.
   */
  private travel = 0;

  private readonly listeners: ((device: InputDevice) => void)[] = [];

  get last(): InputDevice {
    return this.device;
  }

  /** Record that a device was used. Notifies only on a change. */
  use(device: InputDevice): void {
    if (device !== 'mouse') this.travel = 0;
    if (device === this.device) return;
    this.device = device;
    /* Indexed rather than iterated: this can fire from a frame callback, and the house rule about
       allocation in a per-frame path binds it. */
    for (let i = 0; i < this.listeners.length; i += 1) this.listeners[i]?.(device);
  }

  /** Offer pointer movement. Becomes a use of the mouse once it adds up to a decision. */
  moved(dx: number, dy: number): void {
    if (this.device === 'mouse') return;
    this.travel += Math.hypot(dx, dy);
    if (this.travel >= MOUSE_MOVE_THRESHOLD_PX) this.use('mouse');
  }

  /**
   * Hear about changes. Returns the unsubscribe, which is the shape `InputSource.subscribe` uses.
   *
   * Fires only on a change, so a consumer that redraws its prompts here redraws them once rather
   * than every frame a button is held.
   */
  subscribe(listener: (device: InputDevice) => void): () => void {
    this.listeners.push(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }
}

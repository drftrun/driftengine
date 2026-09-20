/**
 * A pad's `vibrationActuator`, the standard's `dual-rumble` effect, driven through SDL's rumble.
 *
 * The strong magnitude drives the low-frequency motor and the weak one the high-frequency motor,
 * the pair every rumbling pad has. A later effect preempts the one playing, whose promise then
 * settles `preempted`, as the standard describes; one that runs its course settles `complete`.
 */

/** What this drives of an SDL pad, a controller's or a joystick's. */
export interface Rumbler {
  rumble(low: number, high: number, durationMs: number): void;
  stopRumble(): void;
}

export interface DualRumble {
  readonly type: 'dual-rumble';
  readonly effects: readonly string[];
  playEffect(type: string, params: Readonly<Record<string, number>>): Promise<string>;
  reset(): Promise<string>;
}

export function dualRumble(motors: Rumbler): DualRumble {
  let settle: ((result: string) => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const finish = (result: string): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const settling = settle;
    settle = null;
    settling?.(result);
  };
  return {
    type: 'dual-rumble',
    effects: ['dual-rumble'],
    playEffect(type, params) {
      if (type !== 'dual-rumble') {
        return Promise.reject(new Error(`[driftengine] the native host plays no ${type} effect`));
      }
      finish('preempted');
      const duration = params['duration'] ?? 0;
      const delay = params['startDelay'] ?? 0;
      return new Promise((resolve) => {
        settle = resolve;
        const start = () => {
          motors.rumble(params['strongMagnitude'] ?? 0, params['weakMagnitude'] ?? 0, duration);
          timer = setTimeout(() => finish('complete'), duration);
        };
        if (delay > 0) timer = setTimeout(start, delay);
        else start();
      });
    },
    reset() {
      finish('preempted');
      motors.stopRumble();
      return Promise.resolve('complete');
    },
  };
}

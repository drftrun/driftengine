/**
 * A defect in `node-web-audio-api` 2.2.0's automation, corrected for the engine's ramps until it is
 * fixed upstream.
 *
 * **The defect, measured against Chrome on 2026-09-19.** A `setTargetAtTime` whose start is past
 * the first render quantum, following an event that has *settled* — the value simply set, a
 * `setValueAtTime`, the end of a linear or exponential ramp — renders garbage from the second
 * quantum until it starts: 31.1 for a gain holding at 1, 10.5 for one a ramp left at 0.5, a
 * low-pass at −839,731 Hz. From its start on it is Chrome's to four places, and following another
 * `setTargetAtTime` it is right throughout. Every other shape the engine schedules was compared
 * and agrees. The engine's every level and cutoff move is this shape (`mix/inserts.ts`, `ramp`), so
 * the reference mix came out 28 dB hot in its second second.
 *
 * **The correction is what the specification says the value already is.** Before a target starts,
 * a parameter holds the value its last settled event left; so a `setValueAtTime` of exactly that
 * value is placed at the target's start, which changes nothing a browser computes and gives this
 * engine the event it renders correctly. To know that value, each parameter's scheduled events are
 * written down as they are made. Where that record cannot say — a curve spanning the start, a
 * `cancelAndHoldAtTime`, a value set while events are pending — nothing is added, rather than a
 * guess.
 *
 * Remove this with the dependency's fix: `audioParams.test.ts` is Chrome's numbers and will say.
 */

import { createRequire } from 'node:module';

interface Scheduled {
  /** When it takes hold: a ramp's end, a curve's end, a target's start. */
  readonly time: number;
  /** Whether the value from `time` on is `value`, or still moving toward it. */
  readonly settled: boolean;
  readonly value: number;
}

type ParamMethods = {
  setValueAtTime(value: number, time: number): AudioParam;
  linearRampToValueAtTime(value: number, time: number): AudioParam;
  exponentialRampToValueAtTime(value: number, time: number): AudioParam;
  setTargetAtTime(target: number, start: number, constant: number): AudioParam;
  setValueCurveAtTime(values: ArrayLike<number>, start: number, duration: number): AudioParam;
  cancelScheduledValues(time: number): AudioParam;
  cancelAndHoldAtTime(time: number): AudioParam;
};

/** Each parameter's events, time-ordered, or `null` once the record cannot be trusted. */
const records = new WeakMap<object, Scheduled[] | null>();

function recordOf(param: object): Scheduled[] | null {
  let record = records.get(param);
  if (record === undefined) {
    record = [];
    records.set(param, record);
  }
  return record;
}

function add(param: object, event: Scheduled): void {
  const record = recordOf(param);
  if (record === null) return;
  let at = record.length;
  while (at > 0 && (record[at - 1] as Scheduled).time > event.time) at -= 1;
  record.splice(at, 0, event);
}

let installed = false;

/** Correct the Rust engine's parameters, once, for every context made after or before. */
export function correctAutomation(): void {
  if (installed) return;
  installed = true;
  const { AudioParam: Param } = createRequire(import.meta.url)('node-web-audio-api') as {
    AudioParam: { prototype: ParamMethods & { value: number } };
  };
  const proto = Param.prototype;
  const original = {
    setValueAtTime: proto.setValueAtTime,
    linearRampToValueAtTime: proto.linearRampToValueAtTime,
    exponentialRampToValueAtTime: proto.exponentialRampToValueAtTime,
    setTargetAtTime: proto.setTargetAtTime,
    setValueCurveAtTime: proto.setValueCurveAtTime,
    cancelScheduledValues: proto.cancelScheduledValues,
    cancelAndHoldAtTime: proto.cancelAndHoldAtTime,
  };
  const value = Object.getOwnPropertyDescriptor(proto, 'value');

  proto.setValueAtTime = function (this: AudioParam, next, time) {
    add(this, { time, settled: true, value: next });
    return original.setValueAtTime.call(this, next, time);
  };
  proto.linearRampToValueAtTime = function (this: AudioParam, next, time) {
    add(this, { time, settled: true, value: next });
    return original.linearRampToValueAtTime.call(this, next, time);
  };
  proto.exponentialRampToValueAtTime = function (this: AudioParam, next, time) {
    add(this, { time, settled: true, value: next });
    return original.exponentialRampToValueAtTime.call(this, next, time);
  };
  proto.setValueCurveAtTime = function (this: AudioParam, values, start, duration) {
    add(this, { time: start + duration, settled: true, value: values[values.length - 1] ?? 0 });
    /* A curve spans its duration, and a target starting inside it has no settled value to hold. */
    add(this, { time: start, settled: false, value: Number.NaN });
    return original.setValueCurveAtTime.call(this, values, start, duration);
  };
  proto.cancelScheduledValues = function (this: AudioParam, time) {
    const record = recordOf(this);
    if (record !== null) {
      while (record.length > 0 && (record[record.length - 1] as Scheduled).time >= time)
        record.pop();
    }
    return original.cancelScheduledValues.call(this, time);
  };
  proto.cancelAndHoldAtTime = function (this: AudioParam, time) {
    records.set(this, null);
    return original.cancelAndHoldAtTime.call(this, time);
  };
  proto.setTargetAtTime = function (this: AudioParam, target, start, constant) {
    const record = recordOf(this);
    if (record !== null) {
      let last: Scheduled | undefined;
      for (const event of record) if (event.time <= start) last = event;
      /* Nothing before it: what it holds is the value the parameter was simply given. */
      const held =
        last === undefined
          ? (this as unknown as { value: number }).value
          : last.settled
            ? last.value
            : null;
      if (held !== null && Number.isFinite(held)) {
        add(this, { time: start, settled: true, value: held });
        original.setValueAtTime.call(this, held, start);
      }
    }
    add(this, { time: start, settled: false, value: target });
    return original.setTargetAtTime.call(this, target, start, constant);
  };
  if (value?.set !== undefined && value.get !== undefined) {
    const { get, set } = value;
    Object.defineProperty(proto, 'value', {
      configurable: true,
      enumerable: value.enumerable ?? false,
      get,
      set(this: AudioParam, next: number) {
        /* With events pending, a value set now is an event at a time this cannot see. */
        const record = records.get(this);
        if (record !== undefined && record !== null && record.length > 0) records.set(this, null);
        set.call(this, next);
      },
    });
  }
}

import { describe, expect, it } from 'vitest';

import * as rules from './rules.drs';
import { ScriptHost } from './scriptHost';
import * as transit from './transit.drs';

const KEYS = ['interact', 'next', 'previous', 'leave', 'skip', 'map', 'north', 'pause', 'quality'];

/** The rules, stepped once with `pressed` down and the walker riding or not. */
function rulesAfter(
  host: ScriptHost,
  pressed: readonly string[],
  riding = 0,
): Record<string, number> {
  const Keys = host.type('Keys');
  const Play = host.type('Play');
  for (const k of KEYS) host.write(Keys, k, pressed.includes(k) ? 1 : 0);
  host.write(Play, 'riding', riding);
  host.step();
  const out: Record<string, number> = {};
  for (const f of [
    'paused',
    'mapOpen',
    'northUp',
    'board',
    'choose',
    'getOff',
    'skipHour',
    'nextTier',
  ]) {
    out[f] = host.read(Play, f);
  }
  return out;
}

describe("the city's rules", () => {
  it('PAUSED, ONLY THE QUALITY KEY MEANS ANYTHING, AND P AGAIN RESUMES', () => {
    const host = new ScriptHost(rules as unknown as Record<string, unknown>, 'rules', [
      'Keys',
      'Play',
    ]);
    expect(rulesAfter(host, ['pause']).paused).toBe(1);
    const paused = rulesAfter(host, ['map', 'interact', 'skip', 'next', 'quality']);
    expect([paused.mapOpen, paused.board, paused.skipHour, paused.choose, paused.nextTier]).toEqual(
      [0, 0, 0, 0, 1],
    );
    /* Resumed, a key pressed with P counts at once. */
    const resumed = rulesAfter(host, ['pause', 'map']);
    expect([resumed.paused, resumed.mapOpen]).toEqual([0, 1]);
    expect(rulesAfter(host, ['map']).mapOpen).toBe(0);
  });

  it('E BOARDS ONLY A WALKER, ESC LEAVES ONLY A RIDE, AND AN INTENT LASTS ONE FRAME', () => {
    const host = new ScriptHost(rules as unknown as Record<string, unknown>, 'rules', [
      'Keys',
      'Play',
    ]);
    expect(rulesAfter(host, ['interact']).board).toBe(1);
    expect(rulesAfter(host, []).board).toBe(0);
    expect(rulesAfter(host, ['interact'], 1).board).toBe(0);
    expect(rulesAfter(host, ['leave']).getOff).toBe(0);
    expect(rulesAfter(host, ['leave'], 1).getOff).toBe(1);
    expect(rulesAfter(host, ['previous']).choose).toBe(-1);
  });

  it('A RIDE WAITS, BOARDS WHAT COMES, AND IS OVER AT ITS STOP; ESC GIVES UP A WAIT BUT NOT A FLIGHT', () => {
    const host = new ScriptHost(transit as unknown as Record<string, unknown>, 'transit', ['Ride']);
    const Ride = host.type('Ride');
    const after = (facts: Record<string, number>): number[] => {
      for (const [k, v] of Object.entries(facts)) host.write(Ride, k, v);
      host.step();
      for (const k of Object.keys(facts)) host.write(Ride, k, 0);
      return ['state', 'boarded', 'getOffNext', 'landed'].map((f) => host.read(Ride, f));
    };
    expect(after({ askedTrain: 1 })).toEqual([1, 0, 0, 0]);
    expect(after({ cancel: 1 })).toEqual([0, 0, 0, 0]);
    expect(after({ askedTaxi: 1 })).toEqual([3, 0, 0, 0]);
    expect(after({ vehicleHere: 1 })).toEqual([4, 1, 0, 0]);
    /* In the air, Esc asks for nothing: the taxi's next stop is its only one. */
    expect(after({ cancel: 1 })).toEqual([4, 0, 0, 0]);
    expect(after({ atStop: 1 })).toEqual([0, 0, 0, 1]);
    expect(after({ askedTrain: 1 })).toEqual([1, 0, 0, 0]);
    expect(after({ vehicleHere: 1 })).toEqual([2, 1, 0, 0]);
    expect(after({ cancel: 1 })).toEqual([2, 0, 1, 0]);
  });
});

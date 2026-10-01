import { describe, expect, it } from 'vitest';

import { AirTaxis, CRUISING, DESCENDING, HOLDING, PARKED, taxiConfig } from './airTaxis';
import type { SkyportData } from './airTaxis';
import type { TaxiRow } from './data/life';

const CAB: TaxiRow = { kind: 'cab', prefab: 'Taxi', weight: 1, cruise: 44, bias: 0, dwellScale: 1 };
const DT = 1 / 60;
const port = (x: number, z: number): SkyportData => ({ x, z, yaw: 0, deck: 12.3 });

describe('the air taxis', () => {
  it('A FLIGHT CLIMBS TO ITS CRUISE, CROSSES AT ITS KIND’S SPEED, AND PARKS ON ANOTHER DECK', () => {
    const taxis = new AirTaxis(
      [port(0, 0), port(2000, 0), port(0, 2000)],
      [CAB],
      taxiConfig({ airTaxiCount: 3 }),
      5,
    );
    let top = 0;
    let fastest = 0;
    let left = false;
    let t = 0;
    for (; t < 300; t += DT) {
      taxis.step(DT);
      top = Math.max(top, taxis.y[0] as number);
      fastest = Math.max(fastest, taxis.speed[0] as number);
      if (taxis.phase[0] !== PARKED) left = true;
      if (left && taxis.phase[0] === PARKED) break;
    }
    /* Up to 120–160 m, across at no more than its 44 m/s, and down on a deck that is not its own. */
    expect(top).toBeGreaterThanOrEqual(120);
    expect(top).toBeLessThanOrEqual(160);
    expect(fastest).toBeGreaterThan(40);
    expect(fastest).toBeLessThanOrEqual(44 + 1e-3);
    expect(taxis.target[0]).not.toBe(0);
    expect(taxis.phase[0]).toBe(PARKED);
    expect(taxis.y[0]).toBeCloseTo(12.3, 4);
  });

  it('ONE TAXI ON A DECK AT A TIME; THE REST HOLD 40 M ABOVE IT, 15 M APART, FOUR AT MOST, FIRST DOWN FIRST', () => {
    /* Two decks and twenty-four taxis between them: the stacks fill, and the rest go elsewhere. */
    const taxis = new AirTaxis(
      [port(0, 0), port(600, 0)],
      [CAB],
      taxiConfig({ airTaxiCount: 24 }),
      7,
    );
    const heights = new Set<number>();
    const cruising = new Float32Array(taxis.count);
    const since = new Float64Array(taxis.count);
    let most = 0;
    const was = new Uint8Array(taxis.count);
    for (let tick = 0; tick < 60 * 600; tick++) {
      was.set(taxis.phase);
      taxis.step(DT);
      for (let i = 0; i < taxis.count; i++) {
        if (taxis.phase[i] === CRUISING)
          cruising[i] = Math.max(cruising[i] as number, taxis.y[i] as number);
        if (was[i] !== HOLDING && taxis.phase[i] === HOLDING) since[i] = tick;
        /* Down from the stack: nobody who joined it before is still up there. */
        if (was[i] === HOLDING && taxis.phase[i] === DESCENDING) {
          for (let j = 0; j < taxis.count; j++) {
            if (j !== i && taxis.phase[j] === HOLDING && taxis.target[j] === taxis.target[i]) {
              expect(since[j]).toBeGreaterThanOrEqual(since[i] as number);
            }
          }
        }
      }
      for (const p of [0, 1]) {
        let down = 0;
        let holding = 0;
        for (let i = 0; i < taxis.count; i++) {
          if (taxis.target[i] !== p) continue;
          if (taxis.phase[i] === PARKED || taxis.phase[i] === DESCENDING) down++;
          if (taxis.phase[i] === HOLDING) {
            holding++;
            /* Settled in its place: 12.3 + 40, + 55, + 70 or + 85. */
            if (was[i] === HOLDING && taxis.y[i] === taxis.py[i]) {
              heights.add(Math.round(((taxis.y[i] as number) - 12.3) * 10) / 10);
            }
          }
        }
        expect(down).toBeLessThanOrEqual(1);
        most = Math.max(most, holding);
      }
    }
    expect(most).toBe(4);
    expect([...heights].sort((a, b) => a - b)).toEqual([40, 55, 70, 85]);
    /* Every one that cruised did so between 120 and 160 m. */
    for (const top of cruising) if (top > 0) expect(top >= 120 && top <= 160).toBe(true);
  });

  it('OVER A BUSY DECK THE FIRST TO COME IS THE FIRST DOWN, THE FIFTH GOES ELSEWHERE, AND 30 S IS ALL THEY WAIT', () => {
    const config = { airTaxiCount: 7, airTaxiDwellMin: 100, airTaxiDwellMax: 100 };
    /* Taxi 0 parked on the first deck for 100 s; five more closing on it, the highest-numbered
       nearest, so they reach it in the reverse of their numbers. */
    const arrive = (
      patience: number,
    ): { order: [number, number][]; held: number[]; waited: number[] } => {
      const taxis = new AirTaxis(
        [port(0, 0), port(3000, 0)],
        [CAB],
        taxiConfig({ ...config, airTaxiHoldPatience: patience }),
        3,
      );
      taxis.place(0, 0, 12.3, 0, 0);
      taxis.step(0);
      for (let k = 2; k <= 6; k++) taxis.place(k, 60 + 40 * (6 - k), 130, 0, 0);
      const order: [number, number][] = [];
      const held = new Set<number>();
      const joined = new Float64Array(7).fill(-1);
      const waited: number[] = [];
      const was = new Uint8Array(7);
      /* Each lands and stands its 100 s: four in turn take 400 s and more. */
      for (let t = 0; t < 520; t += DT) {
        was.set(taxis.phase);
        taxis.step(DT);
        for (let k = 2; k <= 6; k++) {
          /* Who held on the first approach: the one turned away may come back later. */
          if (t < 60 && taxis.phase[k] === HOLDING && taxis.target[k] === 0) held.add(k);
          if (was[k] !== HOLDING && taxis.phase[k] === HOLDING) joined[k] = t;
          if (was[k] === HOLDING && taxis.phase[k] === DESCENDING) order.push([k, t]);
          if (was[k] === HOLDING && taxis.phase[k] !== HOLDING && taxis.phase[k] !== DESCENDING) {
            waited.push(Math.round((t - (joined[k] as number)) * 10) / 10);
          }
        }
      }
      return { order, held: [...held].sort(), waited };
    };
    /* Patient: 6 first, then 5, 4, 3; 2 found the stack full and never held. */
    const patient = arrive(1000);
    expect(patient.held).toEqual([3, 4, 5, 6]);
    expect(patient.order.slice(0, 4).map(([k]) => k)).toEqual([6, 5, 4, 3]);
    /* With the reference's 30 s, every one gives up before the deck clears at 100 s. */
    const impatient = arrive(30);
    expect(impatient.order.filter(([, t]) => t < 100)).toEqual([]);
    expect(impatient.waited.slice(0, 4)).toEqual([30, 30, 30, 30]);
  });
});

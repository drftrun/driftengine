import { describe, expect, it } from 'vitest';

import { mulberry32 } from '../../packages/core/src/index';
import { Crowd, RADIUS } from './crowd';
import type { JobRow, PersonRow } from './data/life';
import { buildLanes } from './lanes';
import type { StreetData } from './lanes';
import { PavementGraph } from './pavements';
import { Places } from './places';
import { Residents } from './residents';
import { GREEN, RED, lightAt } from './signals';
import { IDLE, PATH, WANDER, Walkers } from './walkers';

const street = (vertical: boolean, from: number, to: number): StreetData => ({
  vertical,
  at: 0,
  from,
  to,
  lanes: 2,
  laneWidth: 3.5,
  median: 0,
  sidewalk: 3,
  speed: 11,
  closed: false,
  green: 14,
  y: 0.3,
});
/* The signalled crossing: pavement corners at (±8.5, ±8.5), arms ending 100 m out. */
const STREETS = [
  street(true, -100, 0),
  street(true, 0, 100),
  street(false, -100, 0),
  street(false, 0, 100),
];
const JUNCTIONS = [{ x: 0, z: 0, streets: [0, 1, 2, 3] }];
const lanes = buildLanes(STREETS, JUNCTIONS, []);
const pavements = new PavementGraph(STREETS, JUNCTIONS, lanes.junctionSignal);
const DT = 1 / 60;

/** The first moment the crossing's `phase` shows `light`, from `t`. */
function when(phase: number, light: number, t = 0): number {
  while (lightAt(lanes.signals, 0, phase, t) === light) t += 0.05;
  while (lightAt(lanes.signals, 0, phase, t) !== light) t += 0.05;
  return t;
}

const PERSON: PersonRow = {
  kind: 'clerk',
  body: 'Walker',
  lite: 'Far',
  job: 'office',
  weight: 1,
  scale: 1,
  speed: [1.5, 1.5],
  homes: {},
  streets: {},
  jaywalk: 0,
  transit: 0,
  palettes: [
    {
      weight: 1,
      skin: [1, 1, 1],
      cloth: [1, 1, 1],
      cloth2: [1, 1, 1],
      hair: [1, 1, 1],
      accent: [1, 1, 1],
      glow: 0,
    },
  ],
};
const step = (hour: number, place: string, outside = 0) => ({
  hour,
  jitter: 0,
  place,
  kind: '',
  radius: 0,
  dwell: 0,
  repeat: 1,
  outside,
});
const OFFICE: JobRow = {
  home: 'VenueHome',
  work: 'VenueOffice',
  favorite: 'VenueBar',
  workRadius: 1000,
  favoriteRadius: 1000,
  steps: [step(0, 'PlaceHome'), step(8, 'PlaceWork')],
};

describe('the people', () => {
  it('A WALK WAITS AT THE KERB FOR ITS GREEN, CROSSES, AND ENDS AT ITS DOOR', () => {
    const walkers = new Walkers(pavements, 1, mulberry32(1));
    walkers.speed[0] = 1.5;
    /* At the south-west corner as the phase that lets it across the south arm turns red. */
    walkers.standAt(0, -8.5, -8.5, 2);
    const t0 = when(1, RED);
    const green = when(1, GREEN, t0);
    /* A door 41.5 m along the east arm's south side, whose nearest corner is the south-east. */
    walkers.go(0, 3, 50, -8.5);
    let t = t0;
    for (; t < green - 0.1; t += DT) walkers.step(DT, t, lanes.signals, 0, 0);
    expect([walkers.x[0], walkers.z[0], walkers.mode[0]]).toEqual([-8.5, -8.5, PATH]);
    /* Across, 17 m, and along, 41.5 m, at 1.5 m/s: 39 s, with a second to spare. */
    for (; t < green + 40; t += DT) walkers.step(DT, t, lanes.signals, 0, 0);
    expect([walkers.x[0], walkers.z[0], walkers.mode[0], walkers.arrived[0]]).toEqual([
      50,
      -8.5,
      IDLE,
      1,
    ]);
  });

  it('OUT OF SIGHT A WALK KEEPS THE DAY’S PACE AND WAITS AT NO KERB; IN SIGHT IT WALKS', () => {
    const t0 = when(1, RED);
    const walk = (eyeX: number): Walkers => {
      const walkers = new Walkers(pavements, 1, mulberry32(1));
      walkers.speed[0] = 1.5;
      walkers.standAt(0, -8.5, -8.5, 2);
      walkers.go(0, 3, 50, -8.5);
      for (let t = t0; t < t0 + 2; t += DT) walkers.step(DT, t, lanes.signals, eyeX, 0);
      return walkers;
    };
    /* Two seconds with the eye 1 km off: 58.5 m at the day's 72 times a walk, red or not. */
    const unseen = walk(1000);
    expect([unseen.x[0], unseen.z[0], unseen.arrived[0]]).toEqual([50, -8.5, 1]);
    /* With the eye at the crossing, the same walk is still waiting for its green. */
    const seen = walk(0);
    expect([seen.x[0], seen.z[0], seen.arrived[0]]).toEqual([-8.5, -8.5, 0]);
  });

  it('A WANDERER NEVER TURNS STRAIGHT BACK WHERE THERE IS ANOTHER WAY', () => {
    const walkers = new Walkers(pavements, 1, mulberry32(3));
    walkers.speed[0] = 1.5;
    walkers.standAt(0, 8.5, 8.5, 0);
    walkers.wander(0);
    const corners: number[] = [];
    for (let tick = 0; tick < 60 * 60 * 20; tick++) {
      walkers.step(DT, tick * DT, lanes.signals, 0, 0);
      const n = walkers.node[0] as number;
      if (corners[corners.length - 1] !== n) corners.push(n);
    }
    expect(walkers.mode[0]).toBe(WANDER);
    expect(corners.length).toBeGreaterThan(20);
    for (let i = 2; i < corners.length; i++) {
      const via = corners[i - 1] as number;
      const ways = (pavements.first[via + 1] as number) - (pavements.first[via] as number);
      if (ways > 1) expect(corners[i]).not.toBe(corners[i - 2]);
    }
  });

  it('A RESIDENT SETS OUT FOR WORK AT ITS HOUR, AND ON ARRIVING GOES IN', () => {
    const places = new Places(
      [
        { x: -50, z: -8.5, kind: 'VenueHome' },
        { x: 50, z: 8.5, kind: 'VenueOffice' },
      ],
      pavements,
    );
    const walkers = new Walkers(pavements, 1, mulberry32(1));
    const residents = new Residents(
      walkers,
      1,
      [PERSON],
      { office: OFFICE },
      places,
      mulberry32(2),
      7,
    );
    /* Seven o'clock: at home, indoors. */
    expect([walkers.x[0], walkers.z[0], residents.shown[0]]).toEqual([-50, -8.5, 0]);
    residents.step(7.99);
    expect(walkers.mode[0]).toBe(IDLE);
    residents.step(8);
    expect([walkers.mode[0], residents.shown[0]]).toEqual([PATH, 1]);
    let t = 0;
    for (; t < 300 && walkers.arrived[0] === 0; t += DT) walkers.step(DT, t, lanes.signals, 0, 0);
    residents.step(8 + t / 3600);
    expect([walkers.x[0], walkers.z[0], residents.shown[0]]).toEqual([50, 8.5, 0]);
  });

  it('THE CROWD FOLLOWS THE WALKER: WHOEVER FALLS OUT OF RANGE IS SET DOWN AGAIN WITHIN IT', () => {
    const walkers = new Walkers(pavements, 60, mulberry32(1));
    const crowd = new Crowd(walkers, 0, 60, [PERSON], pavements, mulberry32(4));
    crowd.step(-60, 0);
    const within = (x: number, z: number): number => {
      let n = 0;
      for (let i = 0; i < 60; i++)
        if (
          ((walkers.x[i] as number) - x) ** 2 + ((walkers.z[i] as number) - z) ** 2 <=
          RADIUS * RADIUS
        )
          n++;
      return n;
    };
    expect(within(-60, 0)).toBe(60);
    /* The walker goes to the far end of the east arm: the west arm is 190 m behind it. */
    crowd.step(95, 0);
    expect(within(95, 0)).toBe(60);
  });
});

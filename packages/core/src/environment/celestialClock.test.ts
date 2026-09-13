import { expect, test } from 'vitest';
import { celestialStateAt, createCelestialState, moonIllumination } from './celestialClock.ts';
import type { CelestialSite } from './celestialClock.ts';

const AZIMUTH = 0.7;

function localTime(hours: number, minutes = 0): number {
  return new Date(2026, 5, 15, hours, minutes, 0, 0).getTime();
}

test('the sun is up at local noon and down at local midnight', () => {
  const state = createCelestialState();
  celestialStateAt(localTime(12), AZIMUTH, state);
  expect(state.sunDir[1]).toBeGreaterThan(0.5);
  expect(state.dayFactor).toBe(1);

  celestialStateAt(localTime(0), AZIMUTH, state);
  expect(state.sunDir[1]).toBeLessThan(-0.5);
  expect(state.dayFactor).toBe(0);
});

test('day factor rises monotonically through dawn', () => {
  const state = createCelestialState();
  let previous = -1;
  for (let minutes = 4 * 60; minutes <= 9 * 60; minutes += 10) {
    celestialStateAt(localTime(0, minutes), AZIMUTH, state);
    expect(state.dayFactor).toBeGreaterThanOrEqual(previous);
    previous = state.dayFactor;
  }
  expect(previous).toBe(1);
});

test('day and night factors partition one', () => {
  const state = createCelestialState();
  for (let hour = 0; hour < 24; hour++) {
    celestialStateAt(localTime(hour), AZIMUTH, state);
    expect(state.dayFactor + state.nightFactor).toBeCloseTo(1, 12);
  }
});

test('the moon opposes the sun and both directions stay normalized', () => {
  const state = createCelestialState();
  for (let hour = 0; hour < 24; hour += 3) {
    celestialStateAt(localTime(hour), AZIMUTH, state);
    expect(state.moonDir[0]).toBeCloseTo(-state.sunDir[0], 12);
    expect(state.moonDir[1]).toBeCloseTo(-state.sunDir[1], 12);
    expect(state.moonDir[2]).toBeCloseTo(-state.sunDir[2], 12);
    expect(Math.hypot(state.sunDir[0], state.sunDir[1], state.sunDir[2])).toBeCloseTo(1, 12);
  }
});

test('lunar phase stays inside one cycle', () => {
  // Cloud drift used to live here, on a fixed speed and bearing. It belongs to
  // the wind now: the clock says what time it is, not what the weather is doing.
  const state = createCelestialState();

  for (let day = 0; day < 60; day++) {
    celestialStateAt(localTime(12) + day * 86_400_000, AZIMUTH, state);
    expect(state.moonPhase).toBeGreaterThanOrEqual(0);
    expect(state.moonPhase).toBeLessThan(1);
  }
});

test('moon illumination follows lunar phase landmarks', () => {
  expect(moonIllumination(0)).toBe(0);
  expect(moonIllumination(0.25)).toBeCloseTo(0.5, 12);
  expect(moonIllumination(0.5)).toBe(1);
  expect(moonIllumination(0.75)).toBeCloseTo(0.5, 12);
  expect(moonIllumination(1)).toBe(0);
});

test('the same inputs always produce the same state', () => {
  const a = createCelestialState();
  const b = createCelestialState();
  celestialStateAt(localTime(15, 37), AZIMUTH, a);
  celestialStateAt(localTime(15, 37), AZIMUTH, b);
  expect(b).toEqual(a);
});

/**
 * The sited model: a latitude, a season, and a moon that agrees with its own phase.
 *
 * **Every expectation here is an almanac fact or a hand-derived literal**, never a second
 * implementation of the same arithmetic — which for a solar-position model is the whole difficulty,
 * because the formula that produces the answer will happily reproduce its own sign error.
 */
const SITE_LONDON = { latitudeDeg: 51.5 };
const SITE_EQUATOR = { latitudeDeg: 0 };
const SITE_TROMSO = { latitudeDeg: 69.6 };

/** June solstice and December solstice, as days of the year. */
const JUNE = 172;
const DECEMBER = 355;

/** The sun's altitude in degrees at a given hour, from `sunDir.y`. */
function altitudeDeg(hours: number, site: Parameters<typeof celestialStateAt>[3]): number {
  const state = createCelestialState();
  celestialStateAt(localTime(hours), AZIMUTH, state, site);
  return (Math.asin(state.sunDir[1]) * 180) / Math.PI;
}

test('a caller that names no site gets exactly what it always got', () => {
  /*
   * **Against literals derived by hand, not against a second call.** The point of keeping the old
   * model is that no existing world moves, and a test comparing the function to itself would pass
   * however far both halves had drifted.
   *
   * At noon the day's fraction is 0.5, so the elevation is `sin(π/2) · 1.15 = 1.15` radians and the
   * azimuth is `0.7 + π/2 = 2.270796`. From there: `cos(1.15) = 0.408487` and `sin(1.15) =
   * 0.912764`; `cos(2.270796) = −0.644218` and `sin(2.270796) = 0.764842`. So the direction is
   * `(0.408487 · −0.644218, 0.912764, 0.408487 · 0.764842)`.
   */
  const state = createCelestialState();
  celestialStateAt(localTime(12), AZIMUTH, state);
  expect(state.sunDir[0]).toBeCloseTo(0.408487 * -0.644218, 6);
  expect(state.sunDir[1]).toBeCloseTo(0.912764, 6);
  expect(state.sunDir[2]).toBeCloseTo(0.408487 * 0.764842, 6);
  /* And the moon is still exactly opposite it, which is the property the sited model drops. */
  expect(state.moonDir[0]).toBeCloseTo(-state.sunDir[0], 12);
});

/**
 * **The complaint this exists for**: without a site the noon sun is 66° up wherever you are.
 *
 * With one it is not. At the June solstice the sun stands within a degree and a half of the zenith
 * at the equator, reaches about 62° in London and about 44° at Tromsø — the almanac figures, each
 * of which is `90 − |latitude − declination|`.
 */
test('noon altitude follows the latitude, which the model without a site cannot', () => {
  const withoutSite = altitudeDeg(12, undefined);
  expect(withoutSite, 'the same everywhere').toBeCloseTo(65.9, 1);

  const june = { dayOfYear: JUNE };
  expect(altitudeDeg(12, { ...SITE_EQUATOR, ...june }), 'equator').toBeCloseTo(66.6, 0);
  expect(altitudeDeg(12, { ...SITE_LONDON, ...june }), 'London').toBeCloseTo(62, 0);
  expect(altitudeDeg(12, { ...SITE_TROMSO, ...june }), 'Tromso').toBeCloseTo(44, 0);
});

/** And it follows the season, which is the other half of the same missing number. */
test('noon altitude follows the season', () => {
  const summer = altitudeDeg(12, { ...SITE_LONDON, dayOfYear: JUNE });
  const winter = altitudeDeg(12, { ...SITE_LONDON, dayOfYear: DECEMBER });
  /* London: about 62° at midsummer and about 15° at midwinter, forty-seven degrees apart —
     which is twice the obliquity, and is the one number a reader can check without an almanac. */
  expect(summer - winter).toBeCloseTo(2 * 23.44, 0);
  expect(winter).toBeGreaterThan(0);
  expect(winter).toBeLessThan(20);
});

/** A world with no tilt has no season at all, which is what the parameter is for. */
test('an untilted world has the same sun every day of its year', () => {
  const one = altitudeDeg(12, { latitudeDeg: 40, dayOfYear: 1, obliquityDeg: 0 });
  const two = altitudeDeg(12, { latitudeDeg: 40, dayOfYear: 200, obliquityDeg: 0 });
  expect(two).toBeCloseTo(one, 9);
  /* And it stands at `90 − latitude`, which is the definition. */
  expect(one).toBeCloseTo(50, 6);
});

/**
 * The polar day, which is where a model without latitude cannot even be wrong in the right shape.
 *
 * Above the Arctic circle at midsummer the sun does not set: its altitude stays positive around the
 * whole clock, and `nightFactor` never reaches one.
 */
test('the sun does not set inside the arctic circle at midsummer', () => {
  const site = { ...SITE_TROMSO, dayOfYear: JUNE };
  for (let hour = 0; hour < 24; hour++) {
    expect(altitudeDeg(hour, site), `at ${hour}:00`).toBeGreaterThan(0);
  }
  /*
   * **`nightFactor` does not reach zero, and that is the model telling the truth rather than a
   * near miss.** The midnight sun at Tromsø stands about three degrees up, whose sine is 0.05 —
   * inside the twilight band the day factor is smoothstepped across. So the sky is *mostly* lit and
   * says so; a hard zero would claim full daylight at a sun sitting on the horizon.
   */
  const state = createCelestialState();
  celestialStateAt(localTime(0), AZIMUTH, state, site);
  expect(state.sunDir[1], 'up, but barely').toBeGreaterThan(0);
  expect(state.nightFactor, 'and mostly lit').toBeLessThan(0.3);
});

/** And the polar night, which is the same fact in December. */
test('and does not rise there at midwinter', () => {
  const site = { ...SITE_TROMSO, dayOfYear: DECEMBER };
  for (let hour = 0; hour < 24; hour++) {
    expect(altitudeDeg(hour, site), `at ${hour}:00`).toBeLessThan(0);
  }
});

/**
 * **The moon agrees with its own phase**, which the model without a site cannot: it pins the moon
 * exactly opposite the sun, so a crescent rises at midnight.
 *
 * A full moon is opposite the sun and is up at local midnight. A new moon shares the sun's place in
 * the sky and is up at noon. The phase is derived from the timestamp, so the fixture searches for a
 * day carrying the phase it wants rather than asserting one.
 */
test('the moon stands where its phase says, not always opposite the sun', () => {
  const state = createCelestialState();
  const site = { ...SITE_LONDON, dayOfYear: JUNE };

  const dayWithPhase = (want: number): number => {
    let best = 0;
    let closest = 1;
    for (let day = 0; day < 30; day++) {
      celestialStateAt(localTime(12) + day * 86_400_000, AZIMUTH, state, site);
      const distance = Math.abs(state.moonPhase - want);
      if (distance < closest) {
        closest = distance;
        best = day;
      }
    }
    return best;
  };

  /*
   * Full: opposite the sun, so up at midnight and down at noon.
   *
   * **Low, though, and the number is an almanac fact worth writing down**: a full moon in June has
   * the *December* sun's declination, so at London it transits at about `90 − 51.5 − 23.4 = 15`
   * degrees — a sine of 0.26. A summer full moon rides along the horizon, which is why it looks
   * enormous, and a test expecting it overhead would be testing an intuition rather than the sky.
   */
  const full = dayWithPhase(0.5);
  celestialStateAt(localTime(0) + full * 86_400_000, AZIMUTH, state, site);
  expect(state.moonDir[1], 'a full moon is up at midnight').toBeGreaterThan(0.2);
  celestialStateAt(localTime(12) + full * 86_400_000, AZIMUTH, state, site);
  expect(state.moonDir[1], 'and down at noon').toBeLessThan(0);

  /* New: with the sun, so up at noon and down at midnight — the exact opposite of the old model. */
  const fresh = dayWithPhase(0);
  celestialStateAt(localTime(12) + fresh * 86_400_000, AZIMUTH, state, site);
  expect(state.moonDir[1], 'a new moon is up at noon').toBeGreaterThan(0.4);
  expect(state.moonDir[1], 'beside the sun rather than opposite it').toBeCloseTo(
    state.sunDir[1],
    1,
  );
});

/** Directions stay unit whatever the site, because everything downstream assumes it. */
test('both directions stay normalised at every latitude and hour', () => {
  const state = createCelestialState();
  for (const latitudeDeg of [-90, -51.5, 0, 23.44, 69.6, 90]) {
    for (let hour = 0; hour < 24; hour += 2) {
      celestialStateAt(localTime(hour), AZIMUTH, state, { latitudeDeg });
      expect(Math.hypot(...state.sunDir), `sun at ${latitudeDeg}`).toBeCloseTo(1, 12);
      expect(Math.hypot(...state.moonDir), `moon at ${latitudeDeg}`).toBeCloseTo(1, 12);
    }
  }
});

/** A latitude past a pole is clamped rather than producing a NaN nobody can trace. */
test('a latitude past a pole is clamped', () => {
  const state = createCelestialState();
  celestialStateAt(localTime(12), AZIMUTH, state, { latitudeDeg: 140 });
  const pole = createCelestialState();
  celestialStateAt(localTime(12), AZIMUTH, pole, { latitudeDeg: 90 });
  expect(state.sunDir[1]).toBeCloseTo(pole.sunDir[1], 12);
});

/**
 * **A clock the host machine cannot move**, which is the whole reason `longitudeDeg` and
 * `utcOffsetHours` exist.
 *
 * The hour used to be read off the timestamp with `Date#getHours`, so one argument named a
 * different hour on every machine and there was no way to say which one was meant. These walk four
 * time zones inside one process — `process.env.TZ` is re-read by V8 on assignment — and assert the
 * old reading still does exactly that and the new one does not.
 *
 * `TZ` is restored in a `finally` rather than at the end of the body, because a failed expectation
 * throws and would otherwise leave every test after it running in Tokyo.
 */
declare const process: { env: Record<string, string | undefined> };

/** June, so the northern offsets are the summer ones: +2, −4 and +9 against UTC. */
const ZONES = ['UTC', 'Europe/Rome', 'America/New_York', 'Asia/Tokyo'];

function inZone<T>(zone: string, body: () => T): T {
  const before = process.env.TZ;
  process.env.TZ = zone;
  try {
    return body();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

/** Midnight UTC on the day every measurement below is taken on. */
const JUNE_DAY_MS = Date.UTC(2026, 5, 15);
/** Rome: the site the complaint came from, and the one place off its zone's centre. */
const ROME = { latitudeDeg: 41.9, dayOfYear: JUNE } as const;
/** The middle of UTC+2 is 30° east, so Rome's meridian is an hour and ten minutes behind it. */
const ROME_NOON_UTC = 12 - 12.5 / 15;

/**
 * The UTC hour at which the sun stands highest, swept to the minute.
 *
 * Solar noon is the hour angle's zero and the declination is pinned, so the maximum is exactly
 * there and a sweep finds it to within half a minute — which is why every expectation below is to
 * one decimal place rather than to twelve.
 */
function peakUtcHour(site: CelestialSite): number {
  const state = createCelestialState();
  let best = 0;
  let highest = -2;
  for (let minute = 0; minute < 24 * 60; minute++) {
    celestialStateAt(JUNE_DAY_MS + minute * 60_000, AZIMUTH, state, site);
    if (state.sunDir[1] > highest) {
      highest = state.sunDir[1];
      best = minute;
    }
  }
  return best / 60;
}

/**
 * **The defect, measured, and deliberately still here.**
 *
 * These four numbers are the ones in the report: one build, one instant, `dayOfYear` pinned, and
 * solar noon lands at a different place on the clock in every zone. A site naming no zone is the
 * form every world was authored against, so it keeps this reading exactly — and a test that says
 * so is what stops somebody quietly making it host-independent and moving every shadow in every
 * consumer at once.
 */
test('a site naming no zone still reads the hour off the host, which is the old contract', () => {
  const noon = ZONES.map((zone) => inZone(zone, () => peakUtcHour(ROME)));
  expect(noon[0], 'UTC').toBeCloseTo(12, 1);
  expect(noon[1], 'Europe/Rome').toBeCloseTo(10, 1);
  expect(noon[2], 'America/New_York').toBeCloseTo(16, 1);
  expect(noon[3], 'Asia/Tokyo').toBeCloseTo(3, 1);
});

/** And naming one is what stops it: the same instant, the same hour, on every machine. */
test('an offset names the hour outright, and the host stops being consulted', () => {
  const site = { ...ROME, utcOffsetHours: 2 };
  for (const zone of ZONES) {
    /* Noon on a clock two hours ahead of UTC is 10:00 UTC, wherever the process is running. */
    expect(
      inZone(zone, () => peakUtcHour(site)),
      zone,
    ).toBeCloseTo(10, 1);
  }
});

/**
 * **The meridian is what places the sun; the offset only names the day.**
 *
 * Rome sits at 12.5° east and keeps the time of 30° east, so its sun is an hour and ten minutes
 * behind its clock — the half-hour-either-way error the header has always warned about, now the
 * engine's to correct rather than the caller's.
 */
test('a longitude moves the sun off the centre of its zone', () => {
  const site = { ...ROME, longitudeDeg: 12.5, utcOffsetHours: 2 };
  for (const zone of ZONES) {
    expect(
      inZone(zone, () => peakUtcHour(site)),
      zone,
    ).toBeCloseTo(ROME_NOON_UTC, 1);
  }
  /* Which is 13:10 on the wall, and not 12:00 — the whole point of naming the meridian. */
  expect(ROME_NOON_UTC + 2).toBeCloseTo(13 + 10 / 60, 2);
});

/**
 * A longitude alone is a place keeping its own solar time, which is the same sun.
 *
 * The zone it implies differs — 12.5° east is UTC+0:50, not UTC+2 — and that shows only in which
 * calendar day the declination comes from, which is the test below this one.
 */
test('a longitude alone places the sun exactly where the pair does', () => {
  const alone = peakUtcHour({ ...ROME, longitudeDeg: 12.5 });
  expect(alone).toBeCloseTo(ROME_NOON_UTC, 1);
  expect(alone).toBeCloseTo(peakUtcHour({ ...ROME, longitudeDeg: 12.5, utcOffsetHours: 2 }), 6);
});

/**
 * **Which day of the year the season comes from is the site's, not UTC's and not the host's.**
 *
 * Recovered rather than asserted about: pin every day in turn and find the one that reproduces the
 * sun the site derived for itself. Float equality is exact here because it is the same arithmetic
 * over the same inputs.
 */
test('the offset names the site’s own calendar day', () => {
  /* Half past eleven at night on the thirty-first: already January two hours east, still
     December two hours west. */
  const when = Date.UTC(2026, 11, 31, 23, 30);
  const dayUsed = (utcOffsetHours: number): number => {
    const derived = createCelestialState();
    const site = { latitudeDeg: 41.9, longitudeDeg: 12.5, utcOffsetHours };
    celestialStateAt(when, AZIMUTH, derived, site);
    const probe = createCelestialState();
    for (let day = 1; day <= 366; day++) {
      celestialStateAt(when, AZIMUTH, probe, { ...site, dayOfYear: day });
      if (probe.sunDir[1] === derived.sunDir[1]) return day;
    }
    return -1;
  };
  expect(dayUsed(2), 'the first of January').toBe(1);
  expect(dayUsed(-2), 'the thirty-first of December').toBe(365);
});

/**
 * **The moon is the half the workaround could not reach**, and is why this landed on the site
 * rather than as an hour on its own.
 *
 * The way to steady the sun without an engine change was to build the timestamp from local parts,
 * so the host's offset cancelled instead of being added. It works — the sun below is one number
 * across four zones — and it works by handing this function a *different instant* on every
 * machine, which `moonPhase` reads. Naming the zone hands it one instant and steadies both.
 */
test('naming a zone steadies the moon too, which the timestamp trick could not', () => {
  const site = { ...ROME, longitudeDeg: 12.5, utcOffsetHours: 2 };
  const byHand = new Set<string>();
  const named = new Set<string>();

  for (const zone of ZONES) {
    inZone(zone, () => {
      const trick = createCelestialState();
      celestialStateAt(new Date(2026, 5, 15, 12, 0, 0, 0).getTime(), AZIMUTH, trick, ROME);
      byHand.add(`${trick.sunDir[1]}|${trick.moonPhase}`);

      const state = createCelestialState();
      celestialStateAt(Date.UTC(2026, 5, 15, 10, 0, 0), AZIMUTH, state, site);
      named.add(`${state.sunDir[1]}|${state.moonPhase}`);
    });
  }

  expect(byHand.size, 'the sun held, the moon did not').toBe(ZONES.length);
  expect(named.size, 'one instant, one sky').toBe(1);
});

/** Whole state, not just the sun: nothing the caller reads depends on where the process runs. */
test('every field of a zoned sky is identical across time zones', () => {
  const site = { ...ROME, longitudeDeg: 12.5, utcOffsetHours: 2 };
  const when = Date.UTC(2026, 5, 15, 16, 43, 7);
  const states = ZONES.map((zone) =>
    inZone(zone, () => {
      const state = createCelestialState();
      celestialStateAt(when, AZIMUTH, state, site);
      return state;
    }),
  );
  for (const state of states) expect(state).toEqual(states[0]);
  /* And it is a real sky rather than four copies of a default. */
  expect(Math.hypot(...states[0]!.sunDir)).toBeCloseTo(1, 12);
});

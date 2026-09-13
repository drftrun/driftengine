/**
 * Allocation-free wall-clock sampling for a procedural sun, moon and clouds.
 *
 * **Two models, and a caller chooses by whether it names a place.** Without a `CelestialSite` this
 * is what it has always been: a sun swung through a fixed arc, peaking at the same altitude every
 * day of every year wherever the world is meant to be. With one, it is the standard solar-position
 * arithmetic — a declination from the day of the year, an hour angle from the clock, and an
 * altitude and azimuth from those and the latitude.
 *
 * **The simplified model is kept rather than replaced**, and that is the engine's ordinary rule
 * rather than a soft touch: every world authored against this engine has its lighting tuned against
 * that arc, and a model that silently moved the sun would move every shadow, every exposure and
 * every night in every consumer at once. A caller that passes no site gets the same numbers it got
 * before, bit for bit, which `celestialClock.test.ts` asserts against literals rather than against
 * a second implementation.
 *
 * **What the simplified model gives up, said plainly, because a consumer worked it out for
 * themselves first:** no latitude, so the sun reaches 66° at noon on the equator and at the pole
 * alike; no season, so the arc is the same in December as in June; an azimuth that sweeps a whole
 * turn in a day where a real one swings through rather less; and a moon pinned exactly opposite the
 * sun, which contradicts the phase reported beside it — a crescent that rises at midnight. All four
 * are fixed by naming a site.
 *
 * **A site can also name its clock, and until 2026-09-03 nothing could.** The hour was read off the
 * timestamp through the *host machine's* time zone, so one argument put the sun in four places on
 * four machines — solar noon at 12:00 under `TZ=UTC`, 10:00 in Rome, 16:00 in New York, 03:00 in
 * Tokyo — and the only way to say an hour was to build a timestamp whose host offset cancelled the
 * one being added. `longitudeDeg` and `utcOffsetHours` are the way to say it instead: either one
 * makes the timestamp a UTC instant and the engine derives the site's own hour, so the sky is a
 * function of the arguments alone. It was found by a player in Italy watching the sun set before
 * six, which is what the workaround cost when the host disagreed with the world.
 */

import { TAU, smoothstep } from '../math/scalar.ts';
import type { Vec3 } from '../math/color.ts';

/**
 * Where in the world, and when in the year, the sky is being sampled.
 *
 * **A site rather than a latitude alone**, because latitude and season are one question: the sun's
 * altitude is a function of the declination *and* the latitude, and a model with one and not the
 * other is wrong in a way that only shows up six months later.
 */
export interface CelestialSite {
  /**
   * Degrees north of the equator, −90 to 90. Clamped rather than refused, because a value past a
   * pole is a caller's arithmetic overshooting rather than a request for something impossible.
   */
  readonly latitudeDeg: number;
  /**
   * Degrees east of Greenwich, −180 to 180, or absent.
   *
   * **Naming this or `utcOffsetHours` changes what the timestamp means**: it stops being read
   * through the host machine's time zone and becomes a plain UTC instant, from which this site's
   * own hour is derived. See `celestialStateAt`. Not clamped, because a longitude is an angle and
   * a value past the antimeridian means the place a turn around says it does.
   *
   * Alone, it also stands in for the zone: a place is assumed to keep the time of its own
   * meridian, which is exact solar time and differs from a real zone by up to half an hour.
   */
  readonly longitudeDeg?: number;
  /**
   * Hours this site's wall clock runs ahead of UTC — `2` for Italy in summer — or absent.
   *
   * The other half of the pair above, and the same switch: naming it makes the timestamp a UTC
   * instant. It is what turns that instant into the site's *calendar day*, which is the one thing
   * a longitude cannot do; with `longitudeDeg` beside it the sun also stops sitting at the zone's
   * centre and moves to the place's real meridian, up to half an hour either way.
   *
   * **Daylight saving is the caller's**, because a zone's offset is a function of the date and of
   * legislation, and an engine that shipped a table of it would ship a table that expires.
   */
  readonly utcOffsetHours?: number;
  /**
   * Day of the year, 1 to 365, or absent to take it from the timestamp.
   *
   * Present because a world may run on a calendar of its own — a game whose year is forty days
   * still wants a season — and taking it from the timestamp would tie that to the wall clock.
   */
  readonly dayOfYear?: number;
  /**
   * The planet's axial tilt in degrees. Earth's 23.44 by default.
   *
   * Zero is a world with no seasons at all, where the sun's arc is the same every day and depends
   * on latitude alone; larger values are a world with sharper ones. It is here because it costs one
   * multiply and because a stylised world is exactly the consumer this engine has.
   */
  readonly obliquityDeg?: number;
}

export interface CelestialState {
  sunDir: Vec3;
  moonDir: Vec3;
  /** 0 at night, 1 in full day. Smoothstepped across the twilight band. */
  dayFactor: number;
  nightFactor: number;
  /** Wrapped scroll distance suitable for a highp shader uniform. */
  /** 0..1 across the lunar cycle. */
  moonPhase: number;
}

const MS_PER_DAY = 86_400_000;
/** One hour, for shifting an instant into a site's own zone. */
const MS_PER_HOUR = 3_600_000;
/**
 * How high the sun climbs at noon in the model that knows no latitude: 1.15 radians, 66 degrees.
 *
 * Unused by the sited model, which derives the altitude instead, and kept because every world
 * authored before 2026-08-27 is tuned against it.
 */
const MAX_ELEVATION = 1.15;
/** Earth's axial tilt, and the default a site takes when it names none. */
const OBLIQUITY_DEG = 23.44;
/** Days in the year the declination is derived against. */
const YEAR_DAYS = 365;
const DEG = Math.PI / 180;
const LUNAR_CYCLE_DAYS = 29.530_588_67;
const NEW_MOON_EPOCH_MS = Date.UTC(2000, 0, 6, 18, 14);
const TWILIGHT = 0.12;
/**
 * Reused because `celestialStateAt` runs every frame; `new Date` would allocate.
 *
 * It holds the caller's timestamp verbatim when the site names no zone, and the same instant
 * shifted into the site's zone when it does — so the UTC getters read that site's wall clock.
 */
const scratchDate = new Date(0);

export function createCelestialState(): CelestialState {
  return {
    sunDir: [0, 1, 0],
    moonDir: [0, -1, 0],
    dayFactor: 1,
    nightFactor: 0,
    moonPhase: 0,
  };
}

/** Visible fraction: new at 0/1, quarters at 0.25/0.75, full at 0.5. */
export function moonIllumination(phase: number): number {
  return 0.5 - Math.cos(phase * TAU) * 0.5;
}

/**
 * Convert a timestamp and an authored azimuth into sky state.
 *
 * The caller decides where the timestamp comes from and must keep it out of a deterministic
 * simulation if wall time should not affect gameplay.
 *
 * `sunAzimuth` is **where the world's north points**, as an angle in the xz plane from +x toward
 * +z. It was an arbitrary offset in the model that knows no latitude and it means the same thing
 * there; with a site it becomes load-bearing, because the sun's own azimuth is then derived and
 * this is what relates it to the world's axes.
 *
 * **`site` is what turns the simplified model into the sited one**, and omitting it is not a
 * degraded mode — it is the model every world here was authored against. See the header.
 *
 * **Which hour the timestamp names depends on whether the site states a zone**, and that is the
 * one thing to get right before anything else here matters:
 *
 * - **A site naming `longitudeDeg` or `utcOffsetHours`** makes `whenMs` a plain **UTC instant** —
 *   `Date.now()`, or `Date.UTC(…)` for an hour chosen outright — and the engine derives that
 *   site's own hour from it. The answer is then a function of the arguments and of nothing else,
 *   which is the only form that gives every machine the same sky.
 * - **A site naming neither, or no site at all**, reads the hour off the timestamp through the
 *   **host machine's** time zone, which is what this function has always done. Every world
 *   authored against it is tuned that way, so it is kept exactly: the same argument gives the same
 *   numbers, bit for bit. But the same argument on another machine gives another hour, so a caller
 *   in this form must build the timestamp from local parts — `new Date(y, m, d, h)` — for the
 *   host's offset to cancel rather than be added.
 *
 * **`moonPhase` is the reason the first form is worth taking even where the sun already looks
 * right.** It comes from the timestamp's absolute value rather than from the hour, so the
 * build-it-from-local-parts trick that steadies the sun leaves the moon drifting by the host's
 * offset — a fiftieth of a lunar cycle across the world, invisible and still not a fact about the
 * world.
 *
 * **The equation of time stays the caller's**, and it is the last correction left: a real sun runs
 * up to about a quarter of an hour ahead of or behind mean time across the year, from the Earth's
 * eccentricity and its tilt. The zone and the meridian are the engine's as soon as a site states
 * them; this one is not, because it is a property of the planet's orbit rather than of the place,
 * and a world with an obliquity of its own has an equation of time of its own. A caller measuring
 * a shadow against an almanac applies it to the timestamp; a caller lighting a world does not care.
 */
export function celestialStateAt(
  whenMs: number,
  sunAzimuth: number,
  out: CelestialState,
  site?: CelestialSite,
): void {
  const cycles = (whenMs - NEW_MOON_EPOCH_MS) / MS_PER_DAY / LUNAR_CYCLE_DAYS;
  const phase = cycles - Math.floor(cycles);
  out.moonPhase = phase;

  if (site === undefined) {
    scratchDate.setTime(whenMs);
    simplified(hostHours(scratchDate), sunAzimuth, out);
  } else {
    /*
     * The zone, or nothing.
     *
     * A longitude alone implies its own offset, so a site that gives one and not the other still
     * describes a consistent clock: `undefined` here means the site named neither, which is the
     * one case that falls back to the host's.
     */
    const meridianDeg = site.longitudeDeg;
    const offsetHours =
      site.utcOffsetHours ?? (meridianDeg === undefined ? undefined : meridianDeg / 15);

    if (offsetHours === undefined) {
      scratchDate.setTime(whenMs);
      sited(
        hostHours(scratchDate),
        site.dayOfYear ?? hostDayOfYear(scratchDate),
        sunAzimuth,
        phase,
        site,
        out,
      );
    } else {
      /*
       * Shifted into the site's zone, so the UTC getters read its wall clock; the meridian then
       * carries that clock the rest of the way to solar time, which is where the hour angle is
       * measured from. That correction is zero for a place at the centre of its zone and up to
       * half an hour at its edges. It can push the hour past midnight either way and nothing needs
       * it wrapped: an hour angle is an angle, and the calendar day is the site's rather than the
       * sun's.
       */
      scratchDate.setTime(whenMs + offsetHours * MS_PER_HOUR);
      const solar = utcHours(scratchDate) + (meridianDeg ?? offsetHours * 15) / 15 - offsetHours;
      sited(solar, site.dayOfYear ?? utcDayOfYear(scratchDate), sunAzimuth, phase, site, out);
    }
  }

  out.dayFactor = smoothstep(-TWILIGHT, TWILIGHT, out.sunDir[1]);
  out.nightFactor = 1 - out.dayFactor;
}

/**
 * The model that knows no latitude, unchanged since it was written.
 *
 * A sine of the day's fraction scaled to a fixed peak, an azimuth sweeping a whole turn, and a moon
 * pinned exactly opposite. Every number a world authored before 2026-08-27 was tuned against.
 */
function simplified(hours: number, sunAzimuth: number, out: CelestialState): void {
  const fraction = hours / 24;
  const elevation = Math.sin((fraction - 0.25) * TAU) * MAX_ELEVATION;
  const azimuth = sunAzimuth + (fraction - 0.25) * TAU;
  const cosElevation = Math.cos(elevation);
  const sx = cosElevation * Math.cos(azimuth);
  const sy = Math.sin(elevation);
  const sz = cosElevation * Math.sin(azimuth);

  out.sunDir[0] = sx;
  out.sunDir[1] = sy;
  out.sunDir[2] = sz;
  out.moonDir[0] = -sx;
  out.moonDir[1] = -sy;
  out.moonDir[2] = -sz;
}

/**
 * The sited model: a declination, an hour angle, and the two spherical formulas over them.
 *
 * **Standard solar-position arithmetic and deliberately the plain form of it.** The declination is
 * Cooper's equation, `ε · sin(2π (284 + N) / 365)`, which is within about half a degree of the
 * truth all year; the altitude and azimuth are the spherical law of cosines and its companion. A
 * more accurate model exists — the equation of centre, nutation, refraction — and buys a fraction
 * of a degree for a sky nobody is navigating by.
 *
 * **The moon follows its phase rather than the sun's opposite**, which is what makes the position
 * and the phase agree at last. The phase *is* the elongation: at new moon the moon shares the sun's
 * ecliptic longitude and its hour angle, so it is up in the daytime and invisible; at full it is
 * half a turn away in both, so it rises as the sun sets. Its own five-degree orbital inclination is
 * ignored, which is what makes this a line rather than a page and costs the moon up to five degrees
 * of altitude.
 *
 * **It takes an hour and a day rather than a `Date`**, because which clock those came off is the
 * caller's question and settled before this is reached — see `celestialStateAt`. The model itself
 * has no time zone in it at all.
 */
function sited(
  hours: number,
  day: number,
  northAzimuth: number,
  phase: number,
  site: CelestialSite,
  out: CelestialState,
): void {
  const latitude = Math.max(-90, Math.min(90, site.latitudeDeg)) * DEG;
  const obliquity = (site.obliquityDeg ?? OBLIQUITY_DEG) * DEG;

  /* Ecliptic longitude measured from the point that puts the solstices where they belong. */
  const sunLongitude = (TAU * (284 + day)) / YEAR_DAYS;
  const sunHourAngle = (hours - 12) * (Math.PI / 12);
  place(
    latitude,
    Math.asin(Math.sin(obliquity) * Math.sin(sunLongitude)),
    sunHourAngle,
    northAzimuth,
    out.sunDir,
  );

  /*
   * The moon, a phase's worth of longitude ahead of the sun and the same amount behind in hour
   * angle — because an hour angle is the sky turning westward and a longitude is the moon crawling
   * eastward through it.
   */
  const moonLongitude = sunLongitude + phase * TAU;
  place(
    latitude,
    Math.asin(Math.sin(obliquity) * Math.sin(moonLongitude)),
    sunHourAngle - phase * TAU,
    northAzimuth,
    out.moonDir,
  );
}

/**
 * A declination and an hour angle at a latitude, into a world-space direction.
 *
 * `sin(alt) = sin φ sin δ + cos φ cos δ cos H` is the altitude; the azimuth is the `atan2` form,
 * which needs no quadrant test and is stable at the poles where the cosine form divides by nearly
 * nothing. It comes out measured from **south**, so half a turn puts it on north, and the world's
 * own north then rotates the whole sky into place.
 */
function place(
  latitude: number,
  declination: number,
  hourAngle: number,
  northAzimuth: number,
  out: Vec3,
): void {
  const sinLat = Math.sin(latitude);
  const cosLat = Math.cos(latitude);
  const sinDec = Math.sin(declination);
  const cosDec = Math.cos(declination);
  const sinAlt = sinLat * sinDec + cosLat * cosDec * Math.cos(hourAngle);
  const altitude = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  const fromSouth = Math.atan2(
    Math.sin(hourAngle) * cosDec,
    Math.cos(hourAngle) * cosDec * sinLat - sinDec * cosLat,
  );
  const azimuth = northAzimuth + fromSouth + Math.PI;
  const cosAltitude = Math.cos(altitude);
  out[0] = cosAltitude * Math.cos(azimuth);
  out[1] = Math.sin(altitude);
  out[2] = cosAltitude * Math.sin(azimuth);
}

/** The hour, with its minutes and seconds, off the host machine's own clock. */
function hostHours(date: Date): number {
  return date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
}

/** The same, off an instant already shifted into the site's zone. See `scratchDate`. */
function utcHours(date: Date): number {
  return date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
}

/**
 * Which day of the year a host-local date falls on, 1 to 366.
 *
 * From the date's own month and day rather than a difference of timestamps, because a difference
 * across a daylight-saving boundary is an hour short and lands on the previous day for an hour of
 * every spring.
 */
function hostDayOfYear(date: Date): number {
  const start = Date.UTC(date.getFullYear(), 0, 1);
  const here = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((here - start) / MS_PER_DAY) + 1;
}

/**
 * The same for an instant already shifted into the site's zone, read through the UTC getters.
 *
 * A separate four lines rather than a flag, because the pair is the whole difference between the
 * two clocks this function can be asked about and folding them together hides it. No daylight
 * saving to step around here: the shift was a constant, so the difference of timestamps would
 * have done — it is written this way to read beside its neighbour.
 */
function utcDayOfYear(date: Date): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  const here = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.round((here - start) / MS_PER_DAY) + 1;
}

/**
 * The frequency bands every rhythm detector in the engine reads.
 *
 * One definition, shared by the offline analyser and the live detector, so
 * "a kick" means the same thing whether it is being found ahead of time for an
 * edit or reacted to in the moment for a light. Two sets of numbers that
 * drifted apart would produce a replay whose cuts disagreed with the lights in
 * the very footage they are cutting.
 *
 * The split is finer than "bass / mid / treble" because the hard problem is not
 * finding low energy, it is telling a *kick* apart from a sustained bassline
 * sitting in nearly the same octave. `sub`/`punch`/`sweet` are the kick;
 * `bassline`/`mud` are what has to be subtracted from it.
 */
export interface Band {
  readonly lowHz: number;
  readonly highHz: number;
}

export const RHYTHM_BANDS = {
  sub: { lowHz: 40, highHz: 60 },
  punch: { lowHz: 60, highHz: 100 },
  sweet: { lowHz: 75, highHz: 110 },
  bassline: { lowHz: 95, highHz: 180 },
  mud: { lowHz: 180, highHz: 420 },
  lowMid: { lowHz: 500, highHz: 2500 },
  high: { lowHz: 5000, highHz: 12000 },
} as const satisfies Record<string, Band>;

export type BandName = keyof typeof RHYTHM_BANDS;

/** Energy in each band, 0–1, filled in place so nothing allocates per hop. */
export interface BandEnergies {
  sub: number;
  punch: number;
  sweet: number;
  bassline: number;
  mud: number;
  lowMid: number;
  high: number;
}

export function createBandEnergies(): BandEnergies {
  return { sub: 0, punch: 0, sweet: 0, bassline: 0, mud: 0, lowMid: 0, high: 0 };
}

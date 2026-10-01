/**
 * The city's fixed lights, from the markers its templates carry and the lights their host gives
 * them: where each stands, its colour, how bright and how far, and whether it waits for night.
 *
 * **A light is an entity with a `PointLight`.** Its template leaves the intensity at zero when the
 * host is meant to switch it on at dusk from its `NightLight`'s `light`, and gives it a number when
 * it burns day and night; one with neither never shines, and is none. **Its colour is its
 * emission's, else its own**, linear. **Or it is one the host gives an instance**: a street lamp's
 * bulb carries only its glow, and its road's style says how bright and how far it shines; a prop's
 * table does the same for the prop. **Its range is the template's, in metres**, whatever scale
 * its parents give it, as the host's lights take a range. The numbers are the reference's own,
 * unconverted: how bright one of its units draws is the runtime's decision.
 *
 * What it gives up: a `SpotLight` — none stands still in the city; the one the scripts declare
 * rides an air taxi, which is the runtime's.
 */
import type { Value } from '../script/values.ts';
import { effective } from '../script/world.ts';
import { multiply } from './flatten.ts';
import type { Marker, Matrix } from './flatten.ts';
import type { Instance } from './instances.ts';
import { linear } from './materials.ts';

export interface CityLight {
  readonly position: readonly [number, number, number];
  /** Linear. */
  readonly color: readonly [number, number, number];
  readonly intensity: number;
  /** Metres. */
  readonly range: number;
  /** Whether it waits for night, or burns always. */
  readonly night: boolean;
}

const field = (v: Value | undefined, key: string): Value | undefined =>
  v?.k === 'struct' ? v.fields?.get(key) : undefined;
const num = (v: Value | undefined, key: string, fallback: number): number => {
  const f = field(v, key);
  return f?.k === 'num' ? f.v : fallback;
};
const rgb = (v: Value | undefined): [number, number, number] | null =>
  v?.k === 'struct'
    ? [linear(num(v, 'r', 255)), linear(num(v, 'g', 255)), linear(num(v, 'b', 255))]
    : null;

/**
 * An instance's lights: its template's own, or else the one its host gives it — at its place and
 * the host's height, in the colour of its glow, waiting for night. Never both, or a lamp whose
 * template carries its light would shine twice.
 */
export function instanceLights(
  inst: Instance,
  markers: readonly Marker[],
  place?: Matrix,
): CityLight[] {
  const own = lightsOf(markers, place);
  const host = inst.light;
  if (own.length > 0 || host === undefined || !(host.intensity > 0)) return own;
  const glow = markers.find((m) => m.component === 'LightGlow') ?? markers[0];
  const color =
    (glow === undefined ? null : rgb(field(effective(glow.entity, 'Emissive'), 'color'))) ?? WARM;
  return [
    {
      position: [inst.position[0], host.y, inst.position[1]],
      color,
      intensity: host.intensity,
      range: host.range,
      night: true,
    },
  ];
}

/** A lamp's warm white, the reference's default glow, where a light names no colour. */
const WARM: readonly [number, number, number] = [linear(255), linear(214), linear(160)];

/** The lights among `markers`, placed by `place` where they were flattened at the origin. */
export function lightsOf(markers: readonly Marker[], place?: Matrix): CityLight[] {
  const out: CityLight[] = [];
  for (const marker of markers) {
    if (marker.component !== 'PointLight') continue;
    const always = num(marker.value, 'intensity', 0);
    const atNight = num(effective(marker.entity, 'NightLight'), 'light', 0);
    const intensity = always > 0 ? always : atNight;
    if (!(intensity > 0)) continue;
    const m = place === undefined ? marker.matrix : multiply(place, marker.matrix);
    const color = rgb(field(effective(marker.entity, 'Emissive'), 'color')) ??
      rgb(effective(marker.entity, 'Rgba')) ?? [1, 1, 1];
    out.push({
      position: [m[12] as number, m[13] as number, m[14] as number],
      color,
      intensity,
      range: num(marker.value, 'range', 10),
      night: !(always > 0),
    });
  }
  return out;
}

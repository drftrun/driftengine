/**
 * The presentation seam: a fire, as numbers a renderer can draw.
 *
 * **What this measures is the cost of making chemistry visible**, over `chemistry-only`. It is the
 * last thing a consumer adds and the first thing a consumer without a renderer can decline — which
 * is why it is a separate entry point at all, and why the number is worth having.
 */
import { installChemistry, parcelFromBounds } from '@driftengine/chemistry/present';
import {
  blackbodyRGB,
  crackleRate,
  emitSmoke,
  flameColour,
  flameHeight,
  hissRate,
  roarLevel,
  smokeColour,
  writeSurface,
} from '@driftengine/chemistry/present';
import { ORGANIC } from '@driftengine/chemistry/library/organic';

const particles = {
  positions: new Float32Array(768),
  velocities: new Float32Array(768),
  colors: new Float32Array(768),
  alphas: new Float32Array(256),
  sizes: new Float32Array(256),
  ages: new Float32Array(256),
  seeds: new Float32Array(256),
  count: 0,
  capacity: 256,
};
const surfaces = {
  albedos: new Float32Array(96),
  emissives: new Float32Array(96),
  roughness: new Float32Array(32),
  scales: new Float32Array(32),
  count: 0,
};
const colour = new Float32Array(3);

/** Install, spawn from a bounding box, tick once, and write everything a renderer reads. */
export function hearth(): number {
  const chem = installChemistry({ libraries: [ORGANIC] });
  const box = parcelFromBounds(0.08, 0.08, 1, 700);
  const log = chem.parcels.spawn({
    substance: chem.substances.indexOf('oak'),
    mass: box.mass,
    temperature: 293.15,
    area: box.area,
    x: 0.5,
    y: 0.5,
    z: 0.5,
  });
  chem.world.sources.add(0, 0.5, 0.5, 1200, 0.1, 60000);
  chem.world.simulate(1 / 60, 0, 0);

  writeSurface(chem.parcels, [log], surfaces);
  emitSmoke(chem.air, 0, 0, 0, 8, particles, { threshold: 1e-8, size: 0.4, wind: 0 });
  smokeColour(1e-5, 1e-6, colour);
  blackbodyRGB(chem.parcels.surfaceTemperatureOf(log), colour);
  flameColour(1.8, 1400, colour);

  const report = chem.match(['oak', 'dragonhide']);
  return (
    flameHeight(chem.parcels.heatReleaseOf(log) / 1000, 0.3) +
    crackleRate(chem.parcels.fuelFluxOf(log), box.area) +
    hissRate(chem.parcels.massFluxOf(log), box.area) +
    roarLevel(chem.air.riseAt(0.5, 1.5, 0.5)) +
    (surfaces.albedos[0] as number) +
    (colour[0] as number) +
    report.matched
  );
}

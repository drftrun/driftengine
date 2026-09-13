/**
 * `@driftengine/chemistry/present` — the numbers a renderer draws a fire from, and the installer.
 *
 * **Nothing here imports an engine package or names a core type.** Every target is described
 * structurally by what it must have, which is the `ragdollFromBones` arrangement: core's
 * `ParticleInstances` satisfies `SmokeTarget` exactly and neither package knows the other exists.
 * That matters more here than it did there, because this package imports **no** engine package at
 * all and `present/` is the module most tempted to break it.
 *
 * **Both backends, checked rather than assumed.** `ARCHITECTURE.md` §5 asks every visual feature to
 * ship on WebGL2 and WebGPU or to refuse one in writing. Nothing in this directory is a shader, a
 * pipeline or a bind group — it is arithmetic that writes into typed arrays a consumer already owns
 * — so there is no backend-specific path to be missing. The one thing a consumer must know is not
 * about backends at all and is written at `writeSurface`: **emissive in this engine is gated on
 * `nightFactor`**, so embers written here look right at dusk and dead at noon.
 */
export { GLOW_MIN_TEMPERATURE, blackbodyRGB, glowIntensity } from './blackbody.ts';
export { flameColour, flameHeight, sootLuminosity } from './flame.ts';
export type { SmokeOptions, SmokeTarget } from './smoke.ts';
export { emitSmoke, smokeColour } from './smoke.ts';
export type { SurfaceTarget } from './surface.ts';
export { writeSurface } from './surface.ts';
export { crackleRate, hissRate, roarLevel } from './audio.ts';
export type { ChemistryOptions, InstalledChemistry, MatchReport, ParcelBox } from './install.ts';
export { installChemistry, parcelFromBounds } from './install.ts';

/**
 * The demo scenes the engine ships, and the gate every one of them passes.
 *
 * Outside `src/` and outside the barrel on purpose. These are not part of the
 * public surface — nothing in `src/` may import them and no consumer receives
 * them by installing the package — but they are the only place in this
 * repository where the engine is used the way a consumer uses it. That makes
 * them the standing test of the boundary `AGENTS.md` opens with: if a scene
 * worth looking at cannot be built here without reaching for something that only
 * means anything inside one game, the boundary is in the wrong place, and it
 * fails here rather than being discovered by whoever tries second.
 *
 * A consumer reaches these by path from its own bundler, the same way `src/build/`
 * is reached.
 */
export type {
  DemoBudget,
  DemoPipeline,
  DemoScene,
  DemoHandle,
  DemoSceneOptions,
  DemoStats,
  ResolutionControl,
} from './types';
export { DEMO_PIPELINES } from './types';
/*
 * The answer a host should reach for before it reaches for stopping a scene. See
 * `sceneGovernor.ts`: a machine that cannot hold the rate is owed a softer picture, and until
 * this existed the only replies available were a cheaper profile and nothing at all.
 */
export { SceneGovernor } from './sceneGovernor';
export { demoQualityFor, isHandheld, readDemoDeviceHints } from './deviceBudget';
export type { DemoDeviceHints } from './deviceBudget';

import { DEMO_PIPELINES, type DemoScene } from './types';
import { collapse } from './collapse';
import { contributedPass } from './contributedPass';
import { giField } from './giField';
import { city } from './city';
import { gpuDrivenDense } from './gpuDrivenDense';
import { gpuDrivenMaterials } from './gpuDrivenMaterials';
import { gpuDrivenOcclusion } from './gpuDrivenOcclusion';
import { character } from './character';
import { hierarchy } from './hierarchy';
import { instancing } from './instancing';
import { dayClock } from './dayClock';
import { showroom } from './showroom';
import { gildedChamber } from './gildedChamber';
import { nightCourt } from './nightCourt';
import { nightStreet } from './nightStreet';
import { smokeRoom } from './smokeRoom';
import { voxelSandbox } from './voxelSandbox';
import { stormSea } from './stormSea';
import { windField } from './windField';

/** Ids are keys and URL fragments: lower case, no spaces, stable once published. */
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Whether a value satisfies the scene contract.
 *
 * Exists so the check is one thing rather than a habit. A registry that grows by
 * one line is a registry where the next entry quietly skips whatever the last one
 * was checked against, and a scene missing `mount` fails at the moment somebody
 * clicks it rather than at the moment it was added.
 */
export function isDemoScene(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const scene = value as Partial<DemoScene>;
  if (typeof scene.id !== 'string' || !ID_PATTERN.test(scene.id)) return false;
  if (typeof scene.title !== 'string' || scene.title.trim().length === 0) return false;
  if (typeof scene.note !== 'string' || scene.note.trim().length === 0) return false;
  /* Absent is the forward path alone; present is a list of known pipelines, each named once. */
  const pipelines = scene.pipelines as unknown;
  if (pipelines !== undefined) {
    if (!Array.isArray(pipelines) || pipelines.length === 0) return false;
    if (new Set(pipelines).size !== pipelines.length) return false;
    if (!pipelines.every((one) => (DEMO_PIPELINES as readonly unknown[]).includes(one))) {
      return false;
    }
  }
  return typeof scene.mount === 'function';
}

/**
 * Every scene, in the order a consumer should offer them. The first is the one to
 * lead with.
 *
 * A registry was worth having before its first entry, because the alternative is a
 * consumer importing one scene directly and a second scene later becoming a refactor
 * rather than a line.
 */
export const SCENES: readonly DemoScene[] = [
  /*
   * First, because it is the only one a reader can *play*, and a demos page is read by somebody
   * deciding whether to spend a week on this engine. The others are looked at; this one is picked
   * up. It is also the honest lead for a port: what it demonstrates is how much of a game the
   * standard material carries before anybody writes a shader, which is the question a studio is
   * actually asking.
   *
   * `CREDITS.md` and the site both name whose demo it is a port of. Leading with somebody else's
   * design is a choice that has to be said out loud rather than arranged around.
   */
  voxelSandbox,
  gildedChamber,
  /*
   * Second, and it was last.
   *
   * The argument for last was that the six asset-free scenes should be met first, so the one that
   * loads a model reads as the contrast to them. That holds for somebody who works through the
   * whole list, and most readers open one or two. Putting the import second means the two things
   * the engine does are both in front of anybody who looks at all: a room built out of nothing,
   * then a model brought in from a file.
   *
   * The contrast survives the move, because the page states it in words rather than relying on
   * the order: the lead counts which scenes generate everything and which one loads a model, and
   * both halves are read from this list rather than written down.
   */
  showroom,
  nightCourt,
  windField,
  stormSea,
  collapse,
  dayClock,
  /*
   * **The city at dusk, the second pipeline's own scene**, published by the demos plan's Task 12
   * once its flight and its measurements were in — this line is that act. Last, so every published
   * scene before it keeps the index a capture already names it by; the drafts each move up one.
   * It says `pipelines: ['gpu-driven']`, so a host that cannot run the second pipeline can say so
   * from the list rather than from a mount that refuses.
   */
  city,
];

/*
 * Re-exported so a host page can turn it on without reaching past this barrel.
 *
 * A page showing these scenes is exactly where a silent uniform miss needs to become
 * audible: it is the surface that gets opened on hardware nobody here owns, and the only
 * channel back is somebody reading a panel.
 */
export { setUniformStrictMode } from '../packages/core/src/index';

/*
 * The gesture binding, exported because every consumer needs it and only one should own
 * it. `OrbitView` says what a drag means; this says which events are a drag.
 */
/**
 * Scenes that are being worked on, and are deliberately **not** in `SCENES`.
 *
 * `SCENES` is what a consumer publishes, so anything in it is on the website the moment it
 * is registered — which is how an unfinished showroom appeared on the public demos page.
 * A work in progress needs somewhere to live that is visible to the engine's own harness
 * and invisible to everybody else, and this is it.
 *
 * Moving a scene from here to `SCENES` is then a deliberate one-line act of publishing,
 * rather than something that happens by writing the file.
 */
export const DRAFT_SCENES: readonly DemoScene[] = [
  /*
   * Track A, composed. It stays a draft until it has been held to frame budget on a mid-range
   * phone, which is the bar `AGENTS.md` sets and which nobody has measured yet — publishing it
   * before that would put an unverified claim on the demos page.
   */
  character,
  /*
   * A rig rather than a scene, and it stays here for the same reason the reproduction does: it
   * argues for an API rather than showing what the engine looks like. It is in the harness so
   * `registerPass` is exercised by a real device on both backends every time the shots are run.
   */
  contributedPass,
  /*
   * The distance field on a device. A draft because a marched field is a diagnostic rather than a
   * material — what it is here for is that `GiFieldPass` runs and reports what it costs.
   */
  giField,
  /*
   * A rig for the same reason: it puts a number on what a hierarchy prunes, which is an argument
   * about the engine rather than a picture of what it can do.
   */
  hierarchy,
  /*
   * A rig for the same reason as the one above it: two ranks of the same blocks, submitted two
   * ways, so the readout can say thirty draws against one. What it argues for is an API, and a
   * published scene is a picture of what the engine looks like — a field of tinted boxes is
   * neither, however useful the number under it is.
   */
  instancing,
  /*
   * A rig rather than a scene. It reproduces the conditions two consumers reported a shading
   * artefact under, which the published showroom hides by being a brightly lit room. Publishing
   * a reproduction would put a deliberately unflattering picture on a page that argues for the
   * engine, so it stays here until there is nothing left to reproduce.
   */
  nightStreet,
  /*
   * An instrument rather than a scene. It exists to measure what the absence of participating media
   * costs — smoke that does not absorb or re-emit a fire's radiation — which is a refusal Track P's
   * design records with "measured evidence that a large smoke-filled scene reads wrong" beside it.
   * Arguing about a refusal is not what a demos page is for, so it stays here.
   */
  smokeRoom,
  /*
   * Three rigs for the second pipeline, and they stay here until it draws the standard material.
   * What they show is a pipeline rather than a picture — a million triangles through one indirect
   * draw, a wall and what is not drawn behind it, and sixteen material bins — and each of the
   * three exists because a stage of it does no visible work in the other two.
   */
  gpuDrivenDense,
  gpuDrivenOcclusion,
  gpuDrivenMaterials,
];

export { bindOrbitControls } from './controls';
export type { OrbitControlOptions } from './controls';

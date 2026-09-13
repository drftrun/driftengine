/**
 * The engine as a DriftScript host: a registry describing what it provides, and the map that binds
 * a compiled module to the real implementations.
 *
 * **This package is the only place the language and the engine are coupled**, and this file is the
 * only place in it that knows about both at once. `driftscript` imports no `@driftengine/*` at all,
 * asserted three ways; everything the engine contributes arrives through here.
 *
 * ---
 *
 * ## Adding a binding when a track lands
 *
 * **A capability that exists and is not bound is a capability DriftScript cannot reach**, and
 * nothing fails when one is missed — a script author simply finds the module refused and assumes
 * the track has not shipped. That silence is why this note exists rather than a checklist somewhere
 * else.
 *
 * When a track lands, or a package grows a public function a script would want:
 *
 * 1. **Describe it.** A `defineCapability` entry in `bindings/`: its parameters and return as type
 *    names, its effects, whether a `@deterministic` function may call it, and a sentence of
 *    documentation that hover will show.
 * 2. **Implement it.** One entry in the module's implementation map. A binding is a *lookup*; if it
 *    needs the engine to grow a function, that function belongs in the package that owns the
 *    subsystem.
 * 3. **Provide it.** Add the module to `ENGINE_MODULES`, or a target cannot link it.
 * 4. **Check the trap.** If the TypeScript signature has an optional parameter whose absence
 *    produces a *wrong result* rather than an error, make it required here and say why — a script
 *    author is further from the subsystem than a TypeScript caller and meets it first.
 *    `bindings/animation.ts` is the worked example.
 * 5. **Correct the table.** `docs/CAPABILITIES.md` names which modules DriftScript reaches, and
 *    `driftscript`'s own linker names which do not, and refuses them by name.
 *    Those two lists must agree; a test asserts it.
 *
 * A binding is cheap — a table entry and a lookup — and is the difference between a subsystem
 * a consumer can script and one they can only call from TypeScript.
 */
import type { AudioGraph, SoundRegistry } from '@driftengine/audio';
import {
  BEHAVIOR_CAPABILITIES,
  BEHAVIOR_MODULE,
  BEHAVIOR_TYPES,
  behaviorImplementation,
  type BehaviorServices,
} from './bindings/behavior.ts';
import {
  NAVIGATION_CAPABILITIES,
  NAVIGATION_MODULE,
  NAVIGATION_TYPES,
  navigationImplementation,
  type NavigationServices,
} from './bindings/navigation.ts';
import {
  TERRAIN_CAPABILITIES,
  TERRAIN_MODULE,
  TERRAIN_TYPES,
  terrainImplementation,
} from './bindings/terrain.ts';
import {
  SPRITES_CAPABILITIES,
  SPRITES_MODULE,
  SPRITES_TYPES,
  spritesImplementation,
} from './bindings/sprites.ts';
import {
  INTERFACE_CAPABILITIES,
  INTERFACE_MODULE,
  INTERFACE_TYPES,
  interfaceImplementation,
} from './bindings/interface.ts';
import {
  EDITOR_CAPABILITIES,
  EDITOR_MODULE,
  EDITOR_TYPES,
  editorImplementation,
} from './bindings/editor.ts';
import {
  NETWORK_CAPABILITIES,
  NETWORK_MODULE,
  NETWORK_TYPES,
  networkImplementation,
} from './bindings/network.ts';
import {
  ROLLBACK_CAPABILITIES,
  ROLLBACK_MODULE,
  ROLLBACK_TYPES,
  rollbackImplementation,
} from './bindings/rollback.ts';
import {
  bindHost,
  createRegistry,
  defineTarget,
  type CapabilityRegistry,
  type DriftModule,
  type TargetManifest,
} from 'driftscript';
import {
  AI_CAPABILITIES,
  AI_MODULE,
  AI_TYPES,
  aiImplementation,
  type AgentRegistry,
  type AiServices,
} from './bindings/ai.ts';
import {
  AUDIO_CAPABILITIES,
  AUDIO_MODULE,
  AUDIO_TYPES,
  audioImplementation,
} from './bindings/audio.ts';
import {
  XR_CAPABILITIES,
  XR_MODULE,
  XR_TYPES,
  xrImplementation,
  type XrRuntime,
} from './bindings/xr.ts';
import {
  RENDER_CAPABILITIES,
  RENDER_MODULE,
  RENDER_TYPES,
  renderImplementation,
} from './bindings/render.ts';
import {
  ANIMATION_CAPABILITIES,
  ANIMATION_MODULE,
  ANIMATION_TYPES,
  animationImplementation,
} from './bindings/animation.ts';
import {
  CAMERA_CAPABILITIES,
  CAMERA_MODULE,
  CORE_TYPES,
  EVENTS_CAPABILITIES,
  EVENTS_MODULE,
  INPUT_CAPABILITIES,
  INPUT_MODULE,
  PERSISTENCE_CAPABILITIES,
  PERSISTENCE_MODULE,
  PHYSICS_CAPABILITIES,
  PHYSICS_MODULE,
  RANDOM_CAPABILITIES,
  RANDOM_MODULE,
  SCENE_CAPABILITIES,
  SCENE_MODULE,
  TIME_CAPABILITIES,
  TIME_MODULE,
  cameraImplementation,
  eventsImplementation,
  inputImplementation,
  persistenceImplementation,
  physicsImplementation,
  randomImplementation,
  sceneImplementation,
  timeImplementation,
} from './bindings/core.ts';
import type { CoreServices } from './bindings/core.ts';
import {
  ECS_CAPABILITIES,
  QUERY_CAPABILITIES,
  ECS_MODULE,
  ENTITY_TYPES,
  type EntityServices,
  PREFAB_CAPABILITIES,
  PREFAB_MODULE,
  entitiesImplementation,
  prefabImplementation,
} from './bindings/entities.ts';
import {
  CHEMISTRY_CAPABILITIES,
  CHEMISTRY_MODULE,
  CHEMISTRY_TYPES,
  type ChemistryServices,
  chemistryImplementation,
} from './bindings/chemistry.ts';
import { registerStd, stdImplementations } from 'driftscript/std';

/**
 * What the engine can provide. Everything wired; nothing that is not.
 *
 * `drift/core` is deliberately absent: §11 gives its provider as `startLoop` and `LoopHooks`, which
 * are what *drives* a script rather than what a script calls. A module with nothing to call is not
 * registered rather than registered empty.
 */
export const ENGINE_MODULES: readonly string[] = [
  AI_MODULE,
  XR_MODULE,
  ANIMATION_MODULE,
  BEHAVIOR_MODULE,
  AUDIO_MODULE,
  CAMERA_MODULE,
  CHEMISTRY_MODULE,
  ECS_MODULE,
  EDITOR_MODULE,
  EVENTS_MODULE,
  NETWORK_MODULE,
  ROLLBACK_MODULE,
  INPUT_MODULE,
  NAVIGATION_MODULE,
  PERSISTENCE_MODULE,
  PHYSICS_MODULE,
  RANDOM_MODULE,
  RENDER_MODULE,
  SCENE_MODULE,
  SPRITES_MODULE,
  TERRAIN_MODULE,
  TIME_MODULE,
  INTERFACE_MODULE,
];

/**
 * A registry describing this engine's capabilities.
 *
 * Built rather than exported as a constant, because a registry refuses a duplicate registration —
 * two consumers sharing one module-level instance would be one consumer's startup failing on
 * another's import. Cheap: a few dozen object literals.
 */
export function engineRegistry(): CapabilityRegistry {
  const registry = createRegistry();

  /* The standard library first, because it belongs to the language rather than to this host and a
     host that forgot it would produce scripts that fail on `math.clamp`. */
  registerStd(registry);

  for (const type of [
    ...AI_TYPES,
    ...AUDIO_TYPES,
    ...ANIMATION_TYPES,
    ...CHEMISTRY_TYPES,
    ...CORE_TYPES,
    ...ENTITY_TYPES,
    ...BEHAVIOR_TYPES,
    ...NAVIGATION_TYPES,
    ...TERRAIN_TYPES,
    ...SPRITES_TYPES,
    ...INTERFACE_TYPES,
    ...EDITOR_TYPES,
    ...NETWORK_TYPES,
    ...ROLLBACK_TYPES,
    ...RENDER_TYPES,
    ...XR_TYPES,
  ]) {
    registry.addType(type);
  }
  for (const capability of [
    ...AI_CAPABILITIES,
    ...ANIMATION_CAPABILITIES,
    ...AUDIO_CAPABILITIES,
    ...BEHAVIOR_CAPABILITIES,
    ...CAMERA_CAPABILITIES,
    ...CHEMISTRY_CAPABILITIES,
    ...ECS_CAPABILITIES,
    ...EDITOR_CAPABILITIES,
    ...NETWORK_CAPABILITIES,
    ...ROLLBACK_CAPABILITIES,
    ...QUERY_CAPABILITIES,
    ...EVENTS_CAPABILITIES,
    ...INPUT_CAPABILITIES,
    ...NAVIGATION_CAPABILITIES,
    ...PERSISTENCE_CAPABILITIES,
    ...PHYSICS_CAPABILITIES,
    ...PREFAB_CAPABILITIES,
    ...RANDOM_CAPABILITIES,
    ...RENDER_CAPABILITIES,
    ...XR_CAPABILITIES,
    ...SCENE_CAPABILITIES,
    ...SPRITES_CAPABILITIES,
    ...INTERFACE_CAPABILITIES,
    ...TERRAIN_CAPABILITIES,
    ...TIME_CAPABILITIES,
  ]) {
    registry.add(capability);
  }
  return registry;
}

/**
 * A target providing everything this engine has wired.
 *
 * A consumer that wants less passes its own list. **A consumer that wants more cannot** — the
 * manifest may only name modules something provides, so a target claiming `drift/ecs` is refused
 * at the manifest rather than at every call site.
 */
export function engineTarget(name = 'driftengine'): TargetManifest {
  return defineTarget(name, ENGINE_MODULES);
}

export interface HostServices extends CoreServices {
  /**
   * The agents a script may name, and what the two bridges answer for them.
   *
   * `agents` alone is a supported configuration: a host with no navigation graph and no session
   * still gets `wake`, `consider`, `intentId` and `degraded`. The bridge sub-services are what
   * `reachable`, `navigate`, `path` and `deciding` need, and a capability whose service is absent
   * fails at the call saying which one to provide rather than answering falsely.
   */
  readonly ai?: AiServices;
  /**
   * The live session, if a host has one.
   *
   * Absent means `drift/xr` calls fail at the call naming the namespace, which is the bargain every
   * optional service here makes. A stub would be worse than usual: a script asking where a head is
   * and getting the origin cannot tell a headset at the world origin from no headset at all, and
   * one of those is a scene that draws and the other is a scene nobody is in.
   */
  readonly xr?: XrRuntime;
  readonly audio?: { readonly graph: AudioGraph; readonly registry: SoundRegistry };
  /**
   * The component types, and any prefabs, a script may name.
   *
   * Absent means a script's `drift/ecs` calls fail at the call with the namespace's own name in the
   * error — the same bargain every other optional service makes, and the reason none of them is
   * stubbed.
   */
  readonly entities?: EntityServices;
  /**
   * The chemistry world a script reads and writes.
   *
   * Absent means `drift/chemistry` calls fail at the call naming the namespace — the same bargain
   * every other optional service makes, and the reason none of them is stubbed. A stub would make a
   * script whose fire never lights indistinguishable from one whose chemistry is not connected.
   */
  readonly chemistry?: ChemistryServices;
  /**
   * The network scripts path over: a graph, and one search reused across every agent.
   *
   * Absent means `drift/navigation` calls fail at the call naming the namespace, like every other
   * optional service. A stub would be worse here than elsewhere: an agent given a route of no nodes
   * behaves exactly like one that arrived, so a world whose navigation was never connected would
   * look like a world where every agent is already where it wants to be.
   */
  readonly navigation?: NavigationServices;
  /**
   * What a behaviour tick is handed.
   *
   * Absent means `drift/behavior` calls fail at the call naming the namespace. A stub is
   * particularly bad here for the reason `doing` exists: an agent whose routine never runs looks
   * exactly like one that is standing about because it has nothing to do.
   */
  readonly behavior?: BehaviorServices;
}

/**
 * The implementation map a generated module's `__bind` receives.
 *
 * Keyed by logical module name, because that is what generated code looks up: `audio` in a `.drs`
 * file is `$host['drift/audio']` in the output.
 *
 * **A service the consumer did not supply is absent rather than stubbed.** A module that binds it
 * and then calls it fails at the call with the namespace's own name in the error, which is what the
 * rule against silent no-ops asks for — a stub that quietly did nothing would make a script that
 * plays no sound indistinguishable from one whose audio is not connected.
 */
export function engineImplementations(services: HostServices): Record<string, unknown> {
  /* The standard library is merged in rather than bound separately, because a module importing both
     `std/math` and `drift/audio` receives one host object. Leaving it to a consumer would produce a
     script that fails on `math.clamp` with the namespace undefined. */
  const map: Record<string, unknown> = { ...stdImplementations() };

  if (services.audio !== undefined) {
    map[AUDIO_MODULE] = audioImplementation(services.audio.graph, services.audio.registry);
  }
  if (services.clocks !== undefined) map[TIME_MODULE] = timeImplementation(services.clocks);
  if (services.entities !== undefined) {
    map[ECS_MODULE] = entitiesImplementation(services.entities);
    map[PREFAB_MODULE] = prefabImplementation(services.entities);
  }

  /*
   * These four take their handle as an argument rather than from the host, so they need nothing
   * supplied and are always available. A script passes the `Node` or the `Actions` it was given.
   */
  map[RANDOM_MODULE] = randomImplementation();
  map[SCENE_MODULE] = sceneImplementation();
  map[RENDER_MODULE] = renderImplementation();
  map[PHYSICS_MODULE] = physicsImplementation();
  map[CAMERA_MODULE] = cameraImplementation();
  map[ANIMATION_MODULE] = animationImplementation();
  map[EVENTS_MODULE] = eventsImplementation();
  map[PERSISTENCE_MODULE] = persistenceImplementation();
  /* **Unconditional, unlike the four below it.** Every terrain capability takes the field it is
     asking about, so the module needs nothing from the host: a `Terrain` reaches a script through
     `uses`, the way a `NavGraph` does. There is nothing for an absent service to make fail. */
  map[TERRAIN_MODULE] = terrainImplementation();
  /* Unconditional for the same reason: every capability takes the batch, sheet, map or tree it
     acts on, so neither module needs anything from the host to answer. */
  map[SPRITES_MODULE] = spritesImplementation();
  map[INTERFACE_MODULE] = interfaceImplementation();
  map[INPUT_MODULE] = inputImplementation();
  /* And once more for `drift/editor`: every capability takes the gizmo it is asking about, which
     reaches a script through `uses`. There is nothing for an absent service to make fail. */
  map[EDITOR_MODULE] = editorImplementation();
  /* And the two Track J surfaces: each capability takes the session or the rewind it asks about,
     so neither needs anything from the host beyond the handle a script is given through `uses`. */
  map[NETWORK_MODULE] = networkImplementation();
  map[ROLLBACK_MODULE] = rollbackImplementation();

  /* `drift/ai` needs a registry for the same reason `drift/audio` needs one: an opaque
     handle has to enter a script through a capability, and which agents exist in a
     scene is not something an engine can know. Absent means a script's `ai.agent` calls
     resolve to nothing — the same bargain every other optional service makes. */
  if (services.ai !== undefined) map[AI_MODULE] = aiImplementation(services.ai);
  if (services.xr !== undefined) map[XR_MODULE] = xrImplementation(services.xr);

  /* And `drift/chemistry` needs a world for the same reason: a `Chemistry` handle has to enter a
     script through a capability, and which parcels exist in a scene is not something an engine can
     know. */
  if (services.chemistry !== undefined) {
    map[CHEMISTRY_MODULE] = chemistryImplementation(services.chemistry);
  }

  /* And `drift/navigation` needs the network, for the reason above stated once more: which places
     a world has and which of them connect is the world's, not the engine's. */
  if (services.navigation !== undefined) {
    map[NAVIGATION_MODULE] = navigationImplementation(services.navigation);
  }

  /* And `drift/behavior` needs to know what a tick is handed, which is the consumer's world. */
  if (services.behavior !== undefined) {
    map[BEHAVIOR_MODULE] = behaviorImplementation(services.behavior);
  }

  return map;
}

export type BindResult =
  { readonly bound: true } | { readonly bound: false; readonly reason: string };

/**
 * Give a loaded module its host, and refuse in words when the host cannot satisfy it.
 *
 * Checked against `__drift.requires` before anything is called, so a missing service is reported at
 * bind time naming the module — rather than at the first capability call, deep in a frame, as an
 * undefined property.
 */
export function bindModule(module: DriftModule, services: HostServices): BindResult {
  const implementations = engineImplementations(services);

  const missing = module.info.requires.filter(
    (required) => required.startsWith('drift/') && implementations[required] === undefined,
  );
  if (missing.length > 0) {
    return {
      bound: false,
      reason:
        `\`${module.info.module}\` requires ${missing.map((m) => `\`${m}\``).join(', ')}, which ` +
        'this host has not been given. Pass the service to `bindModule` before loading the module.',
    };
  }

  /*
   * Through `bindHost` rather than by calling `__bind` directly, because the runtime has to
   * remember which host this module was bound to.
   *
   * `patchModule` re-binds the new version to it. Calling `__bind` here would bind this version and
   * leave the next one with every namespace at `undefined` — which is what happened for as long as
   * `__bind` has existed, invisible because the only module anything ever patched imported no
   * capability at all.
   *
   * A module with no capability imports has no `__bind`; `bindHost` treats that as a no-op, because
   * a consumer should not have to know which of its scripts happen to use one.
   */
  bindHost(module, implementations);
  return { bound: true };
}

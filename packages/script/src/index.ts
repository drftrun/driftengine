/*! DriftEngine | Copyright 2026 Drift Technologies | Apache-2.0 | https://github.com/drftrun/driftengine */
/**
 * `@driftengine/script` — the `drift/*` bindings, and the only place the engine and the language
 * are coupled.
 *
 * `driftscript` is host-neutral and imports no `@driftengine/*` at all, which three separate
 * mechanisms assert. Everything this engine contributes to the language arrives through this
 * package: registry entries describing capabilities that already exist, and the implementations a
 * host hands to a compiled module.
 *
 * **There is no new engine code here.** A binding is a description plus a lookup. If one needed the
 * engine to grow a function, that function belongs in the package that owns the subsystem, and the
 * binding then describes it like any other.
 */
export {
  AUDIO_CAPABILITIES,
  AUDIO_MODULE,
  AUDIO_TYPES,
  audioImplementation,
} from './bindings/audio.ts';

export type { ChemistryServices } from './bindings/chemistry.ts';
export {
  CHEMISTRY_CAPABILITIES,
  CHEMISTRY_COMPONENT,
  CHEMISTRY_MODULE,
  CHEMISTRY_TYPES,
  chemistryImplementation,
} from './bindings/chemistry.ts';

export type { ComponentRegistry, RegisteredModule } from './entityHost.ts';
export { assertHostShapes, registerEntityModule } from './entityHost.ts';

export type { BindResult, HostServices } from './host.ts';
export {
  ENGINE_MODULES,
  bindModule,
  engineImplementations,
  engineRegistry,
  engineTarget,
} from './host.ts';

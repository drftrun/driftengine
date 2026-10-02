/**
 * A DriftScript module, hosted: loaded, and bound to the engine capabilities it imports.
 *
 * The examples that have behaviour a script can own keep it in a `.drs` file beside `main.ts`.
 * Under `npm run examples`, saving that file patches the running page: the functions are replaced,
 * and the records the page holds keep their values, so the scene carries on from where it was.
 */
import { bindModule } from '@driftengine/script';
import type { HostServices } from '@driftengine/script';
import { loadModule } from 'driftscript';
import type { DriftModule } from 'driftscript';

// #region host
/**
 * Load a compiled `.drs` module and bind it. Most of the modules the examples import need no host;
 * `drift/navigation` needs the graph it routes over, which is what `services` is for.
 */
export function hostScript(compiled: unknown, services: HostServices = {}): DriftModule {
  const module = loadModule(compiled as Record<string, unknown>);
  const bound = bindModule(module, services);
  if (!bound.bound) throw new Error(bound.reason);
  return module;
}

/** One of the module's exports, by name: a function, or the factory a `data` declaration makes. */
export function exported<T>(module: DriftModule, name: string): T {
  const value = module.exports[name];
  if (value === undefined) throw new Error(`the script exports no ${name}`);
  return value as T;
}
// #endregion

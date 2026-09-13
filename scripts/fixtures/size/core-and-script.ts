/**
 * What a consumer pays to make this engine scriptable.
 *
 * Core plus the bindings — the registry entries, the implementation maps and the host glue — and
 * **not** the compiler, which a production bundle never reaches. The gap between this and
 * `core-only` is the whole cost of the feature, and it is a number rather than a claim.
 */
import { createRenderer } from '@driftengine/core';
import {
  bindModule,
  engineImplementations,
  engineRegistry,
  engineTarget,
} from '@driftengine/script';
export const entry = [
  createRenderer,
  engineRegistry,
  engineTarget,
  engineImplementations,
  bindModule,
];

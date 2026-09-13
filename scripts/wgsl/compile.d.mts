import type { Bindings } from './transform.d.mts';

/**
 * Returns nothing on purpose: the emscripten Module is a thenable, and handing it across a
 * promise boundary makes every `await` on it hang. See the note in `compile.mjs`.
 */
export function loadGlslang(): Promise<void>;
export function hasNaga(): boolean;
export function compileToWgsl(
  glsl: string,
  stage: 'vertex' | 'fragment',
  label?: string,
): Promise<{ wgsl: string; bindings: Bindings }>;

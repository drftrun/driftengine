/**
 * Types for `transform.mjs`.
 *
 * The rules are plain JavaScript so `node --test` can exercise them with nothing installed
 * and nothing compiled, which is what keeps them cheap enough to have one test per rule.
 * This file is what lets `tsc -p tsconfig.scripts.json` still see them.
 */

/** Where the transform put each thing, so the renderer can bind the same numbers. */
export interface Bindings {
  /** The binding of the single anonymous uniform block, or null when a shader has none. */
  readonly uniforms?: number | null;
  /** One entry per sampler the shader declared, under its original GLSL name. */
  readonly textures?: Readonly<
    Record<string, { readonly texture: number; readonly sampler: number; readonly type: string }>
  >;
}

export function raiseVersion(source: string): string;
export function renameBuiltins(source: string): string;
export function mapLocations(source: string): string;
export function hoistDefines(source: string): string;
export function hoistUniformBlock(
  source: string,
  binding?: number,
): { source: string; bindings: Bindings };
export function padNarrowArrays(
  members: readonly string[],
  source: string,
): { members: string[]; source: string };
export function separateSamplers(
  source: string,
  firstBinding?: number,
): { source: string; bindings: Bindings };
export function transform(source: string): { source: string; bindings: Bindings };

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
  /** The `// wgsl:material` block's binding, size and fields; absent where nothing is marked. */
  readonly materialUniforms?: number;
  readonly materialSize?: number;
  readonly materialFields?: Readonly<
    Record<string, { readonly offset: number; readonly size: number }>
  >;
  /** The `// wgsl:view` block's binding, size and fields; absent where nothing is marked. */
  readonly viewUniforms?: number;
  readonly viewSize?: number;
  readonly viewFields?: Readonly<
    Record<string, { readonly offset: number; readonly size: number }>
  >;
  /** Each `// wgsl:override` constant's specialisation id, by name; absent where there are none. */
  readonly overrides?: Readonly<Record<string, number>>;
}

export function raiseVersion(source: string): string;
export function renameBuiltins(source: string): string;
export function mapLocations(source: string): string;
export function hoistDefines(source: string): string;
export function hoistUniformBlock(
  source: string,
  binding?: number,
  marked?: Readonly<Record<string, number>>,
): { source: string; bindings: Bindings };
export function padNarrowArrays(
  members: readonly string[],
  source: string,
): { members: string[]; source: string };
export function separateSamplers(
  source: string,
  firstBinding?: number,
): { source: string; bindings: Bindings };
export function overridableConstants(source: string): {
  source: string;
  overrides: Record<string, number>;
};
export function transform(source: string): { source: string; bindings: Bindings };

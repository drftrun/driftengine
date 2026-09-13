/** What a fragment shader's uniforms cost against `MAX_FRAGMENT_UNIFORM_VECTORS`, counted from it. */
import { MAX_AREA_LIGHTS } from './areaLights.ts';
import { MAX_POINT_LIGHTS } from './lightBudget.ts';

/**
 * How many lights a build of the lit shader declares room for.
 *
 * Two numbers rather than one because they buy different things and cost differently: a point
 * light is ten uniform arrays with point shadows off and twenty with them on, a rectangle is six
 * and fourteen. A scene with four lamps and one window wants a different pair from one with
 * sixteen lamps and no windows, and until this existed neither could ask.
 */
export interface LightBudget {
  /** Slots in every `uLight*` array, and the bound of the light loop. `MAX_LIGHTS` in the source. */
  readonly maxLights: number;
  /** Slots in every `uAreaLight*` array. `MAX_AREA_LIGHTS` in the source. */
  readonly maxAreaLights: number;
}

/** What the engine declares when nobody says otherwise, and what the generated WGSL is built at. */
export const FULL_LIGHT_BUDGET: LightBudget = Object.freeze({
  maxLights: MAX_POINT_LIGHTS,
  maxAreaLights: MAX_AREA_LIGHTS,
});

/**
 * What WebGL2 guarantees every conforming implementation offers a fragment shader.
 *
 * Not a number to design against on any particular device — a desktop part reports thousands and
 * an Adreno 740 reports 256 — but the floor beneath all of them, and therefore the only number a
 * budget can be called *reachable* against. `uniformVectorBudget.test.ts` asserts the ladder's
 * last rung fits inside it with every feature still compiled in.
 */
export const GUARANTEED_FRAGMENT_UNIFORM_VECTORS = 224;

/**
 * How many rows of the uniform grid one variable of each type occupies.
 *
 * A matrix is one row per column; everything else is one row. Samplers are absent deliberately:
 * they are opaque handles counted against `MAX_TEXTURE_IMAGE_UNITS`, which `renderer.ts` budgets
 * separately, and `countUniformVectors` skips them by name rather than by looking here.
 */
const ROWS: Readonly<Record<string, number>> = Object.freeze({
  float: 1,
  int: 1,
  uint: 1,
  bool: 1,
  vec2: 1,
  ivec2: 1,
  uvec2: 1,
  bvec2: 1,
  vec3: 1,
  ivec3: 1,
  uvec3: 1,
  bvec3: 1,
  vec4: 1,
  ivec4: 1,
  uvec4: 1,
  bvec4: 1,
  mat2: 2,
  mat3: 3,
  mat4: 4,
  mat2x3: 2,
  mat2x4: 2,
  mat3x2: 3,
  mat3x4: 3,
  mat4x2: 4,
  mat4x3: 4,
});

/** `uniform [precision] type name[size];`, which is the only form this engine's shaders use. */
const DECLARATION =
  /^\s*uniform\s+(?:(?:highp|mediump|lowp)\s+)?([A-Za-z0-9_]+)\s+([A-Za-z0-9_]+)\s*(?:\[\s*([A-Za-z0-9_]+)\s*\])?\s*;/;

/** `#define NAME 12`, and `#define A B` where B is already known. */
const DEFINE = /^#define\s+([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/;

/**
 * What one build of a shader spends, in rows of the uniform grid, counted from its own source.
 *
 * **Counted rather than stated, and that is the whole point of this function.** The alternative is
 * a constant somebody measured once, and a constant measured once against a shader that moves is a
 * black screen waiting for the next uniform somebody adds. A consumer that had to work around this
 * wrote the same counter over its vendored copy of the engine for exactly that reason.
 *
 * **It is an upper bound, not the driver's own answer.** GLSL ES 3.00 Appendix A lets an
 * implementation pack loose scalars and small vectors together — four `float`s can share one row —
 * and this counts a row each. Arrays are exact, because Appendix A gives an array a whole row per
 * element whatever its base type, which is why a `float uLightRadius[16]` costs the same sixteen
 * rows a `vec3` array of sixteen does and why the light arrays dominate everything else here.
 *
 * Erring high is the direction that is safe to be wrong in: a build this says fits will link, and a
 * build this says will not fit may still have linked — which costs one rung of the ladder in a
 * marginal case and never costs a picture. The driver is the authority either way, which is why
 * `Renderer` also catches the link failure rather than trusting this number alone.
 */
export function countUniformVectors(source: string): number {
  const defines = new Map<string, number>();
  let total = 0;
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    const define = DEFINE.exec(line);
    if (define !== null) {
      const [, name, body] = define;
      const literal = Number(body.trim());
      if (Number.isInteger(literal)) defines.set(name, literal);
      else {
        const alias = defines.get(body.trim());
        if (alias !== undefined) defines.set(name, alias);
      }
      continue;
    }
    const declaration = DECLARATION.exec(raw);
    if (declaration === null) continue;
    const [, type, , dimension] = declaration;
    if (/^[iu]?sampler/.test(type)) continue;
    const rows = ROWS[type];
    if (rows === undefined) continue;
    if (dimension === undefined) {
      total += rows;
      continue;
    }
    const literal = Number(dimension);
    const size = Number.isInteger(literal) ? literal : defines.get(dimension);
    /*
     * An array whose size this cannot resolve is counted as one element rather than skipped.
     * Undercounting a budget is the failure mode that ends in a refused link, so an unreadable
     * declaration must still cost something — and every array in this engine's shaders is sized by
     * a `#define` above it, so reaching this at all would be a shader written in a new shape.
     */
    total += rows * (size ?? 1);
  }
  return total;
}

/**
 * Every light budget worth trying, largest first.
 *
 * **A ladder rather than arithmetic**, because the numbers are a picture decision and not a
 * solution to an inequality: halving the lamps a scene can shade is a visible change and the steps
 * are where somebody thought about it. Each rung roughly halves what the arrays cost, and the last
 * one fits the whole shader — point shadows, area lights and all — inside
 * `GUARANTEED_FRAGMENT_UNIFORM_VECTORS`, so there is a rung for every conforming device rather
 * than a floor the engine cannot reach.
 */
export const LIGHT_BUDGET_LADDER: readonly LightBudget[] = Object.freeze([
  FULL_LIGHT_BUDGET,
  Object.freeze({ maxLights: 12, maxAreaLights: 3 }),
  Object.freeze({ maxLights: 8, maxAreaLights: 2 }),
  Object.freeze({ maxLights: 4, maxAreaLights: 1 }),
  Object.freeze({ maxLights: 2, maxAreaLights: 1 }),
]);

/**
 * The next rung down from a budget, or null when there is nothing smaller to try.
 *
 * For the caller that has been refused by the driver rather than by arithmetic: `planLightBudget`
 * counts an upper bound, so a build it passed can still fail to link, and the only honest answer to
 * a refusal is to ask for less. A budget between rungs — a consumer's own ceiling — steps to the
 * largest rung strictly under it.
 */
export function nextLightBudget(budget: LightBudget): LightBudget | null {
  for (const rung of LIGHT_BUDGET_LADDER) {
    if (rung.maxLights < budget.maxLights || rung.maxAreaLights < budget.maxAreaLights) {
      return {
        maxLights: Math.min(rung.maxLights, budget.maxLights),
        maxAreaLights: Math.min(rung.maxAreaLights, budget.maxAreaLights),
      };
    }
  }
  return null;
}

/** What `planLightBudget` decided, and what it decided it from. */
export interface PlannedLightBudget {
  /** The budget to build at. Never larger than the ceiling it was given. */
  readonly budget: LightBudget;
  /** That budget's source, already built — the caller compiles this rather than rebuilding it. */
  readonly source: string;
  /** What `countUniformVectors` makes of that source. */
  readonly vectors: number;
  /** Whether the ceiling itself fits, so a caller knows whether to say anything out loud. */
  readonly fits: boolean;
  /**
   * What the ceiling would have spent, for the sentence a caller prints when it could not have it.
   *
   * Carried rather than left to the caller to re-derive, because re-deriving it means building the
   * whole source a second time — 1.7 ms, measured, on the one path that is already the slow one.
   */
  readonly ceilingVectors: number;
}

/**
 * The largest budget at or under `ceiling` whose shader fits this device's fragment uniform grid.
 *
 * **Why the engine does this rather than the consumer.** `flat` at the full budget declares 440
 * rows and an Adreno 740 offers 256, so the program does not link, `new WebGL2Renderer` throws,
 * and a game that awaited `createRenderer` gets no renderer, no reason and no frame — the page's
 * background colour for as long as the player is willing to look at it. Reported from outside
 * exactly that way. The only lever a consumer had was to switch point shadows off, which pays a
 * whole feature to save 192 of the 184 rows that needed saving, and still cannot reach a
 * conforming 224-row device: the lit path without point shadows is 248.
 *
 * Sizing the arrays instead keeps the feature and fits the part: 8 lights and 2 rectangles is 252
 * rows **with** point shadows compiled in.
 *
 * Walking the ladder costs one shader build and one count per rung — about 1.7 ms each, measured —
 * and a device with room spends exactly one, because the first rung is the ceiling and it fits.
 *
 * Returns the last rung when nothing fits, with `fits: false`. That is not a failure to report
 * here: this counts an upper bound (see `countUniformVectors`) and the driver may well link what
 * this says it will not, so the caller tries it and lets the link be the answer.
 */
export function planLightBudget(
  limitVectors: number,
  ceiling: LightBudget,
  build: (budget: LightBudget) => string,
): PlannedLightBudget {
  const under = LIGHT_BUDGET_LADDER.filter(
    (rung) => rung.maxLights <= ceiling.maxLights && rung.maxAreaLights <= ceiling.maxAreaLights,
  );
  /*
   * The ceiling itself is tried first even when it is not a rung, because a consumer that asked
   * for 6 lights means 6 and should not be handed 4 by a ladder that has no 6 on it. Compared by
   * value rather than by identity: a caller that writes the full budget out as a fresh object
   * means the same thing the frozen constant does, and building that source twice would cost a
   * rung's worth of work to learn nothing.
   */
  const same = (a: LightBudget, b: LightBudget): boolean =>
    a.maxLights === b.maxLights && a.maxAreaLights === b.maxAreaLights;
  const tried = under[0] !== undefined && same(under[0], ceiling) ? under : [ceiling, ...under];
  let last: PlannedLightBudget | null = null;
  let ceilingVectors = 0;
  for (const budget of tried) {
    const source = build(budget);
    const vectors = countUniformVectors(source);
    /* The first rung tried is the ceiling, by construction above. */
    if (last === null) ceilingVectors = vectors;
    if (vectors <= limitVectors) {
      return { budget, source, vectors, fits: same(budget, ceiling), ceilingVectors };
    }
    last = { budget, source, vectors, fits: false, ceilingVectors };
  }
  /* `tried` always holds the ceiling, so `last` is set by the time the loop ends. */
  return last as PlannedLightBudget;
}

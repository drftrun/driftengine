#!/usr/bin/env node
/**
 * Generate WGSL from the GLSL this engine is authored in.
 *
 * **The GLSL stays the source of truth and the WebGL2 path stays hand-written.** That
 * direction is the safety property of the whole WebGPU backend: a defect in this script can
 * only ever reach WebGPU, which has a fallback, and never the path that runs everywhere.
 *
 * The output is committed rather than built, because `package.json` points `main` at
 * `src/index.ts` and consumers bundle the source. `--check` is what stops a committed copy
 * going stale, which is the only moment the two representations are ever compared.
 *
 * **Shaders are read by evaluating their modules, not by matching their text.** Half this
 * corpus interpolates (`${MAX_POINT_LIGHTS}`, `${FOG_GLSL}`) and `flat.ts` exports no
 * fragment string at all — it exports `flatFrag(options)`, a permutation. A regex over the
 * file would capture placeholder text and miss the largest shader in the engine entirely.
 *
 * The toolchain and the reason for every transform rule are recorded in
 * the WGSL toolchain design. Change them there first.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { compileToWgsl, hasNaga } from './wgsl/compile.mjs';
import { stageOf } from './wgsl/stage.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
/**
 * Every directory of authored GLSL, each with its own `generated/` beside it.
 *
 * **A list rather than one path, because a package may author shaders too (2026-08-25).** The
 * generator existed for core alone and `@driftengine/splats` is the first package with a program
 * of its own — a splat cloud is a second material path with its own projection, its own blend and
 * its own falloff. The 2026-08-12 rule's two justifications both hold for it: there really are two
 * copies to avoid, some sixty lines of Jacobian, congruence and eigen-decomposition that are the
 * same decision in both languages, and the safety property is the right way up, since a defect in
 * the generator can only reach WebGPU, which has a fallback beneath it.
 *
 * **The answer was found by trying rather than argued in advance**, which is what the plan asked
 * for: both stages translated on the first run with no new transform rule.
 */
const SHADER_ROOTS: readonly string[] = [
  path.join(ROOT, 'packages/core/src/render/shaders'),
  path.join(ROOT, 'packages/splats/src/shaders'),
  /*
   * `@driftengine/ui2d`, 2026-09-03, and it is the second package to author a program. A sprite
   * is a quad with no lighting, no fog and no depth, which is not a corner of the flat shader —
   * and putting it there would have priced it by the permutation count for a capability most
   * consumers of core never draw.
   */
  path.join(ROOT, 'packages/ui2d/src/shaders'),
];
const generatedIn = (src: string): string => path.join(src, 'generated');

/** A shader source, resolved, with everything it needs to be compiled and named. */
interface Source {
  readonly name: string;
  readonly stage: 'vertex' | 'fragment';
  readonly glsl: string;
  /** Set for a permutation, absent for a plain constant. */
  readonly variant?: string;
}

/**
 * The permutations, declared here because only this file needs to know the whole space.
 *
 * Every combination is emitted rather than the ones a default profile happens to use: the
 * four booleans come from consumer-set quality and a runtime probe check, so any of the
 * sixteen is reachable and a missing one is a black screen on somebody's settings.
 *
 * **This list is the one that decides how many exist**, and it is a second statement of the flags
 * `FlatShaderOptions` declares. Adding a flag there and not here is silent in a way worth naming:
 * the generator writes the same sixteen it wrote before, `npm run wgsl:check` is happy because
 * what it produced matches what is committed, and the failure arrives at runtime as
 * `flatPass: no bindings for variant "..."` from a consumer who turned the feature on. It was
 * caught here on the first run, by the shader count in the tool's own output being unchanged.
 */
const PERMUTATIONS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  'flat/index.ts': {
    flatFrag: ['pointShadows', 'directionalShadows', 'environmentProbe', 'nightEmissive'],
    /*
     * The **vertex** stage's only axis, and the first one this generator has had. It is affordable
     * where a fragment flag is not: two near-identical 4.4 KB strings dedupe inside deflate's
     * 32 KB window for 1,118 gzipped bytes — and a *second* vertex flag, taking it to four
     * variants, for 1,674 more. One more fragment flag costs 246,925 because a
     * fragment permutation is larger than that window. See `FlatVertexOptions`.
     */
    flatVert: ['skinned', 'morphed', 'instanced'],
  },
  'lightVolume.ts': { lightVolumeFrag: ['directionalShadows'] },
};

/**
 * Flag pairs that cannot both be on, per permuted function.
 *
 * **An exclusion is not an optimisation.** `skinned` and `instanced` declare the joint indices
 * and the instance matrix at the same two attribute locations, so the combination does not
 * compile — emitting it would fail this generator rather than waste a variant, and `flatVert`
 * throws on the pair for the same reason one level up.
 *
 * `morphed` with `instanced` is excluded for a softer but worse reason: it *compiles*. A morph
 * weight is per draw, so thirty instances would wear one expression between them — a wrong
 * picture rather than a refused one, and per-instance weights would want another attribute the
 * sixteen do not have.
 *
 * The cost of the axis itself is what the note on `flatVert` above measures: a near-identical
 * vertex string dedupes inside deflate's window for about a kilobyte. Five vertex permutations
 * where there were four, rather than the eight a bare cross product would ask for.
 */
const EXCLUSIONS: Readonly<Record<string, readonly (readonly string[])[]>> = {
  flatVert: [
    ['skinned', 'instanced'],
    ['morphed', 'instanced'],
  ],
};

/**
 * A shader's name, whether it is a file or a directory with an `index.ts`.
 *
 * Used for the generated file's name *and* for its bindings export, which have to agree:
 * `flatPass.ts` imports `FLAT_BINDINGS` from `flat.wgsl`, and a directory that named itself
 * `index` would emit `INDEX_BINDINGS` into `flat.wgsl.ts` and break at import rather than here.
 */
function stemOf(file: string): string {
  return file.endsWith('/index.ts')
    ? file.slice(0, -'/index.ts'.length)
    : path.basename(file, '.ts');
}

/** Every combination of the given flags, as objects, in a stable order. */
function combinations(
  flags: readonly string[],
  exclude: readonly (readonly string[])[] = [],
): Record<string, boolean>[] {
  const out: Record<string, boolean>[] = [];
  for (let mask = 0; mask < 1 << flags.length; mask += 1) {
    const options: Record<string, boolean> = {};
    flags.forEach((flag, index) => {
      options[flag] = (mask & (1 << index)) !== 0;
    });
    if (exclude.some((pair) => pair.every((flag) => options[flag] === true))) continue;
    out.push(options);
  }
  return out;
}

/**
 * The key a variant is stored and looked up under: the flags that are on, sorted, joined.
 *
 * Readable on purpose. A bitmask would be shorter and would turn every future debugging
 * session into arithmetic, and this key appears in generated source a human has to read.
 */
export function variantKey(options: Readonly<Record<string, boolean>>): string {
  const on = Object.keys(options)
    .filter((flag) => options[flag] === true)
    .sort();
  return on.length === 0 ? 'none' : on.join('+');
}

/** Every shader a module exports, with permutations expanded. */
async function sourcesFrom(src: string, file: string): Promise<Source[]> {
  const module: Record<string, unknown> = await import(path.join(src, file));
  const found: Source[] = [];

  for (const [name, value] of Object.entries(module)) {
    if (typeof value === 'string' && value.includes('void main')) {
      found.push({ name, stage: stageOf(name), glsl: value });
    }
  }

  const permutations = PERMUTATIONS[file];
  if (permutations !== undefined) {
    for (const [fn, flags] of Object.entries(permutations)) {
      const build = module[fn];
      if (typeof build !== 'function') throw new Error(`${file}: ${fn} is not exported`);
      for (const options of combinations(flags, EXCLUSIONS[fn])) {
        found.push({
          name: fn,
          stage: stageOf(fn),
          glsl: (build as (o: Record<string, boolean>) => string)(options),
          variant: variantKey(options),
        });
      }
    }
  }

  return found;
}

/** The generated module for one shader file. */
function render(file: string, entries: (Source & { wgsl: string; bindings: unknown })[]): string {
  const head =
    `/*\n * Generated from ../${file} by \`npm run wgsl\`. Do not edit.\n *\n` +
    ` * The GLSL beside this file is the source of truth. A hand edit here is discarded by\n` +
    ` * the next generation, and \`npm run wgsl:check\` fails the build when this is stale.\n */\n\n`;

  const lines: string[] = [];
  const plain = entries.filter((entry) => entry.variant === undefined);
  const permuted = entries.filter((entry) => entry.variant !== undefined);

  for (const entry of plain) {
    lines.push(`export const ${entry.name}_WGSL = ${JSON.stringify(entry.wgsl)};\n`);
  }

  for (const name of new Set(permuted.map((entry) => entry.name))) {
    const mine = permuted.filter((entry) => entry.name === name);
    const constant = `${name.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}_WGSL`;
    lines.push(
      `/** One entry per permutation, keyed by the flags that are on. See \`variantKey\`. */\n` +
        `export const ${constant}: Readonly<Record<string, string>> = {\n` +
        mine
          .map((entry) => `  ${JSON.stringify(entry.variant)}: ${JSON.stringify(entry.wgsl)},`)
          .join('\n') +
        '\n};\n',
    );
  }

  /*
   * Bindings for **every** permutation, not only the one with all its features off.
   *
   * A variant that compiles in the shadow path declares three more samplers and a larger
   * uniform block, so its bind group layout is a different shape and its field offsets are
   * different numbers. Emitting only `none` meant a renderer could build the right shader
   * and bind it against the wrong layout — which validates, draws, and is wrong.
   */
  const bindings: Record<string, unknown> = {};
  for (const entry of entries) {
    if (entry.variant === undefined) {
      bindings[entry.name] = entry.bindings;
      continue;
    }
    const perVariant = (bindings[entry.name] ?? {}) as Record<string, unknown>;
    perVariant[entry.variant] = entry.bindings;
    bindings[entry.name] = perVariant;
  }
  lines.push(
    `/**\n * What the transform assigned, so the renderer binds the same numbers.\n *\n` +
      ` * A permuted shader has one entry per variant, keyed as \`FLAT_FRAG_WGSL\` is.\n */\n` +
      `export const ${stemOf(file).toUpperCase()}_BINDINGS = ${JSON.stringify(bindings, null, 2)} as const;\n`,
  );

  return head + lines.join('\n');
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length);
  /*
   * **`--root=` points the generator at one directory instead of the built-in list.**
   *
   * For `wgsl.test.mjs`, which has to prove that `--check` notices a drifted generated file. It
   * did that by editing the *real* `depth.wgsl.ts` and restoring it in a `finally` — a test that
   * mutates a tracked source file, so two runs at once race each other (one restores while the
   * other is still checking, and the check then passes when it must not), and a crash in between
   * leaves a drifted file in the tree. Reproduced with three concurrent runs: two of three failed.
   *
   * A test-only flag on a dev tool rather than a fixture root in production code, and it is the
   * smaller of the two: the alternative is an environment variable read at module scope, which is
   * the same surface with no `--help` to find it in.
   */
  const rootFlag = process.argv.find((arg) => arg.startsWith('--root='))?.slice('--root='.length);
  const roots = rootFlag === undefined ? SHADER_ROOTS : [path.resolve(rootFlag)];

  if (!hasNaga()) {
    console.error(
      'wgsl: `naga` is not on PATH. Install it with `cargo install naga-cli --locked`.\n' +
        'It is a dev tool and is never imported by src/. See the WGSL toolchain design.',
    );
    process.exit(1);
  }

  let stale = 0;
  let written = 0;
  const failures: string[] = [];
  for (const SRC of roots) {
    if (!existsSync(SRC)) continue;
    const OUT = generatedIn(SRC);
    mkdirSync(OUT, { recursive: true });
    /*
     * **A shader is a file *or* a directory with an `index.ts`, and it had to become both.**
     *
     * `flat.ts` split into `flat/` on 2026-08-__ and this loop kept filtering on `.ts`, so the
     * largest shader in the engine silently stopped being generated — and `--check` kept
     * passing, because a file nothing generates is never stale. The committed `flat.wgsl.ts`
     * was left holding the pre-split source, twelve `samplerCube` declarations and all, and
     * nothing said so. A guard that cannot see the thing it guards is worse than no guard,
     * which is why `wgsl.test.mjs` now asserts that every permuted entry is discoverable.
     */
    const files = readdirSync(SRC, { withFileTypes: true })
      .flatMap((entry) => {
        if (entry.isDirectory()) {
          if (entry.name === 'generated') return [];
          return existsSync(path.join(SRC, entry.name, 'index.ts'))
            ? [`${entry.name}/index.ts`]
            : [];
        }
        return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [entry.name] : [];
      })
      .filter((file) => only === undefined || file === only || file.startsWith(`${only}/`));

    for (const file of files) {
      const sources = await sourcesFrom(SRC, file);
      if (sources.length === 0) continue;

      /*
       * One shader's failure does not end the run. Each is a distinct transform rule that
       * has yet to be written, and surfacing all of them per run beats discovering them one
       * slow run at a time. The exit code still fails, and no partial file is ever written.
       */
      const entries: (Source & { wgsl: string; bindings: unknown })[] = [];
      let failedHere = false;
      for (const source of sources) {
        const label =
          `${stemOf(file)}.${source.name}${source.variant === undefined ? '' : `.${source.variant}`}`.replace(
            /[^\w.]/g,
            '_',
          );
        try {
          entries.push({ ...source, ...(await compileToWgsl(source.glsl, source.stage, label)) });
        } catch (error) {
          failures.push(String((error as Error).message ?? error));
          failedHere = true;
        }
      }
      if (failedHere) continue;

      /* `flat/index.ts` writes `flat.wgsl.ts`: the directory is the shader's name. */
      const target = path.join(OUT, `${stemOf(file)}.wgsl.ts`);
      const next = render(file, entries);
      let current: string | null = null;
      try {
        current = readFileSync(target, 'utf8');
      } catch {
        current = null;
      }
      if (current === next) continue;

      if (check) {
        console.error(`wgsl: ${path.basename(target)} is stale`);
        stale += 1;
        continue;
      }
      writeFileSync(target, next);
      written += 1;
      console.log(
        `wgsl: wrote ${path.basename(target)} (${entries.length} shader${entries.length === 1 ? '' : 's'}, ${Math.round(next.length / 1024)} KB)`,
      );
    }
  }

  if (failures.length > 0) {
    console.error(`\nwgsl: ${failures.length} shader(s) did not translate:\n`);
    for (const failure of failures) console.error(`  - ${failure.split('\n')[0]}`);
    console.error('');
    process.exit(1);
  }
  if (check && stale > 0) {
    console.error(`wgsl: ${stale} file(s) stale. Run \`npm run wgsl\` and commit the result.`);
    process.exit(1);
  }
  if (!check) console.log(`wgsl: ${written} file(s) written`);
}

await main();

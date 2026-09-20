/**
 * A game, the native host and the engine as one module for Node, with every module one of them
 * names by URL bundled beside it.
 *
 * **esbuild, for the reason `stage.ts` gives**: it is already a dependency here and it bundles
 * TypeScript in one call. What it does not do is what a browser bundler does for a page:
 * `new Worker(new URL('./islandWorker.ts', import.meta.url))` is left pointing at a source file that
 * a shipped game does not have. So every `new URL('./x.ts', import.meta.url)` in the game's modules
 * becomes an entry of its own, bundled into `modules/` beside the game, and the reference is
 * rewritten to it — the engine's physics islands and splat sorting, and the host's own thread
 * bootstrap, are three. **A DriftScript module is compiled on the way in**, by the language's own
 * transform resolved from the game's tree, as the Vite plugin compiles it for the browser.
 *
 * **Four modules are left out and copied beside it instead** (`NATIVE_MODULES`): three carry a
 * compiled binary, which cannot be bundled, and the JPEG codec reads its WebAssembly from its own
 * directory. **So is a library whose licence asks that it stay replaceable** (`LINKED_LIBRARIES`),
 * left an import and reported with the directory that imports it, where it is found.
 *
 * What it gives up: a module named by a URL that is not a literal is left alone, and fails where it
 * is loaded — the same limit a browser bundler has.
 */

import { type BuildOptions, build as esbuild, type Metafile, type Plugin } from 'esbuild';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join, resolve } from 'node:path';

/**
 * Libraries left outside the bundle for their licence, and copied as files of their own: under the
 * LGPL a work of any licence may use the library so long as a person can put a modified copy in its
 * place, which one bundled file with the game in it does not allow. `codec-parser`, which the Opus
 * decoder reads Ogg pages with, is LGPL-3.0-or-later. Each is found from the package that imports
 * it, as Node will find it.
 */
export const LINKED_LIBRARIES: readonly string[] = ['codec-parser'];

/** What a native bundle was made from, and what it imports from outside itself by licence. */
export interface NativeBundle {
  /** Every file the bundles were made from. */
  readonly inputs: Set<string>;
  /** Each linked library, and the directory of the module that imports it. */
  readonly linked: Set<{ readonly name: string; readonly from: string }>;
}

/** What stays outside the bundle and is copied beside it. */
export const NATIVE_MODULES = [
  '@kmamal/gpu',
  '@kmamal/sdl',
  'node-web-audio-api',
  '@jsquash/jpeg',
] as const;

const MODULE_URL =
  /new URL\(\s*(['"])(\.{1,2}\/[^'"]+?\.(?:ts|mts|js|mjs))\1\s*,\s*import\.meta\.url\s*\)/g;

/**
 * Each module `code` names by a URL relative to `file`, renamed to an entry under `prefix` and
 * recorded in `found`, source path to entry name. One module keeps one name however many name it.
 */
export function rewriteModuleUrls(
  code: string,
  file: string,
  prefix: string,
  found: Map<string, string>,
): string {
  return code.replace(MODULE_URL, (_match, _quote: string, relative: string) => {
    const target = resolve(dirname(file), relative);
    let name = found.get(target);
    if (name === undefined) {
      name = `${basename(relative, extname(relative))}-${found.size + 1}.mjs`;
      found.set(target, name);
    }
    return `new URL('${prefix}${name}', import.meta.url)`;
  });
}

/*
 * A bundle of ESM for Node still carries CommonJS inside it, and esbuild's shim for a `require` of a
 * builtin needs one in scope. The host's own `createRequire(import.meta.url)` calls then resolve the
 * copied native modules from beside the bundle.
 *
 * **Imported under a name nothing bundled uses.** The banner is text esbuild does not read, so it
 * cannot rename around it, and the host imports `createRequire` itself: two declarations of one
 * name, and a bundle Node refused to parse.
 */
const REQUIRE =
  "import { createRequire as __driftCreateRequire } from 'node:module';\n" +
  'const require = __driftCreateRequire(import.meta.url);';

type Transform = (code: string, path: string) => { code: string } | null;

/** The language's own transform, from the game's tree, or a refusal naming the module that asked. */
async function driftScript(projectDir: string, asker: string): Promise<Transform> {
  let resolved: string;
  try {
    resolved = createRequire(join(projectDir, 'package.json')).resolve('driftscript/vite');
  } catch {
    throw new Error(
      `${asker} is a DriftScript module and driftscript is not installed in ${projectDir}; ` +
        '`npm install driftscript` there, at the version the engine pins',
    );
  }
  const { driftScript: plugin } = (await import(resolved)) as {
    driftScript: () => {
      transform: (this: object, code: string, path: string) => { code: string } | null;
    };
  };
  const made = plugin();
  return (code, path) => made.transform.call({ addWatchFile() {} }, code, path);
}

const LINKED = new RegExp(`^(${LINKED_LIBRARIES.join('|')})$`);

function plugin(
  prefix: string,
  found: Map<string, string>,
  projectDir: string,
  linked: Map<string, { readonly name: string; readonly from: string }>,
): Plugin {
  let compile: Transform | null = null;
  return {
    name: 'drift-native',
    setup(build) {
      build.onResolve({ filter: LINKED }, (args) => {
        const from = realpathSync(args.resolveDir);
        linked.set(`${args.path}\0${from}`, { name: args.path, from });
        return { path: args.path, external: true };
      });
      build.onLoad({ filter: /\.(ts|mts|js|mjs)$/ }, async (args) => {
        const code = await readFile(args.path, 'utf8');
        if (!code.includes('import.meta.url')) return undefined;
        const contents = rewriteModuleUrls(code, args.path, prefix, found);
        if (contents === code) return undefined;
        const loader = /\.m?ts$/.test(args.path) ? 'ts' : 'js';
        return { contents, loader, resolveDir: dirname(args.path) };
      });
      build.onLoad({ filter: /\.drs$/ }, async (args) => {
        compile ??= await driftScript(projectDir, args.path);
        const compiled = compile(await readFile(args.path, 'utf8'), args.path);
        if (compiled === null) throw new Error(`${args.path} did not compile`);
        return { contents: compiled.code, loader: 'js', resolveDir: dirname(args.path) };
      });
    },
  };
}

/** Where esbuild says an input came from, as a path, or null for one that is not a file. */
function inputPath(projectDir: string, input: string): string | null {
  return /^[a-z-]+:|^<stdin>$/.test(input) ? null : resolve(projectDir, input);
}

/**
 * Bundle the module `source` into `appDir/game.mjs`, and each module it names into
 * `appDir/modules/`. `source` resolves its imports from `projectDir`, the game's own tree, and so
 * does everything it imports; `conditions` are the package conditions resolved before `default`.
 * Answers every file the bundles were made from.
 */
export async function bundleNative(
  source: string,
  appDir: string,
  projectDir: string,
  conditions: readonly string[] = [],
): Promise<NativeBundle> {
  const found = new Map<string, string>();
  const inputs = new Set<string>();
  const linked = new Map<string, { readonly name: string; readonly from: string }>();
  const common: BuildOptions = {
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: [...NATIVE_MODULES],
    conditions: [...conditions],
    banner: { js: REQUIRE },
    absWorkingDir: projectDir,
    metafile: true,
    logLevel: 'warning',
  };
  const record = (metafile: Metafile | undefined): void => {
    for (const input of Object.keys(metafile?.inputs ?? {})) {
      const path = inputPath(projectDir, input);
      if (path !== null) inputs.add(path);
    }
  };
  record(
    (
      await esbuild({
        ...common,
        stdin: { contents: source, resolveDir: projectDir, sourcefile: 'entry.mjs', loader: 'js' },
        outfile: join(appDir, 'game.mjs'),
        plugins: [plugin('./modules/', found, projectDir, linked)],
      })
    ).metafile,
  );
  /* A module may name others in turn, so this runs until a pass finds nothing new. */
  const built = new Set<string>();
  while (built.size < found.size) {
    for (const [module, name] of [...found]) {
      if (built.has(module)) continue;
      built.add(module);
      record(
        (
          await esbuild({
            ...common,
            entryPoints: [module],
            outfile: join(appDir, 'modules', name),
            plugins: [plugin('./', found, projectDir, linked)],
          })
        ).metafile,
      );
    }
  }
  return { inputs, linked: new Set(linked.values()) };
}

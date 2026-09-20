/*
 * Emit the engine's public API surface as data, for a documentation page to render.
 *
 * The barrel is the boundary, and a defensible one: `src/index.ts` is the entire
 * public surface, and anything not exported there is private whatever its file
 * permissions suggest. So publishing exactly that list publishes exactly what a
 * consumer could ever touch, and nothing else is even considered.
 *
 * **Signatures, and the first paragraph of each comment.** Two mechanisms keep this
 * honest, and neither relies on anyone remembering to be careful. It reads the
 * *declaration* output rather than the source, and a declaration file has had every
 * function body removed by the compiler — so an implementation cannot reach the page
 * even by accident, and that guarantee belongs to `tsc` rather than to this parser.
 * And a summary stops at the first paragraph, because
 * the comments here are long by policy — they carry the measurement, the rejected
 * approach and the bug behind a constant, which is the design rather than the
 * interface, and while the engine is closed the design is what does not ship.
 *
 * Lives in this repository rather than in whatever renders it, because a barrel
 * change and its documentation should move in the same commit. A generator in
 * another repository is a generator that goes stale on a Friday.
 *
 * **Every package, not just core (2026-08-25).** This read `packages/core/src/index.ts` and
 * nothing else for as long as there had been more than one package to read — so six of the
 * seven barrels were undocumented, and the engine's own site described a fraction of the engine
 * under a heading that said "everything a game can reach". Nothing failed, because the count it
 * printed was a true count of what it had looked at. Found when `@driftengine/splats` shipped a
 * whole capability and the reference did not gain a symbol.
 *
 * Core keeps its sub-area grouping — `render`, `physics`, `geometry` and the rest — because those
 * areas are how the capability map orders the engine and a reader should meet it in one order.
 * Every other package is **one group named by the package**, which is also the question a reader
 * has: not which folder a symbol lives in, but which package to import it from.
 *
 * Usage: `node scripts/docs-api.mjs --out path/to/api.json`
 */

import { execFileSync } from 'node:child_process';
import {
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The area a symbol belongs to, from the file it is declared in.
 *
 * The same grouping the capability map uses, so a reader meets the engine in one
 * order and not two. Anything declared in the barrel itself is `core`: it is
 * usually a type alias that belongs to no single area, and inventing a group for
 * it would only add a heading with one row under it.
 */
export function groupFor(sourcePath) {
  const normalised = String(sourcePath).replaceAll('\\', '/');
  const match = /(?:^|\/)src\/([^/]+)\//.exec(normalised);
  return match ? match[1] : 'core';
}

/**
 * The first paragraph of a doc comment, joined onto one line.
 *
 * Paragraph rather than sentence: a summary is often two clauses across a wrapped
 * line, and cutting at the first full stop would leave half a thought. Paragraph
 * rather than "everything": see this file's header.
 *
 * Leading blank lines are skipped before the first paragraph is taken, which is the
 * shape that would otherwise defeat a naive "read until the first blank line" and
 * hand back the essay.
 */
export function summarise(doc) {
  if (typeof doc !== 'string') return '';
  const lines = doc
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => line.trim());
  const collected = [];
  for (const line of lines) {
    if (line.length === 0) {
      if (collected.length > 0) break;
      continue;
    }
    collected.push(line);
  }
  return collected.join(' ').trim();
}

/** What a symbol is, in the words a reader of an API list expects. */
function kindOf(keyword) {
  if (keyword === 'let' || keyword === 'var') return 'const';
  return keyword;
}

/** Every `.d.ts` under a directory. */
function declarationFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...declarationFiles(full));
    else if (entry.endsWith('.d.ts')) found.push(full);
  }
  return found;
}

/**
 * Pull the declarations out of one declaration file.
 *
 * A regular scan rather than a parser, and it can be: declaration output is
 * generated, so it is uniform in a way hand-written source never is. One statement
 * per top-level declaration, a doc comment immediately above it or none at all.
 *
 * The signature is the declaration line with its `export declare` prefix removed and
 * any trailing brace dropped. For an interface or a class that yields the head alone,
 * which is the right amount for a reference: the members belong to a detail view, and
 * a list of 153 symbols that each unfold twenty lines is not a list.
 */
export function parseDeclarations(source) {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  const out = new Map();
  let doc = [];
  let inDoc = false;

  for (const raw of lines) {
    const line = raw.trim();

    if (line.startsWith('/**')) {
      doc = [];
      inDoc = true;
      const rest = line.slice(3).replace(/\*\/$/, '').trim();
      if (rest.length > 0) doc.push(rest);
      if (line.endsWith('*/')) inDoc = false;
      continue;
    }
    if (inDoc) {
      if (line.startsWith('*/')) {
        inDoc = false;
        continue;
      }
      doc.push(line.replace(/^\*\s?/, ''));
      continue;
    }

    /*
     * **`declare` is optional, and requiring it documented values only.**
     *
     * It marks something that exists at run time and has no body in a declaration file, so a
     * class, a function and a const carry it and an interface and a type alias do not — they are
     * erased, and there is nothing left to declare. TypeScript emits `export interface X` and
     * `export type Y` bare against `export declare class Z` beside them, which made two of the
     * nine keywords below dead branches and left the published reference listing `Camera` and
     * `CharacterController` while omitting `RendererApi`, `SurfaceMaterial`, `ShadowCasterSink`
     * and every other type in the barrel.
     *
     * Confirmed by emitting this repository's own declarations and reading them, rather than by
     * reasoning about the emitter. The cost of the looser match is that `export type { A } from`
     * could be read as a declaration named `{`; it cannot, because the name group demands an
     * identifier and a brace is not one, and `docs-api.test.mjs` holds that as its own case.
     */
    const match =
      /^export (?:declare )?(function|class|interface|type|enum|const|let|var) ([A-Za-z_$][\w$]*)/.exec(
        line,
      );
    if (match === null) {
      // Only a blank line detaches a comment from what it documents; an import or a
      // brace between them means the comment was never for this declaration.
      if (line.length > 0) doc = [];
      continue;
    }

    const [, keyword, name] = match;
    let signature = line
      .replace(/^export (?:declare )?/, '')
      .replace(/\s*\{\s*$/, '')
      .replace(/;$/, '')
      .trim();

    /*
     * A string constant is widened to its type, and this is a leak control rather than
     * a tidiness one.
     *
     * Declaration emit gives a `const` its *literal* type, so `export const FIRE_FRAG =
     * "#version 300 es..."` comes back with the whole shader inlined in the signature.
     * Six of them reached the reference on the first real run — the complete GLSL of
     * the fire, smoke and arcane fragment stages, which is source by any reading and
     * exactly what a closed engine does not publish. The declaration-emit guarantee
     * covers function bodies and says nothing about this.
     *
     * Anything past a line's worth of literal is replaced by what it is. A short one is
     * kept, because `const MAX_POINT_LIGHTS: 10` tells a reader something true and
     * costs nothing.
     */
    // `= "..."` is what tsc emits for a literal-typed const; `: "..."` also occurs.
    const literal = /^((?:const|let|var)\s+\w+)\s*[:=]\s*(["'`])([\s\S]*)\2$/.exec(signature);
    if (literal !== null && literal[3].length > 60) {
      signature = `${literal[1]}: string`;
    }

    out.set(name, { name, kind: kindOf(keyword), signature, summary: summarise(doc.join('\n')) });
    doc = [];
  }
  return out;
}

/** The names the barrel re-exports, which is the whole of the public surface. */
function barrelExports(indexDts) {
  const names = new Set();
  for (const block of indexDts.matchAll(/export\s*(?:type\s*)?\{([^}]*)\}/g)) {
    for (const part of block[1].split(',')) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name !== undefined && name.length > 0) names.add(name);
    }
  }
  return names;
}

/**
 * Every package that publishes a barrel, core first.
 *
 * Read from the filesystem rather than listed here, so a package added to the workspace is
 * documented by existing rather than by somebody remembering this file. That is the failure this
 * function was written to end: the generator named one package for as long as there was more than
 * one, and nothing about that was visible from its output.
 */
export function publishedPackages(root) {
  const dir = path.join(root, 'packages');
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      try {
        return statSync(path.join(dir, name, 'src', 'index.ts')).isFile();
      } catch {
        return false;
      }
    })
    .sort();
  return ['core', ...names.filter((name) => name !== 'core')];
}

/**
 * Build the reference.
 *
 * Exported so a consumer's build can call it directly instead of shelling out and
 * parsing stdout, and so a failure is an exception with a stack rather than an exit
 * code nobody reads.
 */
export function buildApi({ root = ROOT } = {}) {
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'driftengine-dts-'));
  try {
    execFileSync(
      'npx',
      [
        'tsc',
        '-p',
        '.',
        '--declaration',
        '--emitDeclarationOnly',
        '--noEmit',
        'false',
        '--outDir',
        outDir,
      ],
      { cwd: root, stdio: 'pipe' },
    );

    /*
     * Only what was emitted from a package's `src/`. `demo/` is compiled by the same project and
     * has a barrel of its own, so "the first index.d.ts" silently picked the demos' one and
     * published an empty reference — a failure that looks like success, which is the kind this
     * file exists to prevent.
     */
    const emitted = declarationFiles(outDir);
    const relative = (file) => path.relative(outDir, file).replaceAll('\\', '/');

    const byArea = new Map();
    const barrels = [];
    /** Packages this project does not compile, so the caller can say so rather than wonder. */
    const skipped = [];
    for (const pkg of publishedPackages(root)) {
      const prefix = `packages/${pkg}/src/`;
      const files = emitted.filter((file) => relative(file).startsWith(prefix));
      const index = files.find((file) => relative(file) === `${prefix}index.d.ts`);
      /*
       * **A package that emitted no declarations is skipped, and skipping it silently was a
       * defect** — it sat one line above two `throw`s written to stop a package going quiet, and
       * did the exact thing they forbid. `@driftengine/native-host` is Node-only and excluded from
       * this project on purpose, so it emits nothing here and its whole surface was missing from
       * the reference with nothing saying so; a consumer's site then described a capability the
       * reference did not group, which is how it was finally noticed.
       *
       * It cannot throw, because that exclusion is correct. So it is **reported**: the caller gets
       * the list and decides. A package that ought to be here and is not now says its own name.
       */
      if (index === undefined) {
        skipped.push(pkg);
        continue;
      }

      const wanted = barrelExports(readFileSync(index, 'utf8'));
      if (wanted.size === 0) {
        throw new Error(`docs-api: ${pkg}'s barrel exports nothing, which cannot be right`);
      }
      barrels.push(`packages/${pkg}/src/index.ts`);

      let found = 0;
      for (const file of files) {
        if (file === index) continue;
        /*
         * Core is grouped by the area a symbol is declared in; every other package is one group
         * named by the package. A small package has no `src/<area>/` to read, so `groupFor` would
         * answer `core` for all of it and quietly merge five packages into core's own heading.
         */
        const area = pkg === 'core' ? groupFor(relative(file)) : pkg;
        for (const [name, symbol] of parseDeclarations(readFileSync(file, 'utf8'))) {
          if (!wanted.has(name)) continue;
          if (!byArea.has(area)) byArea.set(area, new Map());
          byArea.get(area).set(name, symbol);
          found++;
        }
      }
      /*
       * Per package rather than once at the end, because a barrel that emits nothing is a real
       * failure — a renamed directory, a package excluded from the project — and folding it into
       * one total lets six healthy packages hide a seventh that has gone silent.
       */
      if (found === 0) {
        throw new Error(
          `docs-api: ${pkg}'s barrel names ${wanted.size} exports and none was found in the ` +
            'declaration output',
        );
      }
    }
    if (barrels.length === 0) throw new Error('docs-api: no package emitted a barrel');

    /*
     * Core's own areas in the order the capability map uses, so the two pages describe one
     * engine, and then the packages. A package is a heading a reader chooses to import, so it
     * sits after the surface that is always there.
     */
    const order = [
      'core',
      'render',
      'physics',
      'geometry',
      'input',
      'ui',
      'cinematic',
      'dev',
      'environment',
      'host',
      'math',
      'scene',
    ];
    const rank = (area) => {
      const at = order.indexOf(area);
      return at === -1 ? order.length : at;
    };

    const groups = [...byArea.entries()]
      .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
      .map(([area, symbols]) => ({
        area,
        symbols: [...symbols.values()].sort((a, b) => a.name.localeCompare(b.name)),
      }));

    const pkg = JSON.parse(readFileSync(path.join(root, 'packages/core/package.json'), 'utf8'));
    return { generatedFrom: barrels.join(', '), version: pkg.version, groups, skipped };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const flag = process.argv.indexOf('--out');
  if (flag === -1 || process.argv[flag + 1] === undefined) {
    console.error('usage: node scripts/docs-api.mjs --out <path/to/api.json>');
    process.exit(1);
  }
  const out = path.resolve(process.argv[flag + 1]);
  const api = buildApi();
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(api, null, 1)}\n`, 'utf8');
  const total = api.groups.reduce((sum, group) => sum + group.symbols.length, 0);
  console.log(`docs-api: ${total} symbols across ${api.groups.length} areas -> ${out}`);
}

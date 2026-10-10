/**
 * Write `packages/create/templates/` from the examples a new project starts as, and the skill's
 * generated half: its code from the examples, and its three references from the repository.
 *
 * **Generated rather than kept by hand, because the examples are the half the compiler checks.**
 * `examples/` is in the typecheck, the manual quotes it and `npm run examples` serves it, so a
 * starter project copied from it is a program somebody has already compiled and run. A second,
 * hand-kept copy inside the package would start drifting the first time an example changed, and
 * the failure would be silent: `npm create @driftengine` would hand out the old program to everyone
 * who ran it, and nothing in this repository would fail.
 *
 * **Committed rather than built at pack time**, so the tarball's templates are files a reviewer can
 * read in the diff of the commit that changed them. `create-templates.test.mjs` runs this with
 * `--check` and fails when the committed copy differs from what it would write.
 *
 * What a template changes on the way out of `examples/`, and nothing else:
 *
 * - The `#region` markers go. They are anchors for the manual's samples and noise in a project.
 * - The page loses the link back to the examples' index, which says on its own line that it is only
 *   for the served index, and gains an empty icon where it has none: the browser's own request for
 *   `/favicon.ico` is a 404, and a 404 is the console error that fails `npm run look`.
 * - The program moves into `src/`, beside the declaration that types a `.drs` import.
 *
 * **The skill in `skills/driftengine/` is written by hand except where a reader could check it.**
 * Its code blocks name a region of an example, as the manual's do, and their bodies are rewritten
 * from it; its references — every manual page, every example, every package — are generated, so a
 * page added to the manual is in the skill the next time this runs, and `--check` fails until it
 * is. The templates carry a copy of the result, because a project's skill has to be on its disk.
 *
 * Usage: `npm run create:templates`, or `npm run create:templates -- --check`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  fencesOf,
  parseFrontmatter,
  readManual,
  resolveSample,
  withoutRegionMarkers,
} from './manual.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
export const OUT = 'packages/create/templates';

/** The examples a project can start as. `starter` is the default. */
export const TEMPLATES = {
  starter: {
    example: 'starter',
    description: 'A lit cube turning on a fixed clock, at a rate a DriftScript rule decides.',
  },
  'first-game': {
    example: 'first-game',
    description:
      'A complete 3D game: physics, a character, orbs to gather against the clock, sound, shadows, a HUD and rules in DriftScript.',
  },
};

/** Files of an example that are not the program: the still the examples index shows, and the config. */
const NOT_THE_PROGRAM = new Set(['still.webp', 'vite.config.ts']);

/** The one Vite config a copied example needs, which the starter carries and says so. */
const VITE_CONFIG = 'examples/starter/vite.config.ts';
/** How TypeScript resolves a `.drs` import. Every example in the repository shares the starter's. */
const DRS_TYPES = 'examples/starter/drs.d.ts';

const ICON =
  '    <!-- An empty icon until the game has one, so the browser does not ask for /favicon.ico. -->\n' +
  '    <link rel="icon" href="data:," />\n';

/** One rewrite of a page, refused loudly when the page has stopped having the shape it expects. */
function rewrite(text, pattern, replacement, what, file) {
  if (!pattern.test(text)) {
    throw new Error(`create-templates: ${file} no longer has ${what}; update this script with it`);
  }
  return text.replace(pattern, replacement);
}

/** An example's page as a project's: no link back to the index, an icon, the program under `src/`. */
export function projectPage(html, file = 'index.html') {
  let page = html.replaceAll('\r\n', '\n');
  page = rewrite(
    page,
    /\n\s*<!-- Only for the served index;[^\n]*-->/,
    '',
    'the index-only comment',
    file,
  );
  page = rewrite(page, /\n\s*<a id="home"[^\n]*<\/a>/, '', 'the link back to the index', file);
  page = rewrite(page, /\n\s*#home \{[\s\S]*?\n\s*\}/, '', 'the style of that link', file);
  page = rewrite(page, /<title>[^<]*<\/title>/, '<title>my-game</title>', 'a title', file);
  page = rewrite(page, /src="\.\/main\.ts"/, 'src="./src/main.ts"', 'a script at ./main.ts', file);
  if (!/rel="icon"/.test(page)) {
    page = rewrite(page, /(<meta name="viewport"[^\n]*\n)/, `$1${ICON}`, 'a viewport meta', file);
  }
  return page;
}

/** Every `@driftengine/*` package and `driftscript` a program imports, sorted. */
export function importedPackages(sources) {
  const found = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(
      /from '(@driftengine\/[a-z0-9-]+|driftscript)(?:\/[^']*)?'/g,
    )) {
      found.add(match[1]);
    }
  }
  return [...found].sort();
}

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

const read = (root, relative) => readFileSync(path.join(root, relative), 'utf8');

export const SKILL = 'skills/driftengine';

/** Where a reader finds a file of this repository at the tag of the version they installed. */
const RAW = 'https://raw.githubusercontent.com/drftrun/driftengine/v<version>';
const TREE = 'https://github.com/drftrun/driftengine/tree/v<version>';
const VERSION_LINE =
  "`<version>` is the installed engine's, from `node -p \"require('@driftengine/core/package.json').version\"`,\n" +
  'so what it says matches the code the project runs.';

/** `SKILL.md` with every sampled block's body rewritten from the region it names. */
export function syncedSkill(root = ROOT) {
  const relative = `${SKILL}/SKILL.md`;
  const text = read(root, relative).replaceAll('\r\n', '\n');
  const { body } = parseFrontmatter(text, relative);
  const head = text.slice(0, text.length - body.length);
  const lines = body.split('\n');
  for (const fence of fencesOf(body).reverse()) {
    if (fence.sample === null) continue;
    const resolved = resolveSample(root, fence.sample);
    if (resolved.error !== undefined)
      throw new Error(`${relative}:${fence.line}: ${resolved.error}`);
    lines.splice(fence.line, fence.length, ...resolved.code.split('\n'));
  }
  return head + lines.join('\n');
}

/** Every manual page, by section, with the address of its Markdown at a release's tag. */
function manualReference(root) {
  const lines = [
    '# The manual',
    '',
    "Every page of DriftEngine's manual, generated from `docs/manual/` in the engine's repository.",
    '',
    `Each page is Markdown at \`${RAW}/docs/manual/<page>\`, where`,
    VERSION_LINE,
    'The same page is on the web at `https://driftengine.dev/docs/<page>`, without the `.md`.',
  ];
  for (const section of readManual(root).sections) {
    lines.push('', `## ${section.title}`, '', section.blurb, '');
    for (const page of section.pages) {
      if (page.missing) continue;
      lines.push(`- \`${section.id}/${page.slug}.md\`: **${page.title}.** ${page.description}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Every example in the examples' own table, with where its files are at a release's tag. */
function examplesReference(root) {
  const rows = read(root, 'examples/README.md')
    .split('\n')
    .map((line) => /^\| \[`([a-z0-9-]+)\/`\]\([a-z0-9-]+\/\)\s*\| (.*?)\s*\|$/.exec(line))
    .filter((match) => match !== null);
  if (rows.length === 0)
    throw new Error('create-templates: examples/README.md has no table of examples');
  const lines = [
    '# The examples',
    '',
    'Small programs, one capability each, typechecked with the engine and runnable with',
    '`npm run examples` in its repository. Generated from the table in `examples/README.md`.',
    '',
    `Each folder is at \`${TREE}/examples/<name>\`, and its program is`,
    `\`${RAW}/examples/<name>/main.ts\`, where`,
    VERSION_LINE,
    '',
  ];
  for (const [, name, what] of rows) lines.push(`- \`${name}/\`: ${what}`);
  return `${lines.join('\n')}\n`;
}

/** Every published package and the sentence its manifest describes it with. */
function packagesReference(root) {
  const lines = [
    '# The packages',
    '',
    'Every package is published to npm under `@driftengine/` and moves on one version line, so a',
    'project installs the same version of each. `@driftengine/core` is the one every game needs.',
    "Generated from the packages' own manifests.",
    '',
  ];
  for (const dir of readdirSync(path.join(root, 'packages')).sort()) {
    const file = path.join(root, 'packages', dir, 'package.json');
    if (!existsSync(file)) continue;
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    if (manifest.private === true) continue;
    lines.push(`- \`${manifest.name}\`: ${manifest.description}.`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The skill as it should be on disk: a map from a path under `skills/driftengine/` to its text.
 *
 * Hand-written files are carried as they are, `SKILL.md` with its code synced, and the three
 * references generated; a hand-written file under `references/` with one of those names is
 * replaced, which is the point.
 */
export function generateSkill(root = ROOT) {
  const out = new Map();
  const dir = path.join(root, SKILL);
  for (const file of filesUnder(dir))
    out.set(path.relative(dir, file).split(path.sep).join('/'), readFileSync(file, 'utf8'));
  out.set('SKILL.md', syncedSkill(root));
  out.set('references/manual.md', manualReference(root));
  out.set('references/examples.md', examplesReference(root));
  out.set('references/packages.md', packagesReference(root));
  return out;
}

/** What `templates/` should hold: a map from a path under it to that file's text. */
export function generate(root = ROOT) {
  const out = new Map();

  for (const [name, template] of Object.entries(TEMPLATES)) {
    const exampleDir = path.join(root, 'examples', template.example);
    const programs = [];
    for (const entry of readdirSync(exampleDir).sort()) {
      if (NOT_THE_PROGRAM.has(entry)) continue;
      const source = read(root, path.join('examples', template.example, entry));
      if (entry === 'index.html') {
        out.set(
          `${name}/index.html`,
          projectPage(source, `examples/${template.example}/index.html`),
        );
      } else if (/\.(ts|drs)$/.test(entry)) {
        out.set(`${name}/src/${entry}`, withoutRegionMarkers(source));
        if (entry.endsWith('.ts')) programs.push(source);
      } else {
        throw new Error(
          `create-templates: examples/${template.example}/${entry} is neither page nor program`,
        );
      }
    }
    if (!out.has(`${name}/src/drs.d.ts`)) {
      out.set(`${name}/src/drs.d.ts`, withoutRegionMarkers(read(root, DRS_TYPES)));
    }
    out.set(`${name}/vite.config.ts`, withoutRegionMarkers(read(root, VITE_CONFIG)));
    /* The tools — Vite, Vitest, TypeScript — are the same for every template and `scaffold.ts`
       names them; what differs is which engine packages the program reaches for. */
    const manifest = {
      description: template.description,
      dependencies: importedPackages(programs),
    };
    out.set(`${name}/template.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  for (const [relative, text] of generateSkill(root)) out.set(`skill/${relative}`, text);

  out.set('versions.json', `${JSON.stringify(versions(root), null, 2)}\n`);
  return out;
}

/**
 * Vitest for a new project, and deliberately not the range this repository runs.
 *
 * **Vitest 4.1 cannot be installed into a project with no lockfile by npm 10.9**, the npm Node 22
 * ships: its resolver dies on Vitest's peer list with `Cannot read properties of null (reading
 * 'edgesOut')`. Measured 2026-10-10 on npm 10.9.8, from `"vitest": "^4.1.10"` alone in an empty
 * project, and found by `npm run cleanroom` on the first run of a started project. This repository
 * never meets it because its lockfile was resolved once, long ago; every new project would meet it
 * on its first `npm install`, which is the worst place a starter can fail. Vitest 5 resolves, and
 * the clean room runs each template's tests under it.
 *
 * **What would make this wrong**: the repository moving to Vitest 5, when this goes and the
 * workspace's own range is used again.
 */
const PROJECT_VITEST = '^5.0.3';

/**
 * The versions a new project's tools are pinned to: the ones this repository is tested with.
 *
 * `driftscript` exactly, and from `@driftengine/script` rather than from anywhere else: a project
 * compiling `.drs` against a different language version from the one the engine described itself
 * to gets every script refused, and the pin the engine's own scripting package carries is the one
 * that has to agree. `vite` is the installed version, because nothing here declares it — it arrives
 * under `vitest` — and a caret on what was actually run is the honest range.
 */
function versions(root) {
  const manifest = (relative) => JSON.parse(read(root, relative));
  const workspace = manifest('package.json');
  const script = manifest('packages/script/package.json');
  return {
    driftscript: script.dependencies.driftscript,
    vite: `^${manifest('node_modules/vite/package.json').version}`,
    vitest: PROJECT_VITEST,
    typescript: workspace.devDependencies.typescript,
    '@types/node': workspace.devDependencies['@types/node'],
  };
}

/** Write the skill's generated half, then `templates/`, removing anything it no longer produces. */
export function write(root = ROOT) {
  for (const [relative, text] of generateSkill(root)) {
    const target = path.join(root, SKILL, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  const files = generate(root);
  const dir = path.join(root, OUT);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  for (const [relative, text] of files) {
    const target = path.join(dir, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  return files.size;
}

/** Every file that differs from what `write` would make of it, or is missing, or is extra. */
export function stale(root = ROOT) {
  const problems = [];
  const compare = (dir, files, label) => {
    const found = existsSync(dir)
      ? filesUnder(dir).map((f) => path.relative(dir, f).split(path.sep).join('/'))
      : [];
    for (const [relative, text] of files) {
      const target = path.join(dir, relative);
      if (!existsSync(target)) problems.push(`missing: ${label}/${relative}`);
      else if (readFileSync(target, 'utf8') !== text) problems.push(`stale: ${label}/${relative}`);
    }
    for (const relative of found)
      if (!files.has(relative)) problems.push(`extra: ${label}/${relative}`);
  };
  compare(path.join(root, SKILL), generateSkill(root), SKILL);
  compare(path.join(root, OUT), generate(root), OUT);
  return problems;
}

if (import.meta.filename === process.argv[1]) {
  if (process.argv.includes('--check')) {
    const problems = stale();
    for (const problem of problems) console.error(`create-templates: ${problem}`);
    if (problems.length > 0) {
      console.error('Run `npm run create:templates` and commit what it writes.');
      process.exitCode = 1;
    } else console.log('create-templates: every template matches its example');
  } else {
    console.log(`create-templates: wrote ${write()} files under ${OUT}`);
  }
}

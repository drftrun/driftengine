/**
 * What a new project is, as a list of files, and the one function that writes such a list.
 *
 * **Planning is separate from writing so the plan can be tested without a disk**, and so the
 * refusal to overwrite can name every file in the way before any of them is touched: a scaffold
 * that writes half a project and then stops is a directory nobody can rerun the command in.
 *
 * Everything a project starts with comes from three places in this package. `templates/` is the
 * program, generated from the engine repository's `examples/` by `scripts/create-templates.mjs`, so
 * it is code that has been typechecked and run. `shared/` is what every template has around the
 * program — the agent's instructions, the README, the look script, the TypeScript config. The
 * manifest is built here, because which versions it names is the decision this module exists for.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** A file of the plan: where it goes under the project, and what it holds. */
export interface PlannedFile {
  readonly path: string;
  readonly content: string;
}

/** What `templates/<name>/template.json` says about a template. */
export interface TemplateInfo {
  readonly name: string;
  readonly description: string;
  readonly dependencies: readonly string[];
}

/** The project to plan. */
export interface ProjectOptions {
  /** The npm name, also used for the page title and DriftScript's manifest. */
  readonly name: string;
  readonly template: string;
  /** The engine version every `@driftengine/*` dependency is pinned to, with a caret. */
  readonly engineVersion: string;
}

/** The placeholder the templates carry wherever the project's name goes. */
const PLACEHOLDER = 'my-game';

/** Where the skill goes in a project: the two folders the agents in use today read skills from. */
export const SKILL_DIRS = ['.agents/skills/driftengine', '.claude/skills/driftengine'] as const;

/**
 * The scripts a project runs, and `check` is the one an agent is told to finish with.
 *
 * `--passWithNoTests` because the starter has no rule worth a test until somebody writes one, and
 * a project whose `check` fails on its first run teaches an agent that red is normal here.
 */
const SCRIPTS = {
  dev: 'vite',
  build: 'vite build',
  preview: 'vite preview',
  typecheck: 'tsc --noEmit',
  test: 'vitest run --passWithNoTests',
  look: 'node scripts/look.mjs',
  check: 'npm run typecheck && npm test && npm run look',
} as const;

const read = (file: string): string => readFileSync(file, 'utf8');

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

/** Every template this package carries, in the order a listing shows them. */
export function templates(packageRoot: string): TemplateInfo[] {
  const dir = path.join(packageRoot, 'templates');
  return readdirSync(dir)
    .filter((name) => existsSync(path.join(dir, name, 'template.json')))
    .sort((a, b) => (a === 'starter' ? -1 : b === 'starter' ? 1 : a.localeCompare(b)))
    .map((name) => {
      const info = JSON.parse(read(path.join(dir, name, 'template.json'))) as Omit<
        TemplateInfo,
        'name'
      >;
      return { name, ...info };
    });
}

/**
 * A directory name as an npm package name: lower case, and only the characters npm accepts.
 *
 * Returns the placeholder for a name with nothing usable in it, rather than refusing, because the
 * name only has to be valid; the project can be renamed in one line of `package.json`.
 */
export function packageName(directory: string): string {
  const name = path
    .basename(path.resolve(directory))
    .toLowerCase()
    .replace(/[^a-z0-9._~-]+/g, '-')
    .replace(/^[._-]+|[-]+$/g, '');
  return name === '' ? PLACEHOLDER : name.slice(0, 214);
}

/** The project's `package.json`, with every engine package on the version this package shipped with. */
export function manifest(
  options: ProjectOptions,
  info: TemplateInfo,
  versions: Record<string, string>,
): string {
  const dependencies: Record<string, string> = {};
  for (const name of info.dependencies) {
    /* The language is pinned exactly and to the engine's own pin: two versions of the compiler in one
       tree describe the engine's capabilities differently, and every script is then refused. */
    if (name === 'driftscript') dependencies[name] = versionOf(versions, 'driftscript');
    else dependencies[name] = `^${options.engineVersion}`;
  }
  const devDependencies: Record<string, string> = {
    '@types/node': versionOf(versions, '@types/node'),
    typescript: versionOf(versions, 'typescript'),
    vite: versionOf(versions, 'vite'),
    vitest: versionOf(versions, 'vitest'),
  };
  const project = {
    name: options.name,
    private: true,
    version: '0.0.0',
    type: 'module',
    scripts: SCRIPTS,
    dependencies,
    devDependencies,
  };
  return `${JSON.stringify(project, null, 2)}\n`;
}

function versionOf(versions: Record<string, string>, name: string): string {
  const version = versions[name];
  if (version === undefined)
    throw new Error(`templates/versions.json names no version for ${name}`);
  return version;
}

/** The skill as files under both folders an agent reads skills from. */
export function planSkill(packageRoot: string): PlannedFile[] {
  const dir = path.join(packageRoot, 'templates', 'skill');
  const files = filesUnder(dir).map((file) => ({
    relative: path.relative(dir, file),
    content: read(file),
  }));
  return SKILL_DIRS.flatMap((root) =>
    files.map(({ relative, content }) => ({
      path: path.posix.join(root, relative.split(path.sep).join('/')),
      content,
    })),
  );
}

/** Every file of a new project, in the order they are written. */
export function planProject(packageRoot: string, options: ProjectOptions): PlannedFile[] {
  const info = templates(packageRoot).find((t) => t.name === options.template);
  if (info === undefined) {
    const known = templates(packageRoot)
      .map((t) => t.name)
      .join(', ');
    throw new Error(`there is no template called ${options.template}. The templates are: ${known}`);
  }
  const versions = JSON.parse(read(path.join(packageRoot, 'templates', 'versions.json'))) as Record<
    string,
    string
  >;
  const named = (text: string): string => text.replaceAll(PLACEHOLDER, options.name);

  const plan: PlannedFile[] = [
    { path: 'package.json', content: manifest(options, info, versions) },
  ];

  const shared = path.join(packageRoot, 'shared');
  for (const file of filesUnder(shared)) {
    const relative = path.relative(shared, file).split(path.sep).join('/');
    /* npm leaves a file called `.gitignore` out of every tarball it packs, so it travels without its dot. */
    const target = relative === 'gitignore' ? '.gitignore' : relative;
    plan.push({ path: target, content: named(read(file)) });
  }

  const program = path.join(packageRoot, 'templates', options.template);
  for (const file of filesUnder(program)) {
    const relative = path.relative(program, file).split(path.sep).join('/');
    if (relative === 'template.json') continue;
    plan.push({ path: relative, content: named(read(file)) });
  }

  plan.push(...planSkill(packageRoot));
  return plan;
}

/**
 * Write a plan under `dir`, refusing before writing anything if a file is in the way.
 *
 * `replace` names path prefixes that may be overwritten — the skill's own folders, when the skill
 * is being refreshed — and everything else is refused by name, so nothing a person edited is lost.
 */
export function writePlan(
  dir: string,
  plan: readonly PlannedFile[],
  { replace = [] as readonly string[] } = {},
): string[] {
  const inTheWay = plan
    .map((file) => file.path)
    .filter((relative) => existsSync(path.join(dir, relative)))
    .filter((relative) => !replace.some((prefix) => relative.startsWith(`${prefix}/`)));
  if (inTheWay.length > 0) {
    throw new Error(
      `these files already exist, and nothing was written:\n  ${inTheWay.join('\n  ')}`,
    );
  }
  for (const file of plan) {
    const target = path.join(dir, file.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
  return plan.map((file) => file.path);
}

/**
 * Whether a new project may go in a directory: it is missing, or holds nothing but a repository.
 *
 * `.git` is allowed because `git init` first and scaffold second is an ordinary order to do things
 * in, and a refusal there would send somebody to delete their history to get past it.
 */
export function isEmptyDirectory(dir: string): boolean {
  if (!existsSync(dir)) return true;
  return statSync(dir).isDirectory() && readdirSync(dir).every((entry) => entry === '.git');
}

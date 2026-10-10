/**
 * The command `npm create @driftengine` runs: arguments in, files out, an exit code.
 *
 * **It never asks a question.** Every choice has a default and a flag, because the caller is as
 * likely to be a coding agent as a person, and an agent cannot answer a prompt: a scaffold that
 * stops to ask which template is a scaffold that hangs until a timeout kills it. A person who wants
 * to see the choices runs `--help`.
 *
 * It does not run `npm install` either. That is a network operation with its own failures, and a
 * scaffold that reports them as its own makes both harder to read; the next steps it prints say to.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SKILL_DIRS,
  isEmptyDirectory,
  packageName,
  planProject,
  planSkill,
  templates,
  writePlan,
} from './scaffold.ts';

/** This package's root, one level above `src/` or `dist/`, wherever it was installed. */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

interface Parsed {
  readonly directory: string;
  readonly template: string;
  readonly skill: boolean;
  readonly help: boolean;
}

/** `[directory] [--template <name>] [--skill] [--help]`, with `--template=<name>` too. */
export function parseArgs(args: readonly string[]): Parsed {
  let directory: string | undefined;
  let template = 'starter';
  let skill = false;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--skill') skill = true;
    else if (arg === '--template' || arg === '-t') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('-'))
        throw new Error(`${arg} needs a template name`);
      template = value;
      index += 1;
    } else if (arg.startsWith('--template=')) template = arg.slice('--template='.length);
    else if (arg.startsWith('-'))
      throw new Error(`unknown option ${arg}. Run with --help to see them.`);
    else if (directory === undefined) directory = arg;
    else throw new Error(`one directory at a time: got ${directory} and ${arg}`);
  }
  return { directory: directory ?? (skill ? '.' : 'my-game'), template, skill, help };
}

function version(): string {
  const manifest = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
    version: string;
  };
  return manifest.version;
}

function usage(): string {
  const list = templates(PACKAGE_ROOT)
    .map((t) => `  ${t.name.padEnd(12)} ${t.description}`)
    .join('\n');
  return `Start a DriftEngine game.

  npm create @driftengine@latest [directory] -- [--template <name>]
  npm create @driftengine@latest [directory] -- --skill

directory          where the project goes; it must be empty. Defaults to my-game.
--template <name>  which program to start from. Defaults to starter.
--skill            add the driftengine skill to an existing project instead, in
                   ${SKILL_DIRS.join(' and ')}, replacing an older copy.

Templates:
${list}

Nothing is asked and nothing is installed: run npm install in the project afterwards.`;
}

/** Run the command, printing to the given streams. Resolves to the exit code. */
export function main(
  args: readonly string[],
  cwd: string,
  out: (line: string) => void = (line) => console.log(line),
  err: (line: string) => void = (line) => console.error(line),
): number {
  let parsed: Parsed;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    err(`create-driftengine: ${(error as Error).message}`);
    return 1;
  }
  if (parsed.help) {
    out(usage());
    return 0;
  }

  const dir = path.resolve(cwd, parsed.directory);
  try {
    if (parsed.skill) {
      writePlan(dir, planSkill(PACKAGE_ROOT), { replace: SKILL_DIRS });
      out(`Wrote the driftengine skill, for DriftEngine ${version()}, into:`);
      for (const skillDir of SKILL_DIRS) out(`  ${path.join(dir, skillDir)}`);
      return 0;
    }

    if (!isEmptyDirectory(dir)) {
      err(
        `create-driftengine: ${dir} is not empty. Pick a new directory, or add the skill to an ` +
          'existing project with --skill.',
      );
      return 1;
    }
    const name = packageName(dir);
    writePlan(
      dir,
      planProject(PACKAGE_ROOT, { name, template: parsed.template, engineVersion: version() }),
    );
    const relative = path.relative(cwd, dir) || '.';
    out(`Created ${name} from the ${parsed.template} template, on DriftEngine ${version()}.

  cd ${relative}
  npm install
  npm run dev      serve it with hot reload
  npm run check    typecheck, test, and look at it on WebGPU and WebGL2

AGENTS.md tells a coding agent how this project works and how to check a change.
The driftengine skill, in ${SKILL_DIRS.join(' and ')}, teaches it the engine.`);
    return 0;
  } catch (error) {
    err(`create-driftengine: ${(error as Error).message}`);
    return 1;
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2), process.cwd());
}

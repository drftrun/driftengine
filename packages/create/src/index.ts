/*! DriftEngine | Copyright 2026 Drift Technologies | Apache-2.0 | https://github.com/drftrun/driftengine */
/**
 * What `npm create @driftengine` does, as functions a tool can call instead of a command it runs.
 *
 * The command is `bin/create.mjs`. These are for a host that starts projects itself — an editor's
 * "new project", a test that wants a fresh project in a temporary directory — and wants the same
 * files the command writes without parsing its output.
 */
export { main, parseArgs } from './cli.ts';
export {
  SKILL_DIRS,
  isEmptyDirectory,
  manifest,
  packageName,
  planProject,
  planSkill,
  templates,
  writePlan,
} from './scaffold.ts';
export type { PlannedFile, ProjectOptions, TemplateInfo } from './scaffold.ts';

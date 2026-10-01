/**
 * The reference's scripts off disk: which files, in what order, and the refusal when they are not
 * there.
 *
 * The source is never committed — it is the reference's to distribute, not this repository's — so
 * a clone has none, and the bake's first job is to say so with the path it looked for.
 *
 * **The layer order is the reference's own**, from its manifest's comment: its host loads these in
 * turn. Two more files are loaded by nothing in the scripts and must be loaded by the host, so they
 * run where their contents need them: the landmarks after the buildings they share parts with, and
 * the loading screen before the interface that reads its state.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { readScripts } from './script/reader.ts';
import type { ScriptRead } from './script/reader.ts';
import type { EvalOptions } from './script/names.ts';

/** Where the source sits in a checkout that has it, from the repository root. */
export const DEFAULT_SOURCE = 'demo/dev/public/sprawl/source/etc';

export const LAYERS = [
  'config',
  'engine',
  'quality',
  'keybinding',
  'input',
  'materials',
  'props',
  'buildings',
  'landmarks',
  'interiors',
  'vehicles',
  'drones',
  'npcs',
  'transit',
  'scene',
  'loading',
  'ui',
] as const;

/** Why the source at `root` cannot be read — the first path looked for and not found — or null. */
export function missingSource(root: string): string | null {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return `The city's bake reads the reference's scripts from ${root}, which is not there.`;
  }
  for (const layer of LAYERS) {
    const file = join(root, `${layer}.flecs`);
    if (!existsSync(file)) {
      return `The reference's scripts at ${root} are incomplete: ${file} is not there.`;
    }
  }
  return null;
}

/** Every script file below `root`, relative to it, `/`-separated and sorted. */
export function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      if (entry.startsWith('.') || entry === 'assets') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, `${prefix}${entry}/`);
      else if (entry.endsWith('.flecs')) out.push(`${prefix}${entry}`);
    }
  };
  walk(root, '');
  return out;
}

/** Every layer read from `root`, in order. The caller has checked `missingSource`. */
export function readSource(root: string, options: Partial<EvalOptions> = {}): ScriptRead {
  return readScripts(
    LAYERS.map((layer) => `${layer}.flecs`),
    (file) => {
      const full = join(root, file);
      return existsSync(full) ? readFileSync(full, 'utf8') : null;
    },
    options,
  );
}

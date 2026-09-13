/**
 * Write what this engine provides, as data the language server can read.
 *
 * **Generated and committed, and checked for staleness — the same arrangement as the WGSL and the
 * TextMate grammar, for the same reason.** A language server is a plain Node process and cannot
 * import the engine at all: engine packages use extensionless relative imports, which a bundler
 * resolves and Node does not. `AGENTS.md` exempts `driftscript` alone from that. So the server
 * cannot ask the engine what it provides; it reads this.
 *
 * That is possible because of R2 rather than by luck. The registry describes and never invokes — a
 * definition names its implementation as a string — so a registry is data all the way down and
 * survives a process boundary intact.
 *
 * ```sh
 * npm run capabilities         # write it
 * npm run capabilities:check   # fail if it is stale
 * ```
 *
 * Run under `tsx`, like `bake` and `wgsl`, because this script *does* import the engine.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeRegistry } from 'driftscript';
import { engineRegistry, engineTarget } from '../packages/script/src/host.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(ROOT, 'packages', 'script', 'capabilities.json');

const document = {
  ...serializeRegistry(engineRegistry()),
  /* The target travels with the capabilities because an editor needs both: the registry says what
     exists and the manifest says what this target links, and §7's greyed entries are the difference
     between them. Two files would be two things to keep in step. */
  manifest: engineTarget(),
};

const text = `${JSON.stringify(document, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const existing = readFileSync(OUTPUT, 'utf8');
  if (existing !== text) {
    process.stderr.write(
      `${path.relative(ROOT, OUTPUT)} is stale — run \`npm run capabilities\`.\n` +
        'A capability landed and the language server still describes the one before it, which is a ' +
        'completion list that lies about the target.\n',
    );
    process.exit(1);
  }
  process.stdout.write(`${path.relative(ROOT, OUTPUT)} is current\n`);
} else {
  writeFileSync(OUTPUT, text);
  process.stdout.write(
    `wrote ${path.relative(ROOT, OUTPUT)}: ${document.capabilities.length} capabilities, ` +
      `${document.types.length} types\n`,
  );
}

/**
 * Put a car in front of the showroom, in whatever format it arrived as.
 *
 *   npx tsx scripts/showroom-car.ts <file-or-folder> [--to <dir>] [--bake] [--up z]
 *
 * **The showroom looks for `car.<ext>` and reads whichever it finds**, so installing a model is a
 * copy rather than a conversion. This does that copy, and the three things around it that are
 * easy to get wrong:
 *
 * - **Picks the file.** A bought asset is a bundle, so a folder is a valid input and the highest
 *   tier present wins, exactly as the baker chooses. What it picked and what it passed over are
 *   printed, because choosing in silence is how an experimental reader gets used while a
 *   conformance-tested file sits in the next folder.
 * - **Brings the textures.** A model states whatever path was true on the machine that exported
 *   it, so its images are copied into a `textures/` folder beside it, which is one of the places
 *   `assetCandidates` looks. Without this the model arrives and draws untextured, which looks
 *   like a missing feature rather than like a file that stayed behind.
 * - **Says whether it will deploy.** Static hosting has a per-file ceiling, and 25 MiB is the one
 *   this project's own site is under. A model that sails past it locally and fails at deploy is a
 *   bad way to find that out, so the size is checked here and stated either way.
 *
 * `--bake` writes a `.drft` instead of copying the source. That is the better artefact for
 * anything shipped, because it streams, it is zero-copy, and the staged reveal is the file's own
 * layout. The copy is for looking at a model without running a tool first.
 */

import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { MODEL_FORMATS, extensionOf, readerFor } from '@driftengine/assets';
import { DrftError } from '@driftengine/drft';

/** What a static host will accept as one file. Cloudflare's, and the tightest in common use. */
const DEPLOY_LIMIT_BYTES = 25 * 1024 * 1024;

/** Where the showroom looks by default: the engine's own dev server root. */
const DEFAULT_TARGET = 'demo/dev/public';

function walk(dir: string, depth = 0): string[] {
  if (depth > 4) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, depth + 1));
    else out.push(full);
  }
  return out;
}

/**
 * Choose the model in a bundle, by tier and then by what a format can carry.
 *
 * The same order the baker uses, and for the same reason: a download is typically the source the
 * artist worked in plus conversions, every one of them the same model and exactly one of them the
 * best thing to read.
 */
function choose(input: string): string {
  if (!statSync(input).isDirectory()) return input;
  const candidates = walk(input)
    .map((file) => ({ file, reader: readerFor(path.extname(file)) }))
    .filter(
      (entry): entry is { file: string; reader: NonNullable<typeof entry.reader> } =>
        entry.reader !== undefined,
    );
  if (candidates.length === 0) {
    throw new DrftError(
      `${input}: nothing readable here. Looked for ${MODEL_FORMATS.map((f) => f.ext).join(', ')}`,
    );
  }
  candidates.sort(
    (a, b) =>
      a.reader.tier - b.reader.tier ||
      MODEL_FORMATS.indexOf(a.reader) - MODEL_FORMATS.indexOf(b.reader),
  );
  const picked = candidates[0] as (typeof candidates)[number];
  const passed = candidates.slice(1).map((entry) => path.basename(entry.file));
  console.log(`chose ${path.basename(picked.file)} (${picked.reader.note})`);
  if (passed.length > 0) console.log(`  passed over ${passed.join(', ')}`);
  return picked.file;
}

/**
 * Copy the images a model might ask for into a folder beside it.
 *
 * Every image in the bundle rather than only the ones the model names, because reading the model
 * to find out is the baker's job and this is a copy. They are small next to the geometry, and a
 * texture that turns out to be unused costs a few hundred kilobytes while a missing one costs a
 * surface.
 */
function copyTextures(source: string, targetDir: string): number {
  const root = statSync(source).isDirectory() ? source : path.dirname(source);
  const images = walk(root).filter((file) => /\.(png|jpe?g|webp)$/i.test(file));
  if (images.length === 0) return 0;
  const into = path.join(targetDir, 'textures');
  mkdirSync(into, { recursive: true });
  let copied = 0;
  for (const image of images) {
    copyFileSync(image, path.join(into, path.basename(image)));
    copied++;
  }
  /* `textures/<name>` is one of the candidates the resolver tries, which is why this folder. */
  console.log(`  ${copied} image(s) into ${shortPath(into)}/, which is where the resolver looks`);
  return copied;
}

/** Relative where that is shorter, absolute where it is not. A path of `../../..` helps nobody. */
function shortPath(file: string): string {
  const relative = path.relative(process.cwd(), file);
  return relative.startsWith('..') ? file : relative;
}

function report(file: string): void {
  const bytes = statSync(file).size;
  const mib = bytes / 1024 / 1024;
  const fits = bytes <= DEPLOY_LIMIT_BYTES;
  console.log(
    `${shortPath(file)} — ${mib.toFixed(1)} MiB, ` +
      `${fits ? 'within' : 'over'} the ${DEPLOY_LIMIT_BYTES / 1024 / 1024} MiB per-file limit static hosting sets`,
  );
  if (!fits) {
    console.log('  it will run locally and fail to deploy. Bake it, or use a lighter model.');
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const input = args[0];
  if (input === undefined || input.startsWith('-')) {
    console.error(
      'usage: showroom-car <file-or-folder> [--to <dir>] [--bake] [--up x|-x|y|-y|z|-z]',
    );
    process.exit(1);
  }
  const toIndex = args.indexOf('--to');
  const target = toIndex === -1 ? DEFAULT_TARGET : (args[toIndex + 1] ?? DEFAULT_TARGET);
  const bake = args.includes('--bake');
  const upIndex = args.indexOf('--up');

  const chosen = choose(input);
  mkdirSync(target, { recursive: true });

  if (bake) {
    const out = path.join(target, 'car.drft');
    const bakeArgs = ['tsx', 'scripts/bake.ts', chosen, '-o', out];
    if (upIndex !== -1 && args[upIndex + 1] !== undefined)
      bakeArgs.push('--up', args[upIndex + 1] as string);
    const run = spawnSync('npx', bakeArgs, { stdio: 'inherit' });
    if (run.status !== 0) process.exit(run.status ?? 1);
    report(out);
    return;
  }

  const ext = extensionOf(chosen);
  if (readerFor(ext) === undefined) throw new DrftError(`no reader for "${ext}"`);
  const out = path.join(target, `car${ext}`);
  copyFileSync(chosen, out);
  /*
   * A `.gltf` names its buffers beside it, so they travel too or the model arrives with no
   * geometry at all. Copied by name rather than by parsing, since the document says what it wants.
   */
  if (ext === '.gltf') {
    const doc = JSON.parse(readFileSync(chosen, 'utf8')) as { buffers?: { uri?: string }[] };
    for (const buffer of doc.buffers ?? []) {
      if (buffer.uri === undefined || buffer.uri.startsWith('data:')) continue;
      const from = path.join(path.dirname(chosen), decodeURIComponent(buffer.uri));
      try {
        copyFileSync(from, path.join(target, path.basename(from)));
      } catch {
        console.warn(`  warning: ${buffer.uri} was not found beside the model`);
      }
    }
  }
  /* An `.obj` names its `.mtl` the same way, and the materials are in it rather than in the obj. */
  if (ext === '.obj') {
    const named = /^mtllib\s+(.+)$/m.exec(readFileSync(chosen, 'utf8'))?.[1]?.trim();
    if (named !== undefined) {
      try {
        const mtl = path.join(path.dirname(chosen), named);
        copyFileSync(mtl, path.join(target, named));
        /* Written beside the copy under the name the obj states, or nothing will resolve it. */
        writeFileSync(path.join(target, named), readFileSync(mtl));
      } catch {
        console.warn(`  warning: ${named} named by the obj was not found`);
      }
    }
  }
  copyTextures(input, target);
  report(out);
  console.log(`open the showroom and it will find it: npm run demo, then ?scene=6`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof DrftError ? error.message : error);
  process.exit(1);
}

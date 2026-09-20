/**
 * Fetches a model's pinned checkpoint, and any file pinned beside it — a tokenizer's vocabulary —
 * into `models/capture/<name>/`, verifying each as it arrives.
 *
 * **The manifest is the whole of the trust.** Each file is fetched from the revision it pins —
 * a commit, never a branch, so a later upload cannot replace it unseen — hashed while it streams,
 * and kept only if its size and SHA-256 are the manifest's; otherwise the partial file is deleted
 * and the run fails naming both hashes. A file already present and matching is left alone.
 *
 * **This is a development tool, and the only thing here that touches the network.** The runtime
 * never fetches: a game ships the converted model with itself, as it ships a `.drft`. `models/` is
 * outside git, because a weights file is tens to hundreds of megabytes and is its authors' to
 * distribute, not this repository's.
 *
 *     node tools/capture-weights/fetch.mjs [name ...]      no name: every model in the manifest
 */
import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ROOT = new URL('../..', import.meta.url).pathname;
const { models } = JSON.parse(await readFile(new URL('manifest.json', import.meta.url), 'utf8'));

/** Where one of a model's files lives once fetched: its checkpoint, or a file beside it. */
function filePath(model, file) {
  return path.join(ROOT, 'models', 'capture', model.name, path.basename(file.file));
}

async function hashOf(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** One pinned file — `{ file, url, bytes, sha256 }` — kept only if it is the one pinned. */
async function fetchFile(model, file) {
  const target = filePath(model, file);
  if (
    existsSync(target) &&
    statSync(target).size === file.bytes &&
    (await hashOf(target)) === file.sha256
  ) {
    console.log(`present  ${model.name}  ${path.relative(ROOT, target)}`);
    return;
  }
  mkdirSync(path.dirname(target), { recursive: true });
  const partial = `${target}.part`;
  const response = await fetch(file.url);
  if (!response.ok || response.body === null) {
    throw new Error(`${model.name}: ${file.url} answered ${response.status}`);
  }
  const hash = createHash('sha256');
  let bytes = 0;
  await pipeline(
    Readable.fromWeb(response.body),
    async function* (source) {
      for await (const chunk of source) {
        hash.update(chunk);
        bytes += chunk.length;
        yield chunk;
      }
    },
    createWriteStream(partial),
  );
  const digest = hash.digest('hex');
  if (bytes !== file.bytes || digest !== file.sha256) {
    rmSync(partial);
    throw new Error(
      `${model.name}: ${file.file} arrived as ${bytes} bytes hashing ${digest}, and the ` +
        `manifest pins ${file.bytes} bytes hashing ${file.sha256}; nothing was kept`,
    );
  }
  renameSync(partial, target);
  console.log(`fetched  ${model.name}  ${file.file}, ${bytes} bytes, SHA-256 verified`);
}

/** The checkpoint, then every file the manifest pins beside it. */
async function fetchModel(model) {
  await fetchFile(model, model);
  for (const extra of model.extra ?? []) await fetchFile(model, extra);
}

const asked = process.argv.slice(2);
const unknown = asked.filter((name) => !models.some((model) => model.name === name));
if (unknown.length > 0) {
  throw new Error(
    `no model named ${unknown.join(', ')}; the manifest has ${models.map((m) => m.name).join(', ')}`,
  );
}
for (const model of models) {
  if (asked.length === 0 || asked.includes(model.name)) await fetchModel(model);
}

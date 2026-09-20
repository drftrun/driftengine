/**
 * A shell's key-value store as one JSON file, replaced whole so that nothing ever sees half of it.
 *
 * **Written beside the store and renamed over it.** A rename replaces a file in one step, so a
 * reader — or the next boot, after a crash at any instant — finds the previous store or the next
 * one and never a mixture. Written in place, as this was until 2026-09-19, the file is empty from
 * the moment it is opened until the write lands: a test reading it during rewrites found it torn on
 * 72 reads of 119, and a store that does not parse is read as an empty one, so a crash then costs
 * the player every setting they ever made, with nothing said. **Synced before the rename**, so the
 * replacement carries its bytes to the disk before the name moves: without it a power cut can
 * leave the new name on a file whose contents never arrived.
 *
 * **Asynchronous writes land in the order they were asked for.** Each waits for the one before it,
 * so a large early write finishing after a small late one cannot put the older store back.
 *
 * What it gives up: the directory is not synced, so a power cut straight after a rename may bring
 * back the previous store rather than the new one — a lost second of settings, not a lost store.
 * Both shells use this: the desktop shell's main process and the native host.
 */

import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';

type Entries = Iterable<readonly [string, string]>;

/**
 * The store, or an empty one when there is no file or the file is not a store. A value that is not a
 * string is dropped. A preference is never worth failing a boot for.
 */
export function readStoreFile(path: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

let temporaries = 0;
/** One name per write, so two writes in flight never share a half-written file. */
function temporaryFor(path: string): string {
  temporaries += 1;
  return `${path}.${process.pid}.${temporaries}.tmp`;
}

function textOf(entries: Entries): string {
  return JSON.stringify(Object.fromEntries(entries));
}

/** Replace the store now, for the way out, where there is no later to wait for. */
export function writeStoreFileSync(path: string, entries: Entries): void {
  const temporary = temporaryFor(path);
  try {
    const file = openSync(temporary, 'w');
    try {
      writeSync(file, textOf(entries));
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, path);
  } catch (cause) {
    rmSync(temporary, { force: true });
    throw cause;
  }
}

const queues = new Map<string, Promise<void>>();

/** Replace the store after every write already asked for, with `entries` as they are now. */
export function writeStoreFile(path: string, entries: Entries): Promise<void> {
  const text = textOf(entries);
  const before = queues.get(path) ?? Promise.resolve();
  const next = before
    .catch(() => undefined)
    .then(async () => {
      const temporary = temporaryFor(path);
      try {
        const file = await open(temporary, 'w');
        try {
          await file.writeFile(text, 'utf8');
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, path);
      } catch (cause) {
        await rm(temporary, { force: true });
        throw cause;
      }
    });
  queues.set(path, next);
  /* Forgotten once it is the last, so the map holds nothing for a store no longer written. */
  void next
    .catch(() => undefined)
    .then(() => {
      if (queues.get(path) === next) queues.delete(path);
    });
  return next;
}

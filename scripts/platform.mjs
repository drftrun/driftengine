/**
 * Platform APIs a package reaches for directly, instead of taking as a capability.
 *
 * `AGENTS.md` has said since the beginning that **nothing under `packages/` may call a platform
 * API directly when a consumer might want a different one** — persistence goes through a
 * `KeyValueStore` the caller supplies, and the same holds for clocks, network and threads. It was
 * enforced by review, which is to say by memory, and this is the first check ever run against it.
 * Its first run found eleven defects in 91 references across 30 files, every one of which failed in
 * a browser with no native host anywhere near it; `AGENTS.md` records what they were.
 *
 * **The list is what a runtime without a browser does not have, and nothing wider.** `setTimeout`,
 * `queueMicrotask`, `TextEncoder`, `URL`, `Blob`, `AbortController` and `structuredClone` are in
 * every JavaScript runtime that matters, so banning them would be banning JavaScript. The line is
 * drawn at what a runtime without a DOM genuinely lacks, plus the capabilities `AGENTS.md` names
 * by hand.
 *
 * **`performance.now` is deliberately absent and `Date.now` is deliberately present**, which looks
 * backwards until you say what each is for. `performance.now` is a monotonic counter present in
 * browsers, Node, Deno, Bun and workers alike: it is *the* portable way to measure an elapsed
 * duration. `Date.now` is the wall clock, which a user or an NTP step may move, and the audit found
 * two deadlines measured with it — a renderer's boot budget and a physics worker join. Both fail
 * the same way: the clock steps, and the timeout either fires at once or never fires at all. A
 * wall-clock *reading* is legitimate — a save's timestamp, a log line — and that is what the
 * marker is for.
 *
 * **`location` and `screen` are deliberately absent**, and they are the two that taught this gate
 * what it is for. A first draft banned both and reported seventy-seven hits, every one of them
 * false: `location` is where a uniform lives in a shader program, named that by WebGL in eleven
 * render modules, and `screen` is a module `main/ipc.ts` imports from Electron. Both are reachable
 * through a name that *is* banned — `window.location`, `window.screen` — so nothing is lost, and a
 * gate reporting three false alarms for every real one is a gate that gets skimmed.
 */

/**
 * The globals a JavaScript runtime without a browser does not have, grouped by what supplies them.
 *
 * Grouped rather than flat because the group is what a host implements: a native shell writes one
 * input module, not nine exemptions.
 */
export const PLATFORM_GLOBALS = {
  /** The document object model. A runtime with no page has none of it. */
  dom: ['document', 'window', 'navigator', 'matchMedia', 'alert', 'confirm', 'prompt'],
  /** The frame clock. A native host drives its own, and `LoopOptions.frameSource` is the seam. */
  frames: ['requestAnimationFrame', 'cancelAnimationFrame'],
  /** Persistence. `KeyValueStore` is the seam, and `AGENTS.md` names this case by name. */
  storage: ['localStorage', 'sessionStorage', 'indexedDB'],
  /** Network. A host reading from disk supplies its own; `FetchLike` is the shape already in use. */
  network: ['fetch', 'XMLHttpRequest', 'EventSource'],
  /** Threads. A native host has real ones, and the spawn is already a parameter in two places. */
  threads: ['Worker', 'SharedWorker'],
  /** The wall clock. See the header for why this one and not `performance.now`. */
  clock: ['Date.now'],
};

/** Every banned name with the group that explains it, as `[name, group]`. */
const NAMED = Object.entries(PLATFORM_GLOBALS).flatMap(([group, names]) =>
  names.map((name) => [name, group]),
);

/**
 * A free reference to the name, rather than a property or a method of something else.
 *
 * The lookbehind is the whole point. `session.requestAnimationFrame(...)` is an `XRSession`
 * driving the loop, `manifest.window.width` is a field of a manifest, and `this.window.length` is
 * a ring buffer — three hits in three packages that are not platform calls in any sense. A `.`, a
 * word character or a `$` before the name means somebody else owns it.
 *
 * `Worker` and `SharedWorker` are narrowed further to a construction or a feature probe, because
 * every other mention of them is a type annotation — `let pool: Worker` allocates nothing.
 */
function reference(name) {
  if (name.endsWith('Worker')) return new RegExp(String.raw`\b(?:new|typeof)\s+${name}\b`);
  const spelling = name.replace('.', String.raw`\s*\.\s*`);
  return new RegExp(String.raw`(?<![.\w$])${spelling}\b`);
}

/**
 * A local binding by that name, anywhere in the file, including one imported from a module.
 *
 * **What this gives up** is a file that both declares a local `window` and reaches for the
 * browser's. No file does, and a variable shadowing a browser global is worth grepping for on its
 * own account. The import half is not hypothetical: `main/ipc.ts` imports Electron's `screen`.
 */
function shadowed(code, name) {
  if (name.includes('.')) return false;
  const declared = new RegExp(String.raw`\b(?:const|let|var|function|class)\s+${name}\b`);
  const imported = new RegExp(String.raw`\bimport\b[^;]*\b${name}\b[^;]*\bfrom\b`);
  return declared.test(code) || imported.test(code);
}

/**
 * The name is being *declared* here, or is somebody's key, rather than being reached for.
 *
 * Judged per occurrence and not per line, because one line of `loop.ts` contains both:
 * `requestAnimationFrame: (callback) => requestAnimationFrame(callback)` is a key naming the
 * browser default *and* the call that is the default. A line-level test either loses the call or
 * reports the key.
 *
 * Four shapes, every one of them real in this repository:
 *
 * - `readonly window: Float64Array;` and `matchMedia: () => ({ matches: false })` — a typed
 *   property or an object key. A colon straight after the name.
 * - `requestAnimationFrame(callback: (timeMs: number) => void): number;` — an interface member,
 *   recognised by its *first* parameter being typed. The first draft asked whether any colon
 *   appeared before the closing paren, and `fetch(url, { cache: 'no-store' })` silently passed the
 *   gate because of it — the only false negative this file has had, and it was hiding the audit's
 *   headline finding.
 * - `requestAnimationFrame(callback) {` — a method implementation in an object literal.
 * - `cancelAnimationFrame(handle): void;` — a member signature with a return annotation.
 */
function declaration(rest) {
  return (
    /^\s*\??\s*:/.test(rest) ||
    /^\s*\(\s*(?:readonly\s+)?[A-Za-z_$][\w$]*\s*\??\s*:/.test(rest) ||
    /^\s*\([^)]*\)\s*(?::[^=;]*)?\s*\{\s*$/.test(rest) ||
    /^\s*\([^)]*\)\s*:[^=]*;\s*$/.test(rest)
  );
}

/** The escape hatch, which must name a kind and carry a reason after the dash. */
const MARKER = /\/\/\s*platform: [a-z][a-z ]*—\s*\S/;

/**
 * Blank out comments and string literals while preserving every line and column.
 *
 * Lifted from `determinism.mjs`, which needed it for the same reason and learned the string half
 * the hard way: prose about `localStorage` is not a call to it, and this file's own header would
 * otherwise fail the gate it defines.
 */
export function withoutCommentsOrStrings(source) {
  const tokens =
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
  return source.replace(tokens, (match) => match.replace(/[^\n]/g, ' '));
}

/** Every unexempted direct platform call, as `{ line, name, group }`, one-based. */
export function violations(source) {
  const raw = source.split('\n');
  const stripped = withoutCommentsOrStrings(source);
  const code = stripped.split('\n');
  const live = NAMED.filter(([name]) => !shadowed(stripped, name)).map(([name, group]) => ({
    name,
    group,
    re: new RegExp(reference(name).source, 'g'),
  }));
  const found = [];
  for (let i = 0; i < code.length; i++) {
    if (MARKER.test(raw[i - 1] ?? '')) continue;
    const line = code[i] ?? '';
    for (const { name, group, re } of live) {
      re.lastIndex = 0;
      for (let hit = re.exec(line); hit !== null; hit = re.exec(line)) {
        if (declaration(line.slice(hit.index + hit[0].length))) continue;
        found.push({ line: i + 1, name, group });
        break;
      }
    }
  }
  return found;
}

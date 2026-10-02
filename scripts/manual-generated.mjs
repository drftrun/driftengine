/*
 * The manual's generated blocks: text a page carries that is written from the engine's own data, not
 * by hand.
 *
 * A page marks one with `<!-- generated <name> -->` and `<!-- end generated -->` on lines of their
 * own. No colon, so neither the site nor `directivesOf` reads them as a directive: to both they are
 * comments, which a reader never sees.
 * `npm run manual:sync` rewrites what lies between from the generator of that name, and
 * `manual.test.mjs` fails when the two differ, the same bargain a sampled code block makes with its
 * region. A list of every function a script can call is exactly the kind of page that goes stale by
 * hand: the capability file gains a function in one commit and the page learns of it never.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { parseFrontmatter } from './manual.mjs';

const OPEN = /^<!-- generated ([a-z0-9-]+) -->$/;
const CLOSE = '<!-- end generated -->';

/** Every generated block in a page body: its name, and the line range of its contents. */
export function generatedBlocksOf(body) {
  const lines = body.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const open = OPEN.exec(lines[i] ?? '');
    if (open === null) continue;
    const end = lines.indexOf(CLOSE, i + 1);
    if (end < 0) {
      blocks.push({ name: open[1], start: i + 1, end: -1 });
      continue;
    }
    blocks.push({ name: open[1], start: i + 1, end, text: lines.slice(i + 1, end).join('\n') });
    i = end;
  }
  return blocks;
}

/** The pages under `docs/manual`, with each one's title, so a generator can link to them. */
function chaptersByExample(root) {
  const manual = path.join(root, 'docs/manual');
  const runs = new Map();
  for (const section of readdirSync(manual)) {
    const dir = path.join(manual, section);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort()) {
      const text = readFileSync(path.join(dir, file), 'utf8');
      const { data } = parseFrontmatter(text, `${section}/${file}`);
      for (const match of text.matchAll(/<!-- run: ([a-z0-9-]+) -->/g)) {
        const list = runs.get(match[1]) ?? [];
        list.push({ link: `../${section}/${file}`, title: data.title });
        runs.set(match[1], list);
      }
    }
  }
  return runs;
}

/** Which `services` field each module is bound from, read out of `engineImplementations`. */
function servicesByModule(root) {
  const src = path.join(root, 'packages/script/src');
  const names = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
        for (const m of readFileSync(full, 'utf8').matchAll(
          /export const (\w+)_MODULE = '([^']+)'/g,
        ))
          names.set(m[1], m[2]);
      }
    }
  };
  walk(src);
  const host = readFileSync(path.join(src, 'host.ts'), 'utf8');
  const services = new Map();
  for (const m of host.matchAll(
    /if \(services\.(\w+) !== undefined\)\s*\{?\s*map\[(\w+)_MODULE\]/g,
  )) {
    const module = names.get(m[2]);
    if (module !== undefined) services.set(module, m[1]);
  }
  return services;
}

/** The first sentence of a capability's doc, which is what a table row has room for. */
function firstSentence(doc) {
  const flat = String(doc ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const end = flat.search(/\.(\s|$)/);
  return end < 0 ? flat : flat.slice(0, end + 1);
}

const cell = (text) => String(text).replaceAll('|', '\\|');

/** A heading's anchor as the site makes it: GitHub's slug, so `drift/2d` is `#drift2d`. */
const anchorOf = (heading) =>
  heading
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .replace(/\s/g, '-');

/** Every module a script can import, what each holds, and every function in it. */
function scriptReach(root) {
  const all = JSON.parse(
    readFileSync(path.join(root, 'packages/script/capabilities.json'), 'utf8'),
  ).capabilities;
  const grouped = new Map();
  for (const fn of all) {
    const list = grouped.get(fn.module) ?? [];
    list.push(fn);
    grouped.set(fn.module, list);
  }
  /* The language's modules first, then the engine's, each alphabetically. */
  const modules = new Map(
    [...grouped].sort(
      ([a], [b]) =>
        Number(a.startsWith('drift/')) - Number(b.startsWith('drift/')) || a.localeCompare(b),
    ),
  );
  const services = servicesByModule(root);
  const runs = chaptersByExample(root);
  const users = new Map();
  const examples = path.join(root, 'examples');
  for (const dir of readdirSync(examples).sort()) {
    const full = path.join(examples, dir);
    if (!statSync(full).isDirectory()) continue;
    for (const file of readdirSync(full).filter((f) => f.endsWith('.drs'))) {
      const text = readFileSync(path.join(full, file), 'utf8');
      for (const module of modules.keys()) {
        if (!text.includes(`from "${module}"`)) continue;
        const list = users.get(module) ?? new Set();
        list.add(dir);
        users.set(module, list);
      }
    }
  }

  const out = [];
  const total = all.length;
  out.push(
    `${modules.size} modules and ${total} functions, written from \`capabilities.json\` by \`npm run manual:sync\`.`,
  );
  out.push('');
  out.push('| Module | Functions | Deterministic | Bound from |');
  out.push('|---|---|---|---|');
  for (const [module, fns] of modules) {
    const det = fns.filter((f) => f.deterministic).length;
    const from = module.startsWith('std/')
      ? 'the language'
      : services.has(module)
        ? `\`services.${services.get(module)}\``
        : 'arguments';
    out.push(`| [\`${module}\`](#${anchorOf(module)}) | ${fns.length} | ${det} | ${from} |`);
  }
  for (const [module, fns] of modules) {
    out.push('');
    out.push(`### ${module}`);
    out.push('');
    const effects = [...new Set(fns.flatMap((f) => f.effects))].sort();
    const shown = [...(users.get(module) ?? [])].flatMap((example) => runs.get(example) ?? []);
    const unique = [...new Map(shown.map((c) => [c.link, c])).values()].sort((a, b) =>
      a.title.localeCompare(b.title),
    );
    const from = module.startsWith('std/')
      ? 'Part of the language: every script may import it and no host binds it.'
      : services.has(module)
        ? `Bound when the host passes \`services.${services.get(module)}\` to \`bindModule\`; without it, an import of this module is refused at bind with a sentence saying so.`
        : 'Bound always: what each function acts on arrives as an argument the host passes in.';
    out.push(
      `${from} Effects: ${effects.map((e) => `\`${e}\``).join(', ')}.` +
        (unique.length === 0
          ? ''
          : ` Used by ${unique.map((c) => `[${c.title}](${c.link})`).join(', ')}.`),
    );
    out.push('');
    out.push('| Function | Signature | Deterministic | What it does |');
    out.push('|---|---|---|---|');
    for (const fn of fns) {
      out.push(
        `| \`${fn.name}\` | \`${cell(fn.signature)}\` | ${fn.deterministic ? 'yes' : 'no'} | ${cell(firstSentence(fn.doc))} |`,
      );
    }
  }
  return out.join('\n');
}

export const GENERATORS = { 'script-reach': scriptReach };

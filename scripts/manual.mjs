/*
 * The manual, read: its manifest, its pages, and the code its pages show.
 *
 * `docs/manual/` is the consumer's documentation, one Markdown file per page and one manifest that
 * orders them. This module is the only parser of it, and two things import it: this repository's
 * own tests, and the site that renders the manual, which reads it from a checkout beside its own.
 * One parser, so the page a test passed and the page the site publishes are the same page.
 *
 * **Code in a page is never typed into the page.** A `ts` block names a region of a file under
 * `examples/`, and its body has to equal that region. `examples/` is in the typecheck, so every
 * line of TypeScript a reader sees is a line the compiler has accepted, and `npm run manual:sync`
 * rewrites the bodies when a region moves. The Markdown still reads whole on GitHub, which an
 * empty block pointing at a file would not.
 *
 * `node:` builtins only. The documentation workflow runs the tests that import this on a push
 * that changes nothing but Markdown, and the point of that workflow is that it is cheap.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export const MANUAL_DIR = 'docs/manual';
export const EXAMPLES_DIR = 'examples';

/**
 * Fence languages a page may write inline. Everything else that is code comes from a region.
 *
 * `js` is here for a bundler's config, which is the consumer's file and not this engine's. It is
 * the one door code could come in by without a compiler, so `manual.test.mjs` refuses an inline
 * block that imports an engine package: anything that calls the engine is a sample.
 */
export const INLINE_LANGUAGES = new Set(['sh', 'json', 'html', 'css', 'text', 'jsonc', 'js']);

/**
 * Fence languages that must name a region. `drs` is DriftScript: an example's script, which
 * `packages/script/src/examples.test.ts` compiles against the engine's real capabilities.
 */
export const SAMPLED_LANGUAGES = new Set(['ts', 'tsx', 'drs']);

/**
 * Frontmatter, in the subset the manual uses: `key: value` per line, where a value is a string
 * or a list of quoted strings. A YAML parser would accept far more than this and every extra form is one a
 * page could drift into; the subset is small enough to read by eye and strict enough to refuse.
 *
 * @returns {{ data: Record<string, string | string[]>, body: string, bodyLine: number }}
 */
export function parseFrontmatter(text, file = 'page') {
  const normalised = text.replaceAll('\r\n', '\n');
  if (!normalised.startsWith('---\n')) {
    throw new Error(`${file}: a manual page opens with frontmatter between two --- lines`);
  }
  const end = normalised.indexOf('\n---\n', 4);
  if (end === -1) throw new Error(`${file}: the frontmatter is never closed`);

  const data = {};
  const lines = normalised.slice(4, end).split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') continue;
    const match = /^([a-z][a-zA-Z]*):\s*(.*)$/.exec(line);
    if (match === null) throw new Error(`${file}:${index + 2}: not a key: value line: ${line}`);
    const [, key] = match;
    let raw = match[2];
    /* A list too long for one line, which is how Prettier writes one: the key alone, then the
       indented list on the lines after it until its closing bracket. */
    if (raw.trim() === '' && /^\s+\[/.test(lines[index + 1] ?? '')) {
      const parts = [];
      while (index + 1 < lines.length && /^\s/.test(lines[index + 1])) {
        index += 1;
        parts.push(lines[index].trim());
        if (lines[index].trim() === ']') break;
      }
      raw = parts.join(' ').replace(/,\s*\]$/, ']');
    }
    if (key in data) throw new Error(`${file}: ${key} is given twice`);
    if (raw.startsWith('[')) {
      const list = parseList(raw);
      if (list === null) throw new Error(`${file}: ${key} is not a list of quoted strings: ${raw}`);
      data[key] = list;
    } else {
      data[key] = raw.trim();
    }
  }

  const bodyStart = end + 5;
  const bodyLine = normalised.slice(0, bodyStart).split('\n').length;
  return { data, body: normalised.slice(bodyStart), bodyLine };
}

/**
 * A flow list of quoted strings, `['a', "b"]`, or null for anything else.
 *
 * Both quote styles, because Prettier formats frontmatter as YAML and this repository's Prettier
 * prefers single quotes: a list written as JSON comes back from a format pass single-quoted.
 */
function parseList(raw) {
  const match = /^\[(.*)\]$/.exec(raw.trim());
  if (match === null) return null;
  const items = [];
  let rest = match[1].trim();
  while (rest !== '') {
    const item = /^(?:'([^']*)'|"([^"]*)")\s*(?:,\s*|$)/.exec(rest);
    if (item === null) return null;
    items.push(item[1] ?? item[2]);
    rest = rest.slice(item[0].length);
  }
  return items;
}

/**
 * Every fenced block in a page body, with the line it opens on (1-based, within the body).
 *
 * A fence opens with three or more backticks or tildes and closes with at least as many of the
 * same character, which is CommonMark's rule and the one a page that shows a fence inside a fence
 * depends on.
 *
 * @returns {{ lang: string, info: string, sample: string | null, code: string, line: number }[]}
 */
export function fencesOf(body) {
  const lines = body.split('\n');
  const found = [];
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (open === null) continue;
    const [, , marker, rest] = open;
    const info = rest.trim();
    const closing = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`);
    let close = i + 1;
    while (close < lines.length && !closing.test(lines[close])) close += 1;
    const [lang = ''] = info.split(/\s+/);
    const sample = /(?:^|\s)sample=(\S+)/.exec(info)?.[1] ?? null;
    found.push({
      lang,
      info,
      sample,
      code: lines.slice(i + 1, close).join('\n'),
      line: i + 1,
      /* Lines between the fences. Not derivable from `code`: an empty block and one holding a
         single blank line both read as '', and only one of them has a line to replace. */
      length: close - i - 1,
    });
    i = close;
  }
  return found;
}

/** The body with every fence blanked to empty lines, so line numbers still agree. */
export function proseOf(body) {
  const lines = body.split('\n');
  for (const fence of fencesOf(body)) {
    for (let i = fence.line - 1; i <= fence.line + fence.length; i += 1) {
      if (i < lines.length) lines[i] = '';
    }
  }
  /* A generated block is written from the engine's data, so what it names is checked against that
     data where it is generated: a script's enum and its variants are names no package exports. */
  let generated = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^<!-- generated [a-z0-9-]+ -->$/.test(lines[i] ?? '')) generated = true;
    else if (lines[i] === '<!-- end generated -->') generated = false;
    else if (generated) lines[i] = '';
  }
  return lines.join('\n');
}

const REGION_OPEN = /^\s*\/\/\s*#region\s+([A-Za-z0-9-]+)\s*$/;
const REGION_CLOSE = /^\s*\/\/\s*#endregion\b.*$/;

/**
 * Every named region of a source file, dedented, with the marker lines of nested regions left out.
 *
 * `// #region name` and `// #endregion` are the markers editors already fold on, so a sample file
 * reads normally in an editor and the markers cost nothing to leave in.
 *
 * @returns {Map<string, string>}
 */
export function regionsOf(source) {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  const open = [];
  const collected = new Map();
  for (const line of lines) {
    const opening = REGION_OPEN.exec(line);
    if (opening !== null) {
      if (collected.has(opening[1])) throw new Error(`region ${opening[1]} is declared twice`);
      collected.set(opening[1], []);
      open.push(opening[1]);
      continue;
    }
    if (REGION_CLOSE.test(line)) {
      if (open.length === 0) throw new Error('an #endregion closes nothing');
      open.pop();
      continue;
    }
    for (const name of open) collected.get(name).push(line);
  }
  if (open.length > 0) throw new Error(`region ${open.at(-1)} is never closed`);

  const regions = new Map();
  for (const [name, body] of collected) regions.set(name, dedent(trimBlank(body)).join('\n'));
  return regions;
}

/** A source file as a reader should see it whole: the region markers removed. */
export function withoutRegionMarkers(source) {
  return source
    .replaceAll('\r\n', '\n')
    .split('\n')
    .filter((line) => !REGION_OPEN.test(line) && !REGION_CLOSE.test(line))
    .join('\n');
}

function trimBlank(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start += 1;
  while (end > start && lines[end - 1].trim() === '') end -= 1;
  return lines.slice(start, end);
}

function dedent(lines) {
  const indents = lines
    .filter((line) => line.trim() !== '')
    .map((line) => /^ */.exec(line)[0].length);
  const common = indents.length === 0 ? 0 : Math.min(...indents);
  return lines.map((line) => line.slice(common));
}

/** `sample=dir/file.ts#region`, or `.tsx`, or a DriftScript `.drs`, split. */
export function parseSample(reference) {
  const match = /^([A-Za-z0-9_./-]+\.(?:tsx?|drs))#([A-Za-z0-9-]+)$/.exec(reference);
  if (match === null) return null;
  return { file: match[1], region: match[2] };
}

/**
 * What a page asks the site to place, as HTML comments so GitHub shows nothing in their place.
 *
 * `run: <slug>` places a runnable example. `packages` places the table of every package with its
 * own description, which is generated because a hand-written copy of twenty-three descriptions is
 * twenty-three sentences that drift. `sizes` places the gzipped cost of each entry point, read from
 * `scripts/size-floors.mjs`, which the size gate holds within 3% of a real build.
 */
export const DIRECTIVES = { run: 'slug', packages: null, sizes: null };

/** Every directive in a body, recognised or not, so a typo is reported and not ignored. */
export function directivesOf(body) {
  const found = [];
  for (const [index, line] of body.split('\n').entries()) {
    const match = /^<!--\s*([a-z-]+)(?::\s*([a-z0-9-]+))?\s*-->$/.exec(line.trim());
    if (match !== null) found.push({ name: match[1], arg: match[2] ?? null, line: index + 1 });
  }
  return found;
}

/** `<!-- run: slug -->` directives, which place a runnable example. */
export function runDirectives(body) {
  return directivesOf(body)
    .filter((directive) => directive.name === 'run' && directive.arg !== null)
    .map((directive) => ({ slug: directive.arg, line: directive.line }));
}

/**
 * Backticked names in prose that claim to be part of the API.
 *
 * Three shapes are claims, and the rest are not checked:
 *
 * - a PascalCase name with a lower-case letter in it, `PhysicsWorld`, which is how this engine
 *   names every class, interface and type, and is never how prose spells an ordinary word;
 * - an UPPER_SNAKE name with an underscore, `REVERSED_DEPTH`, the engine's constants;
 * - `Type.member`, whose type part is checked here and whose member part the site checks against
 *   the full reference.
 *
 * Bare camelCase in backticks is an option field or a parameter as often as it is an export, so
 * it is not a claim and is not checked. Neither is a `KeyboardEvent.code` value, `KeyW` or
 * `ArrowUp`, which is PascalCase and is the browser's name for a key.
 */
const KEY_CODE =
  /^(?:Key[A-Z]|Digit[0-9]|Numpad\w+|Arrow(?:Up|Down|Left|Right)|F[0-9]{1,2}|Shift(?:Left|Right)|Control(?:Left|Right)|Alt(?:Left|Right)|Meta(?:Left|Right)|Space|Enter|Escape|Tab|Backspace)$/;

export function symbolMentions(body) {
  const prose = proseOf(body);
  const found = [];
  for (const [index, line] of prose.split('\n').entries()) {
    for (const match of line.matchAll(/`([^`\n]+)`/g)) {
      const token = match[1].replace(/\(\)$/, '');
      const member = /^([A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*)\.([A-Za-z_$][\w$]*)$/.exec(token);
      if (member !== null) {
        found.push({ name: member[1], member: member[2], line: index + 1 });
        continue;
      }
      if (KEY_CODE.test(token)) continue;
      if (
        /^[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*$/.test(token) ||
        /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(token)
      ) {
        found.push({ name: token, member: null, line: index + 1 });
      }
    }
  }
  return found;
}

/**
 * Every name a consumer can import, and the packages that export it.
 *
 * Read from the barrels' text, the same way `docs.test.mjs` reads them to check a printed import,
 * plus `export * from '@driftengine/<pkg>'`, which is how core hands over the whole of physics.
 *
 * @returns {Map<string, string[]>}
 */
export function barrelNames(root) {
  const packagesDir = path.join(root, 'packages');
  const own = new Map();
  const stars = new Map();
  for (const pkg of readdirSync(packagesDir)) {
    const barrel = path.join(packagesDir, pkg, 'src', 'index.ts');
    if (!existsSync(barrel)) continue;
    const text = readFileSync(barrel, 'utf8');
    const names = new Set();
    for (const block of text.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
      for (const part of block[1].split(',')) {
        const name = part
          .replace(/\/\/.*$/gm, '')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)
          .pop()
          ?.trim();
        if (name) names.add(name);
      }
    }
    for (const declared of text.matchAll(
      /export\s+(?:declare\s+)?(?:abstract\s+)?(?:const|let|function|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/g,
    )) {
      names.add(declared[1]);
    }
    own.set(pkg, names);
    stars.set(
      pkg,
      [...text.matchAll(/export\s+\*\s+from\s+'@driftengine\/([a-z0-9-]+)'/g)].map((m) => m[1]),
    );
  }

  const result = new Map();
  const add = (name, pkg) => {
    const list = result.get(name) ?? [];
    if (!list.includes(pkg)) list.push(pkg);
    result.set(name, list);
  };
  for (const [pkg, names] of own) {
    for (const name of names) add(name, pkg);
    for (const star of stars.get(pkg)) for (const name of own.get(star) ?? []) add(name, pkg);
  }
  return result;
}

/** The Area cell of every row in `CAPABILITIES.md` §1, in order. */
export function capabilityAreas(root) {
  const text = readFileSync(path.join(root, 'docs', 'CAPABILITIES.md'), 'utf8');
  const start = text.indexOf('## 1. What ships');
  const end = text.indexOf('\n## ', start + 1);
  if (start === -1 || end === -1)
    throw new Error('CAPABILITIES.md has no "## 1. What ships" section');
  const areas = [];
  for (const line of text.slice(start, end).split('\n')) {
    const match = /^\|\s*([^|]+?)\s*\|/.exec(line);
    if (match === null) continue;
    const cell = match[1];
    if (cell === 'Area' || /^-+$/.test(cell)) continue;
    areas.push(cell);
  }
  return areas;
}

/** The packages a page may name, which are the directories under `packages/`. */
export function packageNames(root) {
  return readdirSync(path.join(root, 'packages'))
    .filter((entry) => existsSync(path.join(root, 'packages', entry, 'package.json')))
    .map(
      (entry) =>
        JSON.parse(readFileSync(path.join(root, 'packages', entry, 'package.json'), 'utf8')).name,
    );
}

/**
 * The whole manual, in manifest order.
 *
 * Throws on anything it cannot read at all; what it can read and is merely wrong is left for the
 * tests to report, all of it at once.
 */
export function readManual(root) {
  const dir = path.join(root, MANUAL_DIR);
  const manifest = JSON.parse(readFileSync(path.join(dir, 'manual.json'), 'utf8'));
  const sections = manifest.sections.map((section) => ({
    id: section.id,
    title: section.title,
    blurb: section.blurb,
    pages: section.pages.map((slug) => {
      const relative = path.join(MANUAL_DIR, section.id, `${slug}.md`);
      const file = path.join(root, relative);
      if (!existsSync(file)) return { slug, relative, missing: true };
      const { data, body, bodyLine } = parseFrontmatter(readFileSync(file, 'utf8'), relative);
      return {
        slug,
        relative,
        missing: false,
        title: data.title ?? '',
        description: data.description ?? '',
        packages: data.packages ?? [],
        areas: data.areas ?? [],
        covers: data.covers ?? [],
        plain: data.plain ?? [],
        frontmatter: data,
        body,
        bodyLine,
      };
    }),
  }));
  return { sections };
}

/** Every `.md` file under the manual's section directories, relative to the root. */
export function manualFiles(root) {
  const dir = path.join(root, MANUAL_DIR);
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    for (const file of readdirSync(full)) {
      if (file.endsWith('.md')) found.push(path.join(MANUAL_DIR, entry, file));
    }
  }
  return found.sort();
}

/** The region a sample reference names, or a reason it names none. */
export function resolveSample(root, reference) {
  const parsed = parseSample(reference);
  if (parsed === null) return { error: `sample=${reference} is not dir/file.ts#region` };
  const file = path.join(root, EXAMPLES_DIR, parsed.file);
  if (!existsSync(file))
    return { error: `sample=${reference}: ${EXAMPLES_DIR}/${parsed.file} does not exist` };
  let regions;
  try {
    regions = regionsOf(readFileSync(file, 'utf8'));
  } catch (error) {
    return { error: `sample=${reference}: ${error.message}` };
  }
  if (!regions.has(parsed.region)) {
    return {
      error: `sample=${reference}: ${EXAMPLES_DIR}/${parsed.file} has no region ${parsed.region}`,
    };
  }
  return { code: regions.get(parsed.region) };
}

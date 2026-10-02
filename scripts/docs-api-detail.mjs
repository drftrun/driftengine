/*
 * The detail a reference page needs beyond a signature and a summary: members, parameters, and
 * the whole comment.
 *
 * `docs-api.mjs` reads the declaration output a line at a time, which is enough for one signature
 * per export and is what its tests hold. A class is more than its first line, though: a reader
 * looking up `SceneNode` wants `setPosition`, and a reader looking up `createRenderer` wants to
 * know what the third argument is. This reads the same declaration files with a little more
 * structure, from the same emitter, so no implementation can reach it either.
 *
 * **Why not the compiler's own API.** This repository builds with TypeScript 7, which ships the
 * native compiler and no JavaScript API to parse with, and a second TypeScript installed only to
 * walk declaration files would be a large dependency for a job `tsc`'s regular output makes small.
 * What it gives up: a declaration shape the emitter has never produced here, such as a member
 * whose type spans lines with an unbalanced bracket in a string literal type, would be read wrongly.
 * The tests below hold the shapes it does produce.
 */

/** A comment's text with the `*` gutter removed, its tags separated out. */
export function parseDoc(lines) {
  const text = [];
  const params = {};
  let returns = '';
  let deprecated = null;
  let tag = null;
  for (const raw of lines) {
    const line = raw.replace(/^\s*\*\s?/, '').replace(/\s*\*\/\s*$/, '');
    const opened = /^@(\w+)\s*(.*)$/.exec(line.trim());
    if (opened !== null) {
      const [, name, rest] = opened;
      if (name === 'param') {
        const param = /^(?:\{[^}]*\}\s*)?\[?([\w$.]+)(?:=[^\]]*)?\]?\s*(?:-\s*)?(.*)$/.exec(rest);
        tag = { kind: 'param', name: param?.[1] ?? rest, text: [param?.[2] ?? ''] };
        params[tag.name] = tag.text;
      } else if (name === 'returns' || name === 'return') {
        tag = { kind: 'returns', text: [rest] };
        returns = tag.text;
      } else if (name === 'deprecated') {
        tag = { kind: 'deprecated', text: [rest] };
        deprecated = tag.text;
      } else {
        tag = { kind: 'other', text: [] };
      }
      continue;
    }
    if (tag !== null) tag.text.push(line);
    else text.push(line);
  }
  const join = (parts) => (Array.isArray(parts) ? parts.join('\n').trim() : parts);
  return {
    text: text.join('\n').trim(),
    params: Object.fromEntries(Object.entries(params).map(([name, value]) => [name, join(value)])),
    returns: join(returns),
    deprecated: deprecated === null ? null : join(deprecated),
  };
}

/** Bracket depth over (), [] and {}. Angle brackets are left out: `=>` would unbalance them. */
function depthChange(text) {
  let depth = 0;
  for (const char of text) {
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
  }
  return depth;
}

/** Split at commas that are not inside any bracket, angle brackets included. */
export function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if ('([{<'.includes(char)) depth += 1;
    else if (')]}'.includes(char) || (char === '>' && text[i - 1] !== '=')) depth -= 1;
    else if (char === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last !== '') parts.push(last);
  return parts;
}

/** The parameter list of a call signature, as `{ name, type, optional, rest }`. */
export function parametersOf(signature) {
  let i = signature.indexOf('(');
  // Generic parameters before the list, `<T extends (a: number) => void>(`, are skipped whole.
  const angle = signature.indexOf('<');
  if (angle !== -1 && angle < i) {
    let depth = 0;
    for (let j = angle; j < signature.length; j += 1) {
      if (signature[j] === '<') depth += 1;
      else if (signature[j] === '>' && signature[j - 1] !== '=') depth -= 1;
      if (depth === 0) {
        i = signature.indexOf('(', j);
        break;
      }
    }
  }
  if (i === -1) return [];
  let depth = 0;
  let end = i;
  for (let j = i; j < signature.length; j += 1) {
    if (signature[j] === '(') depth += 1;
    else if (signature[j] === ')') depth -= 1;
    if (depth === 0) {
      end = j;
      break;
    }
  }
  return splitTopLevel(signature.slice(i + 1, end)).map((part) => {
    const match = /^(\.\.\.)?([\w$]+|\{[^}]*\}|\[[^\]]*\])(\?)?\s*:\s*([\s\S]+)$/.exec(part);
    if (match === null) return { name: part, type: '', optional: false, rest: false };
    return {
      name: match[2],
      type: match[4].trim(),
      optional: match[3] === '?',
      rest: match[1] === '...',
    };
  });
}

const MODIFIERS = /^(?:(?:static|readonly|abstract|public|override|declare)\s+)*/;

/** What one member line declares, or null for one a reader cannot reach. */
export function classifyMember(text) {
  const flat = text.replace(/\s+/g, ' ').replace(/;$/, '').trim();
  if (/^(?:private|protected)\b/.test(flat) || flat.startsWith('#')) return null;
  const modifiers = MODIFIERS.exec(flat)[0];
  const body = flat.slice(modifiers.length);
  const isStatic = /\bstatic\b/.test(modifiers);
  const readonly = /\breadonly\b/.test(modifiers);

  let match = /^(get|set)\s+([\w$]+)\s*\(/.exec(body);
  if (match !== null)
    return {
      name: match[2],
      kind: match[1] === 'get' ? 'getter' : 'setter',
      signature: flat,
      isStatic,
      readonly,
    };
  if (/^constructor\s*\(/.test(body))
    return {
      name: 'constructor',
      kind: 'constructor',
      signature: flat,
      isStatic: false,
      readonly: false,
    };
  match = /^([\w$]+)(\?)?\s*(?:<[^(]*>)?\s*\(/.exec(body);
  if (match !== null)
    return {
      name: match[1],
      kind: 'method',
      signature: flat,
      isStatic,
      readonly,
      optional: match[2] === '?',
    };
  match = /^([\w$]+)(\?)?\s*:/.exec(body);
  if (match !== null)
    return {
      name: match[1],
      kind: 'property',
      signature: flat,
      isStatic,
      readonly,
      optional: match[2] === '?',
    };
  return { name: body, kind: 'signature', signature: flat, isStatic, readonly };
}

const DECLARATION =
  /^export (?:declare )?(?:abstract )?(function|class|interface|type|enum|const|let|var) ([A-Za-z_$][\w$]*)/;

/**
 * Every exported declaration's detail, keyed by name.
 *
 * @returns {Map<string, {
 *   doc: ReturnType<typeof parseDoc>,
 *   overloads: string[],
 *   parameters: ReturnType<typeof parametersOf>,
 *   members: (ReturnType<typeof classifyMember> & { doc: ReturnType<typeof parseDoc> })[],
 * }>}
 */
export function describeDeclarations(source) {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  const out = new Map();
  let doc = [];
  let inDoc = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!inDoc && trimmed.startsWith('/**')) {
      doc = [trimmed.slice(3)];
      inDoc = !trimmed.endsWith('*/');
      if (!inDoc) doc = [trimmed.slice(3, -2)];
      continue;
    }
    if (inDoc) {
      if (trimmed.endsWith('*/')) {
        inDoc = false;
        doc.push(trimmed.slice(0, -2));
      } else doc.push(trimmed);
      continue;
    }

    const match = DECLARATION.exec(trimmed);
    if (match === null) {
      if (trimmed !== '') doc = [];
      continue;
    }
    const [, keyword, name] = match;

    // The declaration's own text, to its end: the matching brace for a body, a `;` otherwise.
    let text = trimmed;
    let depth = depthChange(trimmed);
    let j = i;
    const opensBody =
      (keyword === 'class' || keyword === 'interface' || keyword === 'enum') && depth > 0;
    while (
      j + 1 < lines.length &&
      (depth > 0 || (!opensBody && !text.trimEnd().endsWith(';') && !text.trimEnd().endsWith('}')))
    ) {
      j += 1;
      text += `\n${lines[j]}`;
      depth += depthChange(lines[j]);
    }

    const entry = out.get(name) ?? {
      doc: parseDoc([]),
      overloads: [],
      parameters: [],
      members: [],
    };
    const parsed = parseDoc(doc);
    if (parsed.text !== '' || Object.keys(parsed.params).length > 0) entry.doc = parsed;

    if (keyword === 'function') {
      const signature = text
        .replace(/\s+/g, ' ')
        .replace(/;$/, '')
        .replace(/^export (?:declare )?/, '');
      entry.overloads.push(signature);
      if (entry.parameters.length === 0) entry.parameters = parametersOf(signature);
    }

    if (opensBody && keyword !== 'enum') entry.members = membersOf(lines.slice(i + 1, j));

    out.set(name, entry);
    doc = [];
    i = j;
  }
  return out;
}

/** The members of a class or interface body, one level deep. */
function membersOf(body) {
  const members = [];
  let doc = [];
  let inDoc = false;
  for (let i = 0; i < body.length; i += 1) {
    const trimmed = body[i].trim();
    if (!inDoc && trimmed.startsWith('/**')) {
      inDoc = !trimmed.endsWith('*/');
      doc = [inDoc ? trimmed.slice(3) : trimmed.slice(3, -2)];
      continue;
    }
    if (inDoc) {
      if (trimmed.endsWith('*/')) {
        inDoc = false;
        doc.push(trimmed.slice(0, -2));
      } else doc.push(trimmed);
      continue;
    }
    if (trimmed === '' || trimmed.startsWith('//')) continue;

    let text = trimmed;
    let depth = depthChange(trimmed);
    while (i + 1 < body.length && (depth > 0 || !text.trimEnd().endsWith(';'))) {
      i += 1;
      text += `\n${body[i]}`;
      depth += depthChange(body[i]);
    }
    const member = classifyMember(text);
    if (member !== null) {
      const parameters =
        member.kind === 'method' || member.kind === 'constructor'
          ? parametersOf(member.signature)
          : [];
      members.push({ ...member, parameters, doc: parseDoc(doc) });
    }
    doc = [];
  }
  return members;
}

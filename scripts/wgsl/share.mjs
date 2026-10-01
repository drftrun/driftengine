/**
 * The generated WGSL, stored once per distinct item rather than once per permutation.
 *
 * **Sixteen permutations of one shader are mostly the same functions**, and they were stored
 * whole, each a string of a hundred kilobytes: gzip's window is thirty-two, so nothing one
 * permutation shared with the next was found, and every line of the lit shader was paid sixteen
 * times in every consumer's bundle. The functions were not even textually alike: naga names its
 * expression temporaries `_e272` by their place in the whole module, so one GLSL function came out
 * as sixteen different texts.
 *
 * So each shader is cut into its top-level items, each item's temporaries are renumbered from zero
 * in the order they first appear — a name local to one function, so renaming it consistently within
 * that function changes nothing a device sees — and every distinct item is stored once, each
 * permutation a list of indices. `wgsl.ts` validates every reassembled shader with naga before it
 * writes one.
 *
 * What it gives up: the text a device receives is naga's with its temporaries renamed, so a line
 * quoted from a device's error names `_e12` where naga's own output said `_e1041`.
 */

/**
 * The top-level items of a WGSL module, in order: split at blank lines, a piece that begins
 * indented or with a closing brace joined back to the one before it, so no function is ever cut.
 */
export function splitItems(wgsl) {
  const items = [];
  for (const piece of wgsl.split('\n\n')) {
    if (items.length > 0 && (/^[ \t}]/.test(piece) || piece === '')) {
      items[items.length - 1] += `\n\n${piece}`;
    } else {
      items.push(piece);
    }
  }
  return items;
}

/**
 * One item with its function-local names renumbered: naga's expression temporaries `_e0`, `_e1`, …
 * and, in a function, its parameters and its `var` and `let` names `_l0`, `_l1`, … in the order
 * they are declared. naga keeps every name unique across the whole module by a numeric suffix, so
 * one function's parameter was `p_4` in one permutation and `p_5` in the next; local to the function,
 * renaming it consistently within it changes nothing a device sees, and `_l` is a prefix naga does
 * not emit.
 */
export function renumber(item) {
  const temporaries = new Map();
  let out = item.replace(/\b_e\d+\b/g, (name) => {
    if (!temporaries.has(name)) temporaries.set(name, `_e${temporaries.size}`);
    return temporaries.get(name);
  });
  if (!out.startsWith('fn ')) return out;
  const open = out.indexOf('{');
  const declared = [];
  for (const match of out.slice(0, open).matchAll(/[(,]\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) {
    declared.push(match[1]);
  }
  for (const match of out.slice(open).matchAll(/\b(?:var|let)\s+([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
    declared.push(match[1]);
  }
  const locals = new Map();
  for (const name of declared) {
    if (/^_e\d+$/.test(name) || locals.has(name)) continue;
    locals.set(name, `_l${locals.size}`);
  }
  if (locals.size === 0) return out;
  const pattern = new RegExp(`(?<![\\w.])(${[...locals.keys()].join('|')})(?!\\w)`, 'g');
  out = out.replace(pattern, (name) => locals.get(name));
  return out;
}

/**
 * Every shader in `shaders` (key to WGSL) as indices into one list of distinct items, and each
 * shader as it will be reassembled — renumbered, joined back with the blank lines it was cut at.
 */
export function shareItems(shaders) {
  const parts = [];
  const at = new Map();
  const index = {};
  const rebuilt = {};
  for (const [key, wgsl] of Object.entries(shaders)) {
    const mine = [];
    for (const item of splitItems(wgsl).map(renumber)) {
      if (!at.has(item)) {
        at.set(item, parts.length);
        parts.push(item);
      }
      mine.push(at.get(item));
    }
    index[key] = mine;
    rebuilt[key] = mine.map((i) => parts[i]).join('\n\n');
  }
  return { parts, index, rebuilt };
}

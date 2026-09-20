/**
 * CLIP's merges as the pairs of token ids a converted file carries, checked against the vocabulary
 * the upstream ships beside them.
 *
 * **The vocabulary is implied by the merges**, which is why the file carries only these: byte b is
 * written as GPT-2's printable stand-in for it and is token b's place in GPT-2's order — printable
 * bytes first — the same byte at a word's end is 256 further on, the merge of rank r is token
 * 512 + r, and the start and end of text follow the last merge. **So `vocab.json` is not trusted
 * but checked**: every token the merges make must be the id it holds, nothing else may be in it, and
 * a difference is refused by the token that disagrees — a vocabulary that is not CLIP's shape would
 * otherwise tokenize into ids the text model was never trained on, and answer anyway.
 */

const printable = (b: number): boolean =>
  (b >= 33 && b <= 126) || (b >= 161 && b <= 172) || (b >= 174 && b <= 255);

/** `[merges, 2]` token ids, in rank order, from `merges.txt` and `vocab.json`'s object. */
export function clipMerges(
  merges: string,
  vocabulary: Readonly<Record<string, number>>,
): Float32Array {
  const ids = new Map<string, number>();
  let unprintable = 0;
  const stand = new Map<number, string>();
  for (let b = 0; b < 256; b += 1) {
    stand.set(b, String.fromCodePoint(printable(b) ? b : 256 + unprintable++));
  }
  const order = [...stand.keys()]
    .filter(printable)
    .concat([...stand.keys()].filter((b) => !printable(b)));
  order.forEach((b, i) => {
    ids.set(stand.get(b) as string, i);
    ids.set(`${stand.get(b)}</w>`, 256 + i);
  });

  const lines = merges
    .split('\n')
    .filter((line) => line.length > 0 && !line.startsWith('#version'));
  const out = new Float32Array(lines.length * 2);
  lines.forEach((line, rank) => {
    const [left, right] = line.split(' ') as [string, string];
    for (const [side, at] of [
      [left, 0],
      [right, 1],
    ] as const) {
      const id = ids.get(side);
      if (id === undefined) throw new Error(`"${side}" in merge ${rank} is no token before it`);
      out[2 * rank + at] = id;
    }
    ids.set(left + right, 512 + rank);
  });
  ids.set('<|startoftext|>', 512 + lines.length);
  ids.set('<|endoftext|>', 513 + lines.length);

  for (const [token, id] of ids) {
    if (vocabulary[token] === undefined) throw new Error(`the vocabulary has no "${token}"`);
    if (vocabulary[token] !== id) {
      throw new Error(
        `"${token}" is ${vocabulary[token]} in the vocabulary and the merges make it ${id}`,
      );
    }
  }
  const size = Object.keys(vocabulary).length;
  if (size !== ids.size) {
    throw new Error(`the vocabulary has ${size} tokens and the merges imply ${ids.size}`);
  }
  return out;
}

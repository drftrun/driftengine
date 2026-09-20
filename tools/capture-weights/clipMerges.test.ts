import { expect, test } from 'vitest';

import { clipMerges } from './clipMerges.ts';

/**
 * **CLIP's vocabulary is implied by its merges, and the conversion checks it rather than trusting
 * it.** Byte b's symbol is GPT-2's printable stand-in for it — `a` is itself, a space is `Ġ` — and
 * its token its place in GPT-2's order, 256 further on at a word's end; the merge of rank r is
 * token 512 + r; the two specials follow. `c` is 66, `a` 64 and `t</w>` 339, as the tokenizer's
 * own test works out by hand.
 */

const base = (): Record<string, number> => {
  const printable = (b: number): boolean =>
    (b >= 33 && b <= 126) || (b >= 161 && b <= 172) || (b >= 174 && b <= 255);
  const vocabulary: Record<string, number> = {};
  const order = [...Array(256).keys()].filter(printable);
  let extra = 0;
  const symbol = new Map<number, string>();
  for (let b = 0; b < 256; b += 1)
    symbol.set(b, String.fromCodePoint(printable(b) ? b : 256 + extra++));
  order.push(...[...Array(256).keys()].filter((b) => !printable(b)));
  order.forEach((b, i) => {
    vocabulary[symbol.get(b) as string] = i;
    vocabulary[`${symbol.get(b)}</w>`] = 256 + i;
  });
  return vocabulary;
};

test('THE MERGES BECOME PAIRS OF TOKEN IDS, each merge the token after the last', () => {
  const vocabulary = {
    ...base(),
    ca: 512,
    'cat</w>': 513,
    '<|startoftext|>': 514,
    '<|endoftext|>': 515,
  };
  const merges = clipMerges('#version: 0.2\nc a\nca t</w>\n', vocabulary);
  expect(Array.from(merges)).toEqual([66, 64, 512, 339]);
  /* A space's stand-in is Ġ, the 33rd of the unprintable, so 188 + 32. */
  const spaced = clipMerges('Ġ a</w>\n', {
    ...base(),
    'Ġa</w>': 512,
    '<|startoftext|>': 513,
    '<|endoftext|>': 514,
  });
  expect(Array.from(spaced)).toEqual([220, 320]);
});

test('a vocabulary its merges do not imply is refused, by the token that disagrees', () => {
  const wrong = { ...base(), ca: 600, '<|startoftext|>': 513, '<|endoftext|>': 514 };
  expect(() => clipMerges('c a\n', wrong)).toThrow(
    /"ca" is 600 in the vocabulary and the merges make it 512/,
  );
  const missing = { ...base(), ca: 512, '<|startoftext|>': 513 };
  expect(() => clipMerges('c a\n', missing)).toThrow(/<\|endoftext\|>/);
  const extraToken = { ...base(), ca: 512, '<|startoftext|>': 513, '<|endoftext|>': 514, zz: 600 };
  expect(() => clipMerges('c a\n', extraToken)).toThrow(/516 tokens and the merges imply 515/);
  expect(() => clipMerges('c q9\n', { ...base() })).toThrow(
    /"q9" in merge 0 is no token before it/,
  );
});

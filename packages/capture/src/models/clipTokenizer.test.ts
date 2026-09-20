import { expect, test } from 'vitest';

import { clipTokenizer, owlv2Tokens } from './clipTokenizer.ts';

/**
 * **CLIP's tokenizer, on a vocabulary small enough to work by hand.** A byte's token is its place
 * in GPT-2's order — the printable bytes 33–126, 161–172 and 174–255 first, then the rest in order —
 * the same byte ending a word is 256 further on, and merge r makes token 512 + r. So `a` is 64,
 * `c` 66, `t` 83, `t` ending a word 339, and with the three merges below, `<|startoftext|>` is 515
 * and `<|endoftext|>` 516. The real vocabulary's agreement with Transformers' own tokenizer is the
 * hand-run parity's (`tools/capture-weights/reference/owlv2_parity.py`).
 */

/* c+a → 512, then ca+t</w> → 513, then a+t</w> → 514: "cat" is one token, "at" another. */
const MERGES = Float32Array.of(66, 64, 512, 339, 64, 339);

test('A WORD IS ITS BYTES MERGED LOWEST RANK FIRST, between the start and end of text', () => {
  const tokenizer = clipTokenizer(MERGES);
  expect(tokenizer.encode('cat')).toEqual([515, 513, 516]);
  /* t·a·t</w>: t+a has no merge and a+t</w> has, so "t" and "at". */
  expect(tokenizer.encode('tat')).toEqual([515, 83, 514, 516]);
  /* Lowercased, its spaces made one, split into words: "cat", "a" (a</w> = 320), "cat". */
  expect(tokenizer.encode('  Cat \n a   CAT ')).toEqual([515, 513, 320, 513, 516]);
  expect(tokenizer.encode('')).toEqual([515, 516]);
});

test('the lowest rank merges first wherever it is, and among equals the leftmost', () => {
  /* a+t</w> ranked before c+a: "cat" is c, at</w> — the merge further right wins by rank. */
  const byRank = clipTokenizer(Float32Array.of(64, 339, 66, 64));
  expect(byRank.encode('cat')).toEqual([514, 66, 512, 515]);
  /* a+a is the only merge: "aaaa" is aa, a, a</w> — the left pair first — not a, aa, a</w>. */
  const leftmost = clipTokenizer(Float32Array.of(64, 64));
  expect(leftmost.encode('aaaa')).toEqual([513, 512, 64, 320, 514]);
  /* a+b listed first and last: its rank is the last, as the upstream's map keeps it, so b+c</w> wins. */
  const twice = clipTokenizer(Float32Array.of(64, 65, 65, 322, 64, 65));
  expect(twice.encode('abc')).toEqual([515, 64, 513, 516]);
});

test('digits are words of one, punctuation runs are words, and a contraction is its own', () => {
  const tokenizer = clipTokenizer(MERGES);
  /* 1 and 2 end their words: 16 + 256 and 17 + 256. */
  expect(tokenizer.encode('12')).toEqual([515, 272, 273, 516]);
  /* "it" is i (72), t</w> (339); "'s" is ' (6) and s</w> (338). */
  expect(tokenizer.encode("It's")).toEqual([515, 72, 339, 6, 338, 516]);
  /* A comma and a full stop run together into one word: , (11) and .</w> (13 + 256). */
  expect(tokenizer.encode(',.')).toEqual([515, 11, 269, 516]);
});

test('text is composed before it is split into bytes, and a byte outside the printable set has a token', () => {
  const tokenizer = clipTokenizer(MERGES);
  /* e and a combining acute compose to é, bytes C3 A9: 127, and 102 + 256. */
  expect(tokenizer.encode('é')).toEqual([515, 127, 358, 516]);
  /* A soft hyphen is bytes C2 AD, and AD is the last of the unprintable: 126, and 255 + 256. */
  expect(tokenizer.encode('­')).toEqual([515, 126, 511, 516]);
});

test('THE ADDED TOKENS ARE TAKEN OUT OF THE TEXT FIRST: "!" is the padding token, 0, wherever it is', () => {
  const tokenizer = clipTokenizer(MERGES);
  expect(tokenizer.encode('cat!')).toEqual([515, 513, 0, 516]);
  expect(tokenizer.encode('cat<|endoftext|>cat')).toEqual([515, 513, 516, 513, 516]);
  /* The start token is matched after lowercasing, which is how the upstream matches it. */
  expect(tokenizer.encode('<|StartOfText|>cat')).toEqual([515, 515, 513, 516]);
});

test('OWLv2 queries are padded to their positions with zeros, each ending where its end token is', () => {
  const tokenizer = clipTokenizer(MERGES);
  const { tokens, ends } = owlv2Tokens(tokenizer, ['cat', 'tat', ''], 5);
  expect(Array.from(tokens)).toEqual([
    515, 513, 516, 0, 0, 515, 83, 514, 516, 0, 515, 516, 0, 0, 0,
  ]);
  /* Rows of all three queries' positions in one list: 0·5 + 2, 1·5 + 3, 2·5 + 1. */
  expect(Array.from(ends)).toEqual([2, 8, 11]);
  /* Two ends of text: the upstream's argmax takes the first. */
  expect(Array.from(owlv2Tokens(tokenizer, ['cat<|endoftext|>'], 5).ends)).toEqual([2]);
  expect(() => owlv2Tokens(tokenizer, ['cat cat cat cat'], 5)).toThrow(
    /"cat cat cat cat" is 6 tokens and the model reads 5/,
  );
});

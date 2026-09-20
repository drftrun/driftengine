/**
 * CLIP's tokenizer — byte-level BPE — as Transformers' `CLIPTokenizer` runs it at the revision the
 * manifest pins, for OWLv2's text queries.
 *
 * **Its whole vocabulary is its merges.** A byte's token is the byte's place in GPT-2's order —
 * the printable bytes first, then the rest — the same byte ending a word is 256 further on, the
 * merge of rank r makes token 512 + r, and the start and end of text follow the last merge. So a
 * converted file carries the merges as pairs of token ids and nothing else, and the conversion
 * checks the upstream's `vocab.json` says the same.
 *
 * **In the upstream's order**: `!` and `<|endoftext|>` are taken out of the raw text as the added
 * tokens they are — `!` is the padding token, 0, wherever it appears; the rest is composed (NFC)
 * and lowercased a character at a time; `<|startoftext|>` is then taken out of that; what is left
 * is split by CLIP's pattern into contractions, runs of letters, single digits and runs of anything
 * else; each piece's UTF-8 bytes become tokens with the last marked as a word's end, and adjacent
 * pairs merge lowest rank first, leftmost among equals. A pair listed twice ranks as its last, as
 * the upstream's map of merges keeps it.
 *
 * **What it leaves out, and why that changes nothing**: the upstream also makes each run of
 * whitespace one space, and splits again by GPT-2's pattern after CLIP's. No piece holds
 * whitespace, so the first cannot change a token; and neither pattern crosses whitespace while
 * every piece CLIP's makes is one GPT-2's matches whole, so the second divides nothing. What would
 * make that wrong is a pattern change on either side, which the hand-run parity would show.
 */

export interface ClipTokenizer {
  /** The text's tokens, between the start and end of text. */
  encode(text: string): number[];
}

/* CLIP's pieces: its specials, contractions, letter runs, one digit, and runs of anything else. */
const PIECES =
  /<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|\p{L}+|\p{N}|[^\s\p{L}\p{N}]+/gu;

/* Each byte's token: its place in GPT-2's order, printable bytes first. */
const BYTE_TOKEN = ((): Uint16Array => {
  const printable = (b: number): boolean =>
    (b >= 33 && b <= 126) || (b >= 161 && b <= 172) || (b >= 174 && b <= 255);
  const table = new Uint16Array(256);
  let next = 0;
  for (let b = 0; b < 256; b += 1) if (printable(b)) table[b] = next++;
  for (let b = 0; b < 256; b += 1) if (!printable(b)) table[b] = next++;
  return table;
})();
const WORD_END = 256;
const MERGED = 512;
const PADDING = 0;

/** A tokenizer over `merges`, `[count, 2]` token ids in rank order. */
export function clipTokenizer(merges: Float32Array): ClipTokenizer {
  const count = merges.length / 2;
  const ranks = new Map<number, number>();
  for (let r = 0; r < count; r += 1) {
    const key = (merges[2 * r] as number) * 65536 + (merges[2 * r + 1] as number);
    ranks.set(key, r);
  }
  const start = MERGED + count;
  const end = start + 1;
  const bytes = new TextEncoder();

  const word = (piece: string, out: number[]): void => {
    const symbols = Array.from(bytes.encode(piece), (b) => BYTE_TOKEN[b] as number);
    symbols[symbols.length - 1] = (symbols[symbols.length - 1] as number) + WORD_END;
    for (;;) {
      let best = -1;
      let rank = count;
      for (let i = 0; i + 1 < symbols.length; i += 1) {
        const r = ranks.get((symbols[i] as number) * 65536 + (symbols[i + 1] as number));
        if (r !== undefined && r < rank) {
          rank = r;
          best = i;
        }
      }
      if (best < 0) break;
      symbols.splice(best, 2, MERGED + rank);
    }
    out.push(...symbols);
  };
  const normalised = (text: string, out: number[]): void => {
    const lower = Array.from(text.normalize('NFC'), (c) => c.toLowerCase()).join('');
    lower.split('<|startoftext|>').forEach((part, i) => {
      if (i > 0) out.push(start);
      for (const [piece] of part.matchAll(PIECES)) word(piece, out);
    });
  };

  return {
    encode(text) {
      const out = [start];
      text.split('<|endoftext|>').forEach((part, i) => {
        if (i > 0) out.push(end);
        part.split('!').forEach((run, j) => {
          if (j > 0) out.push(PADDING);
          normalised(run, out);
        });
      });
      out.push(end);
      return out;
    },
  };
}

/**
 * OWLv2's text queries as its text graph takes them: `tokens`, `[queries · positions]`, each query
 * padded with zeros to `positions`, and `ends`, `[queries]`, the row of each query's end of text in
 * that list — the upstream pools the row of the largest token, which is that one. A query longer
 * than `positions` is refused, as the upstream's position table refuses it.
 */
export function owlv2Tokens(
  tokenizer: ClipTokenizer,
  texts: readonly string[],
  positions: number,
): { readonly tokens: Float32Array; readonly ends: Float32Array } {
  const tokens = new Float32Array(texts.length * positions);
  const ends = new Float32Array(texts.length);
  texts.forEach((text, q) => {
    const ids = tokenizer.encode(text);
    if (ids.length > positions) {
      throw new RangeError(`"${text}" is ${ids.length} tokens and the model reads ${positions}`);
    }
    tokens.set(ids, q * positions);
    let largest = 0;
    ids.forEach((id, i) => {
      if (id > (ids[largest] as number)) largest = i;
    });
    ends[q] = q * positions + largest;
  });
  return { tokens, ends };
}

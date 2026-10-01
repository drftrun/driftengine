/** A WGSL module's top-level items, in order, no function ever cut. */
export function splitItems(wgsl: string): string[];
/** One item with its expression temporaries renamed `_e0`, `_e1`, … in the order they appear. */
export function renumber(item: string): string;
/** Every shader as indices into one list of distinct items, and each as it will be reassembled. */
export function shareItems(shaders: Readonly<Record<string, string>>): {
  parts: string[];
  index: Record<string, number[]>;
  rebuilt: Record<string, string>;
};

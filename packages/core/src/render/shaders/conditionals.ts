/**
 * `#if NAME` / `#else` / `#endif` resolved here rather than left to GLSL.
 *
 * The driver's own preprocessor would reach the same compiled program, so this is not
 * about the result — it is about what the driver is handed at all. A `#define` still ships
 * every declaration in the source text and asks the compiler to discard them, which leaves
 * the thing being avoided inside the component being blamed. Cutting the lines out in
 * JavaScript means a shadowless profile never sends a sampler anywhere, and it turns the
 * absence into something a test can assert on a string rather than something only a GPU
 * could confirm.
 *
 * Deliberately not a preprocessor: one directive, names only, no expressions. Anything
 * more belongs in GLSL, which already has one.
 *
 * It lived inside `flat.ts` until a second program needed permuting. Nothing about it was
 * ever specific to that shader, and the reason it moved is the reason it is worth stating:
 * the cost that justified it, a shadowless profile still compiling every sampler it could
 * never reach, is paid by whichever program declares them, not by the one that happens to
 * have found it first.
 */
export function resolveConditionals(
  source: string,
  defines: Readonly<Record<string, boolean>>,
  shaderName: string,
): string {
  const kept: string[] = [];
  /** One frame per open `#if`, holding whether its own branch is the live one. */
  const stack: { keep: boolean }[] = [];
  const keeping = (): boolean => stack.every((frame) => frame.keep);

  for (const line of source.split('\n')) {
    const directive = line.trim();
    if (directive.startsWith('#if ')) {
      const name = directive.slice(4).trim();
      if (!(name in defines)) {
        throw new Error(`${shaderName} shader: unknown condition ${name}`);
      }
      stack.push({ keep: defines[name] === true });
      continue;
    }
    if (directive === '#else') {
      const frame = stack[stack.length - 1];
      if (frame === undefined) throw new Error(`${shaderName} shader: #else outside #if`);
      frame.keep = !frame.keep;
      continue;
    }
    if (directive === '#endif') {
      if (stack.pop() === undefined) {
        throw new Error(`${shaderName} shader: #endif outside #if`);
      }
      continue;
    }
    if (keeping()) kept.push(line);
  }

  if (stack.length > 0) throw new Error(`${shaderName} shader: unterminated #if`);
  return kept.join('\n');
}

/**
 * Everything the editor can do, by name, with a key and a place in the palette.
 *
 * **Registering the same identifier twice is refused.** Silent shadowing means a plugin can replace
 * a built-in command and nothing says so — and the symptom is a menu item that stopped working for
 * one person and nobody else.
 *
 * **Fuzzy search ranks a prefix above a subsequence.** Typing `sav` should find *Save* before
 * *Show Asset View*, and a rank that only counts matched characters does not.
 */
export interface EditorCommand {
  readonly id: string;
  readonly label: string;
  readonly run: () => void;
  /** Something like `ctrl+z`. Compared verbatim. */
  readonly binding?: string;
}

export interface CommandRegistry {
  commands: Map<string, EditorCommand>;
  bindings: Map<string, string>;
}

export function createCommandRegistry(): CommandRegistry {
  return { commands: new Map(), bindings: new Map() };
}

export function registerCommand(registry: CommandRegistry, command: EditorCommand): boolean {
  if (registry.commands.has(command.id)) return false;
  registry.commands.set(command.id, command);
  if (command.binding !== undefined) registry.bindings.set(command.binding, command.id);
  return true;
}

export function runCommand(registry: CommandRegistry, id: string): boolean {
  const command = registry.commands.get(id);
  if (command === undefined) return false;
  command.run();
  return true;
}

export function commandForKey(registry: CommandRegistry, binding: string): string | null {
  return registry.bindings.get(binding) ?? null;
}

/** How well a query matches a label, or -1 for no match. Lower is better. */
export function matchScore(label: string, query: string): number {
  if (query === '') return 0;
  const haystack = label.toLowerCase();
  const needle = query.toLowerCase();

  const prefix = haystack.startsWith(needle);
  if (prefix) return 0;
  const contains = haystack.indexOf(needle);
  if (contains !== -1) return 1 + contains;

  /* Subsequence: every character in order but not adjacent. Ranked below any contiguous match. */
  let at = 0;
  let spread = 0;
  for (const character of needle) {
    const found = haystack.indexOf(character, at);
    if (found === -1) return -1;
    spread += found - at;
    at = found + 1;
  }
  return 1000 + spread;
}

/** Fill `out` with matching command identifiers, best first. Returns how many. */
export function searchCommands(registry: CommandRegistry, query: string, out: string[]): number {
  const scored: { id: string; score: number; label: string }[] = [];
  for (const command of registry.commands.values()) {
    const score = matchScore(command.label, query);
    if (score < 0) continue;
    scored.push({ id: command.id, score, label: command.label });
  }
  /* Label breaks ties, so an empty query lists everything in a stable order. */
  scored.sort((a, b) => a.score - b.score || (a.label < b.label ? -1 : 1));
  out.length = 0;
  for (const entry of scored) out.push(entry.id);
  return out.length;
}

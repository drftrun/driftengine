import type { ToolRegistry } from '../tools/registry.ts';
import type { AiCommand } from './log.ts';

export type ApplyOutcome =
  { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly reason: string };

/**
 * Run an accepted command at a tick boundary, revalidating on the way in.
 *
 * The tool's own guard ran once already, when the buffered intent drained. It runs
 * **again** here, because those are two different moments and a snapshot is never
 * authority — the buffer widens the gap on purpose, and admission proves the plan was
 * true when it was taken up rather than that it is true now.
 *
 * Not the execution policy, which ran at acceptance. Running that twice would charge
 * the rate limit twice for one call.
 *
 * **Returns on every path.** A caller inside `fixedUpdate` never needs a `try`, and a
 * consumer's tool throwing must not become an exception halfway through a tick.
 */
export function applyCommand<W>(
  registry: ToolRegistry<W>,
  world: W,
  command: AiCommand,
  _tick: number,
): ApplyOutcome {
  const tool = registry.get(command.toolId);
  if (tool === undefined) {
    return { ok: false, reason: `unknown tool "${command.toolId}" — it is not registered` };
  }

  let admitted: boolean;
  try {
    admitted = tool.admits(command.args as never, world);
  } catch {
    return { ok: false, reason: `the guard for "${command.toolId}" threw, so the call is refused` };
  }

  if (!admitted) {
    return {
      ok: false,
      reason: `"${command.toolId}" no longer admits: the world changed between acceptance and application`,
    };
  }

  try {
    return { ok: true, result: tool.execute(command.args as never, world) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `"${command.toolId}" failed while running: ${message}` };
  }
}

import type { ToolSchema } from '../tools/registry.ts';

/**
 * A read-only snapshot the model is told about.
 *
 * Context and tools are separate surfaces and the separation improves behaviour:
 * nearby objects are context, inspecting one in detail is a tool, moving is a tool.
 */
export interface ContextProvider<T> {
  /** Stable and versioned, like a tool id: `project.visible@5`. */
  readonly id: string;
  readonly priority: number;
  readonly maxItems?: number;
  describe(): { readonly title: string; readonly schema: ToolSchema };
  sample(subject: string): T;
}

export interface ContextSection {
  readonly id: string;
  readonly title: string;
  readonly items: unknown;
  readonly estimatedTokens: number;
  /** True when `maxItems` cut the sample, so a reader can tell short from truncated. */
  readonly truncated: boolean;
}

export interface AssembledContext {
  readonly capturedAtTick: number;
  readonly sections: readonly ContextSection[];
  readonly estimatedTokens: number;
  /**
   * Section ids left out, and why they are named rather than merely absent.
   *
   * A budget that silently truncates reads as coverage. A model told nothing about
   * nearby objects behaves as though there are none, and a consumer reading a trace
   * cannot tell that from a world that was empty.
   */
  readonly dropped: readonly string[];
}

/**
 * Never send the scene graph.
 *
 * Sections are taken in descending priority until the budget is spent, and what did
 * not fit is named. The estimate is deliberately crude — a provider-specific tokenizer
 * may sharpen it, but requiring one would make the core abstraction depend on whichever
 * provider happened to be configured.
 */
export function assembleContext(
  providers: readonly ContextProvider<unknown>[],
  subject: string,
  tick: number,
  tokenBudget: number,
): AssembledContext {
  const ordered = [...providers].sort((a, b) => b.priority - a.priority);
  const sections: ContextSection[] = [];
  const dropped: string[] = [];
  let spent = 0;

  for (const provider of ordered) {
    let items: unknown;
    let truncated = false;
    try {
      items = provider.sample(subject);
    } catch {
      /* One bad context provider must not silence an agent. It is named in `dropped`,
         which is the difference between a section that failed and one that was empty. */
      dropped.push(provider.id);
      continue;
    }

    const limit = provider.maxItems;
    if (limit !== undefined && Array.isArray(items) && items.length > limit) {
      items = items.slice(0, limit);
      truncated = true;
    }

    const cost = estimateTokens(items);
    if (spent + cost > tokenBudget) {
      dropped.push(provider.id);
      continue;
    }

    spent += cost;
    sections.push({
      id: provider.id,
      title: provider.describe().title,
      items,
      estimatedTokens: cost,
      truncated,
    });
  }

  return { capturedAtTick: tick, sections, estimatedTokens: spent, dropped };
}

/** Four characters to a token, which is close enough to budget with and cheap to compute. */
function estimateTokens(value: unknown): number {
  try {
    return Math.ceil(JSON.stringify(value ?? null).length / 4);
  } catch {
    return 0;
  }
}

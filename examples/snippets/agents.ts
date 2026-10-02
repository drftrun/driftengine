/**
 * The parts of an agent the village does not show: a tool of your own with its guard, a real
 * provider behind a proxy and a budget, and a run replayed from its log without asking anyone.
 *
 * A snippet, typechecked with the examples and quoted by the manual's agents chapter.
 */
import {
  AgentSession,
  Budget,
  CommandLog,
  ReplaySession,
  ToolRegistry,
  UtilityPolicy,
  createProxyProvider,
} from '@driftengine/ai';
import type { ToolDefinition } from '@driftengine/ai';

/** The game's own world, which the package never looks inside. */
interface Shop {
  readonly stock: Map<string, number>;
  open: boolean;
}

// #region tool
/** A tool is a versioned id, a schema its arguments are checked against, a guard and an act. */
const sell: ToolDefinition<{ item: string; count: number }, { sold: number }, Shop> = {
  id: 'sell@1',
  description: 'Sell some of one item from the shop.',
  schema: {
    kind: 'object',
    fields: {
      item: { kind: 'enum', values: ['bread', 'nails', 'cloth'] },
      count: { kind: 'number' },
    },
  },
  /* Asked when the intent is proposed and again when it is acted on: still open, still in stock. */
  admits: (args, shop) => shop.open && (shop.stock.get(args.item) ?? 0) >= args.count,
  execute: (args, shop) => {
    shop.stock.set(args.item, (shop.stock.get(args.item) ?? 0) - args.count);
    return { sold: args.count };
  },
};
const tools = new ToolRegistry<Shop>();
tools.register(sell);
// #endregion

// #region provider
/** A model behind your own endpoint, which holds the key; this package never sees one. */
const provider = createProxyProvider({
  endpoint: '/api/model',
  model: 'shopkeeper',
  capabilities: {
    text: true,
    streamingText: true,
    structuredOutput: true,
    toolCalling: true,
    realtimeAudio: false,
    imageInput: false,
    local: false,
  },
});

/** The floor: mind the shop. Over budget, the agent runs on this alone and says it is degraded. */
const floor = new UtilityPolicy([
  {
    intent: {
      id: 'mind the shop',
      priority: 0,
      toolIds: [],
      args: [],
      expectedExtentMs: 5000,
      source: 'floor',
    },
    score: () => 1,
  },
]);
const log = new CommandLog(512);
export const shopkeeper = new AgentSession<Shop>({
  agentId: 'shopkeeper',
  policy: floor,
  provider,
  tools,
  world: { stock: new Map([['bread', 12]]), open: true },
  budget: new Budget({ requests: 120, costMicros: 50_000 }),
  log,
  maxIntentMs: 20_000,
});
// #endregion

// #region replay
/** What the model decided is in the log, so a replay or a rewind asks no provider at all. */
export function replay(ticks: number): string[] {
  const again = new ReplaySession(log, floor, 'shopkeeper');
  const intents: string[] = [];
  for (let tick = 0; tick < ticks; tick += 1) intents.push(again.tick(tick, tick * 16).id);
  return intents;
}
// #endregion

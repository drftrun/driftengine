/*! DriftEngine | Copyright 2026 Drift Technologies | Apache-2.0 | https://github.com/drftrun/driftengine */
/**
 * Drift AI — provider-neutral intelligence sessions.
 *
 * The abstraction is not "an LLM-controlled character". It is typed intelligence
 * sessions over consumer-defined capabilities, which is what makes it an engine
 * package rather than a game feature: the same runtime serves a game exposing
 * movement and dialogue tools, a site exposing camera and material tools, and an
 * editor exposing selection and transform tools.
 *
 * The one property worth stating at the barrel: **an agent is never without a
 * purpose**. A deterministic policy floor runs inside the simulation whether or
 * not a provider exists, and the request for the next intent is issued while the
 * current one is still executing. A provider that is slow, absent, or over budget
 * costs quality, never motion.
 */

export { Budget } from './budget/budget.ts';
export type { BudgetLimits } from './budget/budget.ts';
export { createAiProvider } from './provider/create.ts';
export { hasKnownExtent, UNKNOWN_EXTENT, validateIntent } from './policy/types.ts';
export type {
  AgentPolicy,
  Intent,
  IntentCheck,
  PolicyContext,
  PolicyOption,
} from './policy/types.ts';
export { UtilityPolicy } from './policy/utility.ts';
export {
  describeAgent,
  describeForDevelopment,
  requireStructuredOutput,
} from './describe/manifest.ts';
export type { AiManifest, DevelopmentManifest, StructuredResult } from './describe/manifest.ts';
export { entityContext, entityRef, entityTool, parseEntityRef } from './entities/context.ts';
export type { EntityContextOptions } from './entities/context.ts';
export { createRealtimeSession } from './realtime/session.ts';
export type { RealtimeOptions, RealtimeResult } from './realtime/session.ts';
export { createLocalProvider } from './adapters/local.ts';
export type { LocalProviderConfig } from './adapters/local.ts';
export { createProxyProvider } from './adapters/proxy.ts';
export type { ProxyProviderConfig } from './adapters/proxy.ts';
export { assembleContext } from './context/assemble.ts';
export type { AssembledContext, ContextProvider, ContextSection } from './context/assemble.ts';
export { continuationPreamble } from './context/continuation.ts';
export { applyCommand } from './command/apply.ts';
export type { ApplyOutcome } from './command/apply.ts';
export { CommandLog } from './command/log.ts';
export type { AiCommand, AiPreemption, LogEntry } from './command/log.ts';
export { ReplaySession } from './session/replay.ts';
export type { ReplaySource } from './session/replay.ts';
export { AgentSession } from './session/agent.ts';
export type { AgentSessionOptions, Observation, WhileBusy } from './session/agent.ts';
export { nextState } from './session/states.ts';
export type { AgentState, AgentTransition } from './session/states.ts';
export { admitToolCall, RateWindows } from './tools/policy.ts';
export type { Admission, ExecutionPolicy } from './tools/policy.ts';
export { ToolRegistry } from './tools/registry.ts';
export type { ToolDefinition, ToolSchema } from './tools/registry.ts';

/* The two bridges. Both are factories over a consumer's adapter, because the engine owns the graph
   and the replication and the consumer owns what an agent is. */
export type {
  NavigateArgs,
  NavigateResult,
  NavigationAdapter,
  NavigationBridgeOptions,
} from './bridges/navigation.ts';
export { navigationBridge, reachableBy } from './bridges/navigation.ts';
export type { AgentRole, AuthoritativeAgentOptions, DecisionChannel } from './bridges/authority.ts';
export {
  AI_NETWORK_AUTHORITY,
  AuthoritativeAgent,
  loopbackDecisionChannel,
} from './bridges/authority.ts';
export { validateArgs } from './tools/validate.ts';
export type { ValidationResult } from './tools/validate.ts';
export { LatencyEstimator } from './provider/latency.ts';
export { chargeUsage, createUsage, noteAbort, notePreemption } from './session/usage.ts';
export type { AiUsage } from './session/usage.ts';
export { DeterministicProvider } from './testing/deterministic.ts';
export type { DeterministicScript } from './testing/deterministic.ts';
export type {
  AiEvent,
  AiProvider,
  AiProviderCapabilities,
  AiProviderConfig,
  AiProviderResult,
  AiRequest,
  AiSession,
  AiSessionOptions,
  AssembledContextLike,
} from './provider/types.ts';

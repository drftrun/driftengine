/*! DriftEngine | Copyright 2026 Drift Technologies | Apache-2.0 | https://github.com/drftrun/driftengine */
/**
 * What a game imports from the packager.
 *
 * **The renderer half only.** The main process, the CLI, the builder and the staging step are
 * Node and are reached through the `drift-package` command rather than through this barrel — a
 * game bundling `electron` or `esbuild` into its own payload is the failure this boundary exists
 * to prevent.
 *
 * `createHost` is the one call most consumers need; the classes beside it are for a game that
 * assembles its capabilities itself.
 */
export { createHost } from './renderer/host.ts';
export type { Host } from './renderer/host.ts';
export { FileStore } from './renderer/fileStore.ts';
export {
  NativeDisplay,
  NativeFileDialogs,
  NativeLifecycle,
  hostBridge,
} from './renderer/nativeHost.ts';
/*
 * A store's own features, when a store answered.
 *
 * `createHost().services` is how a game reaches these — null in a browser, null where the manifest
 * named no app, and null when the copy was launched outside the store. The SDK itself is not here:
 * it is a native Node module held by the main process, because the renderer has no Node at all.
 */
export { NativePlatformServices } from './renderer/nativeHost.ts';
export { BRIDGE_KEY } from './preload/bridge.ts';
export type { DriftHostBridge } from './preload/bridge.ts';

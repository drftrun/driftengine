import type { CdpClient } from './cdp.d.mts';

/** A running browser's debugging port, and how to stop it. */
export interface LaunchedBrowser {
  readonly port: number;
  readonly binary: string;
  close(): Promise<void>;
}

export function chromePath(): string;
export function launch(options?: {
  flags?: readonly string[];
  headless?: boolean;
  timeoutMs?: number;
}): Promise<LaunchedBrowser>;
export function rendererName(client: CdpClient): Promise<string>;
export function requireHardwareGpu(client: CdpClient): Promise<string>;

/** A tab opened through `client.page`, sized and ready to be driven. */
export interface CdpPage {
  call(method: string, params?: Record<string, unknown>): Promise<unknown>;
  readonly logs: string[];
  /** `Runtime.evaluate` with `awaitPromise` and `returnByValue`; throws on a page exception. */
  eval(expression: string, options?: Record<string, unknown>): Promise<unknown>;
  settled(expression?: string, options?: { timeoutMs?: number; settleMs?: number }): Promise<void>;
  frames(count?: number): Promise<void>;
  complaints(): string[];
  screenshot(path: string): Promise<string>;
  close(): Promise<void>;
}

/** A session against a browser already listening on its debugging port. */
export interface CdpClient {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
  on(listener: (message: unknown) => void): void;
  page(
    url: string,
    width?: number,
    height?: number,
    options?: { beforeLoad?: string },
  ): Promise<CdpPage>;
  close(): void;
}

export function sleep(ms: number): Promise<void>;
export function connect(port: number, options?: { timeoutMs?: number }): Promise<CdpClient>;

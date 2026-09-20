/**
 * Real threads, as a page's `Worker`, with none of a page's conditions on shared memory.
 *
 * **A browser gives a page `SharedArrayBuffer` only when it is cross-origin isolated**, served with
 * `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers: a condition on every
 * consumer's deployment, which is why the engine's pools are switches rather than defaults. Node
 * has shared memory unconditionally, so on this host they run on real threads with nothing asked.
 *
 * **The engine is not told.** Its pools build their workers the way a page does, `new Worker(url)`,
 * and hear from them through `onmessage` and `error` events; this is that `Worker` over
 * `node:worker_threads`, each thread starting in `workerScope.mjs`, which gives the module a
 * browser worker's scope. The core count is Node's own `navigator.hardwareConcurrency`, which is
 * what the physics pool bounds itself by.
 *
 * What it gives up: a classic, non-module worker script, which a Node thread cannot load; the
 * `name` and `credentials` options, which mean nothing without a page.
 */

import { Worker as NodeWorker } from 'node:worker_threads';

const SCOPE = new URL('./workerScope.mjs', import.meta.url);

export class HostWorker extends EventTarget {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private readonly thread: NodeWorker;

  constructor(url: string | URL, _options?: WorkerOptions) {
    super();
    this.thread = new NodeWorker(SCOPE, { workerData: { url: String(url) } });
    this.thread.on('message', (data: unknown) => {
      const event = Object.assign(new Event('message'), { data }) as MessageEvent;
      this.onmessage?.(event);
      this.dispatchEvent(event);
    });
    this.thread.on('error', (error: Error) => {
      const event = Object.assign(new Event('error'), {
        message: error.message,
        error,
      }) as ErrorEvent;
      this.onerror?.(event);
      this.dispatchEvent(event);
    });
  }

  postMessage(value: unknown, transfer?: readonly Transferable[]): void {
    this.thread.postMessage(value, transfer as never);
  }

  terminate(): void {
    void this.thread.terminate();
  }
}

/** Answer `new Worker(url)` with a real thread, and hand back what takes it away again. */
export function installThreads(
  scope: Record<string, unknown> = globalThis as Record<string, unknown>,
): () => void {
  const had = 'Worker' in scope;
  const before = scope['Worker'];
  scope['Worker'] = HostWorker;
  return () => {
    if (had) scope['Worker'] = before;
    else delete scope['Worker'];
  };
}

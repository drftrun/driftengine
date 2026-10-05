/**
 * The worker `bcLoad.ts` starts: decodes BC blocks off the main thread, one request at a time, and
 * hands each image back rather than copying it. Imports `bcAnswer.ts` alone, so its bundle is the
 * decoders and nothing else.
 *
 * No top-level await, for the reason `islandWorker.ts` gives: a consumer's bundler compiles every
 * `new Worker(new URL(…))` it finds, and an IIFE worker cannot carry one.
 */
import { answerBcRequest } from './bcAnswer.ts';
import type { BcRequest } from './bcAnswer.ts';

const scope = globalThis as unknown as {
  onmessage: ((event: { data: BcRequest }) => void) | null;
  postMessage(reply: unknown, transfer: ArrayBuffer[]): void;
};

scope.onmessage = (event): void => {
  const reply = answerBcRequest(event.data);
  scope.postMessage(reply, reply.rgba === undefined ? [] : [reply.rgba]);
};

/**
 * The worker `bcLoad.ts` and `etc2Load.ts` each start one of: decodes BC blocks off the main
 * thread, or re-encodes them as an ETC2 chain, one request at a time, and hands each answer back
 * rather than copying it. Imports the two answers alone, so its bundle is the codecs and nothing
 * else.
 *
 * No top-level await, for the reason `islandWorker.ts` gives: a consumer's bundler compiles every
 * `new Worker(new URL(…))` it finds, and an IIFE worker cannot carry one.
 */
import { answerBcRequest } from './bcAnswer.ts';
import type { BcRequest } from './bcAnswer.ts';
import { answerEtc2Request } from './etc2Answer.ts';
import type { Etc2Request } from './etc2Answer.ts';

const scope = globalThis as unknown as {
  onmessage: ((event: { data: BcRequest | Etc2Request }) => void) | null;
  postMessage(reply: unknown, transfer: ArrayBuffer[]): void;
};

scope.onmessage = (event): void => {
  const request = event.data;
  if ('kind' in request && request.kind === 'etc2') {
    const reply = answerEtc2Request(request);
    scope.postMessage(reply, reply.levels ?? []);
    return;
  }
  const reply = answerBcRequest(request as BcRequest);
  scope.postMessage(reply, reply.rgba === undefined ? [] : [reply.rgba]);
};

/**
 * The start of every thread the native host makes: a browser worker's scope over `worker_threads`,
 * and then the module the page asked for.
 *
 * **A worker module written for a page reads `self`, `onmessage`, `addEventListener` and a global
 * `postMessage`**, none of which a Node thread has; they are made here over `parentPort`, and a
 * message is handed on with its value as `data`, as a `MessageEvent` carries it.
 *
 * **Messages wait until the module has run**, as a browser holds them until a worker's script has
 * been evaluated: a page usually posts its first message the moment it constructs the worker, and a
 * module that sets `onmessage` after an `await` would otherwise never see it.
 *
 * Plain JavaScript, so that it loads before any loader a host registers has anything to do.
 */
import { parentPort, workerData } from 'node:worker_threads';

const scope = globalThis;
const listeners = new Set();
let ready = false;
const held = [];

function deliver(data) {
  const event = { type: 'message', data, target: scope, currentTarget: scope };
  if (typeof scope.onmessage === 'function') scope.onmessage(event);
  for (const listener of listeners) {
    if (typeof listener === 'function') listener(event);
    else listener.handleEvent(event);
  }
}

scope.self = scope;
scope.onmessage = null;
scope.postMessage = (value, transfer) => parentPort.postMessage(value, transfer);
scope.addEventListener = (type, listener) => {
  if (type === 'message') listeners.add(listener);
};
scope.removeEventListener = (type, listener) => {
  if (type === 'message') listeners.delete(listener);
};
scope.close = () => process.exit(0);
parentPort.on('message', (data) => {
  if (ready) deliver(data);
  else held.push(data);
});

await import(workerData.url);
ready = true;
for (const data of held.splice(0)) deliver(data);

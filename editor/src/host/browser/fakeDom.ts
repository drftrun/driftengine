/**
 * A DOM small enough to assert against, for the two hosts in this directory.
 *
 * **Shipped rather than kept in a test file**, on `scripts/packages.test.mjs`'s rule and for the
 * reason `nav/src/testField.ts` gives: a consumer integrating its own shell wants to drive these
 * hosts without a browser, and a fixture that works is worth more in the package than deleted. It
 * is not in any barrel, so it is reachable by path and by nothing else.
 */
import type { HostClipboard, HostDocument, HostElement, HostEventListener } from './textHost.ts';

export interface FakeElement extends HostElement {
  readonly tag: string;
  readonly attributes: Map<string, string>;
  readonly listeners: Map<string, HostEventListener[]>;
  readonly kids: FakeElement[];
  focused: boolean;
  removed: boolean;
  /** Deliver an event to whatever is listening, as the browser would. */
  emit(type: string, event: unknown): void;
}

export function createFakeElement(tag: string): FakeElement {
  const element: FakeElement = {
    tag,
    style: {},
    value: '',
    textContent: '',
    attributes: new Map<string, string>(),
    listeners: new Map<string, HostEventListener[]>(),
    kids: [],
    focused: false,
    removed: false,
    setAttribute(name: string, value: string): void {
      element.attributes.set(name, value);
    },
    appendChild(child: HostElement): void {
      element.kids.push(child as FakeElement);
    },
    addEventListener(type: string, listener: HostEventListener): void {
      const list = element.listeners.get(type) ?? [];
      list.push(listener);
      element.listeners.set(type, list);
    },
    removeEventListener(type: string, listener: HostEventListener): void {
      const list = element.listeners.get(type) ?? [];
      const at = list.indexOf(listener);
      if (at >= 0) list.splice(at, 1);
    },
    focus(): void {
      element.focused = true;
    },
    blur(): void {
      element.focused = false;
    },
    remove(): void {
      element.removed = true;
    },
    emit(type: string, event: unknown): void {
      for (const listener of [...(element.listeners.get(type) ?? [])]) listener(event);
    },
  };
  return element;
}

export interface FakeDocument extends HostDocument {
  readonly created: FakeElement[];
  readonly body: FakeElement;
}

export function createFakeDocument(): FakeDocument {
  const body = createFakeElement('body');
  const created: FakeElement[] = [];
  return {
    created,
    body,
    createElement(tag: string): HostElement {
      const element = createFakeElement(tag);
      created.push(element);
      return element;
    },
  };
}

/** A clipboard that answers, or one that refuses the way a browser refuses: a rejected promise. */
export function createFakeClipboard(
  options: { refuse?: boolean; text?: string } = {},
): HostClipboard {
  let held = options.text ?? '';
  return {
    readText(): Promise<string> {
      if (options.refuse === true) return Promise.reject(new Error('clipboard permission denied'));
      return Promise.resolve(held);
    },
    writeText(text: string): Promise<void> {
      if (options.refuse === true) return Promise.reject(new Error('clipboard permission denied'));
      held = text;
      return Promise.resolve();
    },
  };
}

/**
 * The browser's text services, behind `@driftengine/ui2d`'s seam.
 *
 * **This directory is the only place in `editor/` that may name a browser global**, and it is
 * shaped so Wave 5A replaces the directory rather than editing anything above it: every module
 * here takes its `document` and its clipboard as parameters and falls back to the globals, so a
 * native host supplies its own and nothing else in the editor changes.
 *
 * **A hidden input, positioned at the field.** A canvas cannot receive an IME composition window,
 * so the trick every web editor uses is a real input element moved to where the caret is, kept
 * transparent and one pixel tall. Placing it matters: an IME candidate list that appears at the
 * top-left of the page while the caret is at the bottom-right is the defect, and it is invisible
 * to anybody typing a language that does not compose.
 *
 * **A refused clipboard answers empty rather than throwing.** Reading the clipboard is a
 * permission, and a browser refuses it by rejecting — often on the very first use, before anybody
 * has agreed to anything. An editor that let that reject escape would take the frame down on a
 * paste, so `readClipboard` resolves to `''` and `writeClipboard` resolves. That is what
 * `createNullTextHost` already promises, and a host that behaves differently when it is present is
 * worse than no host.
 */
import type { TextHost } from '@driftengine/ui2d';

export type HostEventListener = (event: unknown) => void;

/** The part of an element these hosts touch. The real DOM satisfies it. */
export interface HostElement {
  style: Record<string, string>;
  value: string;
  textContent: string;
  setAttribute(name: string, value: string): void;
  appendChild(child: HostElement): void;
  addEventListener(type: string, listener: HostEventListener): void;
  removeEventListener(type: string, listener: HostEventListener): void;
  focus(): void;
  blur(): void;
  remove(): void;
}

export interface HostDocument {
  createElement(tag: string): HostElement;
  readonly body: { appendChild(child: HostElement): void };
}

export interface HostClipboard {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}

/** One composition update, in the shape `applyComposition` takes. */
export interface CompositionUpdate {
  text: string;
  done: boolean;
}

export interface BrowserTextHostOptions {
  readonly document?: HostDocument;
  /** `null` for a host with no clipboard at all, which still answers empty rather than throwing. */
  readonly clipboard?: HostClipboard | null;
}

export interface BrowserTextHost extends TextHost {
  /** The element the browser composes into. Exposed so a shell can size or style it. */
  readonly field: HostElement;
  /**
   * Take the composition updates that have arrived, oldest first, and clear the queue.
   *
   * **A queue rather than a callback**, because composition arrives on the browser's schedule and
   * the editor applies it on the frame's. A callback would call `applyComposition` from inside an
   * event, which is a mutation in the middle of whatever the frame was doing.
   */
  drainCompositions(out: CompositionUpdate[]): number;
  dispose(): void;
}

function globalDocument(): HostDocument {
  const found = (globalThis as { document?: unknown }).document;
  if (found === undefined) throw new Error('createBrowserTextHost: this is not a browser');
  return found as HostDocument;
}

function globalClipboard(): HostClipboard | null {
  const nav = (globalThis as { navigator?: { clipboard?: unknown } }).navigator;
  return (nav?.clipboard as HostClipboard | undefined) ?? null;
}

export function createBrowserTextHost(options: BrowserTextHostOptions = {}): BrowserTextHost {
  const doc = options.document ?? globalDocument();
  const clipboard = options.clipboard === undefined ? globalClipboard() : options.clipboard;

  const field = doc.createElement('textarea');
  field.setAttribute('aria-hidden', 'true');
  field.setAttribute('autocapitalize', 'off');
  field.setAttribute('autocomplete', 'off');
  field.setAttribute('spellcheck', 'false');
  field.style.position = 'absolute';
  field.style.opacity = '0';
  field.style.padding = '0';
  field.style.border = '0';
  field.style.outline = 'none';
  field.style.resize = 'none';
  /* Off-screen until a field is focused, so it cannot catch a stray click. */
  field.style.left = '-9999px';
  field.style.top = '-9999px';
  doc.body.appendChild(field);

  const pending: CompositionUpdate[] = [];
  const record = (event: unknown, done: boolean): void => {
    const data = (event as { data?: unknown }).data;
    pending.push({ text: typeof data === 'string' ? data : '', done });
  };
  const onUpdate: HostEventListener = (event) => {
    record(event, false);
  };
  const onEnd: HostEventListener = (event) => {
    record(event, true);
  };
  /*
   * `compositionstart` is deliberately not listened for. It carries no text and folding it in as an
   * empty update would replace the selection with nothing a frame before the first real update
   * arrives — which reads as the selected word vanishing and then coming back.
   */
  field.addEventListener('compositionupdate', onUpdate);
  field.addEventListener('compositionend', onEnd);

  return {
    field,

    focusField(x: number, y: number, w: number, h: number): void {
      field.style.left = `${String(Math.round(x))}px`;
      field.style.top = `${String(Math.round(y))}px`;
      field.style.width = `${String(Math.max(1, Math.round(w)))}px`;
      field.style.height = `${String(Math.max(1, Math.round(h)))}px`;
      field.focus();
    },

    blurField(): void {
      field.blur();
      field.style.left = '-9999px';
      field.style.top = '-9999px';
    },

    async readClipboard(): Promise<string> {
      if (clipboard === null) return '';
      try {
        return await clipboard.readText();
      } catch {
        /* Refused, or unavailable in this context. Empty is the answer the null host gives. */
        return '';
      }
    },

    async writeClipboard(text: string): Promise<void> {
      if (clipboard === null) return;
      try {
        await clipboard.writeText(text);
      } catch {
        /* Same reasoning: a copy that cannot happen is not an error the editor can act on. */
      }
    },

    drainCompositions(out: CompositionUpdate[]): number {
      out.length = 0;
      for (const update of pending) out.push(update);
      pending.length = 0;
      return out.length;
    },

    dispose(): void {
      field.removeEventListener('compositionupdate', onUpdate);
      field.removeEventListener('compositionend', onEnd);
      field.remove();
    },
  };
}

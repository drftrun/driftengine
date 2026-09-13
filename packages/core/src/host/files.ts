/**
 * Choosing a file, and writing one out.
 *
 * **Nothing in a game needs this**; an editor does, which is why it is a separate capability
 * rather than a member of a larger one — a consumer that never opens a file never has to supply
 * it. `AGENTS.md` calls this the SDF-text shape: opt-in costs a consumer nothing until asked for.
 *
 * **A cancel and an absent API are different answers.** Cancel is `null`, because a person
 * changing their mind is ordinary. No picker at all throws, because that is a boot-time
 * capability failure and the caller should say so rather than show an empty screen.
 */
export interface OpenedFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

export interface FileDialogs {
  /** `null` when the person cancelled. Throws when the platform has no picker. */
  openFile(accept: readonly string[]): Promise<OpenedFile | null>;
  /** `false` when the person cancelled. Throws when the platform has no picker. */
  saveFile(name: string, bytes: Uint8Array): Promise<boolean>;
}

/** What the File System Access API hands back, named minimally rather than typed from a lib. */
interface PickedFileHandle {
  getFile(): Promise<{ name: string; arrayBuffer(): Promise<ArrayBuffer> }>;
}

interface WritableFileHandle {
  createWritable(): Promise<{
    write(data: Uint8Array): Promise<void>;
    close(): Promise<void>;
  }>;
}

export class BrowserFileDialogs implements FileDialogs {
  async openFile(accept: readonly string[]): Promise<OpenedFile | null> {
    const picker = (globalThis as { showOpenFilePicker?: unknown }).showOpenFilePicker;
    if (typeof picker !== 'function') {
      throw new Error('[driftengine] no file picker in this browser; a shell supplies one');
    }
    try {
      const [handle] = await (picker as (options: unknown) => Promise<PickedFileHandle[]>)({
        /* One entry rather than one per extension: the map's keys are MIME types and the
           engine's own container has none registered, so the extensions carry the filter. */
        types: [{ description: 'files', accept: { '*/*': [...accept] } }],
      });
      if (handle === undefined) return null;
      const file = await handle.getFile();
      return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
    } catch {
      /* Every rejection here is a cancel: the picker was present, so a failure to produce a
         file is a person who closed it. A real read error surfaces from `getFile` as a throw
         that this also swallows, which is the one case where null is thin — and a caller that
         got null after a chooser closed has nothing better to do either way. */
      return null;
    }
  }

  async saveFile(name: string, bytes: Uint8Array): Promise<boolean> {
    const picker = (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    if (typeof picker !== 'function') {
      throw new Error('[driftengine] no save picker in this browser; a shell supplies one');
    }
    try {
      const handle = await (picker as (options: unknown) => Promise<WritableFileHandle>)({
        suggestedName: name,
      });
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Choosing a file, in a browser.
 *
 * **The whole of the platform's half of `CaptureFileHost`**, and it is deliberately this small: a
 * picker, a read, and a download. Everything about what a capture *is* lives in `capture/file.ts`,
 * which has never heard of an `<input>` and can be tested with an array of bytes.
 *
 * **A picker has to be opened by a gesture**, which is the browser's rule rather than ours, so this
 * is called from a command a person ran and never from a frame.
 */

/** The bytes somebody chose, or `null` where they cancelled. */
export function chooseCaptureFile(accept = '.drft'): Promise<ArrayBuffer | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    /*
     * **Resolved on `cancel` as well as on `change`.** Without it a dialog somebody closed leaves
     * a promise nobody settles, and the next open waits behind it for ever — which looks like the
     * editor having stopped responding rather than like a dialog having been dismissed.
     */
    input.addEventListener('cancel', () => {
      input.remove();
      resolve(null);
    });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.remove();
      if (file === undefined) {
        resolve(null);
        return;
      }
      void file.arrayBuffer().then(resolve);
    });
    document.body.append(input);
    input.click();
  });
}

/** Hand bytes back to whoever is running the browser, under a name. */
export function downloadCaptureFile(name: string, bytes: ArrayBuffer): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  /* Revoked on the next turn: revoking it in this one races the navigation the click started. */
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

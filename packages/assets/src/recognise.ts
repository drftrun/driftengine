/**
 * Tier 4: identify a container this project has no reader for, and say what to do instead.
 *
 * **The whole value is in the last part.** `.mb` and `.max` are proprietary binaries with no
 * public specification, so there is nothing here that could grow into a reader, and pretending
 * otherwise would be worse than refusing. What this turns is a confusing failure — an unknown
 * extension, or a parser tripping over bytes it was never going to understand — into an
 * instruction somebody can act on in the next thirty seconds.
 *
 * **Identified by content, not by extension.** A renamed file is common enough to matter: a
 * `.max` that is really an FBX should be read, not refused, and a `.mb` renamed to `.fbx`
 * should be refused rather than fed to a reader that will fail obscurely. The magic bytes
 * are the fact; the extension is a claim.
 */

/** What a file turned out to be, and what a person should do with it. */
export interface Recognised {
  /** Short name of the container, for the message. */
  readonly format: string;
  /** Why there is no reader, stated plainly. */
  readonly because: string;
  /** The export that does work, named specifically enough to follow. */
  readonly instead: string;
}

/** Every byte sequence that identifies a container this project deliberately does not read. */
const SIGNATURES: readonly {
  readonly format: string;
  readonly bytes: readonly number[];
  readonly at: number;
  readonly because: string;
  readonly instead: string;
}[] = [
  {
    /*
     * Maya binary is an IFF container. Autodesk's own writes `FOR4`/`FOR8` with a `Maya`
     * form type at byte 8, which is enough to be sure without claiming to understand a
     * single chunk inside it.
     */
    format: 'Maya binary (.mb)',
    bytes: [0x46, 0x4f, 0x52], // 'FOR', then '4' or '8'
    at: 0,
    because:
      'Maya binary is an IFF container with no public specification, so its chunks can be ' +
      'walked but a scene cannot be reconstructed from them without guessing.',
    instead:
      'In Maya, File > Export All and choose FBX or glTF. Or save as .ma, the ASCII form, ' +
      'which this project reads as a tier 2 experimental format.',
  },
  {
    /*
     * 3ds Max writes an OLE2 compound document, the same container old Office files use, so
     * the signature identifies the *wrapper* rather than the format. Said as much in the
     * message: a `.doc` renamed to `.max` would land here too, and a reader that claimed
     * otherwise would be lying about what it knows.
     */
    format: '3ds Max (.max)',
    bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
    at: 0,
    because:
      'A .max is an OLE compound document with no public specification for what is inside ' +
      'it, and Autodesk ships no free scriptable converter worth depending on.',
    instead:
      'In 3ds Max, File > Export and choose glTF 2.0 (.gltf/.glb) or FBX. Both are read here, ' +
      'and glTF is tier 1.',
  },
];

/** Containers that *are* read, so a renamed file is sent to its reader rather than refused. */
const READABLE: readonly {
  readonly format: string;
  readonly bytes: readonly number[];
  readonly at: number;
}[] = [
  { format: 'FBX', bytes: [0x4b, 0x61, 0x79, 0x64, 0x61, 0x72, 0x61], at: 0 }, // 'Kaydara'
  { format: 'glTF binary (.glb)', bytes: [0x67, 0x6c, 0x54, 0x46], at: 0 },
  { format: 'a zip container (.usdz, .3mf)', bytes: [0x50, 0x4b, 0x03, 0x04], at: 0 },
  { format: 'DRFT', bytes: [0x44, 0x52, 0x46, 0x54], at: 0 },
  { format: '.kn5', bytes: [0x73, 0x63, 0x36, 0x39, 0x36, 0x39], at: 0 }, // 'sc6969'
];

function matches(bytes: Uint8Array, signature: readonly number[], at: number): boolean {
  if (bytes.length < at + signature.length) return false;
  return signature.every((byte, index) => bytes[at + index] === byte);
}

/**
 * What this file actually is, when it is something with no reader here.
 *
 * Returns null for anything readable, including a file whose extension is misleading — the
 * caller then carries on and lets the real reader have it.
 */
export function recognise(bytes: Uint8Array): Recognised | null {
  for (const known of READABLE) {
    if (matches(bytes, known.bytes, known.at)) return null;
  }
  for (const signature of SIGNATURES) {
    if (!matches(bytes, signature.bytes, signature.at)) continue;
    if (signature.format.startsWith('Maya')) {
      /* `FOR4`/`FOR8`, and Maya's own form type sits four bytes past the length. */
      const digit = bytes[3];
      const isForm = digit === 0x34 || digit === 0x38;
      const maya = matches(bytes, [0x4d, 0x61, 0x79, 0x61], 8);
      if (!isForm || !maya) continue;
    }
    return { format: signature.format, because: signature.because, instead: signature.instead };
  }
  return null;
}

/**
 * The refusal, as one block of text a person can act on.
 *
 * Written here rather than at the call site so the CLI, a future editor and anything else
 * that meets one of these files says the same thing. A refusal that varies by caller is a
 * refusal somebody has to read twice.
 */
export function describeRecognised(found: Recognised, filename: string): string {
  return (
    `${filename} is ${found.format}, and there is no reader for it here (tier 4: recognised only).\n` +
    `  ${found.because}\n` +
    `  What works: ${found.instead}`
  );
}

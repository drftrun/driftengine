/**
 * Tier 4 recognition.
 *
 * The contract is not "does it parse" — nothing is parsed. It is that a file with no reader
 * produces an instruction rather than a confusing failure, and that identification comes
 * from the bytes rather than from the name on the end of the file.
 */
import { expect, test } from 'vitest';
import { describeRecognised, recognise } from './recognise.ts';

function bytes(...values: number[]): Uint8Array {
  const out = new Uint8Array(64);
  out.set(values, 0);
  return out;
}

/** `FOR4`, a length, then the `Maya` form type: an IFF container written by Maya. */
const MAYA_BINARY = bytes(0x46, 0x4f, 0x52, 0x34, 0, 0, 0x10, 0, 0x4d, 0x61, 0x79, 0x61);
/** The OLE2 compound document header a `.max` is wrapped in. */
const MAX = bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);

test('a Maya binary is identified and told which export works', () => {
  const found = recognise(MAYA_BINARY);
  expect(found?.format).toContain('Maya');
  /*
   * The instruction is the entire point of the tier. Naming FBX or glTF is what turns this
   * from a dead end into a thirty second detour, and `.ma` is worth naming too because the
   * same application writes it and this project reads it.
   */
  expect(found?.instead).toMatch(/FBX|glTF/);
  expect(found?.instead, 'the ASCII form of the same file is read here').toContain('.ma');
});

test('a 3ds Max file is identified, and the message admits what the signature proves', () => {
  const found = recognise(MAX);
  expect(found?.format).toContain('3ds Max');
  expect(found?.because, 'the signature is the OLE wrapper, not the format').toContain('OLE');
  expect(found?.instead).toMatch(/glTF/);
});

test('a format that does have a reader is passed through rather than refused', () => {
  /*
   * This is the half that matters for a renamed file: a `.max` that is really an FBX must
   * reach the FBX reader. Recognition returning null is how the caller is told to carry on.
   */
  expect(recognise(bytes(0x4b, 0x61, 0x79, 0x64, 0x61, 0x72, 0x61)), 'FBX').toBeNull();
  expect(recognise(bytes(0x67, 0x6c, 0x54, 0x46)), 'glb').toBeNull();
  expect(recognise(bytes(0x50, 0x4b, 0x03, 0x04)), 'usdz or 3mf').toBeNull();
  expect(recognise(bytes(0x44, 0x52, 0x46, 0x54)), 'drft').toBeNull();
});

test('an IFF container that is not Maya is not claimed to be one', () => {
  /*
   * `FOR4` alone is IFF, which several unrelated formats use. Without the `Maya` form type
   * this reader has no business naming the application, and saying so wrongly would send
   * somebody to an export dialog in a program they do not have open.
   */
  const otherIff = bytes(0x46, 0x4f, 0x52, 0x34, 0, 0, 0x10, 0, 0x4e, 0x55, 0x4b, 0x45);
  expect(recognise(otherIff)).toBeNull();
});

test('anything unremarkable is left alone', () => {
  expect(recognise(bytes(0x23, 0x75, 0x73, 0x64, 0x61)), 'a usda begins with #usda').toBeNull();
  expect(recognise(new Uint8Array(0)), 'and an empty file is not a claim').toBeNull();
});

test('the refusal names the file, the format, the reason and the way out', () => {
  const found = recognise(MAYA_BINARY);
  if (found === null) throw new Error('not recognised');
  const message = describeRecognised(found, 'scene.mb');
  expect(message).toContain('scene.mb');
  expect(message, 'the tier is stated, unprompted').toContain('tier 4');
  expect(message).toContain('What works:');
});

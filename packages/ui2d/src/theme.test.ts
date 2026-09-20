import { expect, test } from 'vitest';
import {
  createTheme,
  deriveTheme,
  themeColour,
  themeRgba,
  themeSize,
  unpackRgba,
} from './theme.ts';

test('a named colour comes back', () => {
  expect(themeColour(createTheme({ 'panel.background': 0x202020ff }), 'panel.background', 0)).toBe(
    0x202020ff,
  );
});

test('an unknown name gives the fallback rather than undefined', () => {
  expect(themeColour(createTheme({}), 'nothing.here', 0x123456)).toBe(0x123456);
});

test('a derived theme overrides what it names and keeps what it does not', () => {
  const derived = deriveTheme(createTheme({ a: 1, b: 2 }), { b: 3 });
  expect(themeSize(derived, 'a', 0)).toBe(1);
  expect(themeSize(derived, 'b', 0)).toBe(3);
});

test('deriving does not change the theme it derived from', () => {
  const base = createTheme({ a: 1 });
  deriveTheme(base, { a: 99 });
  expect(themeSize(base, 'a', 0)).toBe(1);
});

test('a derived theme is flat, so a lookup never walks a chain', () => {
  const twice = deriveTheme(deriveTheme(createTheme({ a: 1 }), { b: 2 }), { c: 3 });
  expect(Object.keys(twice.values).sort()).toEqual(['a', 'b', 'c']);
});

test('creating a theme copies its input, so a later mutation of the source is not seen', () => {
  const source = { a: 1 };
  const theme = createTheme(source);
  source.a = 99;
  expect(themeSize(theme, 'a', 0)).toBe(1);
});

test('a packed token unpacks into the array a node background wants', () => {
  const out = new Float32Array(4);
  unpackRgba(0x336699ff, out);
  expect(out[0]).toBeCloseTo(0x33 / 255, 6);
  expect(out[1]).toBeCloseTo(0x66 / 255, 6);
  expect(out[2]).toBeCloseTo(0x99 / 255, 6);
  expect(out[3]).toBe(1);
});

/* The top byte is not sign-extended away: 0xff......  is the case `>>` gets wrong and `>>>` gets right. */
test('a token with the top bit set keeps its red', () => {
  const out = new Float32Array(4);
  unpackRgba(0xff000080, out);
  expect(out[0]).toBe(1);
  expect(out[3]).toBeCloseTo(0x80 / 255, 6);
});

test('a theme token goes straight into a node background', () => {
  const theme = createTheme({ 'button.background': 0x20304000 });
  const out = themeRgba(theme, 'button.background', 0xffffffff, new Float32Array(4));
  expect(out[3]).toBe(0);
  expect(themeRgba(theme, 'absent', 0x00000000, new Float32Array(4))[3]).toBe(0);
});

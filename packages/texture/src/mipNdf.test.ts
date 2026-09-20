import { expect, test } from 'vitest';
import { reduceNormalMip, toksvigRoughness } from './mipNdf.ts';

test('four identical normals reduce to the same normal and no added roughness', () => {
  const src = Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const n = new Float32Array(3);
  const r = new Float32Array(1);
  reduceNormalMip(src, 2, 2, n, r);
  expect(n[2]).toBeCloseTo(1, 6);
  expect(r[0]).toBeCloseTo(0, 6);
});

test('four disagreeing normals reduce to a rougher surface, which is the whole point', () => {
  const s = Math.SQRT1_2;
  const src = Float32Array.from([s, 0, s, -s, 0, s, 0, s, s, 0, -s, s]);
  const n = new Float32Array(3);
  const r = new Float32Array(1);
  reduceNormalMip(src, 2, 2, n, r);
  expect(r[0]).toBeGreaterThan(0.1);
});

test('the reduced normal still points the average way', () => {
  const s = Math.SQRT1_2;
  const src = Float32Array.from([s, 0, s, -s, 0, s, 0, s, s, 0, -s, s]);
  const n = new Float32Array(3);
  const r = new Float32Array(1);
  reduceNormalMip(src, 2, 2, n, r);
  expect(n[2]).toBeGreaterThan(0.9);
});

test('a shorter averaged normal means more roughness, monotonically', () => {
  expect(toksvigRoughness(1.0, 0)).toBeLessThan(toksvigRoughness(0.9, 0));
  expect(toksvigRoughness(0.9, 0)).toBeLessThan(toksvigRoughness(0.7, 0));
});

test('roughness already present is never reduced by mipping', () => {
  expect(toksvigRoughness(0.8, 0.5)).toBeGreaterThanOrEqual(0.5);
  expect(toksvigRoughness(1.0, 0.5)).toBeCloseTo(0.5, 6);
});

test('roughness stays inside its range however much variance is added', () => {
  expect(toksvigRoughness(0, 1)).toBeLessThanOrEqual(1);
  expect(toksvigRoughness(0, 0)).toBeLessThanOrEqual(1);
});

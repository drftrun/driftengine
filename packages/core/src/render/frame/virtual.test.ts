import { expect, test } from 'vitest';
import {
  createVirtualTable,
  declareVirtual,
  resetVirtualTable,
  virtualBytes,
  virtualCount,
  virtualKind,
} from './virtual.ts';

test('a declared texture comes back with its own identifier and its byte size', () => {
  const table = createVirtualTable(8);
  const id = declareVirtual(table, { kind: 'texture', width: 64, height: 32, bytesPerTexel: 4 });
  expect(id).toBe(0);
  expect(virtualKind(table, id)).toBe(0);
  expect(virtualBytes(table, id)).toBe(64 * 32 * 4);
});

test('identifiers are dense, so a second declaration is one past the first', () => {
  const table = createVirtualTable(8);
  declareVirtual(table, { kind: 'texture', width: 8, height: 8, bytesPerTexel: 4 });
  const second = declareVirtual(table, { kind: 'buffer', bytes: 256 });
  expect(second).toBe(1);
  expect(virtualKind(table, second)).toBe(1);
  expect(virtualBytes(table, second)).toBe(256);
});

test('a reset empties the table without reallocating it', () => {
  const table = createVirtualTable(8);
  declareVirtual(table, { kind: 'buffer', bytes: 16 });
  const store = table.bytes;
  resetVirtualTable(table);
  expect(virtualCount(table)).toBe(0);
  expect(table.bytes).toBe(store);
});

test('declaring past capacity grows the table and keeps every earlier entry', () => {
  const table = createVirtualTable(1);
  const first = declareVirtual(table, { kind: 'buffer', bytes: 16 });
  const second = declareVirtual(table, { kind: 'buffer', bytes: 32 });
  expect(virtualBytes(table, first)).toBe(16);
  expect(virtualBytes(table, second)).toBe(32);
});

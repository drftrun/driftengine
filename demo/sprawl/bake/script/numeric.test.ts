import { describe, expect, it } from 'vitest';

import { arithmetic, convert, cRound, operatorTypes } from './numeric.ts';
import type { Operand, ScalarType } from './numeric.ts';

const variable = (type: ScalarType, value = 1): Operand => ({ type, literal: false, value });
/** A literal as the language types it: `u64` when non-negative, `i64` when negative, `f64` with a point. */
const literal = (text: string): Operand => {
  const value = Number(text);
  return {
    type: text.includes('.') ? 'f64' : value < 0 ? 'i64' : 'u64',
    literal: true,
    value,
  };
};

describe('script numbers', () => {
  it('AN F32 EXPRESSION ROUNDS AFTER EVERY OPERATION, AS THE LANGUAGE COMPUTES IT', () => {
    /* `w * 0.1` assigned to an f32 member: the literal narrows to f32 and so does the product. */
    expect(operatorTypes('*', variable('f32'), literal('0.1'), 'f32').operand).toBe('f32');
    const tenth = convert(0.1, 'f32');
    expect(tenth).toBe(0.10000000149011612);
    expect(arithmetic('*', 3, tenth, 'f32')).toBe(0.30000001192092896);
    /* Assigned to something untyped, the same expression is f64 throughout. */
    expect(operatorTypes('*', variable('f32'), literal('0.1'), null).operand).toBe('f64');
    expect(arithmetic('*', 3, 0.1, 'f64')).toBe(0.30000000000000004);
  });

  it('divides in f32 when the left side is f32, and in f64 when it is an integer', () => {
    expect(operatorTypes('/', variable('f32'), variable('f64'), null)).toEqual({
      operand: 'f32',
      result: 'f32',
    });
    expect(operatorTypes('/', variable('i32'), literal('2'), null).result).toBe('f64');
    expect(operatorTypes('%', variable('f64'), literal('3'), null).result).toBe('i64');
  });

  it('narrows an integer literal to the smallest type, which decides whether i32 arithmetic stays i32', () => {
    /* 17 is u8, which i32 holds without loss: i32, and it wraps. */
    expect(operatorTypes('*', variable('i32'), literal('17'), null).operand).toBe('i32');
    expect(arithmetic('*', 2 ** 30, 4, 'i32')).toBe(0);
    /* 70000 is u32, which i32 cannot hold: the two meet at i64. */
    expect(operatorTypes('*', variable('i32'), literal('70000'), null).operand).toBe('i64');
  });

  it('meets mixed signs at i64, and turns an unsigned difference signed', () => {
    /* A colour channel minus a literal: 4 is an unsigned literal, so this is u8, and wraps. */
    expect(operatorTypes('-', variable('u8'), literal('4'), null).operand).toBe('u8');
    expect(arithmetic('-', 2, 4, 'u8')).toBe(254);
    /* Plus a negative literal: i8 against u8, which have no lossless meeting point. */
    expect(operatorTypes('+', variable('u8'), literal('-4'), null).operand).toBe('i64');
    /* Two generator draws, subtracted. */
    expect(operatorTypes('-', variable('u64'), variable('u64'), null).operand).toBe('i64');
    /* Unless the hint takes one side: i32 goes to an f32 hint and u32 cannot, so the two meet
       as floats rather than as signed integers. */
    expect(operatorTypes('+', variable('u32'), variable('i32'), null).operand).toBe('i64');
    expect(operatorTypes('+', variable('u32'), variable('i32'), 'f32').operand).toBe('f64');
  });

  it('compares a float with a literal in the float’s own type', () => {
    expect(operatorTypes('==', variable('f32'), literal('0.3'), null)).toEqual({
      operand: 'f32',
      result: 'bool',
    });
    expect(operatorTypes('<', variable('f32'), variable('f64'), null).operand).toBe('f64');
  });

  it('converts as a C cast does: truncating toward zero and wrapping to the width', () => {
    expect(convert(-7.9, 'i64')).toBe(-7);
    expect(arithmetic('%', -7, 3, 'i64')).toBe(-1);
    expect(convert(2 ** 31, 'i32')).toBe(-(2 ** 31));
    expect(convert(300, 'u8')).toBe(44);
    expect(convert(-1, 'u8')).toBe(255);
    expect(() => convert(2 ** 60, 'i64')).toThrow(/2\^53/);
  });

  it("rounds halves away from zero, as C's round does", () => {
    expect(cRound(2.5)).toBe(3);
    expect(cRound(-2.5)).toBe(-3);
    expect(cRound(0.49999999999999994)).toBe(0);
    expect(cRound(-0.4)).toBe(-0);
  });
});

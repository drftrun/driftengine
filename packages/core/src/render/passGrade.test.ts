import { describe, expect, it } from 'vitest';
import { interfaceGrade, passGradeCode, passGradeExposure } from './passGrade.ts';

describe('passGrade', () => {
  /*
   * **PAST THE PRESENT A PASS GRADES ITSELF, COMPOSITE OR NOT.** Under `hdrScene` the resolve grades
   * the frame, so a pass inside it draws linear; a pass after `endFrame` lands on what the resolve
   * wrote and used to stay linear too, the one surface on screen read as a display value.
   */
  it('PAST THE PRESENT A PASS GRADES ITSELF EVEN WHERE THE RESOLVE GRADES THE FRAME', () => {
    expect(passGradeCode(false, false, true, 'aces')).toBe(0);
    expect(passGradeExposure(false, false, true, 1.4)).toBe(1);
    expect(passGradeCode(false, true, true, 'aces')).toBe(2);
    expect(passGradeExposure(false, true, true, 1.4)).toBe(1.4);
  });

  it('grades with the forward code wherever no resolve grades, and filmic as aces', () => {
    expect(passGradeCode(false, false, false, 'none')).toBe(0);
    expect(passGradeCode(false, false, false, 'srgb')).toBe(1);
    expect(passGradeCode(false, false, false, 'aces')).toBe(2);
    expect(passGradeCode(false, false, false, 'shoulder')).toBe(3);
    expect(passGradeCode(false, true, false, 'filmic')).toBe(2);
    expect(passGradeExposure(false, false, false, 0.8)).toBe(0.8);
  });

  it('never grades a probe face or a capture, which store radiance', () => {
    expect(passGradeCode(true, false, false, 'srgb')).toBe(0);
    expect(passGradeCode(true, true, true, 'aces')).toBe(0);
    expect(passGradeExposure(true, true, false, 1.4)).toBe(1);
  });

  /*
   * **AN INTERFACE TAKES THE SCREEN ENCODE AND NEVER THE CURVE**: a caption under `aces` used to be
   * tone mapped like the world, white text coming out grey and a dark panel crushed to black.
   */
  it('AN INTERFACE TAKES THE SCREEN ENCODE AND NEVER THE CURVE', () => {
    expect(interfaceGrade(2)).toBe(1);
    expect(interfaceGrade(3)).toBe(1);
    expect(interfaceGrade(1)).toBe(1);
    expect(interfaceGrade(0)).toBe(0);
  });
});

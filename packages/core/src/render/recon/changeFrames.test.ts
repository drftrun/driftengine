import { describe, expect, it } from 'vitest';
import { frameOfChange, keepsPrevious, pairedInstances } from './changeFrames.ts';

describe('change frames', () => {
  it('A CHANGE MADE BETWEEN FRAMES BELONGS TO THE FRAME ABOUT TO BE DRAWN', () => {
    /* Serial 41 is the frame last begun. Inside it, a change is frame 41's; outside it, 42's. */
    expect(frameOfChange(41, true)).toBe(41);
    expect(frameOfChange(41, false)).toBe(42);
  });

  it('only the first change of a frame keeps the state before it', () => {
    expect(keepsPrevious(41, 42)).toBe(true);
    expect(keepsPrevious(42, 42)).toBe(false);
    expect(keepsPrevious(-1, 0)).toBe(true);
  });

  it('only slots that existed last frame pair with a previous', () => {
    expect(pairedInstances(10, 12)).toBe(10);
    expect(pairedInstances(12, 10)).toBe(10);
    expect(pairedInstances(0, 5)).toBe(0);
  });
});

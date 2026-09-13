import { describe, expect, it, vi } from 'vitest';

import { openSteam } from './main.ts';

describe('openSteam', () => {
  /*
   * **Three ordinary failures, and none of them may throw.** The manifest named no app; the module
   * is not installed; the copy was launched outside Steam. The last of those is every run during
   * development, so a game that refused to start without a store would be a game nobody could
   * develop.
   */
  it('answers null when the manifest named no app, without looking for anything', () => {
    expect(openSteam(null, '/nowhere')).toBeNull();
  });

  it('answers null when the module is not installed, and says which reason it was', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(openSteam(480, '/nowhere-at-all')).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/Steam is not available/));
    log.mockRestore();
  });
});

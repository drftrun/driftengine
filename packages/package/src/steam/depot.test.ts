import { describe, expect, it } from 'vitest';

import { depotScripts } from './depot.ts';

describe('depotScripts', () => {
  const scripts = depotScripts({
    appId: 480,
    depotId: 481,
    description: 'Title 1.2.3 linux-x64',
    contentRoot: 'content',
    branch: null,
  });

  /*
   * Steam's build system is two files handed to `steamcmd`, and their shape is not guessable —
   * which is exactly why they are generated from the manifest rather than written by hand once
   * and copied between projects with the wrong app id left in.
   */
  it('names the app and points at its depot script', () => {
    expect(scripts.app).toMatch(/"appid"\s+"480"/);
    expect(scripts.app).toMatch(/"481"\s+"depot_build_481.vdf"/);
    expect(scripts.app).toMatch(/Title 1\.2\.3 linux-x64/);
  });

  it('maps the whole content root into the depot', () => {
    expect(scripts.depot).toMatch(/"DepotID"\s+"481"/);
    expect(scripts.depot).toMatch(/"recursive"\s+"1"/);
  });

  /*
   * **Nothing is set live by default.** A build that lands on a branch the moment it uploads is a
   * release nobody reviewed; `setlive` stays empty unless a branch is named, which is the same
   * default Valve's own template ships with and the one people delete by accident.
   */
  it('sets no branch live unless one is named', () => {
    expect(scripts.app).toMatch(/"setlive"\s+""/);
    const staged = depotScripts({
      appId: 480,
      depotId: 481,
      description: 'x',
      contentRoot: 'content',
      branch: 'beta',
    });
    expect(staged.app).toMatch(/"setlive"\s+"beta"/);
  });

  /* A depot id defaults to the app id plus one, which is how Steam numbers a first depot. */
  it('has file names that steamcmd will find', () => {
    expect(scripts.appFileName).toBe('app_build_480.vdf');
    expect(scripts.depotFileName).toBe('depot_build_481.vdf');
  });
});

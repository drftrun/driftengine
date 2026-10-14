import { describe, expect, it } from 'vitest';

import { toolStart } from './spawnTool.ts';

describe('toolStart', () => {
  it('starts a tool as it is everywhere but a batch file on Windows', () => {
    expect(toolStart('/sdk/bin/sdkmanager', ['--licenses'], 'linux')).toEqual({
      command: '/sdk/bin/sdkmanager',
      args: ['--licenses'],
      windowsVerbatimArguments: false,
    });
    expect(toolStart('C:\\tools\\unzip.exe', ['-q'], 'win32').command).toBe('C:\\tools\\unzip.exe');
    expect(toolStart('/sdk/bin/run.bat', [], 'darwin').command).toBe('/sdk/bin/run.bat');
  });

  /*
   * **The case the rule exists for**: `spawn` of a `.bat` throws `EINVAL` on any Node since the
   * April 2024 security releases, so `sdkmanager.bat` and `gradle.bat` go through `cmd.exe`, each
   * part quoted so a path with a space in it stays one argument.
   */
  it('starts a batch file on Windows through cmd.exe, every part quoted', () => {
    const start = toolStart(
      'C:\\Users\\A User\\drift\\android-sdk\\cmdline-tools\\latest\\bin\\sdkmanager.bat',
      ['--sdk_root=C:\\Users\\A User\\drift\\android-sdk', '--licenses'],
      'win32',
    );
    expect(start).toEqual({
      command: 'cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        '""C:\\Users\\A User\\drift\\android-sdk\\cmdline-tools\\latest\\bin\\sdkmanager.bat" "--sdk_root=C:\\Users\\A User\\drift\\android-sdk" "--licenses""',
      ],
      windowsVerbatimArguments: true,
    });
    expect(toolStart('C:\\gradle\\bin\\GRADLE.CMD', ['say "hi"'], 'win32').args[3]).toBe(
      '""C:\\gradle\\bin\\GRADLE.CMD" "say ""hi""""',
    );
  });
});

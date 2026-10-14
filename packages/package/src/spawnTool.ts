/**
 * How a tool is started, which on Windows depends on what the tool is.
 *
 * **A batch file is not something Node will start on its own any more.** Since the April 2024
 * security releases (CVE-2024-27980, Node 18.20.2, 20.12.2 and 21.7.3 onward), `spawn` of a
 * `.bat` or `.cmd` without a shell throws `EINVAL` before anything runs, and the packager's
 * Android toolchain on Windows is two of them: `sdkmanager.bat` and `gradle.bat`. A build on
 * Windows then stopped at `accepting the Android SDK licences…` with `spawn EINVAL` and nothing
 * else.
 *
 * **So a batch file goes through `cmd.exe`, with every argument quoted by hand**: `/d` leaves out
 * the AutoRun commands, `/s /c` keeps the quoting of the one line it is given, and
 * `windowsVerbatimArguments` passes that line as it is. Each part is quoted (an SDK root under a
 * user's folder can hold a space) with its own quotes doubled, as cmd reads them. `shell: true`
 * would do the same with Node's quoting, which leaves an argument with a space split in two.
 *
 * Everything else, and every batch file elsewhere, starts as it always did.
 */
export interface ToolStart {
  readonly command: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments: boolean;
}

const quote = (part: string): string => `"${part.replace(/"/g, '""')}"`;

export function toolStart(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): ToolStart {
  if (platform !== 'win32' || !/\.(bat|cmd)$/i.test(command)) {
    return { command, args, windowsVerbatimArguments: false };
  }
  const line = [command, ...args].map(quote).join(' ');
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

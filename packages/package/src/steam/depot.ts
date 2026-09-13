/**
 * The two files `steamcmd` needs to upload a build, generated from the manifest.
 *
 * **Written rather than copied**, because the alternative is a template with somebody else's app
 * id in it. A wrong app id uploads a game into another game's depot, or fails after the whole
 * payload has crossed the network; a wrong depot id ships a build nobody can install.
 *
 * **Nothing is set live.** `setlive` is empty unless a branch is named, so an upload is a build
 * sitting in Steam's admin waiting for a person, not a release. Valve's own template does the same
 * and it is the line people delete by accident.
 *
 * Pure: the strings are the whole of it, and every rule above is a test.
 */
export interface DepotOptions {
  readonly appId: number;
  readonly depotId: number;
  readonly description: string;
  /** Relative to where the scripts are written. */
  readonly contentRoot: string;
  /** A branch to publish to, or null to upload and stop. */
  readonly branch: string | null;
}

export interface DepotScripts {
  readonly appFileName: string;
  readonly app: string;
  readonly depotFileName: string;
  readonly depot: string;
}

export function depotScripts(options: DepotOptions): DepotScripts {
  const depotFileName = `depot_build_${options.depotId}.vdf`;
  return {
    appFileName: `app_build_${options.appId}.vdf`,
    app: `"appbuild"
{
\t"appid"\t"${options.appId}"
\t"desc"\t"${options.description}"
\t"buildoutput"\t"./steam-build-output"
\t"contentroot"\t"./${options.contentRoot}"
\t"setlive"\t"${options.branch ?? ''}"
\t"preview"\t"0"
\t"local"\t""

\t"depots"
\t{
\t\t"${options.depotId}"\t"${depotFileName}"
\t}
}
`,
    depotFileName,
    depot: `"DepotBuildConfig"
{
\t"DepotID"\t"${options.depotId}"
\t"contentroot"\t"./${options.contentRoot}"

\t"FileMapping"
\t{
\t\t"LocalPath"\t"*"
\t\t"DepotPath"\t"."
\t\t"recursive"\t"1"
\t}

\t"FileExclusion"\t"*.pdb"
\t"FileExclusion"\t"*.log"
}
`,
  };
}

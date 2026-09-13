import type { PackageManifest } from '../manifest.ts';

/**
 * The PowerShell a consumer needs on the machine that builds their Windows artifacts.
 *
 * **This is a template and not a shipped script because it has to be a file in their repository**:
 * something has to start Node on that machine, and that something cannot live inside a Node
 * program. Everything in it that could have lived in `drift-package` already does — see
 * `runtime.ts` and `identity.ts`.
 *
 * **Pure ASCII, and `scripts/packaging.test.mjs` asserts it.** Windows PowerShell 5.1, which is
 * what a fresh Windows machine runs, reads a BOM-less `.ps1` in the system ANSI codepage rather
 * than as UTF-8, so one typographic character in a comment arrives as mojibake and takes the
 * *parser* with it — four errors deep, pointing at lines whose content is fine, and invisible from
 * Linux.
 */
export function buildWindowsScript(manifest: PackageManifest): string {
  const name = manifest.name;
  const local = `${manifest.id.split('.').pop() ?? 'drift'}-build`;
  return `# Build the Windows artifacts for ${name}, on Windows, because they are not cross-built.
#
# KEEP THIS FILE PURE ASCII. Windows PowerShell 5.1 -- what a fresh Windows machine runs -- reads a
# .ps1 with no byte-order mark in the system ANSI codepage, not as UTF-8. A single typographic
# character in a comment arrives as mojibake and takes the parser with it, four errors deep,
# pointing at lines whose real content is fine. Nothing on Linux would ever show it.
#
# Wine can produce an NSIS installer from Linux and cannot reach a Windows certificate store, so
# the one platform whose warnings are hardest to shake would be the one built with no way to sign
# it properly.
#
#   .\\scripts\\build-windows.ps1
#   $env:WIN_CSC_LINK = 'C:\\certs\\code.pfx'; $env:WIN_CSC_KEY_PASSWORD = '...'   # when there is one
#
# With no certificate the build succeeds and is unsigned: SmartScreen warns on first launch.
#
# Written by \`drift-package init\`. Edit it and it is yours; init will not overwrite it without
# --force.

$ErrorActionPreference = 'Stop'
$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$SourceDir = $ProjectDir

function Require-Command($name, $hint) {
  if ($null -eq (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "$name is not on PATH. $hint"
  }
}

Require-Command node 'Install Node 22.12 or newer from https://nodejs.org'
Require-Command npm  'It ships with Node'

$version = (node --version).TrimStart('v')
if ([version]($version -split '-')[0] -lt [version]'22.12.0') {
  throw "Node $version is too old; this project needs 22.12.0 or newer"
}

if (-not (Test-Path (Join-Path $ProjectDir 'drift.package.json'))) {
  throw "No drift.package.json in $ProjectDir. That file is what a build is configured from."
}

# ELECTRON_RUN_AS_NODE turns Electron into plain Node, and an Electron-based terminal sets it for
# everything it spawns. Inherited, the build produces an artifact that dies on 'Cannot find module
# electron' with a Node banner, which looks nothing like its cause.
Remove-Item Env:\\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

# A native command's exit code does not trip $ErrorActionPreference.
#
# That preference governs PowerShell cmdlets. npm is an external program: a non-zero exit sets
# $LASTEXITCODE and otherwise does nothing. So a failing step could print a real, useful error, the
# script would carry straight on, and the only thing left to read was a complaint about a directory
# that was never going to exist. PowerShell 7.3 has $PSNativeCommandUseErrorActionPreference and
# 5.1 does not, so it is checked by hand and each step says which step it was.
function Invoke-Step($what, [scriptblock] $step) {
  Write-Host "\`n== $what"
  & $step
  if ($LASTEXITCODE -ne 0) {
    throw "$what failed with exit code $LASTEXITCODE. The reason is in the output above this line."
  }
}

# A build on a mapped or network drive relocates itself to a local disk first.
#
# Node's fs.cp refuses to copy a thing into itself and decides that by comparing dev and ino of the
# destination's parents against the source. A redirector that gets no file index from the server
# invents one, and on Windows dev is already the volume serial number -- so a file and a directory
# come back identical and the first staging copy fails, talking about subdirectories of itself.
# \`drift-package doctor\` refuses that up front and names --out=<dir>; this relocates instead,
# because the artifacts have to end up back in the checkout either way.
#
# node_modules is deliberately not copied: it is reinstalled locally, which is also what stops a
# Windows npm ci from overwriting a Linux checkout's tree when the share is one in use.
$root = [System.IO.Path]::GetPathRoot($ProjectDir)
$driveType = $null
try {
  $driveType = (New-Object System.IO.DriveInfo($root)).DriveType
} catch {
  # An unusual root is not worth failing a build over; treat it as fixed and let the build speak.
}

if ($driveType -ne $null -and $driveType -ne 'Fixed') {
  $local = Join-Path $env:LOCALAPPDATA '${local}'
  Write-Warning ("$ProjectDir is on a $driveType drive, which cannot hold this build. Copying to " +
    "$local and building there instead.")
  Write-Host ''
  Write-Host "== robocopy to $local"
  robocopy $ProjectDir $local /E /XD node_modules out dist .git /NFL /NDL /NJH /NJS /NP
  # robocopy's exit code is a bitmask, not a status: under 8 means it did its job, and 1 is "files
  # were copied", which is the ordinary success and reads as failure to every other tool.
  if ($LASTEXITCODE -ge 8) {
    throw "robocopy failed with exit code $LASTEXITCODE while copying $ProjectDir to $local."
  }
  $global:LASTEXITCODE = 0
  $ProjectDir = $local
  Write-Host "Building from $ProjectDir"
}

Push-Location $ProjectDir
try {
  Invoke-Step 'npm ci' { npm ci }
  Invoke-Step 'drift-package doctor' { node scripts/package.mjs doctor }
  Invoke-Step 'drift-package build' { node scripts/package.mjs build --target=win-x64 }

  # Built, said it succeeded, and produced nothing: worth its own sentence rather than an ENOENT
  # from Get-ChildItem, which is what this looks like otherwise.
  $out = Join-Path $ProjectDir 'out\\win-x64'
  if (-not (Test-Path $out)) {
    throw ('The build reported success and ' + $out + ' does not exist. Nothing was packaged. ' +
      'Run the build step on its own and read what it prints.')
  }

  # The artifacts go back to the checkout this was run from.
  #
  # Relocating the build makes this necessary, and it is easy to miss: the build succeeds, says so,
  # lists its files, and out\\ in the project is empty because the build happened somewhere else.
  # robocopy and not fs.cp: this writes back onto the share, and fs.cp is exactly what will not
  # cross it.
  if ($SourceDir -ne $ProjectDir) {
    $back = Join-Path $SourceDir 'out\\win-x64'
    Write-Host ''
    Write-Host "== copying the artifacts back to $back"
    robocopy $out $back /E /NFL /NDL /NJH /NJS /NP
    if ($LASTEXITCODE -ge 8) {
      throw ("The build succeeded but copying the artifacts from $out back to $back failed with " +
        "robocopy exit code $LASTEXITCODE. They are still in $out -- nothing is lost.")
    }
    $global:LASTEXITCODE = 0
    $out = $back
  }

  Write-Host "\`nArtifacts:"
  Get-ChildItem -Path $out -File | ForEach-Object { $_.FullName }

  if (-not ($env:WIN_CSC_LINK -or $env:CSC_LINK)) {
    Write-Host ""
    Write-Host "This build is unsigned. Windows will run it; SmartScreen warns on first launch."
    Write-Host "A Steam depot raises no warning, because the client delivering it is signed."
    Write-Host "An OV certificate in WIN_CSC_LINK removes the warning for direct downloads."
  }
} finally {
  Pop-Location
}
`;
}

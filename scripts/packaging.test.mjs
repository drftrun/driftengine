/**
 * The two Windows defects that cannot be seen from Linux.
 *
 * **Everything this repository knows about packaging for Windows was learned on a machine none of
 * us is sitting at.** A consumer took a game to Linux, Windows and Android and reported both of
 * these; neither produces a symptom on the platform the suite runs on, and neither is the kind of
 * thing a reviewer catches by reading.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/** Every `.ps1` this repository ships, wherever it lives. */
function shippedScripts(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) shippedScripts(full, out);
    else if (full.endsWith('.ps1')) out.push(full);
  }
  return out;
}

/**
 * The PowerShell `drift-package init` writes, rendered rather than read.
 *
 * Read through the template's own function, so what is asserted is what a consumer receives and not
 * a file that happens to sit beside it.
 */
async function generatedScript() {
  const { buildWindowsScript } = await import('../packages/package/src/templates/buildWindows.ts');
  return buildWindowsScript({
    id: 'dev.example.title',
    name: 'Title',
    targets: ['win-x64'],
  });
}

/**
 * **Windows PowerShell 5.1 reads a BOM-less `.ps1` in the system ANSI codepage, not as UTF-8.**
 *
 * So one typographic character in a comment arrives as mojibake and takes the *parser* with it. A
 * consumer measured an em dash becoming `a<200><174>` and killing a script with "Unexpected token
 * 'a' in expression or statement", four errors deep, pointing at lines whose real content was
 * fine — and 5.1 is what a fresh Windows machine runs, so this is not an old-version problem that
 * ages out.
 *
 * **Nothing on Linux would ever show it**, which is the entire reason this is a gate. An editor
 * that helpfully turns a hyphen into a dash is all it takes.
 */
test('every PowerShell script this repository ships or generates is pure ASCII', async () => {
  const subjects = shippedScripts(path.join(ROOT, 'packages')).map((file) => [
    path.relative(ROOT, file),
    readFileSync(file, 'utf8'),
  ]);
  subjects.push(['drift-package init: scripts/build-windows.ps1', await generatedScript()]);

  const offenders = [];
  for (const [where, source] of subjects) {
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch.charCodeAt(0) < 128) continue;
        offenders.push(
          `${where}:${i + 1} has U+${ch.codePointAt(0).toString(16).padStart(4, '0')} ${ch}`,
        );
        break;
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'PowerShell 5.1 parses a BOM-less .ps1 in the ANSI codepage, so one of these takes the parser ' +
      `with it on a machine nobody here is sitting at:\n  ${offenders.join('\n  ')}`,
  );

  /*
   * **Not a count, because the count is allowed to be one.** This repository ships no `.ps1` of its
   * own any more — `drift-package init` writes the one a consumer runs — so the walk legitimately
   * finds nothing and the only subject that must always be here is the generated script. Asserting
   * a total was the first version of this line and it failed the moment the shipped copy was
   * deleted, which is a guard measuring the wrong thing.
   */
  const generated = subjects.find(([where]) => where.startsWith('drift-package init:'));
  assert.ok(generated !== undefined, 'the generated script was not scanned');
  assert.ok(generated[1].length > 500, 'the generated script came back empty or near-empty');
});

/**
 * **`$ErrorActionPreference = 'Stop'` governs cmdlets, not native commands.**
 *
 * `npm` and `node` are external programs: a non-zero exit sets `$LASTEXITCODE` and does nothing
 * else. So a failing step prints a real, useful error, the script carries straight on, and the
 * reader is left holding a complaint about an output directory that was never going to exist while
 * the cause has scrolled off. PowerShell 7.3 has `$PSNativeCommandUseErrorActionPreference`;
 * **5.1, which is what a fresh machine runs, does not**, so it is checked by hand or not at all.
 *
 * This repository shipped a `build-windows.ps1` with **zero** `$LASTEXITCODE` checks until
 * 2026-08-29, which is a defect of omission — and omission is what a gate is for.
 *
 * **That shipped copy was deleted rather than repaired**, because two scripts that do the same
 * thing drift and only one of them is the one a consumer actually runs. `drift-package init`
 * writes the one they run, and this reads it from the same template.
 *
 * **What this gives up:** it recognises a command at statement position with a regular expression,
 * and PowerShell can express a call in ways that will not match. A false negative is the failure
 * mode. It is affordable because the file being scanned is one this repository writes and is
 * short; it is deliberately not pointed at a consumer's own scripts, where it would be a guess.
 */
test('every native command in generated PowerShell checks its exit code', async () => {
  const source = await generatedScript();
  assert.ok(source.includes('function Invoke-Step'), 'the generated script defines no Invoke-Step');
  assert.ok(source.includes('$LASTEXITCODE'), 'the generated script never reads $LASTEXITCODE');

  const offenders = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    /* A comment is prose, and `#` starts one. */
    if (/^\s*#/.test(line)) continue;
    const call = /^\s*(npm|node)\s/.exec(line);
    if (call === null) continue;
    if (line.includes('Invoke-Step')) continue;
    offenders.push(`${i + 1}: ${line.trim()}`);
  }
  assert.deepEqual(
    offenders,
    [],
    'these run outside Invoke-Step, so a non-zero exit is silently ignored and the failure ' +
      `arrives as a missing directory:\n  ${offenders.join('\n  ')}`,
  );

  /* robocopy is the exception and carries its own check, because its exit code is a bitmask: under
     8 means success and 1 means "files were copied", which reads as failure to everything else. */
  if (source.includes('robocopy')) {
    assert.match(source, /LASTEXITCODE -ge 8/, 'robocopy is called without its bitmask check');
  }
});

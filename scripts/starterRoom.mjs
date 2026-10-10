/**
 * That a project `npm create @driftengine` starts typechecks, passes its tests and builds, from the
 * packed tarballs rather than from this tree.
 *
 * **The clean room is the only place this can be true or false.** Inside the workspace every
 * `@driftengine/*` import resolves to source through a symlink, so a template that leans on
 * something only the source has — a condition, a path, a type that the build leaves out — compiles
 * here and fails for every stranger. `cleanroom.mjs` has already packed and extracted every package
 * into a room outside the checkout; this starts each template from the extracted
 * `@driftengine/create`, gives the project those same packages, and runs the scripts a person or an
 * agent would run first.
 *
 * The third-party half — Vite, Vitest, TypeScript, the language — comes from the registry, as it
 * would for anybody. The engine half is copied from the room, never fetched, so what is tested is
 * the tree in front of it even before a version is published.
 *
 * `--look` also runs `npm run look`, which needs a browser and a hardware GPU and so is opt-in.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** The npm in use, launched through this Node so Windows needs no `.cmd` shim or shell. */
function npm(args, cwd) {
  const cli = process.env['npm_execpath'];
  if (cli !== undefined && cli.endsWith('.js')) {
    return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
  }
  return spawnSync('npm', args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' });
}

/**
 * The third-party packages a set of engine packages needs, following engine dependencies down.
 *
 * Only what the project reaches, so a starter that uses three packages does not install the
 * packager's Electron or the native host's window to prove it builds.
 */
export function thirdPartyClosure(modules, roots) {
  const seen = new Set();
  const external = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const manifest = JSON.parse(
      readFileSync(path.join(modules, name.split('/')[1], 'package.json'), 'utf8'),
    );
    const deps = { ...manifest.dependencies, ...manifest.peerDependencies };
    for (const [dep, range] of Object.entries(deps)) {
      if (dep.startsWith('@driftengine/')) visit(dep);
      else if (!(manifest.peerDependenciesMeta?.[dep]?.optional ?? false))
        external.add(`${dep}@${range}`);
    }
  };
  for (const root of roots) visit(root);
  return [...external].sort();
}

/**
 * Start every template in `room`, install it against the extracted packages, and run its scripts.
 * Returns the number of failures, having printed one line per step.
 */
export function checkStarters({ room, modules, look = false }) {
  const create = path.join(modules, 'create');
  const templates = readdirSync(path.join(create, 'templates')).filter((name) =>
    existsSync(path.join(create, 'templates', name, 'template.json')),
  );
  let failed = 0;
  console.log('\nstarted projects');
  for (const template of templates) {
    const name = `starter-${template}`;
    const dir = path.join(room, name);
    execFileSync(
      process.execPath,
      [path.join(create, 'bin', 'create.mjs'), name, '--template', template],
      {
        cwd: room,
        stdio: 'pipe',
      },
    );

    /* The registry half: the manifest without its engine ranges, so npm fetches none of them. */
    const manifestFile = path.join(dir, 'package.json');
    const manifest = readFileSync(manifestFile, 'utf8');
    const parsed = JSON.parse(manifest);
    const engine = Object.keys(parsed.dependencies).filter((dep) =>
      dep.startsWith('@driftengine/'),
    );
    for (const dep of engine) delete parsed.dependencies[dep];
    const external = thirdPartyClosure(modules, engine);
    writeFileSync(manifestFile, JSON.stringify(parsed));
    const installed = npm(
      ['install', '--no-save', '--silent', '--no-audit', '--no-fund', ...external],
      dir,
    );
    writeFileSync(manifestFile, manifest);
    if (installed.status !== 0) {
      console.log(`  ${name.padEnd(28)} npm install FAILED\n${indent(installed.stderr)}`);
      failed++;
      continue;
    }
    /* The engine half: the extracted packages, in the layout an install leaves. */
    cpSync(modules, path.join(dir, 'node_modules', '@driftengine'), { recursive: true });

    const steps = ['typecheck', 'test', 'build', ...(look ? ['look'] : [])];
    for (const step of steps) {
      const result = npm(['run', step, '--silent'], dir);
      const ok = result.status === 0;
      console.log(`  ${`${name} ${step}`.padEnd(34)}${ok ? 'ok' : 'FAILED'}`);
      if (step === 'look' || !ok) console.log(indent(`${result.stdout}${result.stderr}`));
      if (!ok) failed++;
    }
  }
  return failed;
}

const indent = (text) =>
  String(text ?? '')
    .trim()
    .split('\n')
    .slice(-40)
    .map((line) => `      ${line}`)
    .join('\n');

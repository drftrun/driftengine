#!/usr/bin/env node
/**
 * The `create-driftengine` executable, which `npm create @driftengine` runs.
 *
 * JavaScript because npm's `bin` runs under plain Node, and Node refuses to strip types from
 * anything under `node_modules`. The command itself is TypeScript, compiled into `dist/` before the
 * package is packed.
 */
import { main } from '../dist/cli.js';

process.exitCode = main(process.argv.slice(2), process.cwd());

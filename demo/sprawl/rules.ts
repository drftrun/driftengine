/**
 * `rules.drs`, hosted: what the keys mean in the city. The scene writes each frame's presses into
 * its `Keys` and reads the intents back from its `Play`.
 */
import * as rules from './rules.drs';
import { ScriptHost } from './scriptHost';

export function createRules(): ScriptHost {
  return new ScriptHost(rules as unknown as Record<string, unknown>, 'rules', ['Keys', 'Play']);
}

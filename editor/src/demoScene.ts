/**
 * A few props so there is something to select, move and take back.
 *
 * **The scene the editor opens on until a consumer hands it one**, on every host. It is a
 * `ShellScene` over two maps and nothing else, which is the point: the shell takes whatever a
 * consumer is holding through five methods, and this is the least that satisfies them.
 */
import type { ShellScene } from './shell.ts';

export function demoScene(): ShellScene {
  const positions = new Map<number, Float32Array>();
  const names = new Map<number, string>();
  for (let i = 0; i < 6; i += 1) {
    positions.set(i + 1, Float32Array.from([(i - 2.5) * 2.2, 0, 0]));
    names.set(i + 1, `prop ${String(i + 1)}`);
  }
  return {
    entities: () => [...positions.keys()],
    nameOf: (entity) => names.get(entity) ?? `entity ${String(entity)}`,
    radiusOf: () => 0.9,
    positionOf(entity, out) {
      const at = positions.get(entity);
      if (at === undefined) return false;
      out.set(at);
      return true;
    },
    setPosition(entity, x, y, z) {
      positions.get(entity)?.set([x, y, z]);
    },
    remove(entity) {
      positions.delete(entity);
    },
    restore(entity, x, y, z) {
      positions.set(entity, Float32Array.from([x, y, z]));
    },
  };
}

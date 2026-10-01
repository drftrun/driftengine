/**
 * How much of a container a stream needs before the regions a walker starts among are whole: every
 * one of them arrived, with every mesh their levels draw and their groups copy.
 *
 * **Measured the way the runtime meets it**, by feeding the written file to the engine's stream
 * reader a slice at a time and stopping where the last of it lands — so the figure counts what
 * the writer put ahead of the regions (the pictures, the kit, the scene) exactly as a player's
 * download does. It is the spec's first walkable frame, against the engine's 10 MB initial budget.
 */
import { DrftStream } from '@driftengine/drft';

/** The bytes a stream reads before every region in `ids` is whole, to the nearest `slice`. */
export function bytesUntil(buffer: ArrayBuffer, ids: ReadonlySet<number>, slice = 65536): number {
  const wanted = new Set<number>();
  const arrived = new Set<number>();
  let regions = 0;
  const stream = new DrftStream({
    onRegion: (region) => {
      if (!ids.has(region.id)) return;
      regions += 1;
      for (const level of region.levels) for (const mesh of level.meshes) wanted.add(mesh);
      for (const group of region.instances) wanted.add(group.mesh);
    },
    onMesh: (_, ordinal) => arrived.add(ordinal),
    onAssembly: (_, ordinal) => arrived.add(ordinal),
  });
  const bytes = new Uint8Array(buffer);
  const whole = (): boolean => {
    if (regions < ids.size) return false;
    for (const mesh of wanted) if (!arrived.has(mesh)) return false;
    return true;
  };
  for (let at = 0; at < bytes.length; at += slice) {
    const end = Math.min(at + slice, bytes.length);
    stream.push(bytes.subarray(at, end));
    if (whole()) return end;
  }
  return bytes.length;
}

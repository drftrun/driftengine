/**
 * The district's traffic in motion: the source's own movers, played back from the tracks the bake
 * sampled (`bake/movers.ts`) — every road car, taxi, flying car, sky cab, lift, train and boat.
 *
 * **Each model a batch, every placement rewritten each frame.** The movers' container places each
 * model's copies at rest; once it has arrived, each batch is told which movers its placements are
 * by its first copy's resting place, and from then on a frame interpolates every mover's position
 * and turn between two samples and writes it over its placement, in place.
 *
 * **Every placement every frame, in the same order**, rather than the near ones compacted to the
 * front: an instanced batch is its own identity to the reconstruction, which takes a copy's motion
 * from where the same copy stood last frame, so a copy that changed slot would streak.
 *
 * Nothing here allocates per frame once the batches are bound.
 */
import { DrftLoader, writePartMaterial } from '@driftengine/assets';
import { spawnBcWorker } from '@driftengine/assets/src/bcWorkers.ts';
import type { DrftPart } from '@driftengine/assets';
import type {
  RendererApi,
  ShadowCasters,
  SurfaceMaterial,
  SurfaceTextureHandle,
  TranslucentMeshOptions,
} from '../../packages/core/src/index';

import type { MoversFile } from './bake/movers';

const BLENDED: TranslucentMeshOptions = { depthWrite: false };

interface Bound {
  readonly part: DrftPart;
  readonly movers: readonly number[];
  readonly options: TranslucentMeshOptions | undefined;
}

/** A placement's resting place and copy count, which names its batch: rounded to a centimetre. */
const restKey = (count: number, x: number, y: number, z: number): string =>
  `${count}:${Math.round(x * 100)},${Math.round(y * 100)},${Math.round(z * 100)}`;

export class DistrictMovers {
  readonly loader: DrftLoader;
  private file: MoversFile | null = null;
  private tracks: Float32Array | null = null;
  private bound: Bound[] = [];
  private bindable = false;
  private readonly material: SurfaceMaterial<SurfaceTextureHandle> = {};
  /** Material changes the last frame's draws spent, for the mirror's allowance. */
  changes = 0;

  constructor(private readonly renderer: RendererApi) {
    this.loader = new DrftLoader(renderer, {
      bcWorker: spawnBcWorker,
      revealSec: 0,
      anisotropy: 16,
    });
  }

  /** Fetch the movers; resolves once their container has arrived. A district with none draws none. */
  async open(base: string): Promise<void> {
    const [file, tracks, container] = await Promise.all([
      fetch(`${base}/movers.json`),
      fetch(`${base}/movers.bin`),
      fetch(`${base}/movers.drft`),
    ]);
    const baked = (r: Response): boolean =>
      r.ok && !(r.headers.get('content-type') ?? '').includes('text/html');
    if (!baked(file) || !baked(tracks) || !baked(container)) return;
    this.file = (await file.json()) as MoversFile;
    this.tracks = new Float32Array(await tracks.arrayBuffer());
    await this.loader.consume(container, { fit: 'none' });
    this.bindable = true;
  }

  /** Bind each batch to its movers by where its first copy rests. */
  private bind(): void {
    const file = this.file;
    if (file === null) return;
    const byRest = new Map<string, readonly number[]>();
    for (const variant of file.variants) {
      const first = file.movers[variant.movers[0] ?? -1];
      if (first !== undefined)
        byRest.set(
          restKey(variant.movers.length, first.rest[0], first.rest[1], first.rest[2]),
          variant.movers,
        );
    }
    for (const part of this.loader.parts) {
      const instances = part.instances;
      if (instances === null) continue;
      const m = instances.data.models;
      const movers = byRest.get(
        restKey(instances.data.count, m[12] as number, m[13] as number, m[14] as number),
      );
      if (movers === undefined) continue;
      const options =
        part.glass !== null
          ? { ...BLENDED, glass: part.glass }
          : part.blend || part.opacity < 1
            ? BLENDED
            : undefined;
      this.bound.push({ part, movers, options });
    }
  }

  /** Advance the stream, and place every mover where it is `seconds` into the source's loop. */
  update(dt: number, seconds: number): void {
    this.loader.update(dt);
    if (
      this.bindable &&
      this.bound.length === 0 &&
      this.loader.parts.length > 0 &&
      this.loader.progress.phase === 'ready'
    )
      this.bind();
    const file = this.file;
    const tracks = this.tracks;
    if (file === null || tracks === null || this.bound.length === 0) return;
    for (const { part, movers } of this.bound) {
      const data = (part.instances as NonNullable<DrftPart['instances']>).data;
      const models = data.models;
      for (let k = 0; k < movers.length; k++) {
        const mover = movers[k] as number;
        const track = file.movers[mover] as MoversFile['movers'][number];
        const scale = track.scale;
        /* Its own loop, from where the scene's first frame stands in it. */
        const span = track.samples - 1;
        const u = ((((seconds + track.phase) * file.rate) % span) + span) % span;
        const i0 = Math.floor(u);
        const a = u - i0;
        const p = (track.offset + i0) * 7;
        const q = p + 7;
        let x = tracks[p + 3] as number;
        let y = tracks[p + 4] as number;
        let z = tracks[p + 5] as number;
        let w = tracks[p + 6] as number;
        /* The nearer of the two signs, so a turn through the seam of the hemisphere goes the short way. */
        const sign =
          x * (tracks[q + 3] as number) +
            y * (tracks[q + 4] as number) +
            z * (tracks[q + 5] as number) +
            w * (tracks[q + 6] as number) <
          0
            ? -1
            : 1;
        x += ((tracks[q + 3] as number) * sign - x) * a;
        y += ((tracks[q + 4] as number) * sign - y) * a;
        z += ((tracks[q + 5] as number) * sign - z) * a;
        w += ((tracks[q + 6] as number) * sign - w) * a;
        const n = Math.hypot(x, y, z, w) || 1;
        x /= n;
        y /= n;
        z /= n;
        w /= n;
        const o = k * 16;
        const sx = scale[0];
        const sy = scale[1];
        const sz = scale[2];
        models[o] = (1 - 2 * (y * y + z * z)) * sx;
        models[o + 1] = 2 * (x * y + z * w) * sx;
        models[o + 2] = 2 * (x * z - y * w) * sx;
        models[o + 3] = 0;
        models[o + 4] = 2 * (x * y - z * w) * sy;
        models[o + 5] = (1 - 2 * (x * x + z * z)) * sy;
        models[o + 6] = 2 * (y * z + x * w) * sy;
        models[o + 7] = 0;
        models[o + 8] = 2 * (x * z + y * w) * sz;
        models[o + 9] = 2 * (y * z - x * w) * sz;
        models[o + 10] = (1 - 2 * (x * x + y * y)) * sz;
        models[o + 11] = 0;
        models[o + 12] =
          (tracks[p] as number) + ((tracks[q] as number) - (tracks[p] as number)) * a;
        models[o + 13] =
          (tracks[p + 1] as number) + ((tracks[q + 1] as number) - (tracks[p + 1] as number)) * a;
        models[o + 14] =
          (tracks[p + 2] as number) + ((tracks[q + 2] as number) - (tracks[p + 2] as number)) * a;
        models[o + 15] = 1;
      }
      this.renderer.uploadInstanced(
        (part.instances as NonNullable<DrftPart['instances']>).batch,
        data,
      );
    }
  }

  /** The opaque movers, each batch in its own material. */
  draw(): void {
    this.changes = 0;
    this.drawWhere(false);
  }

  /** The movers' glass and anything blended, after everything opaque. */
  drawLater(): void {
    this.drawWhere(true);
  }

  private drawWhere(translucent: boolean): void {
    const renderer = this.renderer;
    const textures = this.loader.textures;
    for (const { part, options } of this.bound) {
      if ((options !== undefined) !== translucent) continue;
      const instances = part.instances as NonNullable<DrftPart['instances']>;
      writePartMaterial(part, textures, this.material);
      renderer.setMaterial(this.material);
      renderer.setSurfaceReflectivity(part.reflectivity);
      if (options !== undefined)
        renderer.drawTranslucentInstanced(instances.batch, instances.data, part.opacity, options);
      else renderer.drawInstanced(instances.batch, instances.data);
      this.changes++;
    }
    renderer.setMaterial(null);
  }

  /** What the movers shade with by day: every opaque batch. */
  readonly casters: ShadowCasters = (sink) => {
    if (sink.instanced === undefined) return;
    for (const { part, options } of this.bound) {
      if (options !== undefined || part.instances === null) continue;
      sink.instanced(part.instances.batch, part.instances.data);
    }
  };

  /** How many movers are bound and playing. */
  get playing(): number {
    return this.bound.length === 0 ? 0 : (this.file?.movers.length ?? 0);
  }

  dispose(): void {
    this.loader.dispose();
  }
}

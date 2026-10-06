/**
 * The model's packs as they arrive: one loader each, drawn with their whole material, and offered
 * to every depth pass as casters.
 *
 * **Nothing it draws is in this repository.** Each pack is a `.drft` baked from the source by
 * `npm run bake -- models/sponza/<pack> -o demo/dev/public/sponza-<pack>-<cap>.drft --max-texture
 * <cap> --texture-codec jpeg-all --normals-directx --simplify 0.001`, the base pack with `--sdf 0.25`
 * and the trees with `--blend-as-cutout`. A pack that is not there is said in the readout rather
 * than drawn as a hole.
 *
 * **Simplified to a millimetre.** Intel's packs were modelled for an offline renderer: eleven million
 * triangles, most smaller than a pixel at 4K, drawn in the frame, the sun's map and every probe face.
 * At a millimetre, which is a pixel at a metre and a half at 4K, the base pack keeps 40% of its
 * triangles, the ivy's leaves 57%, the curtains 60% and a candle's wax 25%: a view down the
 * courtyard at 4K went from 9.1 ms of GPU time to 8.0 at noon and from 30.5 to 27.5 at night. A held
 * capture of it differs in 2.6% of its pixels by more than 8 levels of 255, against 0.6% between two
 * captures of one bake, along edges and in the shading of the curtains' folds.
 *
 * `?packs=base+curtains` chooses which load (all of them by default), `?cap=` which bake, and
 * `?maps=albedo+normal+orm+emissive` which material maps are bound. A `+` and not a comma, because
 * the capture harness splits its `--urls` on commas and a comma here silently becomes a second
 * URL. The last is an instrument: when a surface looks wrong, switching its inputs off one at a
 * time says which one the wrongness leaves with. `?blend=0` is another: no blended part is drawn,
 * which is how the band beside a pier was found to be a decal (see `BLENDED`).
 */
import { DrftLoader, writePartMaterial } from '@driftengine/assets';
import { spawnBcWorker } from '@driftengine/assets/bcWorkers';
import { STONE_ALBEDO, paleFloor, stoneSurface } from './stone';
import { lanternGlass } from './glass';
import type { DrftLight } from '@driftengine/drft';
import type {
  GlassOptions,
  GlobalFieldInstance,
  MeshInstances,
  RendererApi,
  ShadowCasters,
  SurfaceMaterial,
  SurfaceTextureHandle,
  TranslucentMeshOptions,
} from '../../packages/core/src/index';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * **A blended part writes no depth.** The base pack's one blended material is its dirt decal: sheets
 * standing a centimetre or two off the stone they dirty, wrapped round every pier. Where a sheet
 * passes a corner it hangs in the air, and depth it wrote there is where every pass that reads the
 * frame's depth stops: the haze marched to a sheet 1.3 m away rather than the gallery 20 m behind
 * it, and a pier seen edge-on at dusk wore a clear band its whole height, 12 px of 1,930, which read
 * as a gap between the pier and the gallery. The stone behind each sheet already holds the sky off,
 * which is all a blended surface writes depth for. What it gives up is an order between overlapping
 * sheets, which blend in the order the file lists them. The lanterns' panes are the one blended part
 * standing in the open, and they are glass (`glass.ts`): a haze marching through a pane to the vault
 * behind it is what glass is, so they write no depth either.
 */
const BLENDED: TranslucentMeshOptions = { depthWrite: false };

/** The packs Intel ships beside the base scene, in the order they are loaded. */
const PACKS = ['base', 'curtains', 'ivy', 'trees', 'candles'] as const;
export type Pack = (typeof PACKS)[number];
/** The caps the census baked at. A name outside this list never reaches `fetch`. */
const CAPS = ['none', '2048', '1024'] as const;

/**
 * The packs to load: all of them but the cypress, unless the address bar asks.
 *
 * **The tree is opt-in, `?tree=1`.** It stands in the middle of the courtyard and fills the view
 * down its length, which is the view the scene is about, so by default the courtyard is shown as it
 * is built. `?packs=` names the packs outright and wins over both.
 */
function askedPacks(search: URLSearchParams): Pack[] {
  const asked = search.get('packs');
  if (asked === null || asked === '') {
    const tree = search.get('tree') === '1';
    return PACKS.filter((pack) => pack !== 'trees' || tree);
  }
  return PACKS.filter((pack) => asked.split(/[+,]/).includes(pack));
}

function askedCap(search: URLSearchParams): string {
  const asked = search.get('cap') ?? '1024';
  return (CAPS as readonly string[]).includes(asked) ? asked : '1024';
}

function askedMaps(search: URLSearchParams): Set<string> {
  const asked = search.get('maps');
  return new Set(asked === null ? ['albedo', 'normal', 'orm', 'emissive'] : asked.split(/[+,]/));
}

export class SponzaPacks {
  private readonly renderer: RendererApi;
  private readonly loaders: { pack: Pack; loader: DrftLoader; presence: number }[] = [];
  /** Each instanced part's full count, taken the first time it is seen. */
  private readonly fullCounts = new Map<MeshInstances, number>();
  private readonly maps: Set<string>;
  /** `?blend=0`: no blended part is drawn, the control for what the decals put on screen. */
  private readonly blended: boolean;
  /** One material, rewritten per part, so the part loop allocates nothing. */
  private readonly material: SurfaceMaterial<SurfaceTextureHandle> = {};
  /** The same, for the shadow casters, which run inside a pass the draw loop is not in. */
  private readonly casterMaterial: SurfaceMaterial<SurfaceTextureHandle> & {
    glass?: GlassOptions | undefined;
  } = {};
  /** A glass part's draw options, one per glass its loader made, so a frame builds none. */
  private readonly glassDraws = new Map<GlassOptions, TranslucentMeshOptions>();
  /** Every pack's parts, for the sun's map and every probe face. */
  readonly casters: ShadowCasters;

  constructor(renderer: RendererApi, search: URLSearchParams) {
    this.renderer = renderer;
    this.maps = askedMaps(search);
    this.blended = search.get('blend') !== '0';
    const cap = askedCap(search);
    for (const pack of askedPacks(search)) {
      const loader = new DrftLoader(renderer, {
        bcWorker: spawnBcWorker,
        anisotropy: 16,
        /*
         * A load behind a veil draws no world, so its frames can spend what a drawn one could not,
         * and a part has no fade to wait on because nobody sees it arrive.
         */
        uploadsPerFrame: 24,
        uploadMsPerFrame: 8,
        revealSec: 0,
        ...(pack === 'base'
          ? { surface: (m) => lanternGlass(m) ?? stoneSurface(m), transform: paleFloor }
          : {}),
      });
      /* Not awaited: the scene draws from the first frame and each pack appears when it lands. */
      void loader.load(`sponza-${pack}-${cap}.drft`, { fit: 'none' });
      this.loaders.push({ pack, loader, presence: 1 });
    }
    /*
     * Each caster offers its material, so a cutout (a leaf card, a chain link) casts the shape in its
     * texture rather than its whole quad. One object rewritten per part, so the list allocates nothing.
     */
    this.casters = (sink) => {
      const material = this.casterMaterial;
      for (const { loader, presence } of this.loaders) {
        if (presence <= 0) continue;
        const textures = loader.textures;
        for (const part of loader.parts) {
          /* A blended part here is a dirt decal off the stone, which would shadow the stone; a
             lantern's glass is offered as glass, which lets its flame's light through in its own
             colour — or casts nothing, where glass shadows are off. */
          if (part.blend && part.glass === null) continue;
          writePartMaterial(part, textures, material);
          material.glass = part.glass ?? undefined;
          if (part.instances !== null) {
            sink.instanced?.(part.instances.batch, part.instances.data, material);
          } else {
            sink.mesh(part.mesh, IDENTITY, material);
          }
        }
      }
    };
  }

  /**
   * How much of `pack` is present, 0 to 1. An instanced part draws that share of its copies, in file
   * order, and a pack at 0 draws and casts nothing.
   *
   * For the candles: ten thousand of them hang in the air, which reads as a spell after dark and as
   * clutter at noon. So they are absent by day and arrive at dusk, a share at a time.
   */
  setPresence(pack: Pack, presence: number): void {
    for (const entry of this.loaders) {
      if (entry.pack !== pack) continue;
      entry.presence = Math.min(1, Math.max(0, presence));
      for (const part of entry.loader.parts) {
        const data = part.instances?.data;
        if (data === undefined) continue;
        let full = this.fullCounts.get(data);
        if (full === undefined) {
          full = data.count;
          this.fullCounts.set(data, full);
        }
        data.count = Math.round(full * entry.presence);
      }
    }
  }

  /**
   * Drop every copy of `pack`'s instanced parts that `blocks` says stands in the path, once the pack has
   * finished loading: the survivors are packed down in place and uploaded again. Answers whether it
   * ran, so a caller asks each frame until it has.
   */
  clearInstances(pack: Pack, blocks: (x: number, y: number, z: number) => boolean): boolean {
    for (const entry of this.loaders) {
      if (entry.pack !== pack || entry.loader.progress.phase !== 'ready') continue;
      for (const part of entry.loader.parts) {
        const instances = part.instances;
        if (instances === null) continue;
        const data = instances.data;
        const full = this.fullCounts.get(data) ?? data.count;
        /* A matrix moves the prototype, which already stands at one copy's place: the copy is where
           the matrix takes the prototype's centre, not the matrix's translation. */
        const c = part.mesh.bounds.centre;
        const [cx, cy, cz] = [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0];
        const models = data.models;
        let kept = 0;
        for (let at = 0; at < full; at++) {
          const m = at * 16;
          const x = (models[m] ?? 0) * cx + (models[m + 4] ?? 0) * cy + (models[m + 8] ?? 0) * cz;
          const y =
            (models[m + 1] ?? 0) * cx + (models[m + 5] ?? 0) * cy + (models[m + 9] ?? 0) * cz;
          const z =
            (models[m + 2] ?? 0) * cx + (models[m + 6] ?? 0) * cy + (models[m + 10] ?? 0) * cz;
          if (
            blocks(x + (models[m + 12] ?? 0), y + (models[m + 13] ?? 0), z + (models[m + 14] ?? 0))
          ) {
            continue;
          }
          if (kept !== at) {
            data.models.copyWithin(kept * 16, m, m + 16);
            data.tints.copyWithin(kept * 3, at * 3, at * 3 + 3);
          }
          kept++;
        }
        data.count = kept;
        this.fullCounts.set(data, kept);
        this.renderer.uploadInstanced(instances.batch, data);
      }
      return true;
    }
    return false;
  }

  /** The lights `pack`'s file was authored with, or none until they arrive or if it has none. */
  lightsOf(pack: Pack): readonly DrftLight[] {
    for (const entry of this.loaders) if (entry.pack === pack) return entry.loader.lights;
    return [];
  }

  /** Spend this frame's upload budget on every pack. */
  update(dtSec: number): void {
    for (const { loader } of this.loaders) loader.update(dtSec);
  }

  /**
   * How far the load has come, 0 to 1: each pack's own fraction, weighted by its bytes once its
   * header has said how many, so the ninety-megabyte base is not one fifth of the bar.
   */
  get fraction(): number {
    let done = 0;
    let total = 0;
    for (const { loader } of this.loaders) {
      const progress = loader.progress;
      const weight = progress.totalBytes > 0 ? progress.totalBytes : 1e7;
      const phase = progress.phase;
      const fraction =
        phase === 'ready' || phase === 'absent' || phase === 'failed' ? 1 : progress.fraction;
      done += fraction * weight;
      total += weight;
    }
    return total > 0 ? done / total : 1;
  }

  /** Whether every pack asked for has finished, absent ones included. */
  get settled(): boolean {
    for (const { loader } of this.loaders) {
      const phase = loader.progress.phase;
      if (phase !== 'ready' && phase !== 'absent' && phase !== 'failed') return false;
    }
    return true;
  }

  /**
   * Declare every field the loaded packs carry, where it stands, for tracing indirect light. The
   * base pack carries one, over its stone; the rest carry none. Every frame, after `beginFrame`,
   * which is where the renderer clears the list. A no-op on a backend that cannot trace.
   */
  declareFields(): void {
    for (const { loader, presence } of this.loaders) {
      if (presence <= 0) continue;
      for (const placed of loader.fields) {
        this.renderer.addDistanceField(placed.source, placed.model, STONE_ALBEDO);
      }
    }
  }

  /**
   * Every field the base pack carries, where it stands, for tracing through the courtyard once: the
   * fires' summed candlelight is occluded by it. Empty until the base's fields and fit are in.
   */
  occluders(): GlobalFieldInstance[] {
    const placed: GlobalFieldInstance[] = [];
    for (const { pack, loader } of this.loaders) {
      if (pack !== 'base') continue;
      for (const field of loader.fields)
        placed.push({ source: field.source, transform: field.model });
    }
    return placed;
  }

  /** The options a glass part draws with: blended as `BLENDED`, and glass as its loader says. */
  private glassDraw(glass: GlassOptions): TranslucentMeshOptions {
    let options = this.glassDraws.get(glass);
    if (options === undefined) {
      options = { ...BLENDED, glass };
      this.glassDraws.set(glass, options);
    }
    return options;
  }

  /**
   * Draw every part with its whole material. Returns the draws issued.
   *
   * **A probe's faces leave out the ivy and the candles**, `forProbe`. They are ten of the fourteen
   * million triangles a night's frame draws, and a probe face is 64 texels across and read as an
   * 8 × 8 irradiance: the stone behind the leaves stands in for them, which moves the bounce off a
   * wall a shade toward grey from green. The candles' light reaches the probes as light, not as wax.
   */
  draw(forProbe = false): number {
    const renderer = this.renderer;
    const material = this.material;
    const maps = this.maps;
    let draws = 0;
    for (const { pack, loader, presence } of this.loaders) {
      if (presence <= 0) continue;
      if (forProbe && (pack === 'ivy' || pack === 'candles')) continue;
      const textures = loader.textures;
      for (const part of loader.parts) {
        if (part.blend && !this.blended) continue;
        writePartMaterial(part, textures, material);
        /* The instrument: a map switched off in the address bar is unbound after the fact. */
        if (!maps.has('albedo')) material.albedo = null;
        if (!maps.has('normal')) material.normal = null;
        if (!maps.has('orm')) material.orm = null;
        if (!maps.has('emissive')) material.emissive = null;
        renderer.setMaterial(material);
        renderer.setSurfaceReflectivity(part.reflectivity);
        const opacity = part.opacity * part.reveal;
        /* A blended part is drawn translucent whatever its opacity: its alpha is in its texture. */
        const translucent = opacity < 1 || part.blend;
        const options =
          part.glass !== null ? this.glassDraw(part.glass) : part.blend ? BLENDED : undefined;
        /* A mesh the file draws many times goes through the instanced path, every copy one draw. */
        if (part.instances !== null) {
          if (translucent) {
            renderer.drawTranslucentInstanced(
              part.instances.batch,
              part.instances.data,
              opacity,
              options,
            );
          } else {
            renderer.drawInstanced(part.instances.batch, part.instances.data);
          }
        } else if (translucent) renderer.drawTranslucentMesh(part.mesh, IDENTITY, opacity, options);
        else renderer.drawMesh(part.mesh, IDENTITY);
        draws++;
      }
    }
    renderer.setMaterial(null);
    return draws;
  }

  /**
   * One line per pack that is not simply finished, so an absent bake is said rather than shown as
   * a hole. A string built per frame, which the stats row is for; nothing hot reads it.
   */
  describe(): string {
    let parts = 0;
    let text = '';
    for (const { pack, loader } of this.loaders) {
      const load = loader.progress;
      parts += load.partsTotal;
      if (load.phase === 'ready') continue;
      text +=
        `${text === '' ? '' : ' · '}sponza-${pack}: ` +
        (load.phase === 'absent' || load.phase === 'failed'
          ? `${load.message} — not baked? see the census`
          : `${load.phase} ${Math.round(load.fraction * 100)}%`);
    }
    return text === '' ? `${parts} parts across ${this.loaders.length} packs` : text;
  }

  dispose(): void {
    for (const { loader } of this.loaders) loader.dispose();
  }
}

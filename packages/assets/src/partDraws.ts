/**
 * A loaded model's parts drawn, cast and prepared by the rules a baked container needs, so a caller
 * gets them right by calling one method rather than by knowing each of them.
 *
 * **Every rule here is one that fails as a picture rather than an error**, which is why they are in
 * one place: a part's whole material (`writePartMaterial`), or foliage loses its alpha test and a
 * one-sided card vanishes from behind; a part's copies through the instanced path, or a repeated arch
 * is drawn once; a blended part translucent whatever its opacity and writing no depth, since its
 * alpha is in its texture, or a decal draws as a black patch on the stone; glass as glass, its options
 * kept per pane so a frame allocates none; each part's own reflectivity; and in the shadow, every
 * part but a decal, which would shadow its own surface, with its material so a cutout casts the
 * shape in its texture. A part fades in on its `reveal`, translucent while it does.
 *
 * **What it gives up**: one material and one reflectivity a part, as the container says, with no
 * per-part override; a caller who wants one (a map switched off, a part left out) draws the parts
 * itself, which `writePartMaterial` and the fields of `DrftPart` are for. It sets no camera and opens
 * no pass: it draws into whichever mesh pass is open, as `drawMesh` does.
 */
import type {
  GlassOptions,
  RendererApi,
  ShadowCasterSink,
  SurfaceMaterial,
  SurfaceTextureHandle,
  TranslucentMeshOptions,
} from '@driftengine/core';
import type { TextureSet } from './drftTextures.ts';
import type { DrftPart } from './loadProgress.ts';
import { writePartMaterial } from './partMaterial.ts';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** A blended part's draw: its alpha is in its texture, and a depth it wrote would hide what is behind. */
const BLENDED: TranslucentMeshOptions = Object.freeze({ depthWrite: false });
const OPAQUE_PREPARED = Object.freeze({ translucent: false });
const TRANSLUCENT_PREPARED = Object.freeze({ translucent: true });

/** A caster's material: a part's, and its glass, rewritten for each part. */
type CasterMaterial = SurfaceMaterial<SurfaceTextureHandle> & { glass?: GlassOptions };

/** Parts drawn, cast and prepared by every rule a container needs; `DrftLoader.draw` is one. */
export class PartDraws {
  private readonly material: SurfaceMaterial<SurfaceTextureHandle> = {};
  private readonly casterMaterial: CasterMaterial = {};
  /** Each pane's draw options, made once: a frame drawing glass allocates nothing. */
  private readonly glassDraws = new Map<GlassOptions, TranslucentMeshOptions>();

  constructor(private readonly renderer: RendererApi) {}

  /** Draw every part into the open mesh pass. Returns the draws issued. */
  draw(parts: readonly DrftPart[], textures: TextureSet<SurfaceTextureHandle> | null): number {
    const renderer = this.renderer;
    let draws = 0;
    for (const part of parts) {
      renderer.setMaterial(writePartMaterial(part, textures, this.material));
      renderer.setSurfaceReflectivity(part.reflectivity);
      const opacity = part.opacity * part.reveal;
      const options = this.optionsFor(part);
      const instances = part.instances;
      if (instances !== null) {
        if (translucent(part, opacity)) {
          renderer.drawTranslucentInstanced(instances.batch, instances.data, opacity, options);
        } else {
          renderer.drawInstanced(instances.batch, instances.data);
        }
      } else if (translucent(part, opacity)) {
        renderer.drawTranslucentMesh(part.mesh, IDENTITY, opacity, options);
      } else {
        renderer.drawMesh(part.mesh, IDENTITY);
      }
      draws++;
    }
    /* Nothing of the last part is left for the caller's own draws: no material, no mirror. */
    renderer.setMaterial(null);
    renderer.setSurfaceReflectivity(0);
    return draws;
  }

  /** Offer every part that stands in the light to a shadow pass, or to a mirror's replay. */
  cast(
    sink: ShadowCasterSink,
    parts: readonly DrftPart[],
    textures: TextureSet<SurfaceTextureHandle> | null,
  ): void {
    const material = this.casterMaterial;
    for (const part of parts) {
      /* A blended part that is not glass is a decal, which would shadow the surface it lies on. */
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

  /**
   * Compile, off the frame, what every part's draw will take, then wait for it: each in its own
   * material, translucent as well where it will be drawn so, through its batch where it has copies.
   * What it cannot reach is the shadow passes' and a probe's own pipelines, which one frame drawn
   * behind a loading screen compiles; see `RendererApi.prepareMesh`.
   */
  async prepare(
    parts: readonly DrftPart[],
    textures: TextureSet<SurfaceTextureHandle> | null,
  ): Promise<void> {
    const renderer = this.renderer;
    for (const part of parts) {
      const material = writePartMaterial(part, textures, this.material);
      const options = translucent(part, part.opacity) ? TRANSLUCENT_PREPARED : OPAQUE_PREPARED;
      if (part.instances !== null)
        renderer.prepareInstanced(part.instances.batch, material, options);
      else renderer.prepareMesh(part.mesh, material, options);
    }
    await renderer.ready();
  }

  /** A part's translucent draw options: glass as glass, a blended part writing no depth. */
  private optionsFor(part: DrftPart): TranslucentMeshOptions | undefined {
    const glass = part.glass;
    if (glass !== null) {
      let options = this.glassDraws.get(glass);
      if (options === undefined) {
        options = Object.freeze({ ...BLENDED, glass });
        this.glassDraws.set(glass, options);
      }
      return options;
    }
    return part.blend ? BLENDED : undefined;
  }
}

/** A blended part is drawn translucent whatever its opacity: its alpha is in its texture. */
function translucent(part: DrftPart, opacity: number): boolean {
  return opacity < 1 || part.blend;
}

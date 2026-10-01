/**
 * The city's texture arrays, as the bake's plan sizes them: one albedo array a class, its layers'
 * effects beside it, and an emissive twin where any layer glows.
 *
 * **Built a class at a time, once every picture it names has arrived**, in whatever order they
 * decode; a class not built yet draws white, which reads as a city still arriving rather than as a
 * wrong one. A picture is named however the plan names it — by path for a page reading rasters, by
 * its `TEXS` name for the scene reading a container — so both build through this.
 *
 * **Each picture is drawn to fill its layer**, and a flipbook's column cut out of its sheet, as the
 * engine plays one: layer after layer. A picture that did not decode fills its layer white.
 *
 * What it gives up: the metal-roughness maps the plan names, which the arrays do not carry yet —
 * every surface takes its roughness and metalness from its own numbers.
 */
import type {
  RendererApi,
  SurfaceLayerEffect,
  SurfaceMaterial,
  SurfaceTextureHandle,
} from '../../packages/core/src/index';

export interface PlanLayer {
  readonly albedo: string | null;
  readonly emissive: string | null;
  readonly mr: string | null;
  readonly frame: readonly [number, number] | null;
  readonly effect: SurfaceLayerEffect | null;
}

export interface PlanClass {
  readonly size: number;
  readonly layers: readonly PlanLayer[];
}

/** How a class covers what is behind it: the bake's `MaterialClass`. */
export interface MaterialClass {
  readonly blend: 'opaque' | 'additive' | 'blend' | 'cutout';
  readonly texture: number;
  readonly alpha: number;
  readonly sway?: boolean;
}

interface Built {
  readonly albedo: SurfaceTextureHandle;
  readonly emissive: SurfaceTextureHandle | null;
}

export class CityArrays {
  private readonly images = new Map<string, ImageBitmap | null>();
  private readonly built: (Built | null)[];
  private readonly materials = new Map<number, SurfaceMaterial<SurfaceTextureHandle>>();

  constructor(
    private readonly renderer: RendererApi,
    private readonly classes: readonly PlanClass[],
  ) {
    this.built = classes.map(() => null);
  }

  /** Every picture the plan names, once each: what `take` waits for. */
  names(): Set<string> {
    const out = new Set<string>();
    for (const cls of this.classes) {
      for (const l of cls.layers) {
        if (l.albedo !== null) out.add(l.albedo);
        if (l.emissive !== null) out.add(l.emissive);
      }
    }
    return out;
  }

  /** A picture arrived, or did not decode: build every class it completes. */
  take(name: string, image: ImageBitmap | null): void {
    this.images.set(name, image);
    this.classes.forEach((cls, index) => {
      if (this.built[index] !== null) return;
      const waiting = cls.layers.some(
        (l) =>
          (l.albedo !== null && !this.images.has(l.albedo)) ||
          (l.emissive !== null && !this.images.has(l.emissive)),
      );
      if (!waiting) this.built[index] = this.build(cls);
    });
  }

  /** Whether every class is built. */
  get complete(): boolean {
    return this.built.every((b) => b !== null);
  }

  /**
   * What a class wears, or null — white — while its pictures are still arriving. The same object
   * for the same class every frame: a draw loop asks once a class a draw.
   */
  material(cls: MaterialClass): SurfaceMaterial<SurfaceTextureHandle> | null {
    const built = this.built[cls.texture];
    if (built === null || built === undefined) return null;
    const key = cls.texture * 2 + (cls.blend === 'cutout' ? 1 : 0);
    let material = this.materials.get(key);
    if (material === undefined) {
      material = {
        albedo: built.albedo,
        emissive: built.emissive,
        /* Leaves are cut out of their picture: what its alpha leaves is not drawn at all. */
        ...(cls.blend === 'cutout' ? { cutout: 0.5 } : {}),
      };
      this.materials.set(key, material);
    }
    return material;
  }

  private build(cls: PlanClass): Built {
    const albedo = this.renderer.createSurfaceTextureArray(
      this.layers(cls, (l) => l.albedo, '#ffffff'),
      { colorSpace: 'srgb', effects: cls.layers.map((l) => l.effect ?? undefined) },
    );
    const glows = cls.layers.some((l) => l.emissive !== null);
    const emissive = glows
      ? this.renderer.createSurfaceTextureArray(
          this.layers(cls, (l) => l.emissive, '#000000'),
          {
            colorSpace: 'srgb',
          },
        )
      : null;
    return { albedo, emissive };
  }

  /** A class's layers at its size, each a picture — or `empty` — drawn to fill it. */
  private layers(
    cls: PlanClass,
    pick: (l: PlanLayer) => string | null,
    empty: string,
  ): OffscreenCanvas[] {
    return cls.layers.map((layer) => {
      const c = new OffscreenCanvas(cls.size, cls.size);
      const g = c.getContext('2d');
      if (g === null) throw new Error('CityArrays: no 2d canvas to draw a layer in');
      const name = pick(layer);
      const bitmap = name === null ? null : (this.images.get(name) ?? null);
      if (bitmap === null) {
        g.fillStyle = name === null ? empty : '#ffffff';
        g.fillRect(0, 0, cls.size, cls.size);
        return c;
      }
      const [k, n] = layer.frame ?? [0, 1];
      const w = bitmap.width / n;
      g.drawImage(bitmap, k * w, 0, w, bitmap.height, 0, 0, cls.size, cls.size);
      return c;
    });
  }
}

/** What the second pipeline's shading pass computes, in TypeScript, so something can disagree. */

import { EMISSIVE_SHADOW_SHARE, MIN_LOBE_ALPHA } from '../shaders/flat/lobes.ts';
import { environmentWeight } from './ibl.ts';

/**
 * **The lit expression had no reference until 2026-09-16, and that was a gap rather than a policy.**
 *
 * `shadeBins.ts` is the reference for the *reconstruction* — screen vertices, perspective-correct
 * weights, their gradients — and `gpu-parity.mjs` runs it against `SHADE_SURFACE_WGSL` over
 * generated triangles. The shading pass's header gives the reason and it is a good one: the
 * interpolation is the only part that differs between the two pipelines, so it is the only part
 * that can drift.
 *
 * That argument holds for a lit expression of four lines. It stops holding the moment the
 * expression grows a term, and it was never an argument for having *no* reference: nothing in the
 * tree computed what the shader computed, so nothing could disagree with it. The forward path's own
 * expression is GLSL and cannot be compared to WGSL by reading them side by side.
 *
 * **This is the twin, and it is deliberately not the forward path's whole material.** What the
 * second pipeline draws is still a subset — no texture, so every property a texel could vary is a
 * per-material constant — and every term that *is* here matches `flat/main.ts` exactly. Stating
 * the subset is the point; discovering it from a capture is what this repository keeps refusing.
 */

/** A surface, after the visibility buffer has been turned back into one. */
export interface LitSurface {
  /** Vertex colour times the material's tint. */
  readonly albedo: readonly [number, number, number];
  /** Unit length, in world space. */
  readonly normal: readonly [number, number, number];
  /** Unit length, from the surface toward the eye. */
  readonly toEye: readonly [number, number, number];
  /** 0 is a mirror, 1 is fully rough. */
  readonly roughness: number;
  /** How much of the light the surface returns as a highlight. Zero for a matte one. */
  readonly specular: number;
  /** Added as `emissiveColour * emissive`, which is `albedo * emissive` where no map says otherwise. */
  readonly emissive: number;
  /**
   * What the glow is coloured by: flat/main.ts's `emissiveTint * emissiveMapped`, the albedo times
   * an emissive map. **Defaults to the albedo**, so a surface with no map glows exactly as it did —
   * and it reaches the glow and nothing else, because a map says where light is emitted rather than
   * what the surface is made of.
   */
  readonly emissiveColour?: readonly [number, number, number];
  /**
   * How much of the environment the surface returns, before the angle and the roughness are
   * accounted for. **Defaults to 0**, so a material that says nothing reflects nothing.
   */
  readonly reflectivity?: number;
  /**
   * How much of the directional source reaches this surface: 0 in full shadow, 1 in full light.
   *
   * **Applied to the diffuse term and the highlight, and to nothing else**, which is where
   * `flat/main.ts` puts its own `sunShade`. Its comment records what applying it more widely costs:
   * scale the ambient too and an enclosed face is darkened once for having no sun and again for the
   * light it should still have received, which a consumer answered by raising a floor constant and
   * losing the contrast permanently.
   *
   * **Defaults to 1**, so a caller that says nothing about occlusion renders exactly the frame this
   * pipeline rendered before it had a shadow map — the same promise `roughness` and `specular`
   * make.
   */
  readonly shade?: number;
  /**
   * 0 is a dielectric and 1 is a metal. **Defaults to 0.**
   *
   * `flat/main.ts` reads this per texel from the blue channel of an occlusion-roughness-metallic
   * image; this pipeline has no textures, so it is one number a material. That is the whole of the
   * difference — every expression it enters is the forward path's with a constant standing in for
   * a fetch — and it is four of them: the direct diffuse it removes, the colour it gives the
   * highlight, the side of the environment blend the highlight is added on, and the `f0` and the
   * amount `ibl.ts` builds the weight from.
   */
  readonly metalness?: number;
  /**
   * How much of the surface's light a crevice leaves, from an ORM map's red channel. **Defaults
   * to 1.**
   *
   * **It multiplies the whole result**, highlight, reflection and emissive included, because that
   * is what `flat/main.ts` does — `lit *= ormOcclusion` — and its comment records the narrower
   * reading as considered and not taken, with the double count against a cast shadow as the
   * stated cost.
   */
  readonly occlusion?: number;
}

/** The frame's one directional light and its hemispheric fill. */
export interface LitEnvironment {
  /** Toward the light, unit length, as `Environment.directionalDir` is. */
  readonly lightDir: readonly [number, number, number];
  readonly lightColour: readonly [number, number, number];
  readonly sky: readonly [number, number, number];
  readonly ground: readonly [number, number, number];
  /**
   * The room's diffuse light in the surface's own direction, from a cosine-convolved level.
   *
   * **It replaces the hemispheric gradient rather than lifting it**, by `irradianceAmount`, which
   * is what `flat/main.ts` does and what its own comment records the alternative costing: a mix
   * *toward* a coarse box-filtered level is a sample of the room rather than an integral over it,
   * and it rendered a night courtyard black.
   */
  readonly irradiance?: readonly [number, number, number];
  /** How much of the gradient the irradiance replaces. **Defaults to 0**, which keeps it. */
  readonly irradianceAmount?: number;
  /**
   * What the surface sees in the mirror direction, from the chain at its own roughness.
   *
   * **It replaces a hemispheric gradient rather than standing alone**, by `radianceAmount`, and the
   * default matters more here than anywhere else in this interface: a metal's environment weight is
   * exactly 1 at every angle and every roughness, so a metal with nothing to reflect is **black**.
   * The gradient is what `flat/main.ts` reflects where a scene has no probe, and computing it here
   * rather than in the caller is what stops that being something a caller can forget.
   */
  readonly radiance?: readonly [number, number, number];
  /**
   * How much of the gradient the radiance replaces. **Defaults to 0**, which keeps the gradient —
   * the same shape and the same default as `irradianceAmount`.
   */
  readonly radianceAmount?: number;
  /**
   * Whether that radiance came from a GGX-convolved chain. **Defaults to 0.**
   *
   * The split sum is the correct share of a *prefiltered* environment and asserts an integral that
   * was never performed over anything else — `ibl.ts` carries what ignoring that costs.
   */
  readonly prefiltered?: number;
  /**
   * The frame's emissive gain times its night factor. **Defaults to 1.**
   *
   * `flat/main.ts` scales every glow by `uEmissiveGain * uNightFactor`, so a scene whose clock says
   * it is day has nothing glowing on the forward path. This pipeline added `albedo * emissive` and
   * nothing else until 2026-09-17, which is a rig that glowed on one pipeline and not the other.
   */
  readonly emission?: number;
}

/**
 * How much of the sky a normal sees, against how much of the ground.
 *
 * `n.y * 0.5 + 0.5`, which is `flat/main.ts`'s own. Named rather than inlined because two
 * pipelines disagreeing about it is two pipelines lighting one scene differently, with nothing on
 * screen to say which is right.
 */
export function HEMISPHERIC(ny: number): number {
  return ny * 0.5 + 0.5;
}

/**
 * The normalised GGX distribution, transcribed from `flat/lobes.ts`.
 *
 * **It peaks at one whatever the roughness**, and that is what makes a widened lobe broader rather
 * than brighter — `lobes.ts` records paying for the version that did not. The floor on `a` is what
 * keeps a mirror from dividing by nothing.
 */
/*
 * **Two floors, and only one of them can be seen in the output.** The denominator's is what keeps
 * a near-mirror's peak finite, and deleting it is worth 256 times the highlight at roughness 0.05 —
 * `gpu-parity.mjs` catches that, now that a fifth of its corpus sits on the peak. The floor on `a`
 * cannot be caught, because the denominator's already prevents the division by zero it guards
 * against: at roughness zero the whole term is a ten-thousandth with it and zero without, and both
 * round to nothing beside a lit surface. It is kept because it is what `flat/lobes.ts` has, and two
 * spellings of one lobe differing by a guard is the drift this pair exists to prevent.
 */
export function specularLobe(ndh: number, roughness: number): number {
  const a = Math.max(roughness * roughness, MIN_LOBE_ALPHA);
  const a2 = a * a;
  const d = ndh * ndh * (a2 - 1) + 1;
  return (a2 * a2) / Math.max(d * d, 1e-8);
}

export function newLitColour(): Float32Array {
  return new Float32Array(3);
}

/** Scratch, because this is per pixel in the reference as well as on the device. */
const HALFWAY = new Float32Array(3);

/**
 * The colour the second pipeline writes for one reconstructed surface.
 *
 * **The highlight is added on both sides of the environment blend, and which side carries how much
 * is metalness.** `flat/main.ts` writes it as two lines with the blend between them, and its
 * comments carry what each is for. The dielectric's share goes in *underneath*, where the blend
 * dims it by the surface's own reflectance — moving it out "takes a lobe that was correctly dimmed
 * and puts it back at full strength", which on a near-black glass lens carrying `specular` 1 is a
 * white blob where there was none. The metal's share goes *over the top*, because on a metal the
 * blend reaches 1 and a highlight left underneath is multiplied by exactly zero: the surface with
 * the most reason to show a specular streak is the one guaranteed not to.
 *
 * **This file had both shares on the outside until 2026-09-17** and cited the metal argument for
 * it. Nothing caught it: no material in any rig carries a `specular` and a `reflectivity` at once,
 * so the two orders had never been asked to differ.
 */
export function litColour(
  surface: LitSurface,
  environment: LitEnvironment,
  out: Float32Array,
): Float32Array {
  const [nx, ny, nz] = surface.normal;
  const [lx, ly, lz] = environment.lightDir;

  const ndl = Math.max(nx * lx + ny * ly + nz * lz, 0);
  const fill = HEMISPHERIC(ny);

  /* The half vector between the light and the eye, which is where a highlight is brightest. */
  HALFWAY[0] = lx + (surface.toEye[0] as number);
  HALFWAY[1] = ly + (surface.toEye[1] as number);
  HALFWAY[2] = lz + (surface.toEye[2] as number);
  const length = Math.hypot(HALFWAY[0] as number, HALFWAY[1] as number, HALFWAY[2] as number);
  let ndh = 0;
  let voh = 0;
  if (length > 0) {
    ndh = Math.max(
      (nx * (HALFWAY[0] as number) + ny * (HALFWAY[1] as number) + nz * (HALFWAY[2] as number)) /
        length,
      0,
    );
    voh = Math.max(
      ((surface.toEye[0] as number) * (HALFWAY[0] as number) +
        (surface.toEye[1] as number) * (HALFWAY[1] as number) +
        (surface.toEye[2] as number) * (HALFWAY[2] as number)) /
        length,
      0,
    );
  }
  /*
   * **Computed whether or not the surface is shiny, and multiplied by zero where it is not.** A
   * branch on a material's specular would be a branch on a value read from a table, which is what
   * the shading pass's own header refuses for the same reason the forward path does: it is not
   * provably uniform control flow.
   */
  const lobe = specularLobe(ndh, surface.roughness);
  /* One number for both direct terms: the sun being occluded is one fact about one source. */
  const shade = surface.shade ?? 1;
  const metal = surface.metalness ?? 0;
  const occlusion = surface.occlusion ?? 1;
  /*
   * **A glow is scaled by the frame and dimmed by a share of the sun's shadow**, which is
   * flat/main.ts's `mix(1, min(lightShade, sunShade), EMISSIVE_SHADOW_SHARE)` with no lamps: a lit
   * inlay in a deck that is itself in shade, rather than a lamp head blacked out by a passer-by.
   */
  const glow =
    surface.emissive * (environment.emission ?? 1) * (1 + (shade - 1) * EMISSIVE_SHADOW_SHARE);
  /*
   * **A metal's highlight goes white at a grazing angle, and that is most of what reads as
   * polished.** Schlick's reflectance climbs to 1 at the edge whatever the material is, so a red
   * metal shows a red highlight face-on and a white one along every panel edge. Scaled by
   * metalness, so `specColour + (1 - specColour) * 0` is `specColour` exactly on a dielectric.
   */
  const facing = 1 - voh;
  const edge = facing * facing * facing * facing * facing * metal;

  /*
   * **How much of the room the surface returns, computed once rather than per channel.** It is a
   * function of the angle, the roughness and the material alone — `ibl.ts` carries both halves of
   * the split sum and why the selector between them is exactly 0 or exactly 1.
   */
  const nv =
    nx * (surface.toEye[0] as number) +
    ny * (surface.toEye[1] as number) +
    nz * (surface.toEye[2] as number);
  const ndv = Math.max(nv, 0);
  const weight = environmentWeight(
    ndv,
    surface.roughness,
    surface.reflectivity ?? 0,
    environment.prefiltered ?? 0,
    metal,
  );
  const irradianceAmount = environment.irradianceAmount ?? 0;
  const radianceAmount = environment.radianceAmount ?? 0;
  /*
   * **The mirror direction, and what a surface sees along it with no probe bound.** `reflect(-v, n)`
   * written out: the two-colour gradient the ambient comes from, sampled in the direction the
   * surface is reflecting rather than the one it faces. That distinction is the whole of what makes
   * a curved dielectric read as curved with no environment in the scene at all.
   *
   * **The unclamped dot, not `ndv`.** `reflect` takes the facing term as it is; clamping it at zero
   * would fold the mirror direction back on itself for a surface seen from behind — which happens
   * on every silhouette where interpolated normals turn past the eye — and reflect the sky where
   * the ground belongs. The weight below clamps because a negative Fresnel is not a reflectance;
   * the two uses are different questions about one dot product.
   */
  const mirroredY = 2 * nv * ny - (surface.toEye[1] as number);

  for (let channel = 0; channel < 3; channel += 1) {
    const albedo = surface.albedo[channel] as number;
    const hemispheric =
      (environment.ground[channel] as number) +
      ((environment.sky[channel] as number) - (environment.ground[channel] as number)) * fill;
    const room = environment.irradiance?.[channel] ?? 0;
    const ambient = hemispheric + (room - hemispheric) * irradianceAmount;
    /*
     * **A metal's highlight takes its own colour and a dielectric's takes the light's**, which is
     * why gold under a white lamp reads as gold rather than as beige plastic with a white dot on
     * it. `specular` is this engine's dielectric reflectance — a look control rather than an `f0` —
     * so the blend runs from it to the albedo rather than from 0.04.
     */
    const specColour = surface.specular + (albedo - surface.specular) * metal;
    const sunSpec = specColour + (1 - specColour) * edge;
    const highlight = (environment.lightColour[channel] as number) * lobe * sunSpec * shade;
    /*
     * **A metal keeps its ambient and loses its direct diffuse**, written as one term because the
     * honest two cancel: a metal's reduced diffuse plus the ambient floor that stops a rough one
     * going black once its diffuse is gone sum to `albedo * ambient` exactly.
     */
    const base =
      albedo *
        (ambient + (environment.lightColour[channel] as number) * ndl * shade * (1 - metal)) +
      highlight * (1 - metal);
    /*
     * **What a metal reflects is the room through itself**, which is the other half of "a metal is
     * nothing but its reflection". `mix(1, albedo, 0)` is exactly 1, so a dielectric reflects the
     * room's own colour as it always did.
     */
    const gradient =
      (environment.ground[channel] as number) +
      ((environment.sky[channel] as number) - (environment.ground[channel] as number)) *
        HEMISPHERIC(mirroredY);
    const seen = gradient + ((environment.radiance?.[channel] ?? 0) - gradient) * radianceAmount;
    const reflected = seen * (1 + (albedo - 1) * metal);
    const glowColour = surface.emissiveColour?.[channel] ?? albedo;
    out[channel] =
      (base + (reflected - base) * weight + highlight * metal + glowColour * glow) * occlusion;
  }
  return out;
}

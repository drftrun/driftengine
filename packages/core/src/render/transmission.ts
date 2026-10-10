/**
 * A thin surface's light from behind as the lit stage reads it: `SurfaceMaterial.diffuseTransmission`
 * and `transmissionColor` into the four lanes of the glass tint an opaque material leaves unused.
 *
 * **The colour rides lanes glass owns**, because the lit stage's uniform rows are spent
 * (`flat/preamble.ts`): a pane writes its own tint there for its draw, so whatever binds a pane
 * puts this back after it, or the next draw of the material lets light through in the pane's colour.
 * **−1 in the colour lanes means "the albedo"**, which is what a material naming no colour has
 * always let through, so a scene that names none draws to the bit as it did.
 */

/** What a material lets through from behind and in which colour, as the glass tint carries it. */
export interface Transmission {
  readonly diffuseTransmission?: number;
  readonly transmissionColor?: readonly [number, number, number] | null;
}

/**
 * `material` into `out`: the colour, or −1 three times where it names none, then the amount held
 * to 0..1. A colour component below zero is held at zero, so a mistyped colour lets no light
 * through rather than reading as "the albedo".
 */
export function resolveTransmission(material: Transmission | null, out: Float32Array): void {
  const colour = material?.transmissionColor ?? null;
  for (let i = 0; i < 3; i++) out[i] = colour === null ? -1 : Math.max(colour[i] ?? 0, 0) || 0;
  out[3] = Math.min(Math.max(material?.diffuseTransmission ?? 0, 0), 1) || 0;
}

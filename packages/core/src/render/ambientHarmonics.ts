/**
 * A draw's own ambient light, as nine spherical-harmonic coefficients: what `setAmbientSH` takes,
 * how both backends pack it, and the arithmetic the lit stage evaluates, which its tests hold.
 *
 * **Why a draw needs its own.** The engine's diffuse ambient is one answer for a whole frame — the
 * sky-and-ground gradient, or the probe grid's irradiance — so everything standing in one place is
 * lit alike. A stage with a baked volume of indirect light (Unreal's volumetric lightmap) lights a
 * character by sampling that volume where the character stands; a consumer that samples it each
 * frame hands the result here, around that character's draws, and the character takes the light of
 * the spot it is in rather than the frame's average.
 *
 * **The coefficients are of incoming radiance**, `L(ω) ≈ Σ c_lm Y_lm(ω)`, on the standard real
 * basis in its usual order — `Y00`, then `Y1,-1 Y1,0 Y1,1`, then `Y2,-2 Y2,-1 Y2,0 Y2,1 Y2,2` —
 * evaluated on the engine's own world axes as written: `Y1,-1 = 0.488603 y`, `Y1,0 = 0.488603 z`,
 * `Y1,1 = 0.488603 x`, `Y2,-2 = 1.092548 xy`, `Y2,-1 = 1.092548 yz`, `Y2,0 = 0.315392 (3z² − 1)`,
 * `Y2,1 = 1.092548 xz`, `Y2,2 = 0.546274 (x² − y²)`, with y up. Three numbers a coefficient, red
 * green blue, twenty-seven in all. A source in another engine's axes is rotated into these first.
 *
 * **What the surface receives is the cosine convolution**, Ramamoorthi and Hanrahan's: the bands
 * scaled by π, 2π/3 and π/4 and divided by π, which is the irradiance over π a Lambertian surface
 * multiplies its albedo by — the same quantity the gradient and the probes hand the shader. A
 * constant radiance `L` everywhere is `c00 = L / 0.282095` and lights a surface exactly as an
 * ambient of `L` does. Negative ringing, which a second-order fit of a sharp source has, is clamped
 * to zero.
 *
 * **What it gives up** is the reflections: these replace the diffuse ambient only, and a glossy
 * surface still reflects the frame's probes or sky. **What would make it wrong** is light the
 * volume holds at a frequency nine coefficients cannot carry — a sharp sun patch — which is the
 * stage's own direct light's job and not this.
 */

/** Numbers `setAmbientSH` takes: nine coefficients of three channels. */
export const AMBIENT_SH_VALUES = 27;

/** Floats the lit stage's `uAmbientSH` holds: the coefficients, and whether they are on. */
export const AMBIENT_SH_FLOATS = 28;

/**
 * The coefficients as the lit stage reads them, into `out` of `AMBIENT_SH_FLOATS`: the twenty-seven
 * numbers in order and a last one that is 1, or every float zero for `null` — the frame's own
 * ambient. Refuses a list that is not twenty-seven numbers, naming its length.
 */
export function packAmbientSH(coefficients: ArrayLike<number> | null, out: Float32Array): void {
  if (coefficients === null) {
    out.fill(0);
    return;
  }
  if (coefficients.length !== AMBIENT_SH_VALUES) {
    throw new Error(
      `setAmbientSH: ${coefficients.length} values, where nine coefficients of red, green and ` +
        `blue are ${AMBIENT_SH_VALUES}`,
    );
  }
  for (let i = 0; i < AMBIENT_SH_VALUES; i++) {
    const value = coefficients[i] as number;
    out[i] = Number.isFinite(value) ? value : 0;
  }
  out[AMBIENT_SH_VALUES] = 1;
}

/** The band factors of the cosine convolution, over π: 1, 2/3 and 1/4. */
const BAND = [1, 2 / 3, 1 / 4] as const;

/**
 * The ambient a surface facing `nx, ny, nz` (unit) receives from these coefficients, into `out`
 * (three floats): what `ambientHarmonics` in the lit stage computes. Run at no point by the engine;
 * the reference its tests hold.
 */
export function ambientFromSH(
  coefficients: ArrayLike<number>,
  nx: number,
  ny: number,
  nz: number,
  out: Float32Array,
): void {
  const basis = [
    0.282095 * BAND[0],
    0.488603 * ny * BAND[1],
    0.488603 * nz * BAND[1],
    0.488603 * nx * BAND[1],
    1.092548 * nx * ny * BAND[2],
    1.092548 * ny * nz * BAND[2],
    0.315392 * (3 * nz * nz - 1) * BAND[2],
    1.092548 * nx * nz * BAND[2],
    0.546274 * (nx * nx - ny * ny) * BAND[2],
  ];
  for (let c = 0; c < 3; c++) {
    let sum = 0;
    for (let k = 0; k < 9; k++) sum += (coefficients[k * 3 + c] as number) * (basis[k] as number);
    out[c] = Math.max(sum, 0);
  }
}

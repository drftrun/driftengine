/**
 * Where rendering puts its origin, and the rule that the simulation never moves.
 *
 * **Rebasing is a rendering concern. The simulation never rebases.** This is the rule the whole
 * large-world design hangs on. A rebase that touched simulation state would change floating-point
 * results — and therefore the replay fingerprint — for no reason a player could see, and the
 * divergence would appear only in sessions that happened to cross an origin boundary. That is a
 * defect nobody reproduces on demand and nobody attributes correctly.
 *
 * So: simulation coordinates stay absolute, in double precision, where the fixed-point kernel's
 * range of roughly ±2³⁷ is more world than anybody has. Render coordinates are single precision
 * relative to an origin that follows the camera.
 *
 * **The origin moves in whole cells and never continuously.** A continuously-moving origin
 * re-quantises every vertex every frame, which is visible as the whole world shimmering — the
 * precision problem it was meant to solve, wearing a different hat.
 */

/** The render origin for a camera at this position: its cell's minimum corner. */
export function renderOrigin(
  cameraX: number,
  cameraY: number,
  cameraZ: number,
  cellSize: number,
  out: Float64Array,
): void {
  out[0] = Math.floor(cameraX / cellSize) * cellSize;
  out[1] = Math.floor(cameraY / cellSize) * cellSize;
  out[2] = Math.floor(cameraZ / cellSize) * cellSize;
}

/**
 * A world position in render space, as single precision.
 *
 * The subtraction happens in double precision and only the result narrows, which is the whole
 * point: subtracting two large doubles and then narrowing keeps the precision, where narrowing
 * first and subtracting loses it before the subtraction can help.
 */
export function toRenderSpace(
  worldX: number,
  worldY: number,
  worldZ: number,
  origin: Float64Array,
  out: Float32Array,
): void {
  out[0] = worldX - (origin[0] as number);
  out[1] = worldY - (origin[1] as number);
  out[2] = worldZ - (origin[2] as number);
}

/** Back to absolute, in double precision. Exact for anything `toRenderSpace` produced. */
export function toWorldSpace(render: Float32Array, origin: Float64Array, out: Float64Array): void {
  out[0] = (render[0] as number) + (origin[0] as number);
  out[1] = (render[1] as number) + (origin[1] as number);
  out[2] = (render[2] as number) + (origin[2] as number);
}

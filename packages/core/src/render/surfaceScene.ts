/**
 * The scene's surface clock and weather, decided once for both backends: the four numbers the lit
 * stage reads as `uSurfaceScene`. Each backend only uploads them, so the two cannot disagree about
 * what a wetness of 1.4 means — it means 1, as a share of lit windows past one means all of them.
 */
import type { Environment } from './backend/webgl2/renderer.ts';

const unit = (value: number | undefined): number => Math.min(1, Math.max(0, value ?? 0));

/** Fill `out`: seconds on the caller's clock, wetness, the lit share, the late share. */
export function resolveSurfaceScene(env: Environment, out: Float32Array): void {
  out[0] = env.surfaceTime ?? 0;
  out[1] = unit(env.wetness);
  out[2] = unit(env.litWindows);
  out[3] = unit(env.lateWindows);
}

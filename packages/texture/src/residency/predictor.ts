/**
 * Prediction, generic over what is being streamed.
 *
 * **Written generic now rather than generalised later, and the reason is a contract rather than
 * tidiness.** Wave 4B streams world cells by exactly this mechanism. Writing the tile case against
 * a concrete type would mean a second speculative-advance implementation there — and therefore a
 * second place for "put the simulation back exactly" to be got wrong, in a subsystem where being
 * wrong means the world runs at double speed only when streaming is enabled.
 *
 * One prediction, two consumers.
 */
import { predictViews } from './predict.ts';
import type { SimulationHandle } from './predict.ts';

export interface Predictor<T> {
  /** What this view needs, most important first. Fills `out` and returns how many. */
  needs(view: Float32Array, out: T[], budget: number): number;
  /** Whether this item is already here. */
  resident(item: T): boolean;
  /** Ask for it. Lower priority is sooner. */
  request(item: T, priority: number): void;
}

const VIEWS = new Float32Array(16 * 32);
const WANTED: unknown[] = [];

/**
 * Advance the simulation, ask the predictor what each predicted view needs, and put it back.
 *
 * Returns how many requests were made. `budget` bounds the total across every predicted frame
 * rather than per frame, so a near frame cannot be starved by a distant one filling the queue.
 */
export function runPrediction<T>(
  sim: SimulationHandle,
  predictor: Predictor<T>,
  frames: number,
  dt: number,
  budget: number,
): number {
  const horizon = Math.min(frames, Math.floor(VIEWS.length / 16));
  const count = predictViews(sim, horizon, dt, VIEWS);

  let requested = 0;
  const out = WANTED as T[];
  for (let frame = 0; frame < count && requested < budget; frame += 1) {
    const view = VIEWS.subarray(frame * 16, frame * 16 + 16);
    const wanted = predictor.needs(view, out, budget - requested);
    for (let i = 0; i < wanted && requested < budget; i += 1) {
      const item = out[i] as T;
      if (predictor.resident(item)) continue;
      /*
       * Priority is how far ahead the frame is, so nearer frames come first — and within a frame,
       * the place the predictor named the item in, as a fraction that never reaches the next
       * frame. A frame's priority alone would tie its items, and a queue breaks a tie however it
       * likes; a budget that cut the frame short would then keep an arbitrary part of it.
       */
      predictor.request(item, frame + i / wanted);
      requested += 1;
    }
  }
  return requested;
}

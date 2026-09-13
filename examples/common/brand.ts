/**
 * The lockup on the examples index, taken from the engine's own asset rather than copied.
 *
 * Imported through the module graph so there is exactly one lockup in the repository. A copy
 * under `examples/` would render identically today and quietly disagree with the real one the
 * first time the mark is redrawn — and nothing would fail to say so.
 */
import lockup from '../../packages/package/assets/lockup.svg';

const img = document.querySelector<HTMLImageElement>('#logo');
if (img !== null) img.src = lockup;

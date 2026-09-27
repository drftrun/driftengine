/**
 * Where a file's distance fields stand once its model has been placed: the loader's fit, and each
 * copy's own placement for a mesh the file draws many times.
 *
 * **The loader's to say, because the loader moved the model.** A field is in the file's own space,
 * and a loader that fits a model to a footprint has scaled and moved every vertex; a field handed
 * on as it was read would trace light through the model where it was authored rather than where it
 * is drawn. The fit is a uniform scale and a translation, which is also what keeps a distance a
 * distance: `composeGlobalField` refuses a non-uniform scale for that reason.
 */
import { SDFV_WHOLE_FILE } from '@driftengine/drft';
import type { DrftSdfvEntry } from '@driftengine/drft';

/** One field, where it stands. */
export interface DrftFieldPlacement {
  /** The field, in the object space of what it covers. It is a `FieldSource` as it stands. */
  readonly source: DrftSdfvEntry;
  /** World from object: the fit, and for a copied mesh that copy's placement inside it. */
  readonly model: Float32Array;
  /** The mesh the field covers, or `SDFV_WHOLE_FILE` for all of the file's static geometry. */
  readonly mesh: number;
}

/** The loader's fit: a uniform scale, then a translation. */
export interface FieldFit {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Every field, placed. A whole-file field and the field of a mesh drawn once stand at the fit; the
 * field of a copied mesh stands once a copy, at the fit composed with that copy's matrix.
 */
export function placeFields(
  entries: readonly DrftSdfvEntry[],
  fit: FieldFit,
  instances: ReadonlyMap<number, Float32Array>,
): DrftFieldPlacement[] {
  const placed: DrftFieldPlacement[] = [];
  for (const source of entries) {
    const copies = source.mesh === SDFV_WHOLE_FILE ? undefined : instances.get(source.mesh);
    if (copies === undefined) {
      placed.push({ source, model: fitted(fit, null, 0), mesh: source.mesh });
      continue;
    }
    for (let at = 0; at + 16 <= copies.length; at += 16) {
      placed.push({ source, model: fitted(fit, copies, at), mesh: source.mesh });
    }
  }
  return placed;
}

/**
 * The fit, or the fit times the column-major matrix at `copies[at]`. The fit is `T · S` with a
 * uniform `S`, so each column of the product is the copy's column scaled, plus the translation
 * times that column's last row.
 */
function fitted(fit: FieldFit, copies: Float32Array | null, at: number): Float32Array {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    const base = column * 4;
    const m0 = copies === null ? (column === 0 ? 1 : 0) : (copies[at + base] as number);
    const m1 = copies === null ? (column === 1 ? 1 : 0) : (copies[at + base + 1] as number);
    const m2 = copies === null ? (column === 2 ? 1 : 0) : (copies[at + base + 2] as number);
    const m3 = copies === null ? (column === 3 ? 1 : 0) : (copies[at + base + 3] as number);
    out[base] = fit.scale * m0 + fit.x * m3;
    out[base + 1] = fit.scale * m1 + fit.y * m3;
    out[base + 2] = fit.scale * m2 + fit.z * m3;
    out[base + 3] = m3;
  }
  return out;
}

/**
 * Materials as slices of a few texture arrays, which is what WebGPU can bind.
 *
 * **This is the binding design, and it is why this package lands in the same wave as the
 * GPU-driven pipeline rather than later.** WebGPU has no bindless resource access, which is the
 * usual way a GPU-driven renderer reaches a thousand materials from one indirect draw. A thousand
 * materials as six thousand independent textures is unreachable. A thousand materials as a
 * thousand latent slices in a handful of arrays, indexed by a material identifier read from a
 * storage buffer, is ordinary.
 *
 * **Identical content shares a layer.** The tile index already hashes by content, so two materials
 * whose latents are the same occupy one layer — which is the deduplication paying for itself a
 * second time, in binding slots rather than in bytes.
 */
export interface MaterialArray {
  /** Layer per material identifier. */
  layerOf: Map<number, number>;
  /** Which content hash each layer holds, so identical latents share one. */
  layerByHash: Map<string, number>;
  layerCapacity: number;
  tileSize: number;
  used: number;
}

export function createMaterialArray(layerCapacity: number, tileSize: number): MaterialArray {
  return {
    layerOf: new Map(),
    layerByHash: new Map(),
    layerCapacity,
    tileSize,
    used: 0,
  };
}

/**
 * Give this material a layer. Returns it, or -1 when the array is full.
 *
 * **Full reports failure rather than evicting.** An eviction here would silently repoint a
 * material that is still being drawn, which is a texture swap nobody asked for in the middle of a
 * frame; a caller that runs out needs to know.
 */
export function assignLayer(array: MaterialArray, materialId: number, contentHash: string): number {
  const existing = array.layerOf.get(materialId);
  if (existing !== undefined) return existing;

  const shared = array.layerByHash.get(contentHash);
  if (shared !== undefined) {
    array.layerOf.set(materialId, shared);
    return shared;
  }

  if (array.used >= array.layerCapacity) return -1;
  const layer = array.used;
  array.used += 1;
  array.layerByHash.set(contentHash, layer);
  array.layerOf.set(materialId, layer);
  return layer;
}

export function layerOf(array: MaterialArray, materialId: number): number {
  return array.layerOf.get(materialId) ?? -1;
}

/** What a bind group needs to know: how many layers and how large each is. */
export function arrayDescriptor(array: MaterialArray): { layers: number; size: number } {
  return { layers: array.used, size: array.tileSize };
}

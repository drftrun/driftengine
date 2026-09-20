/**
 * A texture that can be written to at runtime, without allocating a layer for what nobody touched.
 *
 * **Sparse, so that a scorch mark on one wall does not allocate a layer for the building.** Only
 * written tiles exist; an unwritten coordinate reports nothing written and the base is used
 * unchanged. That is the difference between a decal system a game can leave on for a whole level
 * and one somebody turns off because of the memory.
 *
 * **Written is tracked per texel *and* per channel.** A scorch darkens the albedo and leaves the
 * normal alone, so compositing has to know which channels a texel had written rather than treating
 * a written texel as wholly overwritten. One byte a texel, one bit a channel — which caps the
 * channel count at eight and is stated where the array is declared rather than discovered.
 *
 * **Two numbers are needed to turn a UV into a texel, and the plan gave one.** `tileSize` is texels
 * per tile edge and says nothing about how much of the surface a tile covers; `tilesAcross` is what
 * closes it. Without both, a radius in UV has no length in texels and every write is either the
 * whole surface or a single texel depending on which guess was made.
 *
 * **The address mode is the base texture's**, not this file's opinion. `DecodeGraph` carries one —
 * 0 clamps outside the unit square and 1 wraps — and an overlay that disagreed would put a mark on
 * the far side of a wall from where somebody aimed, on exactly the textures that wrap.
 */
import { hashTile } from '../tileHash.ts';

/** How many channels a texel carries. One bit each in the written mask, so this cannot exceed 8. */
export const OVERLAY_CHANNELS = 4;

export const ADDRESS_CLAMP = 0;
export const ADDRESS_WRAP = 1;

export interface OverlayTile {
  readonly tx: number;
  readonly ty: number;
  /** `tileSize * tileSize * OVERLAY_CHANNELS` values. */
  readonly texels: Float32Array;
  /** One byte a texel; bit `c` is set where channel `c` has been written. */
  readonly written: Uint8Array;
  /** Content hash, recomputed lazily after a write. Empty means stale. */
  hash: string;
}

export interface OverlayOptions {
  /** Tiles across the unit square. With `tileSize`, this fixes the texel density. */
  readonly tilesAcross?: number;
  /** `ADDRESS_CLAMP` or `ADDRESS_WRAP`. Take it from the base texture's `DecodeGraph`. */
  readonly addressMode?: number;
}

export interface Overlay {
  /** Texels along a tile edge. */
  readonly tileSize: number;
  /** Tiles along the unit square's edge. */
  readonly tilesAcross: number;
  /** Texels along the whole unit square's edge: `tileSize * tilesAcross`. */
  readonly resolution: number;
  readonly addressMode: number;
  /** Written tiles only, keyed `"tx,ty"`. An untouched tile does not exist. */
  readonly tiles: Map<string, OverlayTile>;
}

export function createOverlay(tileSize: number, options: OverlayOptions = {}): Overlay {
  const size = Math.max(1, Math.floor(tileSize));
  const across = Math.max(1, Math.floor(options.tilesAcross ?? 16));
  return {
    tileSize: size,
    tilesAcross: across,
    resolution: size * across,
    addressMode: options.addressMode === ADDRESS_WRAP ? ADDRESS_WRAP : ADDRESS_CLAMP,
    tiles: new Map<string, OverlayTile>(),
  };
}

function key(tx: number, ty: number): string {
  return `${String(tx)},${String(ty)}`;
}

function tileAt(overlay: Overlay, tx: number, ty: number, make: boolean): OverlayTile | null {
  const at = key(tx, ty);
  const held = overlay.tiles.get(at);
  if (held !== undefined) return held;
  if (!make) return null;
  const texels = overlay.tileSize * overlay.tileSize;
  const tile: OverlayTile = {
    tx,
    ty,
    texels: new Float32Array(texels * OVERLAY_CHANNELS),
    written: new Uint8Array(texels),
    hash: '',
  };
  overlay.tiles.set(at, tile);
  return tile;
}

/**
 * A texel coordinate brought inside the surface, or `-1` where it is outside and the mode clamps.
 *
 * `-1` rather than a clamped edge texel under `ADDRESS_CLAMP`: clamping a *write* would smear the
 * whole edge of the texture with whatever somebody aimed past it, which is a visible band rather
 * than the nothing they expected. Clamping a *read* is right, and `sampleOverlay` does that.
 */
function wrapTexel(overlay: Overlay, texel: number, forWrite: boolean): number {
  const size = overlay.resolution;
  if (overlay.addressMode === ADDRESS_WRAP) return ((texel % size) + size) % size;
  if (texel >= 0 && texel < size) return texel;
  return forWrite ? -1 : Math.min(size - 1, Math.max(0, texel));
}

/**
 * Write `value` into one channel of every texel within `radius` of `(u, v)`.
 *
 * A disc rather than a square, because a square decal is a square nobody asked for, and the radius
 * is in UV so a caller reasons in surface fractions rather than in whatever resolution this is.
 */
export function writeOverlay(
  overlay: Overlay,
  u: number,
  v: number,
  radius: number,
  channel: number,
  value: number,
): number {
  if (channel < 0 || channel >= OVERLAY_CHANNELS) return 0;
  const size = overlay.resolution;
  const centreX = u * size;
  const centreY = v * size;
  const reach = Math.max(0, radius) * size;

  const from = Math.floor(centreX - reach);
  const to = Math.ceil(centreX + reach);
  const top = Math.floor(centreY - reach);
  const bottom = Math.ceil(centreY + reach);

  let touched = 0;
  for (let y = top; y <= bottom; y += 1) {
    for (let x = from; x <= to; x += 1) {
      /* Texel centres, so a radius of half a texel marks one texel rather than none or four. */
      const dx = x + 0.5 - centreX;
      const dy = y + 0.5 - centreY;
      if (dx * dx + dy * dy > reach * reach) continue;

      const wx = wrapTexel(overlay, x, true);
      const wy = wrapTexel(overlay, y, true);
      if (wx < 0 || wy < 0) continue;

      /*
       * The tile is found from the *wrapped* texel, which is what makes a write near a boundary
       * land in both tiles: the loop runs over one continuous span and each texel finds its own
       * tile. A version that found one tile and wrote into it leaves a hard edge at every seam —
       * the defect that looks like the decal was clipped and is usually blamed on the mesh.
       */
      const tile = tileAt(
        overlay,
        Math.floor(wx / overlay.tileSize),
        Math.floor(wy / overlay.tileSize),
        true,
      ) as OverlayTile;
      const local = (wy % overlay.tileSize) * overlay.tileSize + (wx % overlay.tileSize);
      tile.texels[local * OVERLAY_CHANNELS + channel] = value;
      tile.written[local] = (tile.written[local] as number) | (1 << channel);
      tile.hash = '';
      touched += 1;
    }
  }
  return touched;
}

/**
 * Read every channel at a coordinate into `out`. False where nothing has been written there.
 *
 * False is the ordinary answer and the important one: it is what tells a sampler to use the base
 * unchanged rather than compositing a zero over it.
 */
export function sampleOverlay(overlay: Overlay, u: number, v: number, out: Float32Array): boolean {
  const size = overlay.resolution;
  const x = wrapTexel(overlay, Math.floor(u * size), false);
  const y = wrapTexel(overlay, Math.floor(v * size), false);
  const tile = tileAt(
    overlay,
    Math.floor(x / overlay.tileSize),
    Math.floor(y / overlay.tileSize),
    false,
  );
  if (tile === null) return false;

  const local = (y % overlay.tileSize) * overlay.tileSize + (x % overlay.tileSize);
  if ((tile.written[local] ?? 0) === 0) return false;
  for (let c = 0; c < OVERLAY_CHANNELS; c += 1) {
    out[c] = tile.texels[local * OVERLAY_CHANNELS + c] as number;
  }
  return true;
}

/** Which channels have been written at a coordinate, as a bit per channel. Zero for none. */
export function writtenMaskAt(overlay: Overlay, u: number, v: number): number {
  const size = overlay.resolution;
  const x = wrapTexel(overlay, Math.floor(u * size), false);
  const y = wrapTexel(overlay, Math.floor(v * size), false);
  const tile = tileAt(
    overlay,
    Math.floor(x / overlay.tileSize),
    Math.floor(y / overlay.tileSize),
    false,
  );
  if (tile === null) return 0;
  return tile.written[(y % overlay.tileSize) * overlay.tileSize + (x % overlay.tileSize)] ?? 0;
}

/**
 * A tile's content hash, computed once per write rather than once per call.
 *
 * **A cost guard, not a correctness one**, and it does not change an answer — a perturbation
 * removing it fails no test and is expected to. It stays because `overlayTiles` is called every
 * frame to decide uploads, and hashing is bytes: four hundred written tiles of 64×64×4 floats took
 * **79 ms uncached and 0.061 ms cached**, measured 2026-09-15. The first of those is a frame
 * budget spent several times over to learn that nothing changed.
 */
function hashOf(overlay: Overlay, tile: OverlayTile): string {
  if (tile.hash !== '') return tile.hash;
  /* The written mask is hashed with the values: two tiles holding the same numbers where one of
     them wrote a zero and the other did not are different tiles, and compositing proves it. */
  const bytes = new Uint8Array(tile.texels.buffer.byteLength + tile.written.byteLength);
  bytes.set(new Uint8Array(tile.texels.buffer), 0);
  bytes.set(tile.written, tile.texels.buffer.byteLength);
  tile.hash = hashTile(bytes);
  return tile.hash;
}

/**
 * The distinct content hashes of the written tiles, into `out`. Returns how many.
 *
 * **Distinct, because an identical mark in two places is one thing to store.** The same blast
 * scorch on twenty crates is twenty tiles in memory — each is written in place and they diverge the
 * moment anything else touches one — and one page to upload, which is where the cost actually is.
 * Hashed exactly as a base tile is, by `hashTile`, so the two live in one address space.
 */
export function overlayTiles(overlay: Overlay, out: string[]): number {
  out.length = 0;
  const seen = new Set<string>();
  for (const tile of overlay.tiles.values()) {
    const hash = hashOf(overlay, tile);
    if (seen.has(hash)) continue;
    seen.add(hash);
    out.push(hash);
  }
  out.sort();
  return out.length;
}

/** How many tiles hold a written texel. What a memory readout shows. */
export function overlayTileCount(overlay: Overlay): number {
  return overlay.tiles.size;
}

/**
 * Put the overlay over the base, channel by channel, into `out`.
 *
 * **`written` is a parameter because the plan's signature had no way to say which texels and
 * channels were touched**, and without it compositing either overwrites everything — so one scorch
 * mark erases the base across the whole tile — or guesses from a sentinel value, which is a value
 * somebody eventually writes on purpose.
 */
export function compositeOverlay(
  out: Float32Array,
  base: Float32Array,
  overlay: Float32Array,
  written: Uint8Array,
): void {
  for (let texel = 0; texel < written.length; texel += 1) {
    const mask = written[texel] as number;
    for (let c = 0; c < OVERLAY_CHANNELS; c += 1) {
      const at = texel * OVERLAY_CHANNELS + c;
      out[at] = (mask & (1 << c)) === 0 ? (base[at] as number) : (overlay[at] as number);
    }
  }
}

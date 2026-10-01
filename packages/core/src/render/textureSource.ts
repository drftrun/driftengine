/**
 * The size of an image a caller hands over, and the one rule a texture array adds to it: every
 * layer the same size.
 *
 * Backend-neutral, because both backends upload the same `TexImageSource` and must agree on its
 * size, and on refusing an array whose layers disagree, before either touches a device.
 */

export interface SourceSize {
  readonly width: number;
  readonly height: number;
}

/** Width and height of any `TexImageSource`: a video by its frame, everything else by its own size. */
export function sourceSize(source: TexImageSource): SourceSize {
  const candidate = source as {
    width?: number;
    height?: number;
    videoWidth?: number;
    videoHeight?: number;
  };
  const width = candidate.videoWidth ?? candidate.width ?? 0;
  const height = candidate.videoHeight ?? candidate.height ?? 0;
  return { width: Math.max(1, width), height: Math.max(1, height) };
}

/**
 * The one size every layer of an array shares, or a refusal naming the first that differs.
 *
 * **Refused rather than resized**, because an array layer has no size of its own — the device
 * allocates one size for all of them — and quietly scaling a 128-pixel sign up to a 512 array, or a
 * facade down, is a decision about quality the caller should make where they can see it. Sorting
 * images into arrays by size is theirs; this makes sure they did.
 */
export function layerSize(sources: readonly TexImageSource[]): SourceSize {
  const first = sources[0];
  if (first === undefined) {
    throw new Error('createSurfaceTextureArray: an array needs at least one image');
  }
  const size = sourceSize(first);
  for (let layer = 1; layer < sources.length; layer++) {
    const next = sourceSize(sources[layer] as TexImageSource);
    if (next.width !== size.width || next.height !== size.height) {
      throw new Error(
        `createSurfaceTextureArray: layer ${layer} is ${next.width}×${next.height} and layer 0 is ` +
          `${size.width}×${size.height}. Every layer of an array is one size on the device; group ` +
          'images into arrays by size, or scale them to one, before building the array.',
      );
    }
  }
  return size;
}

/** Whether a constructor argument is a list of images rather than one. */
export function isSourceList(
  source: TexImageSource | readonly TexImageSource[],
): source is readonly TexImageSource[] {
  return Array.isArray(source);
}

/**
 * `update` replaces the one image of a plain texture. An array's layers are its identity — a
 * block's facades by index — and replacing "the image" of a forty-layer array has no single
 * meaning, so it is refused rather than guessed at.
 */
export function refuseArrayUpdate(layers: number): void {
  if (layers === 1) return;
  throw new Error(
    `updateSurfaceTexture: this texture is an array of ${layers} layers, and update replaces the ` +
      'one image of a plain texture. Build a new array for new layers.',
  );
}

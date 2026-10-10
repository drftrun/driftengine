import type { RgbaImage } from './png.d.mts';

/** The backends `look` photographs by default, in the order a consumer runs them. */
export const LOOK_BACKENDS: readonly ['webgpu', 'webgl2'];

/** At or above this share of one colour, a canvas is called empty. */
export const EMPTY_SHARE: number;

/** What a frame is made of. */
export interface FrameStats {
  readonly width: number;
  readonly height: number;
  /** The most common colour, as `#rrggbb`. */
  readonly dominant: string;
  /** The share of the frame that colour covers, 0 to 1. */
  readonly dominantShare: number;
  /** Rec. 709 luminance averaged over the frame, 0 to 255. */
  readonly meanLuminance: number;
}

/** One backend's photograph and everything the page said while it was taken. */
export interface LookCapture {
  readonly backend: string;
  readonly url: string;
  /** What a player sees, interface included. */
  readonly file: string;
  /**
   * The backend that actually drew, read from the context the page's canvas asked for: `'webgpu'`,
   * `'webgl2'`, or `null` when no canvas in the page asked for either.
   */
  readonly drawnWith: 'webgpu' | 'webgl2' | null;
  /** Measured over the canvas alone; `null` when the page never booted. */
  readonly stats: FrameStats | null;
  /** The share of the canvas that changed between two frames; `null` when the page never booted. */
  readonly moved: number | null;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  /** Every console line, `level: text`. */
  readonly logs: readonly string[];
  readonly problems: readonly string[];
}

export interface LookReport {
  readonly url: string;
  /** The renderer string of the GPU that drew, read from a WebGL2 context. */
  readonly gpu: string;
  readonly captures: readonly LookCapture[];
  readonly problems: readonly string[];
  /** True when no capture found a problem. */
  readonly ok: boolean;
}

export interface LookOptions {
  /** The address of the running game. */
  readonly url: string;
  readonly backends?: readonly string[];
  /** Where the PNGs and `look.json` go. Defaults to `.driftengine/look`. */
  readonly out?: string;
  readonly width?: number;
  readonly height?: number;
  /** How long to wait for a canvas in the page to ask for a WebGPU or WebGL2 context. */
  readonly bootMs?: number;
  /** A pause after that for the first frames. */
  readonly settleMs?: number;
  /** How long to wait after that for the canvas to show more than one colour. */
  readonly drawMs?: number;
  /** The gap between the two frames compared to tell whether the game moves. */
  readonly moveMs?: number;
  /** Browser flags; defaults to `gpuFlagsFor()`. */
  readonly flags?: readonly string[] | null;
  /** `false` opens a real window, for a machine whose headless browser cannot reach its GPU. */
  readonly headless?: boolean;
}

export function gpuFlagsFor(platform?: string): string[] | null;
export function lookUrl(url: string, backend: string): string;
export function frameStats(image: RgbaImage): FrameStats;
export function changedShare(a: RgbaImage, b: RgbaImage, tolerance?: number): number;
export function sortConsole(lines: readonly string[]): { errors: string[]; warnings: string[] };
export function look(options: LookOptions): Promise<LookReport>;
export function formatLook(report: LookReport): string;

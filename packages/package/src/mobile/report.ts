/**
 * What a device says about itself, collected rather than assumed.
 *
 * **A pinned desktop Chromium cannot see the failures this tier exists to catch.** WebKit enforces
 * a sixteen-byte stride for arrays in the uniform address space where Dawn does not, so the shaders
 * that draw everything compiled on every desktop browser and on no iPhone — and nothing in the
 * pipeline could have known. A mobile build that ships without collecting what devices report
 * throws away the only reason mobile is in this delivery at all.
 *
 * **Every value is what the device said**, and a value that could not be read is the empty string.
 * An invented renderer string is what the capability clamp then matches against, which is how a
 * phone ends up in the wrong tier — the same rule `AGENTS.md` sets for a backend that cannot answer.
 *
 * Reached in a packaged build with `?report=1` on the entry URL. Not a hidden gesture: a tester who
 * has to be told a secret is a tester who reports the wrong thing.
 */
export function deviceReport(): Record<string, string> {
  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  return {
    userAgent: agent,
    platform: platformOf(agent),
    engine: engineOf(agent),
    webgpu:
      (globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu === undefined
        ? 'absent'
        : 'present',
    webglRenderer: unmaskedRenderer(),
    secureContext: String(Boolean((globalThis as { isSecureContext?: boolean }).isSecureContext)),
    host: (globalThis as Record<string, unknown>).__driftHost === undefined ? 'absent' : 'present',
    pixelRatio: String((globalThis as { devicePixelRatio?: number }).devicePixelRatio ?? ''),
  };
}

/**
 * The part number the driver reports, which is the only string worth having.
 *
 * `WEBGL_debug_renderer_info` is the extension that gives it. Where a browser withholds it — some
 * do, for fingerprinting — the answer is empty rather than the vendor-neutral placeholder, because
 * an empty string is visibly nothing and `WebKit WebGL` is visibly a device.
 */
function unmaskedRenderer(): string {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (gl === null) return '';
    const info = (gl as WebGLRenderingContext).getExtension('WEBGL_debug_renderer_info') as {
      UNMASKED_RENDERER_WEBGL: number;
    } | null;
    if (info === null) return '';
    const value: unknown = (gl as WebGLRenderingContext).getParameter(info.UNMASKED_RENDERER_WEBGL);
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

/** `iOS 18.2` or `Android 14`, from the agent string, or empty where it says neither. */
function platformOf(agent: string): string {
  const ios = agent.match(/(?:iPhone|iPad|CPU) OS (\d+)[._](\d+)/);
  if (ios !== null) return `iOS ${ios[1]}.${ios[2]}`;
  const android = agent.match(/Android (\d+(?:\.\d+)?)/);
  if (android !== null) return `Android ${android[1]}`;
  return '';
}

/**
 * Which browser engine build this is.
 *
 * The number that matters when a shader fails to compile: an Android WebView is updated through
 * the store independently of the OS, so two phones on the same Android version can disagree.
 */
function engineOf(agent: string): string {
  const chrome = agent.match(/Chrome\/([\d.]+)/);
  if (chrome !== null) return `Chrome ${chrome[1]}`;
  const safari = agent.match(/Version\/([\d.]+).*Safari/);
  if (safari !== null) return `Safari ${safari[1]}`;
  return '';
}

/** The query that turns the table on. Documented rather than secret, for the reason above. */
const REPORT_QUERY = 'report=1';

/**
 * Draw the report over whatever is on screen, if this build was asked for it.
 *
 * **Over the game rather than instead of it**, so a tester can see that the game is running behind
 * the numbers they are reading — a report on a blank page cannot distinguish a device that failed
 * to draw from one that was never asked to.
 *
 * Does nothing at all unless the entry URL carries `?report=1`, which is the whole of the switch.
 */
export function showDeviceReport(): void {
  try {
    if (!globalThis.location?.search?.includes(REPORT_QUERY)) return;
  } catch {
    return;
  }

  const draw = (): void => {
    try {
      const panel = document.createElement('pre');
      panel.style.cssText =
        'position:fixed;inset:auto 8px 8px 8px;z-index:2147483647;margin:0;padding:10px;' +
        'background:rgba(11,11,13,.92);color:#ececf0;font:12px/1.5 ui-monospace,monospace;' +
        'border:1px solid #26262d;border-radius:6px;white-space:pre-wrap;max-height:60vh;' +
        'overflow:auto;pointer-events:none';
      panel.textContent = Object.entries(deviceReport())
        .map(([key, value]) => `${key.padEnd(14)} ${value === '' ? '—' : value}`)
        .join('\n');
      document.body?.appendChild(panel);
    } catch {
      /* No DOM yet, or a page that replaced its own body. A diagnostic is never worth a throw. */
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', draw, { once: true });
  } else {
    draw();
  }
}

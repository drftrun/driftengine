import { describe, expect, it } from 'vitest';

import { CSP, sourcesFor } from './csp.ts';

/**
 * **A directive missing one scheme is invisible until somebody attaches a debugger to a shipped
 * build**, which is why the policy is data with assertions over it rather than a careful read.
 */
describe('the packaged content security policy', () => {
  /**
   * The reported case: `wss:` was allowed and `ws:` was not, so a packaged game could not reach a
   * relay on its own network. Chromium blocks that before a packet leaves — the relay logs nothing,
   * the game reports only that it did not connect, and the two together point at the network.
   */
  it('allows a socket to a server that cannot hold a certificate', () => {
    expect(sourcesFor('connect-src')).toContain('ws:');
  });

  it('and still allows the secure scheme a public relay needs', () => {
    expect(sourcesFor('connect-src')).toContain('wss:');
  });

  /*
   * The rest of `connect-src`, because a game fetches from its own origin, from blobs it made and
   * from ordinary web services, and a policy that breaks one of those is one somebody switches off.
   */
  it('keeps everything else a game connects to', () => {
    for (const source of ["'self'", 'drift:', 'blob:', 'data:', 'https:']) {
      expect(sourcesFor('connect-src'), source).toContain(source);
    }
  });

  /**
   * **The refusal this policy exists for, and the one thing it must never lose.**
   *
   * A renderer that can fetch a script over the network is a renderer whose network can hand it
   * code, and it runs beside a bridge to the filesystem. Widening `connect-src` must not widen
   * this, which is the assertion that says the two are separate decisions.
   */
  it('never lets a script come from the network', () => {
    const scripts = sourcesFor('script-src');
    expect(scripts).not.toContain('https:');
    expect(scripts).not.toContain('http:');
    expect(scripts.some((source) => source.startsWith('http'))).toBe(false);
    expect(scripts).toContain("'self'");
  });

  /** And nothing else quietly gains the network either. */
  it('keeps plaintext http out of every directive', () => {
    expect(CSP).not.toMatch(/(^|[ ;])http:/);
  });

  it('carries every directive the served page needs', () => {
    for (const directive of [
      'default-src',
      'script-src',
      'style-src',
      'img-src',
      'media-src',
      'font-src',
      'worker-src',
      'connect-src',
    ]) {
      expect(sourcesFor(directive).length, directive).toBeGreaterThan(0);
    }
  });

  /** One header value, semicolon separated, which is what the served response carries. */
  it('joins into a single header value', () => {
    expect(CSP.split('; ')).toHaveLength(8);
    expect(CSP).toContain("default-src 'self'");
  });
});

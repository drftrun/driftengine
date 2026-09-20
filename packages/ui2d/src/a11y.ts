/**
 * The interface tree in the shape assistive technology needs, and the seam that publishes it.
 *
 * **A seam, because whether anything can receive this is the host's business.** A browser host can
 * mirror the tree into a hidden structure that a screen reader walks. A native host may have a
 * platform accessibility service, or may have nothing — and `createNullA11yHost` is the honest
 * answer in that case rather than an absence nobody noticed.
 */
import type { UiNode } from './uiNode.ts';

export interface A11yNode {
  role: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  focused: boolean;
}

export interface A11yHost {
  publish(nodes: readonly A11yNode[], count: number): void;
}

/** A host that accepts a tree and does nothing with it. See the header. */
export function createNullA11yHost(): A11yHost {
  return { publish() {} };
}

/**
 * What role this node plays, derived rather than declared.
 *
 * Derived, because a role a caller has to set is a role most callers will not set, and an
 * accessibility tree that is mostly unlabelled is worse than none: it reads as though the interface
 * has been described when it has not.
 */
function roleOf(node: UiNode): string {
  if (node.focusable && node.children.length === 0) return 'button';
  if (node.clip && (node.contentSpanX > node.rect.w || node.contentSpanY > node.rect.h)) {
    return 'scrollable';
  }
  return 'text';
}

function contributes(node: UiNode): boolean {
  return node.interactive || node.focusable || node.text.length > 0;
}

function gather(node: UiNode, out: A11yNode[], at: number): number {
  if (node.hidden) return at;
  let next = at;
  if (contributes(node)) {
    const slot = out[next] ?? { role: '', label: '', x: 0, y: 0, w: 0, h: 0, focused: false };
    slot.role = roleOf(node);
    slot.label = node.text;
    slot.x = node.rect.x;
    slot.y = node.rect.y;
    slot.w = node.rect.w;
    slot.h = node.rect.h;
    slot.focused = false;
    out[next] = slot;
    next += 1;
  }
  for (const child of node.children) next = gather(child, out, next);
  return next;
}

/** Fill `out` with every node worth describing, in tree order. Returns how many. */
export function a11yTree(root: UiNode, out: A11yNode[]): number {
  const count = gather(root, out, 0);
  out.length = count;
  return count;
}

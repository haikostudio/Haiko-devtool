/**
 * Native stub — the edge-peek reveal is a mouse-driven affordance and only
 * exists on web. See use-left-edge-peek.web.ts for the real implementation.
 */
export function useLeftEdgePeek(_options: { enabled: boolean; sidebarWidth: number }): boolean {
  return false;
}

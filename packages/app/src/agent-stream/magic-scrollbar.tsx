import type { StreamMagicScrollbarProps } from "./magic-scrollbar-types";

// Native fallback: the magic scrollbar is a pointer-centric web affordance
// (hover tooltips, dot targets). Metro resolves magic-scrollbar.web.tsx on web;
// native renders nothing.
export function StreamMagicScrollbar(_props: StreamMagicScrollbarProps): null {
  return null;
}

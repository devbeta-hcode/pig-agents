/** Viewport rect for native BrowserView (window client / DIP coordinates). */

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const MIN_SIZE = 8;

/** Map `.browser-viewport` host element to BrowserView.setBounds (no clipping — element is the host). */
export function measureBrowserHost(el: HTMLElement): BrowserBounds | null {
  const r = el.getBoundingClientRect();
  if (r.width < MIN_SIZE || r.height < MIN_SIZE) return null;
  return {
    x: Math.round(r.left),
    y: Math.round(r.top),
    width: Math.round(r.width),
    height: Math.round(r.height),
  };
}

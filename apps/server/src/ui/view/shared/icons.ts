import { svg } from './dom.js';
import type { Tone } from './format.js';

/** Decorative only (aria-hidden): the word next to the icon carries the meaning. */
function icon(...children: SVGElement[]): SVGSVGElement {
  return svg(
    'svg',
    {
      class: 'icon',
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 2.4,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    ...children,
  );
}

/** Octagon with "!": critical. */
export const critIcon = () =>
  icon(
    svg('polygon', { points: '7.9 2 16.1 2 22 7.9 22 16.1 16.1 22 7.9 22 2 16.1 2 7.9' }),
    svg('line', { x1: 12, y1: 7.5, x2: 12, y2: 13 }),
    svg('line', { x1: 12, y1: 16.5, x2: 12.01, y2: 16.5 }),
  );

/** Triangle with "!": warning. */
export const warnIcon = () =>
  icon(
    svg('path', {
      d: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
    }),
    svg('line', { x1: 12, y1: 9, x2: 12, y2: 13 }),
    svg('line', { x1: 12, y1: 17, x2: 12.01, y2: 17 }),
  );

/** Circle with a check: healthy / done. */
export const okIcon = () =>
  icon(
    svg('circle', { cx: 12, cy: 12, r: 10 }),
    svg('polyline', { points: '7.5 12.5 10.5 15.5 16.5 9' }),
  );

/** Circle with "i": info / unknown / not configured. */
export const infoIcon = () =>
  icon(
    svg('circle', { cx: 12, cy: 12, r: 10 }),
    svg('line', { x1: 12, y1: 16, x2: 12, y2: 11.5 }),
    svg('line', { x1: 12, y1: 8, x2: 12.01, y2: 8 }),
  );

/** Clock: countdowns and expiry. */
export const clockIcon = () =>
  icon(
    svg('circle', { cx: 12, cy: 12, r: 10 }),
    svg('polyline', { points: '12 6.5 12 12 15.5 14' }),
  );

export function toneIcon(tone: Tone): SVGSVGElement {
  switch (tone) {
    case 'crit':
      return critIcon();
    case 'warn':
      return warnIcon();
    case 'ok':
      return okIcon();
    default:
      return infoIcon();
  }
}

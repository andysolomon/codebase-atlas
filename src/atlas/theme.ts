/* The bridge between the design system's CSS tokens and the map, which paints on a canvas and so
   needs concrete colours rather than `var(--ink)`.

   There is exactly one source of truth for colour — `src/styles/tokens/colors.css`, mirrored from the
   Codebase Atlas design system. Nothing here restates a hex value; a theme is read out of the
   cascade by giving a throwaway element the `data-theme` we want and asking for its computed tokens.
   Add a theme upstream, list its name in `PAPERS`, and the map picks it up. */

import type { PaperTheme, Theme } from './types';

/** Every paper the design system ships, in the order the topbar cycles them. */
export const PAPERS: PaperTheme[] = ['tan', 'blueprint', 'dark-luxe', 'graphite', 'oxblood'];

/** The names the two original themes shipped under, so links written before still land somewhere. */
const ALIASES: Record<string, PaperTheme> = { light: 'blueprint', dark: 'dark-luxe' };

/** A paper name from a URL, an attribute or a stale bookmark, resolved to one we actually have. */
export function resolvePaper(name: string | null | undefined): PaperTheme {
  if (!name) return 'tan';
  const alias = ALIASES[name];
  if (alias) return alias;
  return PAPERS.includes(name as PaperTheme) ? (name as PaperTheme) : 'tan';
}

/** Which token fills which slot on the map. The right-hand side is the design system's vocabulary. */
const SLOTS: Record<keyof Theme, string> = {
  bg:    '--paper',        // the sheet itself
  paper: '--paper-sunken', // the ground the blocks stand on
  top:   '--paper-raised', // block tops, catching the light
  faceA: '--face-shade',   // left faces, densely hatched
  faceB: '--face-tint',    // right faces, lightly hatched
  ink:   '--ink',
  dim:   '--ink-dim',
  hair:  '--ink-hair',
  faint: '--ink-faint',
};

/* The tan theme, spelled out once, for the case where the tokens never arrive — the element used
   standalone without the stylesheet, or read before the CSS has landed. Everything else is cascade. */
const FALLBACK: Theme = {
  bg: '#cfc79c', paper: '#c8c093', top: '#ddd6b2', faceA: '#bdb488', faceB: '#cec696',
  ink: '#16130a', dim: 'rgba(22,19,10,.55)', hair: 'rgba(22,19,10,.28)', faint: 'rgba(22,19,10,.16)',
};

const cache = new Map<PaperTheme, Theme>();

/** Read one theme out of the token layer. Cached: tokens are static once the stylesheet has loaded. */
export function readTheme(name: PaperTheme): Theme {
  const hit = cache.get(name);
  if (hit) return hit;

  const probe = document.createElement('div');
  probe.dataset.theme = name;
  probe.style.cssText = 'position:absolute;width:0;height:0;visibility:hidden;pointer-events:none';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const read = (token: string) => cs.getPropertyValue(token).trim();
  const ink = read('--ink');
  const slots = Object.keys(SLOTS) as (keyof Theme)[];
  // No stylesheet yet: hand back the fallback and don't cache it — the tokens may land later.
  const theme: Theme = ink ? { ...FALLBACK } : FALLBACK;
  if (ink) for (const slot of slots) theme[slot] = read(SLOTS[slot]) || FALLBACK[slot];
  probe.remove();

  if (ink) cache.set(name, theme);
  return theme;
}

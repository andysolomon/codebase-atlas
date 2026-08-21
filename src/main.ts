import { defineAtlas } from './atlas/engine';
import type { PaperTheme } from './atlas/types';
import { ARC_WORLDS } from './data/arc-worlds';

defineAtlas();

const PAPERS: PaperTheme[] = ['tan', 'light', 'dark'];
const atlas = document.getElementById('atlas') as import('./atlas/engine').Atlas;

// Theme: ?paper=tan|light|dark (default tan). Persisted in the URL so links carry the theme.
const q = new URLSearchParams(location.search).get('paper');
const paper: PaperTheme = PAPERS.includes(q as PaperTheme) ? (q as PaperTheme) : 'tan';
atlas.setAttribute('paper', paper);
document.documentElement.dataset.theme = paper;

// Keep the page background in step whenever the element's paper attribute changes.
new MutationObserver(() => {
  const p = atlas.getAttribute('paper') as PaperTheme;
  document.documentElement.dataset.theme = p;
  const u = new URL(location.href);
  if (p === 'tan') u.searchParams.delete('paper'); else u.searchParams.set('paper', p);
  history.replaceState(null, '', u.pathname + u.search + u.hash);
}).observe(atlas, { attributes: true, attributeFilter: ['paper'] });

// Dataset: static import of the demo repo. Swap for a fetched JSON file per repo.
atlas.data = ARC_WORLDS;

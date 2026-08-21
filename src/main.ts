import { defineAtlas } from './atlas/engine';
import type { AtlasData, PaperTheme } from './atlas/types';
import { buildAtlas, loadGitHub, parseGitHub } from './analyze';
import { enrichInBrowser } from './analyze/ai/client';
import { ARC_WORLDS } from './data/arc-worlds';

defineAtlas();

const PAPERS: PaperTheme[] = ['tan', 'light', 'dark'];
const atlas = document.getElementById('atlas') as import('./atlas/engine').Atlas;
const status = document.getElementById('status') as HTMLDivElement;

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

// ── status line (shown while a repo is being scanned, or on error) ──
function showStatus(html: string, isError = false) {
  status.innerHTML = html;
  status.style.display = 'block';
  status.style.borderColor = isError ? 'currentColor' : '';
}
function hideStatus() { status.style.display = 'none'; }

function setRepoParam(key: 'repo' | 'atlas' | null, value?: string) {
  const u = new URL(location.href);
  u.searchParams.delete('repo'); u.searchParams.delete('atlas');
  if (key && value) u.searchParams.set(key, value);
  history.replaceState(null, '', u.pathname + u.search);
}

/** Open a repository by GitHub URL / owner/name. */
async function openGitHub(query: string) {
  const ref = parseGitHub(query);
  if (!ref) { showStatus(`COULD NOT READ “${esc(query)}” — TRY github.com/owner/repo`, true); return; }
  const label = `${ref.owner}/${ref.repo}${ref.ref ? '@' + ref.ref : ''}`;
  atlas.setAttribute('repo-query', label);
  setRepoParam('repo', label);
  showStatus(`SCANNING ${esc(label).toUpperCase()} …`);
  try {
    const src = await loadGitHub(ref, {
      onProgress: (p) => {
        if (p.phase === 'tree') showStatus(`SCANNING ${esc(label).toUpperCase()} · ${p.message ? esc(p.message).toUpperCase() : 'TREE'}`);
        else showStatus(`READING ${esc(label).toUpperCase()} · ${p.done} / ${p.total} FILES`);
      },
    });
    showStatus(`BUILDING THE MAP …`);
    atlas.data = buildAtlas(src);
    hideStatus();
    // The scanned map is on screen. If an enrichment endpoint is deployed, upgrade it in place.
    void enrich(src, label);
  } catch (e) {
    showStatus(`✕ ${esc(String((e as Error).message || e)).toUpperCase()}`, true);
  }
}

// Once the endpoint has proved to be absent — nobody deployed it, `bun run dev` has no backend —
// stop asking for the rest of the session rather than failing three times per repo.
let enrichOffered = true;
let enriching: AbortController | null = null;

async function enrich(src: Parameters<typeof buildAtlas>[0], label: string) {
  if (!enrichOffered) return;
  enriching?.abort();
  const run = new AbortController();
  enriching = run;
  try {
    const r = await enrichInBrowser(src, {
      signal: run.signal,
      onProgress: (m) => { if (!run.signal.aborted) showStatus(`${esc(label).toUpperCase()} · ${esc(m).toUpperCase()} …`); },
    });
    if (run.signal.aborted) return;
    if (r.data.provenance) atlas.data = r.data;
    else if (r.fallbacks.some((f) => /\b(404|405)\b|Failed to fetch|NetworkError/i.test(f))) enrichOffered = false;
    hideStatus();
  } catch {
    hideStatus();   // a map without written prose is still a map
  } finally {
    if (enriching === run) enriching = null;
  }
}

/** Open a pre-built atlas JSON (e.g. written by `bun run atlas`). */
async function openAtlasJson(url: string) {
  setRepoParam('atlas', url);
  showStatus(`LOADING ${esc(url).toUpperCase()} …`);
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
    atlas.data = (await r.json()) as AtlasData;
    hideStatus();
  } catch (e) {
    showStatus(`✕ ${esc(String((e as Error).message || e)).toUpperCase()}`, true);
  }
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');

// The topbar's OPEN REPO field: a GitHub URL, owner/name, or a path to an atlas JSON.
atlas.openRepo = (value) => {
  if (/\.json(\?|$)/i.test(value)) void openAtlasJson(value); else void openGitHub(value);
};

// ── initial dataset ──
const params = new URLSearchParams(location.search);
const repoParam = params.get('repo'), atlasParam = params.get('atlas');
if (atlasParam) { atlas.data = ARC_WORLDS; void openAtlasJson(atlasParam); }
else if (repoParam) { atlas.data = ARC_WORLDS; void openGitHub(repoParam); }
else atlas.data = ARC_WORLDS;

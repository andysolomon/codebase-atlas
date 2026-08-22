import { defineAtlas, resolvePaper } from './atlas/engine';
import type { AtlasData } from './atlas/types';
import { buildAtlas, loadGitHub, parseGitHub } from './analyze';
import type { RepoSource } from './analyze';
import { openLocalRepo, supportsLocalRepos } from './analyze/local';
import { enrichInBrowser } from './analyze/ai/client';
import { ARC_WORLDS } from './data/arc-worlds';
import * as trail from './trail';
import type { TrailEntry } from './trail';

defineAtlas();

const atlas = document.getElementById('atlas') as import('./atlas/engine').Atlas;
const status = document.getElementById('status') as HTMLDivElement;

// Paper: ?paper=<name> for any theme the design system ships (default tan). Persisted in the URL so
// links carry the theme; `light` and `dark`, the names the first two shipped under, still resolve.
// data-theme on the root is what selects the token block, so the page and the element share a palette.
const rawPaper = new URLSearchParams(location.search).get('paper');
const paper = resolvePaper(rawPaper);
atlas.setAttribute('paper', paper);
document.documentElement.dataset.theme = paper;

/** Write the paper into the URL under the name the design system uses for it now. */
function syncPaperParam(p: string) {
  const u = new URL(location.href);
  if (p === 'tan') u.searchParams.delete('paper'); else u.searchParams.set('paper', p);
  history.replaceState(null, '', u.pathname + u.search + u.hash);
}
// An old ?paper=light|dark link lands where it always did, and leaves with the current name on it.
if (rawPaper !== null && rawPaper !== paper) syncPaperParam(paper);

// Keep the page background in step whenever the element's paper attribute changes.
new MutationObserver(() => {
  const p = resolvePaper(atlas.getAttribute('paper'));
  document.documentElement.dataset.theme = p;
  syncPaperParam(p);
}).observe(atlas, { attributes: true, attributeFilter: ['paper'] });

// ── status line (shown while a repo is being scanned, or on error) ──
function showStatus(html: string, isError = false) {
  status.innerHTML = `<span class="msg">${html}</span>`;
  status.style.display = 'flex';
  status.style.borderColor = isError ? 'currentColor' : '';
}
/** The same card, carrying one thing to press. Used where continuing would spend money: the atlas
    states what it would do and waits, rather than doing it and mentioning it afterwards. */
function showStatusOffer(html: string, label: string, act: () => void) {
  showStatus(html, true);
  const b = document.createElement('button');
  b.textContent = label;
  b.onclick = () => { hideStatus(); act(); };
  status.appendChild(b);
}
function hideStatus() { status.style.display = 'none'; }
/** A line worth reading once. It says what happened, then gets out of the way. */
function flash(html: string, ms = 5000) {
  showStatus(html);
  const shown = status.textContent;
  window.setTimeout(() => { if (status.textContent === shown) hideStatus(); }, ms);
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function setRepoParam(key: 'repo' | 'atlas' | null, value?: string) {
  const u = new URL(location.href);
  u.searchParams.delete('repo'); u.searchParams.delete('atlas');
  if (key && value) u.searchParams.set(key, value);
  history.replaceState(null, '', u.pathname + u.search + u.hash);   // keep #inside / #trace / #edge
}

// ── the repository currently on screen ──
// Held so ANALYZE can re-read it without scanning again. A pre-built atlas JSON and the demo have no
// source, which is what greys the button out: their prose was already written.
let scanned: { source: RepoSource; label: string } | null = null;

/** Redraw the topbar from what is actually true right now: the trail, and whether there is a
    repository the model could be pointed at. */
function refreshChrome() {
  atlas.nav = { entries: trail.entries.map((e) => ({ label: e.label, ...(e.query ? { query: e.query } : {}) })), index: trail.index, go };
  if (!scanned) atlas.analyzeState = 'off';
  else if (atlas.analyzeState === 'off') atlas.analyzeState = 'idle';
  atlas.refreshBar();
}

/** Show an entry that is already built: no scan, no spend, and the analysis it carries comes with it. */
function land(entry: TrailEntry, opts: { replace?: boolean } = {}) {
  if (opts.replace) trail.update(entry); else trail.record(entry);
  scanned = entry.source ? { source: entry.source, label: entry.label } : null;
  atlas.setAttribute('repo-query', entry.query && entry.kind === 'github' ? entry.query : '');
  setRepoParam(entry.kind === 'github' ? 'repo' : entry.kind === 'atlas' ? 'atlas' : null, entry.query);
  atlas.analyzeState = !entry.source ? 'off' : entry.data?.provenance ? 'done' : 'idle';
  refreshChrome();
}

/** The topbar's ◀ ▶. An entry that still holds its map is redrawn instantly; one restored from a
    previous session holds only a query, so it is scanned again in place. */
async function go(i: number) {
  const e = trail.moveTo(i);
  if (!e) return;
  if (e.data) { atlas.data = e.data; land(e, { replace: true }); return; }
  if (e.kind === 'github' && e.query) return openGitHub(e.query, { replace: true });
  if (e.kind === 'atlas' && e.query) return openAtlasJson(e.query, { replace: true });
  atlas.data = ARC_WORLDS;
  land(e, { replace: true });
}

/** Open a repository by GitHub URL / owner/name. */
async function openGitHub(query: string, opts: { replace?: boolean } = {}) {
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
    const data = buildAtlas(src);
    atlas.data = data;
    land({ kind: 'github', label, query: label, data, source: src }, opts);
    hideStatus();
    // The scanned map is on screen. If an enrichment endpoint is reachable, upgrade it in place.
    void enrich(src, label);
  } catch (e) {
    showStatus(`✕ ${esc(String((e as Error).message || e)).toUpperCase()}`, true);
  }
}

/** Open a folder on this machine. The files never leave the tab — the scan runs here. */
async function openLocal() {
  showStatus('CHOOSE A FOLDER …');
  try {
    const src = await openLocalRepo({
      onProgress: (p) => {
        if (p.phase === 'tree') showStatus(`WALKING THE FOLDER · ${p.done} FILES`);
        else showStatus(`READING · ${p.done} / ${p.total} FILES`);
      },
    });
    if (!src) { hideStatus(); return; }            // the picker was closed
    if (!src.files.length) { showStatus('✕ THAT FOLDER HAS NOTHING TO MAP', true); return; }
    showStatus('BUILDING THE MAP …');
    const data = buildAtlas(src);
    atlas.data = data;
    land({ kind: 'local', label: src.name, data, source: src });
    hideStatus();
    void enrich(src, src.name);
  } catch (e) {
    showStatus(`✕ ${esc(String((e as Error).message || e)).toUpperCase()}`, true);
  }
}

/** Open a pre-built atlas JSON (e.g. written by `bun run atlas`). */
async function openAtlasJson(url: string, opts: { replace?: boolean } = {}) {
  setRepoParam('atlas', url);
  showStatus(`LOADING ${esc(url).toUpperCase()} …`);
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
    const data = (await r.json()) as AtlasData;
    atlas.data = data;
    land({ kind: 'atlas', label: data.product || url, query: url, data }, opts);
    hideStatus();
  } catch (e) {
    showStatus(`✕ ${esc(String((e as Error).message || e)).toUpperCase()}`, true);
  }
}

// ── AI analysis ──
// Once the endpoint has proved to be absent — nobody deployed it, the dev server has no backend —
// stop asking after every scan rather than failing three times per repo. Pressing ANALYZE still
// asks, and still says why it could not.
let enrichOffered = true;
let enriching: AbortController | null = null;

interface EnrichRun {
  /** A person pressed a button, so failures are worth saying out loud. */
  manual?: boolean;
  /** Ignore what is cached and ask again. */
  refresh?: boolean;
  /** Finish the work on the endpoint's declared fallback model. Only ever set by pressing the offer. */
  useFallback?: boolean;
}

async function enrich(src: RepoSource, label: string, run_: EnrichRun = {}) {
  const { manual = false } = run_;
  if (!enrichOffered && !manual) return;
  enriching?.abort();
  const run = new AbortController();
  enriching = run;
  atlas.analyzeState = 'busy';
  atlas.refreshBar();
  try {
    const r = await enrichInBrowser(src, {
      signal: run.signal,
      ...(run_.refresh ? { refresh: true } : {}),
      ...(run_.useFallback ? { useFallback: true } : {}),
      onProgress: (m) => { if (!run.signal.aborted) showStatus(`${esc(label).toUpperCase()} · ${esc(m).toUpperCase()} …`); },
    });
    if (run.signal.aborted) return;
    const missing = r.fallbacks.some((f) => /\b(404|405)\b|Failed to fetch|NetworkError/i.test(f));
    if (r.data.provenance || r.cached) {
      atlas.data = r.data;
      trail.update({ data: r.data });        // stepping back later returns the analysed map, not the plain one
      atlas.analyzeState = 'done';
      // Say what fell back rather than quietly showing half a map as if it were whole — and where a
      // provider is the thing refusing, offer the way through instead of just naming the wall.
      if (r.fallbacks.length && r.rateLimited && r.fallbackModel && !run_.useFallback) {
        showStatusOffer(
          `ANALYSED, WITH GAPS · ${esc(r.fallbacks[0]).toUpperCase()}`,
          `⏵ FINISH ON ${esc(r.fallbackModel).toUpperCase()}`,
          () => void enrich(src, label, { manual: true, useFallback: true }),
        );
      } else if (r.fallbacks.length) {
        showStatus(`ANALYSED, WITH GAPS · ${esc(r.fallbacks[0]).toUpperCase()}`, true);
      } else if (r.cached) {
        flash('ANALYSED EARLIER · FROM CACHE, NOTHING SPENT');
      } else if (r.report.dropped.length) {
        // Rejected claims are the check working, not a failure — but they are never silent. The CLI
        // prints them; here the count says the map is smaller than what the model offered, and why.
        flash(`ANALYSED · ${r.report.dropped.length} UNSUPPORTED CLAIM${r.report.dropped.length === 1 ? '' : 'S'} DROPPED · ${esc(r.report.dropped[0]).toUpperCase()}`);
      } else hideStatus();
    } else {
      if (missing) enrichOffered = false;
      atlas.analyzeState = 'idle';
      if (!manual) hideStatus();
      else if (missing) showStatus('✕ NO /API/ENRICH HERE — RESTART THE DEV SERVER, OR DEPLOY IT', true);
      else if (r.rateLimited && r.fallbackModel && !run_.useFallback) {
        showStatusOffer(
          `✕ ${esc(r.fallbacks[0]).toUpperCase()}`,
          `⏵ FINISH ON ${esc(r.fallbackModel).toUpperCase()}`,
          () => void enrich(src, label, { manual: true, useFallback: true }),
        );
      } else showStatus(`✕ ${esc(r.fallbacks[0] || 'ANALYSIS RETURNED NOTHING USABLE').toUpperCase()}`, true);
    }
  } catch (e) {
    atlas.analyzeState = scanned ? 'idle' : 'off';
    if (manual) showStatus(`✕ ${esc(String((e as Error).message || e)).toUpperCase()}`, true);
    else hideStatus();   // a map without written prose is still a map
  } finally {
    if (enriching === run) enriching = null;
    atlas.refreshBar();
  }
}

// ── topbar hooks ──
// The OPEN REPO field: a GitHub URL, owner/name, or a path to an atlas JSON.
atlas.openRepo = (value) => {
  if (/\.json(\?|$)/i.test(value)) void openAtlasJson(value); else void openGitHub(value);
};
// LOCAL FOLDER — only offered where a browser can actually open one.
if (supportsLocalRepos()) atlas.openLocal = () => void openLocal();
// ANALYZE — run the model over whatever repository is on screen. Pressing it again on a map that is
// already analysed means "do it over", so that one skips the cache; the first press does not.
atlas.analyze = () => {
  if (!scanned) return;
  void enrich(scanned.source, scanned.label, { manual: true, refresh: atlas.analyzeState === 'done' });
};

// ── initial dataset ──
trail.restore();
const params = new URLSearchParams(location.search);
const repoParam = params.get('repo'), atlasParam = params.get('atlas');
atlas.data = ARC_WORLDS;
if (atlasParam) void openAtlasJson(atlasParam);
else if (repoParam) void openGitHub(repoParam);
else land({ kind: 'demo', label: ARC_WORLDS.product, data: ARC_WORLDS });
refreshChrome();

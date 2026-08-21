/** Loads a public (or token-authorised) GitHub repository as a RepoSource, in the browser or in Bun/Node. */

import { CONTEXT_FILE, isCode, isIgnoredPath } from './ignore.js';
import { countReferences, readingScore } from './references.js';
import { createResolver } from './resolve.js';
import type { OnProgress, RepoFile, RepoSource } from './types.js';

export interface GitHubRef { owner: string; repo: string; ref?: string }

/** Accepts "owner/repo", "github.com/owner/repo", full URLs, and ".../tree/<branch>[/path]". */
export function parseGitHub(input: string): GitHubRef | null {
  const s = input.trim().replace(/^git@github\.com:/, 'github.com/').replace(/\.git$/, '');
  const m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)(?:\/tree\/([^/\s]+))?/i)
    || s.match(/^([\w.-]+)\/([\w.-]+)(?:@([^/\s]+))?$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], ...(m[3] ? { ref: m[3] } : {}) };
}

export interface GitHubOptions {
  token?: string;
  /** Max code files whose content is fetched for import analysis. Default 400. */
  maxContentFiles?: number;
  /** Max manifests and READMEs, fetched on their own allowance so they never displace code. Default 150. */
  maxManifestFiles?: number;
  /** Skip content for files larger than this (bytes). Default 300 KB. */
  maxFileBytes?: number;
  concurrency?: number;
  onProgress?: OnProgress;
  fetchImpl?: typeof fetch;
}

const MANIFEST = /(^|\/)(package\.json|requirements[\w.-]*\.txt|pyproject\.toml|go\.mod|Cargo\.toml|Gemfile|composer\.json)$/;

export async function loadGitHub(ref: GitHubRef, opts: GitHubOptions = {}): Promise<RepoSource> {
  const f = opts.fetchImpl || fetch;
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const api = async (path: string) => {
    const r = await f(`https://api.github.com${path}`, { headers });
    if (!r.ok) {
      const remaining = r.headers.get('x-ratelimit-remaining');
      if (r.status === 403 && remaining === '0') throw new Error('GitHub API rate limit reached (60/hour unauthenticated). Try again later or set a token.');
      if (r.status === 404) throw new Error(`Repository not found: ${ref.owner}/${ref.repo}${ref.ref ? '@' + ref.ref : ''}. Private repos need a token.`);
      throw new Error(`GitHub API ${r.status} for ${path}`);
    }
    return r.json();
  };
  opts.onProgress?.({ phase: 'tree', done: 0, total: 1, message: 'resolving branch' });
  let branch = ref.ref;
  if (!branch) branch = (await api(`/repos/${ref.owner}/${ref.repo}`)).default_branch as string;
  const tree = await api(`/repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  const entries = (tree.tree as { path: string; type: string; size?: number }[]).filter((e) => e.type === 'blob');
  const files: RepoFile[] = entries.map((e) => ({ path: e.path, size: e.size || 0 })).filter((e) => !isIgnoredPath(e.path));
  opts.onProgress?.({ phase: 'tree', done: 1, total: 1, message: `${files.length} files` });

  // Content: manifests and prose first, then code. The budget is small next to a large repository, so
  // it is spent in two goes — a first tranche chosen by shape, then the rest on whatever that tranche
  // turned out to import. What a repository points at is a better guide than what is biggest in it.
  const maxBytes = opts.maxFileBytes ?? 300 * 1024;
  const sized = files.filter((x) => x.size <= maxBytes && x.size > 0);

  // Manifests and READMEs are read on their own allowance rather than out of the code budget. They are
  // small, and a monorepo has one package.json per package — a hundred of them would otherwise take a
  // quarter of the budget away from the code, while being the files that say the least per byte. They
  // still have to be read: they carry the workspace names that make an import resolve at all.
  const docs = sized.filter((x) => MANIFEST.test(x.path) || CONTEXT_FILE.test(x.path))
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length)
    .slice(0, opts.maxManifestFiles ?? 150);

  const want = sized.filter((x) => isCode(x.path) && !MANIFEST.test(x.path) && !CONTEXT_FILE.test(x.path));
  const shape = (x: RepoFile) => (/(^|\/)(index|main|app|server)\./.test(x.path) ? 1e9 : 0) + x.size - x.path.split('/').length * 1000;
  want.sort((a, b) => shape(b) - shape(a));

  const cap = opts.maxContentFiles ?? 400;
  const rawBase = `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${encodeURIComponent(branch)}/`;
  const conc = opts.concurrency ?? 8;
  let done = 0;
  const total = docs.length + Math.min(cap, want.length);

  const fetchAll = async (batch: RepoFile[]) => {
    const queue = batch.slice();
    const worker = async () => {
      for (let x = queue.shift(); x; x = queue.shift()) {
        try {
          const r = await f(rawBase + x.path.split('/').map(encodeURIComponent).join('/'), opts.token ? { headers: { Authorization: `Bearer ${opts.token}` } } : undefined);
          if (r.ok) x.content = await r.text();
        } catch { /* leave content undefined; the map still draws, just with fewer edges */ }
        done++;
        opts.onProgress?.({ phase: 'content', done, total, message: x.path });
      }
    };
    await Promise.all(Array.from({ length: Math.min(conc, batch.length) }, worker));
  };

  // The names first: nothing else resolves without them.
  await fetchAll(docs);

  // Everything fits: there is nothing to choose between, so choose nothing.
  if (want.length <= cap) {
    await fetchAll(want);
    return { name: `${ref.owner}/${ref.repo}`, ref: branch, files };
  }

  const first = Math.max(1, Math.round(cap / 2));
  await fetchAll(want.slice(0, first));

  // Rank what is left by how often the first tranche imported it. A file three others reach for beats
  // any unread file however large, and size only separates the ones nothing has been seen to import.
  const refs = countReferences(files, createResolver(files));
  const rest = want.slice(first).sort((a, b) => readingScore(b, refs) - readingScore(a, refs));
  const second = rest.slice(0, cap - first);
  const cited = second.filter((x) => refs.counts.has(x.path)).length;
  await fetchAll(second);

  const skipped = want.length - cap;
  return {
    name: `${ref.owner}/${ref.repo}`, ref: branch, files,
    note: `Content was fetched for ${cap} of ${want.length} code files — the largest first, then `
      + `${cited} chosen because the rest of the repository imports them. ${skipped} were not read, so `
      + `some links may be missing.`,
  };
}

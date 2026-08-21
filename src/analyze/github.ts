/** Loads a public (or token-authorised) GitHub repository as a RepoSource, in the browser or in Bun/Node. */

import { isCode, isIgnoredPath } from './ignore';
import type { OnProgress, RepoFile, RepoSource } from './types';

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

  // Content: manifests first, then code files — entry-looking files and the largest first, up to the cap.
  const maxBytes = opts.maxFileBytes ?? 300 * 1024;
  const want = files.filter((x) => (MANIFEST.test(x.path) || isCode(x.path)) && x.size <= maxBytes && x.size > 0);
  const score = (x: RepoFile) => (MANIFEST.test(x.path) ? 1e12 : 0) + (/(^|\/)(index|main|app|server)\./.test(x.path) ? 1e9 : 0) + x.size - x.path.split('/').length * 1000;
  want.sort((a, b) => score(b) - score(a));
  const picked = want.slice(0, opts.maxContentFiles ?? 400);
  const rawBase = `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${encodeURIComponent(branch)}/`;
  let done = 0;
  const conc = opts.concurrency ?? 8;
  const queue = picked.slice();
  const worker = async () => {
    for (let x = queue.shift(); x; x = queue.shift()) {
      try {
        const r = await f(rawBase + x.path.split('/').map(encodeURIComponent).join('/'), opts.token ? { headers: { Authorization: `Bearer ${opts.token}` } } : undefined);
        if (r.ok) x.content = await r.text();
      } catch { /* leave content undefined; the map still draws, just with fewer edges */ }
      done++;
      opts.onProgress?.({ phase: 'content', done, total: picked.length, message: x.path });
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, picked.length) }, worker));
  const skipped = want.length - picked.length;
  return {
    name: `${ref.owner}/${ref.repo}`, ref: branch, files,
    ...(skipped > 0 ? { note: `Content was fetched for the ${picked.length} largest code files; ${skipped} smaller ones were skipped to stay within GitHub's limits.` } : {}),
  };
}

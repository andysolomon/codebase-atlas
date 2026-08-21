/** A whole repository in one request.

    Fetching files one at a time caps a scan at a few hundred of them, which on a large repository
    means the map is drawn from filenames. GitHub will hand over the entire tree as a gzipped tar
    instead — one request, no per-file budget, and the scan reads what is actually there.

    Not available in the browser: the API's tarball URL redirects to codeload.github.com, which allows
    only GitHub's own origin, so a page fetching it is refused before the bytes arrive. Callers there
    keep the per-file path. Nothing here is browser-specific otherwise; it is the CORS policy that
    decides, not the code.

    The tar reading is deliberately small — enough of the format for what `git archive` emits: ustar
    headers, PAX extended records for long paths, and GNU long-name entries. */

import { CONTEXT_FILE, isCode, isIgnoredPath, isText } from './ignore.js';
import type { OnProgress, RepoFile } from './types.js';

const BLOCK = 512;

export interface TarballOptions {
  token?: string;
  /** Skip content for files larger than this. Default 300 KB. */
  maxFileBytes?: number;
  /** Stop keeping content once this much has been kept. Default 64 MB. */
  maxTotalBytes?: number;
  onProgress?: OnProgress;
  fetchImpl?: typeof fetch;
}

export interface TarballResult {
  files: RepoFile[];
  /** Content was dropped past the byte budget, so some links may be missing. */
  truncated: boolean;
}

const MANIFEST = /(^|\/)(package\.json|requirements[\w.-]*\.txt|pyproject\.toml|go\.mod|Cargo\.toml|Gemfile|composer\.json|tsconfig[\w.-]*\.json|jsconfig[\w.-]*\.json)$/;

/** Worth the bytes it costs to keep: code the import graph is drawn from, and the files that say what
    the repository is and what it calls its own packages. */
const worthReading = (path: string) => isCode(path) || MANIFEST.test(path) || CONTEXT_FILE.test(path);

/** True where a tarball can actually be fetched: outside a browser, where CORS does not refuse it. */
export const tarballAvailable = () => typeof window === 'undefined';

/** Gunzip, from whichever of the two the runtime has. `DecompressionStream` is the web standard and
    is not in every Bun; `node:zlib` is imported dynamically so no bundler follows it into a browser
    build. Nothing here is reachable from browser code in any case — see the note at the top. */
async function gunzip(body: ReadableStream<Uint8Array>): Promise<AsyncIterable<Uint8Array>> {
  if (typeof DecompressionStream === 'function') {
    return (body as ReadableStream).pipeThrough(new DecompressionStream('gzip')) as unknown as AsyncIterable<Uint8Array>;
  }
  const [{ createGunzip }, { Readable }] = await Promise.all([import('node:zlib'), import('node:stream')]);
  const out = createGunzip();
  Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]).pipe(out);
  return out as unknown as AsyncIterable<Uint8Array>;
}

const octal = (bytes: Uint8Array): number => {
  const s = new TextDecoder().decode(bytes).replace(/\0.*$/, '').trim();
  return s ? parseInt(s, 8) || 0 : 0;
};
const cstr = (bytes: Uint8Array): string => new TextDecoder().decode(bytes).replace(/\0.*$/, '');

/** Read the whole repository at `ref` as a list of files. Throws if the archive cannot be fetched —
    the caller is expected to fall back to reading files one at a time. */
export async function loadTarball(owner: string, repo: string, ref: string, opts: TarballOptions = {}): Promise<TarballResult> {
  const f = opts.fetchImpl || fetch;
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  opts.onProgress?.({ phase: 'tree', done: 0, total: 1, message: 'downloading the archive' });

  const r = await f(`https://api.github.com/repos/${owner}/${repo}/tarball/${encodeURIComponent(ref)}`, { headers });
  if (!r.ok || !r.body) throw new Error(`tarball ${r.status} for ${owner}/${repo}`);

  const maxFileBytes = opts.maxFileBytes ?? 300 * 1024;
  const maxTotalBytes = opts.maxTotalBytes ?? 64 * 1024 * 1024;
  const files: RepoFile[] = [];
  let kept = 0, truncated = false;

  // Everything git archive writes sits under one `owner-repo-sha/` folder; the atlas wants repo-relative.
  let root: string | null = null;
  const strip = (p: string) => {
    if (root === null) root = p.includes('/') ? p.slice(0, p.indexOf('/') + 1) : '';
    return root && p.startsWith(root) ? p.slice(root.length) : p;
  };

  const decoder = new TextDecoder();
  let pending = new Uint8Array(0);
  /** A name carried by the header before this one, for paths too long for the 100-byte field. */
  let longName = '';

  const append = (chunk: Uint8Array) => {
    const next = new Uint8Array(pending.length + chunk.length);
    next.set(pending); next.set(chunk, pending.length);
    pending = next;
  };

  /** Consume as many complete entries as `pending` holds. Returns when it needs more bytes. */
  const drain = () => {
    for (;;) {
      if (pending.length < BLOCK) return;
      const header = pending.subarray(0, BLOCK);
      // Two zero blocks end the archive; one is enough to stop reading.
      if (header.every((b) => b === 0)) { pending = pending.subarray(BLOCK); continue; }

      const size = octal(header.subarray(124, 136));
      const type = String.fromCharCode(header[156] || 0);
      const padded = Math.ceil(size / BLOCK) * BLOCK;
      if (pending.length < BLOCK + padded) return;      // the body has not all arrived

      const body = pending.subarray(BLOCK, BLOCK + size);
      const prefix = cstr(header.subarray(345, 500));
      const raw = cstr(header.subarray(0, 100));
      const name = longName || (prefix ? `${prefix}/${raw}` : raw);

      if (type === 'L') {
        longName = cstr(body);                            // GNU: the next header's real name
      } else if (type === 'x' || type === 'X') {
        // PAX: "<len> path=<value>\n" among other records.
        const path = decoder.decode(body).match(/\d+ path=([^\n]*)\n/);
        longName = path ? path[1] : '';
      } else {
        longName = '';
        if (type === '0' || type === '\0') {
          const path = strip(name);
          if (path && !isIgnoredPath(path)) {
            const file: RepoFile = { path, size };
            if (worthReading(path) && isText(path) && size > 0 && size <= maxFileBytes) {
              if (kept + size <= maxTotalBytes) { file.content = decoder.decode(body); kept += size; }
              else truncated = true;
            }
            files.push(file);
            if (files.length % 500 === 0) opts.onProgress?.({ phase: 'tree', done: files.length, total: 0, message: `${files.length} files` });
          }
        }
      }
      pending = pending.subarray(BLOCK + padded);
    }
  };

  for await (const chunk of await gunzip(r.body)) {
    append(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    drain();
  }
  return { files, truncated };
}

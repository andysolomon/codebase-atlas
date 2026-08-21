/** How a repository names its own code.

    A monorepo does not import its packages by path. It writes `@acme/shared`, or `~/lib/db`, or
    `github.com/acme/svc/internal/store` — names its own config files define. Without reading those
    files, every one of those imports looks exactly like a third-party package: the edge that is the
    whole point of the map is drawn as an arrow pointing off it, to a dependency that does not exist.

    So this reads what the repository already declares:

      - every `package.json` in the tree, whose `name` is how the rest of the repo refers to it;
      - `tsconfig.json` / `jsconfig.json` `compilerOptions.paths`, with `baseUrl`;
      - `go.mod`'s module path, which prefixes every internal Go import.

    It resolves a specifier to *candidate* repo paths and nothing more. Whether a candidate is real is
    the caller's question, answered against the scanned file list — a rule that resolves to nothing
    must not invent an edge. */

import { isIgnoredPath } from './ignore.js';
import type { RepoFile } from './types.js';

export interface AliasMap {
  /** Longest-prefix rules from tsconfig-style `paths`, longest `from` first. */
  rules: { from: string; to: string; wildcard: boolean }[];
  /** Declared package name → the folder that holds it. */
  packages: Map<string, string>;
}

export const emptyAliases = (): AliasMap => ({ rules: [], packages: new Map() });

const dirOf = (p: string) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
const join = (a: string, b: string) => (a ? `${a}/${b}` : b).replace(/\/{2,}/g, '/').replace(/\/$/, '');

/** JSON with the things tsconfig is allowed to contain: comments and trailing commas. Strings are
    tracked so a `//` inside one is not mistaken for a comment. */
function parseLoose(text: string): unknown {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && !(text[j] === '"' && text[j - 1] !== '\\')) j++;
      out += text.slice(i, j + 1); i = j; continue;
    }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 1; continue; }
    out += c;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
  } catch {
    return null;
  }
}

/** Everything the repository says about its own names. */
export function readAliases(files: RepoFile[]): AliasMap {
  const map = emptyAliases();
  const withContent = files.filter((f) => f.content && !isIgnoredPath(f.path));

  // ── package names ── every package.json in the tree, root included: in a monorepo the workspace
  // packages are exactly the specifiers that would otherwise be read as third-party.
  for (const f of withContent) {
    if (!/(^|\/)package\.json$/.test(f.path)) continue;
    const j = parseLoose(f.content!) as { name?: unknown } | null;
    const name = j && typeof j.name === 'string' ? j.name.trim() : '';
    // A name that is a path, or already claimed by a shallower package, is not a specifier.
    if (!name || name.startsWith('.') || name.includes(' ')) continue;
    const dir = dirOf(f.path);
    const prev = map.packages.get(name);
    if (prev === undefined || dir.length < prev.length) map.packages.set(name, dir);
  }

  // ── tsconfig / jsconfig paths ── merged across every config in the tree, because in a monorepo each
  // package carries its own and any of them may be the one that resolved a given import.
  for (const f of withContent) {
    if (!/(^|\/)(tsconfig|jsconfig)[\w.-]*\.json$/.test(f.path)) continue;
    const j = parseLoose(f.content!) as { compilerOptions?: { baseUrl?: unknown; paths?: unknown } } | null;
    const opts = j?.compilerOptions;
    if (!opts || typeof opts.paths !== 'object' || !opts.paths) continue;
    const here = dirOf(f.path);
    const baseUrl = typeof opts.baseUrl === 'string' ? opts.baseUrl : '.';
    const root = join(here, baseUrl.replace(/^\.\/?/, ''));
    for (const [from, targets] of Object.entries(opts.paths as Record<string, unknown>)) {
      const first = Array.isArray(targets) ? targets.find((t) => typeof t === 'string') : undefined;
      if (typeof first !== 'string') continue;
      const wildcard = from.endsWith('*') && first.endsWith('*');
      map.rules.push({
        from: wildcard ? from.slice(0, -1) : from,
        to: join(root, (wildcard ? first.slice(0, -1) : first).replace(/^\.\/?/, '')),
        wildcard,
      });
    }
  }
  // Longest pattern wins, so `@acme/ui/*` is tried before `@acme/*`.
  map.rules.sort((a, b) => b.from.length - a.from.length);

  // ── go module path ── `github.com/acme/svc/internal/x` is `internal/x` in this tree.
  const goMod = withContent.find((f) => f.path === 'go.mod');
  const mod = goMod?.content?.match(/^\s*module\s+(\S+)/m)?.[1];
  if (mod) map.rules.push({ from: mod + '/', to: '', wildcard: true });

  return map;
}

/** Candidate repo paths for a specifier, best first. Empty when the repository's own config says
    nothing about it — which is the signal that it really is a third-party package. */
export function resolveAlias(map: AliasMap, spec: string): string[] {
  const out: string[] = [];

  // A package name, possibly with a subpath: "@acme/shared" or "@acme/shared/client".
  const segs = spec.split('/');
  for (let n = Math.min(segs.length, 3); n >= 1; n--) {
    const head = segs.slice(0, n).join('/');
    const dir = map.packages.get(head);
    if (dir === undefined) continue;
    const rest = segs.slice(n).join('/');
    if (rest) out.push(join(dir, rest));
    else out.push(join(dir, 'src/index'), join(dir, 'src'), join(dir, 'index'), dir);
    break;
  }

  for (const r of map.rules) {
    if (r.wildcard ? spec.startsWith(r.from) : spec === r.from) {
      const tail = r.wildcard ? spec.slice(r.from.length) : '';
      const p = tail ? join(r.to, tail) : r.to;
      if (p) out.push(p);
    }
  }
  return [...new Set(out)];
}

/** True when a specifier belongs to a package this repository declares. Such a name is never a
    third-party dependency, even when the scan never fetched the folder behind it. */
export const isOwnPackage = (map: AliasMap, spec: string): boolean => {
  const segs = spec.split('/');
  for (let n = Math.min(segs.length, 3); n >= 1; n--) if (map.packages.has(segs.slice(0, n).join('/'))) return true;
  return false;
};

/** Where an import actually points, in this repository.

    Pulled out of `build.ts` because two different questions need the same answer. The map needs it to
    draw an edge between blocks. And the scan needs it *before* the map exists, to decide which files
    are worth reading at all: a file that fifty other files import is where a repository keeps its
    meaning, and reading it beats reading the fifty. Ranking by size gets that backwards — the biggest
    file in a repo is often a generated bundle or a fixture.

    Independent of any partition on purpose, so it can run in the middle of a scan. */

import { readAliases, resolveAlias, type AliasMap } from './aliases.js';
import { extOf } from './ignore.js';
import type { RepoFile } from './types.js';

const dirOf = (p: string) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };

function normalize(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop(); else out.push(seg);
  }
  return out.join('/');
}

export interface Resolver {
  /** The repo path an import points at — a real file where one can be found, the folder it names
      otherwise, and null when the import leaves the repository. */
  (fromPath: string, spec: string, pathLike: boolean): string | null;
  /** What the repository calls its own code, so callers need not read it twice. */
  aliases: AliasMap;
  /** True when this path is a file the scan actually saw. */
  isFile: (path: string) => boolean;
}

export function createResolver(files: RepoFile[], known?: AliasMap): Resolver {
  const aliases = known ?? readAliases(files);
  const paths = new Set(files.map((f) => f.path));
  const srcDir = files.some((f) => f.path.startsWith('src/')) ? 'src' : '';
  const topSegs = new Set(files.map((f) => f.path.split('/')[0]));

  // Stem → file, so an extension-less specifier finds the file it means. First writer wins, which
  // keeps `foo.ts` ahead of `foo.test.ts` given the order a tree arrives in.
  const byStem = new Map<string, string>();
  for (const f of files) {
    const stem = f.path.replace(/\.[^./]+$/, '');
    if (!byStem.has(stem)) byStem.set(stem, f.path);
  }

  const exists = (prefix: string) => paths.has(prefix) || files.some((f) => f.path.startsWith(prefix + '/') || f.path.startsWith(prefix + '.'));

  /** The real file behind a path, when there is one: itself, itself plus an extension, or its index.

      A specifier may also name the file the *build* will emit rather than the one on disk — `./x.js`
      written in TypeScript means `x.ts`. Under ESM that spelling is required, so a resolver that does
      not undo it loses every edge in a repo that follows the rule. */
  const locate = (p: string): string | null => {
    if (paths.has(p)) return p;
    const direct = byStem.get(p) ?? byStem.get(p + '/index');
    if (direct) return direct;
    const stem = p.replace(/\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/, '');
    return stem === p ? null : byStem.get(stem) ?? byStem.get(stem + '/index') ?? null;
  };

  const resolve = ((fromPath: string, spec: string, pathLike: boolean): string | null => {
    let p: string | null = null;
    const ext = extOf(fromPath);
    if (spec.startsWith('.')) {
      if (ext === 'py') { // from ..x import y
        const ups = spec.match(/^\.+/)![0].length; let d = dirOf(fromPath);
        for (let i = 1; i < ups; i++) d = dirOf(d);
        p = normalize(d + '/' + spec.slice(ups).replace(/\./g, '/'));
      } else p = normalize(dirOf(fromPath) + '/' + spec);
    } else if (/^[@~$#]\//.test(spec)) p = normalize((srcDir ? srcDir + '/' : '') + spec.slice(2));
    else if (spec.startsWith('/')) p = normalize(spec);
    else if (ext === 'rs') {
      if (/^(crate|self|super)\b/.test(spec)) {
        const parts = spec.split('::');
        if (parts[0] === 'crate') p = normalize((srcDir || '') + '/' + parts.slice(1).join('/'));
        else if (parts[0] === 'self') p = normalize(dirOf(fromPath) + '/' + parts.slice(1).join('/'));
        else p = normalize(dirOf(dirOf(fromPath)) + '/' + parts.slice(1).join('/'));
      } else if (pathLike) p = normalize(dirOf(fromPath) + '/' + spec);
    } else {
      // What the repo's own config says this name means, checked against the scan before it is
      // believed — a rule pointing at nothing must not draw an edge to nothing.
      for (const cand of resolveAlias(aliases, spec)) {
        if (exists(cand)) return locate(cand) ?? cand;
      }
      // A bare specifier that is really an in-repo path: "app/models", "src/x", "lib.foo" (python),
      // or a Go import whose module prefix has already been stripped.
      const asPath = ext === 'py' ? spec.replace(/\./g, '/') : spec;
      const first = asPath.split('/')[0];
      if (topSegs.has(first) && exists(asPath)) p = asPath;
      else if (srcDir && exists(srcDir + '/' + asPath)) p = srcDir + '/' + asPath;
      else if (ext === 'go' && asPath.includes('/')) {
        const segs = asPath.split('/');
        for (let i = 1; i < segs.length; i++) {
          const tail = segs.slice(i).join('/');
          if (exists(tail)) { p = tail; break; }
        }
      }
    }
    if (p == null) return null;
    return locate(p) ?? (exists(p) ? p : null);
  }) as Resolver;

  resolve.aliases = aliases;
  resolve.isFile = (path: string) => paths.has(path);
  return resolve;
}

/** How much of the repository leans on each file.

    A scan can only read a few hundred files of a large repository, and it has to choose them before
    it knows anything. Size is the obvious proxy and a poor one: the biggest file in a tree is as
    likely to be a generated bundle, a lockfile-shaped fixture or a vendored blob as it is to be the
    thing everything else is built on. What the code imports is a far better signal — the module fifty
    files reach for is the one a reader needs, however small it is.

    So the scan reads a first tranche, asks this what that tranche pointed at, and spends the rest of
    its budget there. The same counts then order the symbol evidence the partition sees, so the model
    is told about load-bearing files rather than large ones. */

import { extractImports } from './imports.js';
import { isCode } from './ignore.js';
import { createResolver, type Resolver } from './resolve.js';
import type { RepoFile } from './types.js';

export interface References {
  /** Path → how many other files import it. Files nothing imports are absent, not zero. */
  counts: Map<string, number>;
  /** How many files were read to produce this. Zero means the counts say nothing yet. */
  read: number;
}

/** Count in-repo imports across whatever content has been loaded so far. */
export function countReferences(files: RepoFile[], resolver: Resolver = createResolver(files)): References {
  const counts = new Map<string, number>();
  let read = 0;
  for (const f of files) {
    if (!f.content || !isCode(f.path)) continue;
    read++;
    // One file importing another twice is one relationship, not two.
    const seen = new Set<string>();
    for (const im of extractImports(f.path, f.content)) {
      const target = resolver(f.path, im.spec, im.pathLike);
      if (!target || target === f.path || !resolver.isFile(target) || seen.has(target)) continue;
      seen.add(target);
      counts.set(target, (counts.get(target) ?? 0) + 1);
    }
  }
  return { counts, read };
}

/** An entry point is a file the repository reaches for by convention rather than by import. */
const ENTRY = /(^|\/)(index|main|app|server|cli|mod|__init__|program)\.(ts|tsx|js|jsx|mjs|py|go|rs|rb|java|kt|cs|php)$/i;

/** How much this file is worth reading, given what the scan knows so far.

    References dominate — a file three others import outranks any unreferenced file, whatever its size
    — and size only breaks ties among files nothing has been seen to import yet. Entry points get a
    nudge because nothing imports them by definition, and they are where a reader starts. */
export function readingScore(file: RepoFile, refs: References): number {
  const cited = refs.counts.get(file.path) ?? 0;
  const entry = ENTRY.test(file.path) ? 1 : 0;
  // Bytes are capped before they are added so a 300 KB file cannot outweigh a single real reference.
  return cited * 1e9 + entry * 5e8 + Math.min(file.size, 250_000);
}

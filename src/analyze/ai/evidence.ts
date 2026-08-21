/** Evidence packs — everything a model is allowed to know about a repository, and nothing else.

    Dependency-free and browser-safe on purpose: the in-browser scan builds a pack and POSTs it to
    /api/enrich, so this file must not import `ai`, `zod`, or anything from node. */

import type { AtlasData } from '../../atlas/types.js';
import { isCode, isText, langOf } from '../ignore.js';
import { extractSymbols, head } from '../symbols.js';
import type { RepoFile, RepoSource } from '../types.js';

const kb = (b: number) => (b < 1024 * 1000 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1048576).toFixed(1)} MB`);
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** Rough token count. Four characters per token is close enough to budget a prompt. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

export interface RepoEvidence {
  name: string;
  ref: string;
  tree: string;
  readme: string;
  manifests: string;
  symbols: string;
  entryPoints: string[];
  fileCount: number;
}

export interface BlockEvidence {
  id: string;
  name: string;
  group: string;
  loc: string;
  files: string;
  symbols: string;
  excerpts: string;
  links: string;
}

export interface ComposeEvidence {
  name: string;
  ref: string;
  product: string;
  facts: string;
  blocks: string;
  edges: string;
  externals: string;
}

/** A folder tree with per-folder counts. Folders past `maxPerDir` files are summarised, not listed,
    so a 4,000-file repository still fits in a prompt. */
function treeDigest(files: RepoFile[], maxPerDir = 14): string {
  const byDir = new Map<string, RepoFile[]>();
  for (const f of files) {
    const i = f.path.lastIndexOf('/');
    const d = i < 0 ? '' : f.path.slice(0, i);
    (byDir.get(d) ?? byDir.set(d, []).get(d)!).push(f);
  }
  const lines: string[] = [];
  for (const d of [...byDir.keys()].sort()) {
    const fs = byDir.get(d)!.sort((a, b) => b.size - a.size);
    const bytes = fs.reduce((a, f) => a + f.size, 0);
    lines.push(`${d || '.'}/  (${fs.length} files, ${kb(bytes)})`);
    for (const f of fs.slice(0, maxPerDir)) lines.push(`    ${base(f.path)}  ${kb(f.size)}`);
    if (fs.length > maxPerDir) lines.push(`    … ${fs.length - maxPerDir} more`);
  }
  return lines.join('\n');
}

const ENTRY = /(^|\/)(index|main|app|server|cli|mod|__init__|program)\.(ts|tsx|js|jsx|mjs|py|go|rs|rb|java|kt|cs|php)$/i;
const MANIFEST = /(^|\/)(package\.json|requirements[\w.-]*\.txt|pyproject\.toml|go\.mod|Cargo\.toml|Gemfile|composer\.json|vercel\.json|Dockerfile)$/;

export function repoEvidence(source: RepoSource): RepoEvidence {
  const files = source.files;
  const readmeFile = files.find((f) => /^readme(\.md|\.txt)?$/i.test(f.path)) ?? files.find((f) => /^docs\/readme\.md$/i.test(f.path));

  const manifests = files
    .filter((f) => MANIFEST.test(f.path) && f.content)
    .slice(0, 6)
    .map((f) => `── ${f.path}\n${f.content!.slice(0, 3000)}`)
    .join('\n\n');

  // The biggest code files are where a repository keeps its meaning.
  const symbols = files
    .filter((f) => f.content && isCode(f.path))
    .sort((a, b) => b.size - a.size)
    .slice(0, 45)
    .map((f) => {
      const names = extractSymbols(f.path, f.content!, 16);
      return names.length ? `${f.path} (${kb(f.size)}): ${names.join(', ')}` : `${f.path} (${kb(f.size)})`;
    })
    .join('\n');

  return {
    name: source.name,
    ref: source.ref,
    tree: treeDigest(files),
    readme: readmeFile?.content ? readmeFile.content.slice(0, 6000) : '(no README was read)',
    manifests: manifests || '(no manifest was read)',
    symbols,
    entryPoints: files.filter((f) => ENTRY.test(f.path)).map((f) => f.path).slice(0, 10),
    fileCount: files.length,
  };
}

/** One pack per block, built from the finished scan so the model sees exactly what the map shows. */
export function blockEvidence(source: RepoSource, data: AtlasData): BlockEvidence[] {
  const content = new Map(source.files.filter((f) => f.content).map((f) => [f.path, f.content!]));
  const sizeOf = new Map(source.files.map((f) => [f.path, f.size]));
  const nameOf = new Map(data.STRUCTURES.map((s) => [s.id, s.name]));

  return data.STRUCTURES.map((s) => {
    const paths = s.src.slice(0, 10);
    const files = paths.map((p) => `${p}  ${sizeOf.has(p) ? kb(sizeOf.get(p)!) : '?'}  ${langOf(p)}`).join('\n');

    const symbols = paths
      .filter((p) => content.has(p) && isCode(p))
      .slice(0, 6)
      .map((p) => {
        const names = extractSymbols(p, content.get(p)!, 20);
        return names.length ? `${base(p)}: ${names.join(', ')}` : '';
      })
      .filter(Boolean)
      .join('\n');

    const excerpts = paths
      .filter((p) => content.has(p) && isText(p))
      .slice(0, 3)
      .map((p) => `── ${p}\n${head(content.get(p)!, 45, 2200)}`)
      .join('\n\n');

    const out = data.EDGES.filter((e) => e.f === s.id).map((e) => `→ ${nameOf.get(e.t) ?? e.t}  (${e.pay})`);
    const inn = data.EDGES.filter((e) => e.t === s.id).map((e) => `← ${nameOf.get(e.f) ?? e.f}  (${e.pay})`);

    return {
      id: s.id, name: s.name, group: s.group, loc: s.loc,
      files, symbols: symbols || '(none extracted)',
      excerpts: excerpts || '(no content was read for this block)',
      links: [...out, ...inn].join('\n') || '(no in-repo imports resolved in either direction)',
    };
  });
}

export function composeEvidence(source: RepoSource, data: AtlasData): ComposeEvidence {
  const nameOf = new Map(data.STRUCTURES.map((s) => [s.id, s.name]));
  return {
    name: source.name,
    ref: source.ref,
    product: data.product,
    facts: data.stats.map(([k, v]) => `${k}: ${v}`).join('\n'),
    blocks: data.STRUCTURES.map((s) => `${s.id}  [${s.group}]  ${s.name} — ${s.loc}\n    ${s.what.replace(/\n/g, ' ').slice(0, 300)}`).join('\n'),
    // Only the edges worth a written label. Asking for all 44 buys noise and a reply long enough
    // to get truncated; the drawn ones carry the flow.
    edges: data.EDGES.filter((e) => e.flow || !e.dashed).slice(0, 24)
      .map((e) => `${e.f}->${e.t}  ${nameOf.get(e.f)} -> ${nameOf.get(e.t)}  (${e.pay})`).join('\n'),
    externals: (data.EXTERNALS ?? []).map((x) => `${x.name} used by ${nameOf.get(x.t) ?? x.t}`).join('\n') || '(none)',
  };
}

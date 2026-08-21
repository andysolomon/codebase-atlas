/** Cheap, regex-based import extraction for the languages we care about. Good enough to draw edges. */

import { extOf } from './ignore';

export interface ImportRef {
  /** The raw specifier as written ("./foo", "@/lib/x", "react", "os.path"). */
  spec: string;
  /** True when the specifier is a path (relative or alias) rather than a package name. */
  pathLike: boolean;
}

const JS_PATTERNS = [
  /\bimport\s+(?:[\w*\s{},$]+\s+from\s+)?['"]([^'"\n]+)['"]/g,
  /\bexport\s+(?:[\w*\s{},$]+\s+from\s+)['"]([^'"\n]+)['"]/g,
  /\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g,
];
const PY_PATTERNS = [
  /^\s*from\s+([\w.]+)\s+import\b/gm,
  /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm,
];
const GO_PATTERNS = [/^\s*import\s+(?:\w+\s+)?"([^"\n]+)"/gm, /^\s*"([^"\n]+)"\s*$/gm];
const RS_PATTERNS = [/^\s*(?:pub\s+)?use\s+([\w:]+)/gm, /^\s*mod\s+(\w+)\s*;/gm];
const RB_PATTERNS = [/^\s*require(?:_relative)?\s+['"]([^'"\n]+)['"]/gm];
const JAVA_PATTERNS = [/^\s*import\s+(?:static\s+)?([\w.]+)/gm];
const PHP_PATTERNS = [/^\s*use\s+([\w\\]+)/gm, /\b(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"\n]+)['"]/gm];
const C_PATTERNS = [/^\s*#\s*include\s+"([^"\n]+)"/gm];

function run(patterns: RegExp[], src: string, map: (s: string) => ImportRef[]): ImportRef[] {
  const out: ImportRef[] = [];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) out.push(...map(m[1]));
  }
  return out;
}

const ALIAS = /^[@~$#]\/|^(@\/|~\/|src\/|app\/|lib\/|components\/|utils\/)/;

export function extractImports(path: string, content: string): ImportRef[] {
  const e = extOf(path);
  // Strip block comments cheaply (JS-ish); keeps line structure for the others.
  const src = content.length > 400_000 ? content.slice(0, 400_000) : content;
  switch (e) {
    case 'ts': case 'tsx': case 'mts': case 'cts': case 'js': case 'jsx': case 'mjs': case 'cjs':
    case 'vue': case 'svelte': case 'astro':
      return run(JS_PATTERNS, src, (s) => [{ spec: s, pathLike: s.startsWith('.') || s.startsWith('/') || ALIAS.test(s) }]);
    case 'py':
      return run(PY_PATTERNS, src, (s) => s.split(',').map((x) => x.trim()).filter(Boolean).map((x) => ({ spec: x, pathLike: x.startsWith('.') })));
    case 'go':
      return run(GO_PATTERNS, src, (s) => [{ spec: s, pathLike: false }]);
    case 'rs':
      return run(RS_PATTERNS, src, (s) => [{ spec: s, pathLike: /^(crate|super|self)\b/.test(s) || !s.includes('::') }]);
    case 'rb':
      return run(RB_PATTERNS, src, (s) => [{ spec: s, pathLike: s.startsWith('.') || s.includes('/') }]);
    case 'java': case 'kt': case 'scala':
      return run(JAVA_PATTERNS, src, (s) => [{ spec: s, pathLike: false }]);
    case 'php':
      return run(PHP_PATTERNS, src, (s) => [{ spec: s, pathLike: s.startsWith('.') || s.includes('/') }]);
    case 'c': case 'h': case 'cpp': case 'cc': case 'hpp': case 'm':
      return run(C_PATTERNS, src, (s) => [{ spec: s, pathLike: true }]);
    default:
      return [];
  }
}

/** Package name from a bare specifier: "@scope/pkg/sub" → "@scope/pkg", "lodash/fp" → "lodash". */
export function packageName(spec: string): string {
  if (spec.startsWith('@')) { const p = spec.split('/'); return p.slice(0, 2).join('/'); }
  const i = spec.indexOf('/');
  return i > 0 ? spec.slice(0, i) : spec;
}

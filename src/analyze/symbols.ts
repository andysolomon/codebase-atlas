/** Cheap, regex-based extraction of what a file declares. Good enough to tell an LLM what a
    module is for — "sanitize, defaults, clamp" says far more per token than "9 KB of TypeScript". */

import { extOf } from './ignore.js';

const JS = [
  /\bexport\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g,
  /\bexport\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g,
  /\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  /\bexport\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
  /\bexport\s*\{([^}]*)\}/g,
];
const PY = [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, /^\s*class\s+([A-Za-z_]\w*)/gm];
const GO = [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/gm, /^\s*type\s+([A-Z]\w*)/gm];
const RS = [/^\s*pub\s+(?:async\s+)?fn\s+(\w+)/gm, /^\s*pub\s+(?:struct|enum|trait|type)\s+(\w+)/gm];
const RB = [/^\s*def\s+([A-Za-z_]\w*[?!]?)/gm, /^\s*(?:class|module)\s+([A-Z]\w*)/gm];
const JAVA = [/\b(?:public|protected)\s+(?:static\s+)?(?:final\s+)?(?:class|interface|enum|record)\s+(\w+)/g,
               /\b(?:public|protected)\s+(?:static\s+)?[\w<>\[\],.\s]+?\s(\w+)\s*\(/g];
const PHP = [/^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait)\s+(\w+)/gm, /^\s*(?:public\s+)?function\s+(\w+)/gm];

/** Declared names, in source order, de-duplicated. Capped — a long file's first names are the telling ones. */
export function extractSymbols(path: string, content: string, max = 24): string[] {
  const src = content.length > 200_000 ? content.slice(0, 200_000) : content;
  const e = extOf(path);
  let patterns: RegExp[];
  switch (e) {
    case 'ts': case 'tsx': case 'mts': case 'cts': case 'js': case 'jsx': case 'mjs': case 'cjs':
    case 'vue': case 'svelte': case 'astro': patterns = JS; break;
    case 'py': patterns = PY; break;
    case 'go': patterns = GO; break;
    case 'rs': patterns = RS; break;
    case 'rb': patterns = RB; break;
    case 'java': case 'kt': case 'scala': patterns = JAVA; break;
    case 'php': patterns = PHP; break;
    default: return [];
  }
  const hits: { at: number; name: string }[] = [];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      // `export { a, b as c }` yields a list; everything else yields one name.
      for (const raw of m[1].split(',')) {
        const name = raw.replace(/\bas\b.*$/, '').replace(/\btype\b/, '').trim();
        if (name && /^[A-Za-z_$][\w$]*[?!]?$/.test(name)) hits.push({ at: m.index, name });
      }
    }
  }
  hits.sort((a, b) => a.at - b.at);
  const out: string[] = [];
  for (const h of hits) if (!out.includes(h.name)) { out.push(h.name); if (out.length >= max) break; }
  return out;
}

/** The first `lines` lines of a file, for a head excerpt. Blank-line and comment noise kept — it is often the docstring. */
export function head(content: string, lines = 40, maxChars = 2400): string {
  const text = content.split('\n').slice(0, lines).join('\n');
  return text.length > maxChars ? text.slice(0, maxChars) + '\n…' : text;
}

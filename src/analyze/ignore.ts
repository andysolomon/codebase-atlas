/** What a scan skips, and which files count as code worth reading for imports. */

export const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.turbo',
  '.cache', '.parcel-cache', 'coverage', '.nyc_output', 'vendor', 'target', '__pycache__', '.venv', 'venv',
  '.idea', '.vscode', '.DS_Store', 'bower_components', '.yarn', '.pnpm-store', 'tmp', '.tmp', '.output',
  '.vercel', '.netlify', '.serverless', '.gradle', 'Pods', 'DerivedData', '.bundle', 'storybook-static',
]);

export const IGNORED_FILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum|\.DS_Store|Thumbs\.db)$/;

/** Extension → language label. Only these are fetched/read for import analysis. */
export const CODE_EXT: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  vue: 'Vue', svelte: 'Svelte', astro: 'Astro',
  py: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', swift: 'Swift',
  cs: 'C#', php: 'PHP', c: 'C', h: 'C', cpp: 'C++', cc: 'C++', hpp: 'C++', m: 'Objective-C',
  scala: 'Scala', ex: 'Elixir', exs: 'Elixir', dart: 'Dart', lua: 'Lua', sh: 'Shell', zsh: 'Shell', bash: 'Shell',
  sql: 'SQL', graphql: 'GraphQL', gql: 'GraphQL', prisma: 'Prisma',
};

/** Extensions that are text but not code — counted, never parsed. */
export const TEXT_EXT: Record<string, string> = {
  md: 'Markdown', mdx: 'Markdown', txt: 'Text', json: 'JSON', yml: 'YAML', yaml: 'YAML', toml: 'TOML',
  css: 'CSS', scss: 'SCSS', sass: 'SCSS', less: 'Less', html: 'HTML', htm: 'HTML', xml: 'XML', svg: 'SVG',
  env: 'Config', ini: 'Config', cfg: 'Config', conf: 'Config', lock: 'Lockfile', csv: 'CSV',
};

export function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : '';
}
export function isCode(path: string) { return extOf(path) in CODE_EXT; }
/** Code or other text we can size meaningfully (images, archives and binaries are counted but never measured). */
export function isText(path: string) { const e = extOf(path); return e in CODE_EXT || e in TEXT_EXT || /(^|\/)(\.[\w-]+|[A-Z]+|Makefile|Dockerfile|Procfile|LICENSE|README)$/.test(path); }
export function isIgnoredPath(path: string) {
  if (IGNORED_FILES.test(path)) return true;
  return path.split('/').some((seg) => IGNORED_DIRS.has(seg));
}
export function langOf(path: string): string {
  const e = extOf(path);
  return CODE_EXT[e] || TEXT_EXT[e] || (e ? e.toUpperCase() : 'Other');
}

/** Prose files worth reading even though they are not code: they say what the thing IS.
    Content for these is loaded alongside manifests, and is used only as evidence for AI analysis —
    the scan draws no edges from them. */
export const CONTEXT_FILE = /^(readme|architecture|contributing|agents|claude)\.(md|txt|rst)$|^docs\/(readme|architecture|overview)\.md$/i;

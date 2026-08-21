/* Turns a flat file listing (plus whatever content was loaded) into an AtlasData dataset.
   Every number in the output is a fact from the scan; the prose is templated from those facts. */

import type { AtlasData, ChildPart, Edge, External, Group, Structure, TraceStep } from '../atlas/types';
import { extOf, isCode, isIgnoredPath, isText, langOf } from './ignore';
import { extractImports, packageName } from './imports';
import type { RepoFile, RepoSource } from './types';

export interface BuildOptions {
  /** Upper bound on the number of blocks. Default 24. */
  maxStructures?: number;
  /** Upper bound on drawn edges. Default 44. */
  maxEdges?: number;
}

interface Unit {
  dir: string;              // '' = repo root
  files: RepoFile[];
  bytes: number;            // text bytes — what height encodes
  assets: number;           // binary files (images, archives…): counted, not measured
  id: string;
  code: string;
  name: string;
  group: string;
  hasChildUnits: boolean;
  gx: number; gy: number; w: number; d: number; h: number; slab: boolean;
  out: Map<string, { n: number; ex: string; exTest?: boolean }>;   // unit id → count + example
  inn: Map<string, number>;
  ext: Map<string, number>;                        // package → count
}

const GROUP_ORDER = ['THE APP', 'THE SERVER', 'THE DOMAIN', 'THE CODE', 'THE DATA', 'QUALITY', 'DOCS', 'TOOLING', 'THE ROOT'];
const CATEGORY: [string, RegExp][] = [
  ['QUALITY', /^(test|tests|__tests__|spec|specs|e2e|cypress|playwright|\.github|ci|fixtures|__mocks__|bench|benchmarks|perf|\.circleci)$/i],
  ['THE DATA', /^(db|database|prisma|drizzle|migrations|migration|schema|schemas|models|data|seed|seeds|sql|supabase|datasets?)$/i],
  ['THE SERVER', /^(api|server|backend|functions|convex|worker|workers|services|handlers|controllers|middleware|graphql|trpc|lambda|edge|routes)$/i],
  ['THE APP', /^(app|apps|pages|components|views|screens|ui|layouts|features|client|web|frontend|public|styles|assets|static|hooks|store|state|context|widgets|templates|www|site)$/i],
  ['DOCS', /^(docs|doc|documentation|examples|example|prototype|prototypes|design|guides?)$/i],
  ['TOOLING', /^(scripts|script|tools|tooling|bin|build|infra|infrastructure|deploy|deployment|docker|\.husky|config|configs|\.devcontainer|terraform|k8s|helm)$/i],
  ['THE DOMAIN', /^(lib|libs|utils|util|core|domain|engine|shared|common|helpers|types|packages|modules|internal|pkg|cmd|logic|model|entities|services)$/i],
];
const NICE_NAMES: Record<string, string> = {
  src: 'Source', lib: 'Library', libs: 'Libraries', api: 'API', db: 'Database', e2e: 'E2E tests', ci: 'CI', '.github': 'GitHub workflows',
  __tests__: 'Tests', utils: 'Utilities', util: 'Utilities', pkg: 'Packages', cmd: 'Commands', ui: 'UI', css: 'CSS', sql: 'SQL',
  www: 'Web', bin: 'Binaries', docs: 'Docs', '': 'Root files', trpc: 'tRPC', graphql: 'GraphQL',
};
const SLAB = /^(db|database|prisma|drizzle|migrations?|schemas?|seeds?|sql|data|datasets?|fixtures|supabase)$/i;
const ENTRY = /(^|\/)(index|main|app|server|cli|mod|lib|__init__|program)\.(ts|tsx|js|jsx|mjs|py|go|rs|rb|java|kt|cs|php)$/i;
const FRAMEWORKS: Record<string, string> = {
  next: 'Next.js', react: 'React', 'react-dom': '', vue: 'Vue', nuxt: 'Nuxt', svelte: 'Svelte', '@sveltejs/kit': 'SvelteKit', astro: 'Astro', solid: 'Solid',
  express: 'Express', fastify: 'Fastify', hono: 'Hono', koa: 'Koa', nestjs: 'NestJS', '@nestjs/core': 'NestJS', vite: 'Vite', webpack: 'webpack', esbuild: 'esbuild',
  convex: 'Convex', 'drizzle-orm': 'Drizzle', prisma: 'Prisma', '@prisma/client': '', mongoose: 'Mongoose', 'three': 'three.js', tailwindcss: 'Tailwind',
  '@clerk/nextjs': 'Clerk', '@tanstack/react-query': 'TanStack Query', '@tanstack/react-router': 'TanStack Router', zustand: 'Zustand', redux: 'Redux',
  jest: 'Jest', vitest: 'Vitest', '@playwright/test': 'Playwright', cypress: 'Cypress', typescript: 'TypeScript', electron: 'Electron', 'react-native': 'React Native', expo: 'Expo',
  django: 'Django', flask: 'Flask', fastapi: 'FastAPI', pytest: 'pytest', numpy: 'NumPy', pandas: 'pandas', torch: 'PyTorch', tensorflow: 'TensorFlow',
};

// ── helpers ──
const kb = (b: number) => b < 1024 * 1000 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1048576).toFixed(1)} MB`;
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const dirOf = (p: string) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
const titleCase = (s: string) => s.replace(/[-_.]+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase());
const pct = (a: number, b: number) => b ? Math.round((a / b) * 100) : 0;
const list = (xs: string[]) => xs.length <= 1 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1];

function normalize(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop(); else out.push(seg);
  }
  return out.join('/');
}

function niceName(dir: string): string {
  const seg = dir.slice(dir.lastIndexOf('/') + 1);
  return NICE_NAMES[seg] ?? NICE_NAMES[dir] ?? titleCase(seg);
}
function categorize(dir: string): string {
  if (dir === '') return 'THE ROOT';
  const segs = dir.split('/');
  for (let i = segs.length - 1; i >= 0; i--) for (const [g, re] of CATEGORY) if (re.test(segs[i])) return g;
  return 'THE CODE';
}

/** Two-letter codes, unique across the set, derived from the name. */
function assignCodes(names: string[]): string[] {
  const used = new Set<string>(); const out: string[] = [];
  for (const n of names) {
    const words = n.replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
    const cands: string[] = [];
    if (words.length >= 2) cands.push(words[0][0] + words[1][0]);
    const w = words.join('');
    if (w.length >= 2) cands.push(w.slice(0, 2));
    const cons = w.replace(/[aeiou]/gi, '');
    if (cons.length >= 2) cands.push(cons.slice(0, 2));
    for (let i = 1; i < w.length; i++) cands.push(w[0] + w[i]);
    for (const a of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') cands.push((w[0] || 'X') + a);
    let pick = cands.map((c) => c.toUpperCase()).find((c) => !used.has(c)) || 'X' + used.size;
    used.add(pick); out.push(pick);
  }
  return out;
}

/** Pick which directories become blocks: start with top-level, expand the dominant ones. */
function chooseUnitDirs(files: RepoFile[], max: number): string[] {
  const dirs = new Set<string>(['']);
  for (const f of files) { const top = f.path.split('/')[0]; if (f.path.includes('/')) dirs.add(top); }
  const total = files.length;
  const assign = () => {
    const ds = [...dirs].sort((a, b) => b.length - a.length);
    const m = new Map<string, RepoFile[]>(); ds.forEach((d) => m.set(d, []));
    for (const f of files) {
      const d = ds.find((x) => x === '' || f.path.startsWith(x + '/'))!;
      m.get(d)!.push(f);
    }
    return m;
  };
  for (let iter = 0; iter < 40 && dirs.size < max; iter++) {
    const m = assign();
    const cands = [...m.entries()]
      .filter(([, fs]) => fs.length > Math.max(8, total * 0.12))
      .sort((a, b) => b[1].length - a[1].length);
    let expanded = false;
    for (const [d, fs] of cands) {
      const sub = new Map<string, number>();
      for (const f of fs) {
        const rest = d === '' ? f.path : f.path.slice(d.length + 1);
        if (!rest.includes('/')) continue;
        const s = rest.split('/')[0];
        sub.set(s, (sub.get(s) || 0) + 1);
      }
      const subs = [...sub.entries()].filter(([, n]) => n >= 3 && n < fs.length).sort((a, b) => b[1] - a[1]);
      if (subs.length < 2 && !(subs.length === 1 && subs[0][1] < fs.length * 0.9)) continue;
      const room = max - dirs.size;
      if (room <= 0) break;
      subs.slice(0, room).forEach(([s]) => dirs.add(d === '' ? s : d + '/' + s));
      expanded = true; break;
    }
    if (!expanded) break;
  }
  // Drop empties, then fold the tiniest top-level leftovers into the root block if we overflowed.
  const m = assign();
  let out = [...dirs].filter((d) => d === '' || (m.get(d) || []).length > 0);
  if (out.length > max) {
    const sorted = out.filter((d) => d !== '').sort((a, b) => (m.get(b)!.length) - (m.get(a)!.length));
    out = ['', ...sorted.slice(0, max - 1)];
  }
  return out;
}

export function buildAtlas(source: RepoSource, opts: BuildOptions = {}): AtlasData {
  const MAX = opts.maxStructures ?? 24, MAX_EDGES = opts.maxEdges ?? 44;
  const files = source.files.filter((f) => !isIgnoredPath(f.path)).map((f) => ({ ...f, path: normalize(f.path) }));
  const textFiles = files.filter((f) => isText(f.path));
  const totalBytes = textFiles.reduce((a, f) => a + f.size, 0);
  const assetCount = files.length - textFiles.length;

  // ── units ──
  const unitDirs = chooseUnitDirs(files, MAX);
  const byLen = unitDirs.slice().sort((a, b) => b.length - a.length);
  const unitOf = (path: string) => byLen.find((d) => d === '' || path === d || path.startsWith(d + '/'))!;
  const units = new Map<string, Unit>();
  unitDirs.forEach((dir) => units.set(dir, {
    dir, files: [], bytes: 0, assets: 0, id: '', code: '', name: '', group: categorize(dir),
    hasChildUnits: unitDirs.some((o) => o !== dir && (dir === '' ? true : o.startsWith(dir + '/'))),
    gx: 0, gy: 0, w: 1, d: 1, h: 0.5, slab: false, out: new Map(), inn: new Map(), ext: new Map(),
  }));
  for (const f of files) { const u = units.get(unitOf(f.path))!; u.files.push(f); if (isText(f.path)) u.bytes += f.size; else u.assets++; }
  for (const d of unitDirs) if (units.get(d)!.files.length === 0 && d !== '') units.delete(d);
  if (units.get('')!.files.length === 0 && units.size > 1) units.delete('');
  const U = [...units.values()];

  // names (disambiguate duplicates with the parent segment), ids, codes
  const nameCount = new Map<string, number>();
  U.forEach((u) => { u.name = niceName(u.dir) + (u.hasChildUnits && u.dir !== '' ? ' (root)' : ''); nameCount.set(u.name, (nameCount.get(u.name) || 0) + 1); });
  U.forEach((u) => { if ((nameCount.get(u.name) || 0) > 1 && u.dir.includes('/')) u.name = titleCase(dirOf(u.dir).split('/').pop()!) + ' · ' + u.name; });
  const codes = assignCodes(U.map((u) => u.name));
  const idUsed = new Set<string>();
  U.forEach((u, i) => {
    u.code = codes[i];
    let id = (u.dir || 'root').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'root';
    while (idUsed.has(id)) id += '2';
    idUsed.add(id); u.id = id;
  });
  const unitById = new Map(U.map((u) => [u.id, u]));

  // ── sizes ──
  const maxBytes = Math.max(1, ...U.map((u) => u.bytes));
  U.forEach((u) => {
    const n = u.files.length;
    const side = Math.max(1, Math.min(3, 1 + Math.log2(Math.max(1, n)) / 3.2));
    u.w = u.d = Math.round(side * 10) / 10;
    u.h = Math.round((0.35 + 2.65 * Math.sqrt(u.bytes / maxBytes)) * 100) / 100;
    const seg = u.dir.split('/').pop() || '';
    if (u.group === 'THE DATA' && SLAB.test(seg)) { u.slab = true; u.h = 0.22; u.w = u.d = Math.max(u.w, 1.6); }
  });

  // ── imports → edges ──
  const srcDir = unitDirs.includes('src') || files.some((f) => f.path.startsWith('src/')) ? 'src' : '';
  const topSegs = new Set(files.map((f) => f.path.split('/')[0]));
  const resolveInternal = (fromPath: string, spec: string, pathLike: boolean): string | null => {
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
      // bare specifier that is really an in-repo path: "app/models", "src/x", "lib.foo" (python), go module suffixes
      const asPath = ext === 'py' ? spec.replace(/\./g, '/') : spec;
      const first = asPath.split('/')[0];
      const hits = (prefix: string) => files.some((f) => f.path === prefix || f.path.startsWith(prefix + '/') || f.path.startsWith(prefix + '.'));
      if (topSegs.has(first) && hits(asPath)) p = asPath;
      else if (srcDir && hits(srcDir + '/' + asPath)) p = srcDir + '/' + asPath;
      else if (ext === 'go' && asPath.includes('/')) {
        const segs = asPath.split('/');
        for (let i = 1; i < segs.length; i++) { const tail = segs.slice(i).join('/'); if (unitDirs.includes(tail)) { p = tail; break; } }
      }
    }
    if (p == null) return null;
    const u = unitOf(p);
    return units.has(u) ? u : null;
  };
  let filesRead = 0, importCount = 0;
  for (const f of files) {
    if (!f.content || !isCode(f.path)) continue;
    filesRead++;
    const from = units.get(unitOf(f.path))!;
    for (const im of extractImports(f.path, f.content)) {
      importCount++;
      const target = resolveInternal(f.path, im.spec, im.pathLike);
      if (target != null) {
        const to = units.get(target)!;
        if (to === from) continue;
        const isTest = /\.(test|spec)\.|(^|\/)(tests?|__tests__|e2e)\//.test(f.path);
        const rec = from.out.get(to.id) || { n: 0, ex: `${base(f.path)} → ${im.spec}`, exTest: isTest };
        if (rec.exTest && !isTest) { rec.ex = `${base(f.path)} → ${im.spec}`; rec.exTest = false; }
        rec.n++; from.out.set(to.id, rec);
        to.inn.set(from.id, (to.inn.get(from.id) || 0) + 1);
      } else if (!im.pathLike && !im.spec.startsWith('.') && !/^(node:|bun:|deno:|https?:)/.test(im.spec) && extOf(f.path) !== 'go' && extOf(f.path) !== 'java') {
        const pkg = packageName(im.spec);
        if (!pkg.startsWith('.') && !/^(os|sys|re|json|typing|pathlib|collections|math|time|datetime|std|core|alloc|io|fs|path|http|crypto|util|events|stream|child_process|url|net|assert|buffer|zlib|querystring|readline|process|tty|cluster|dgram|dns|vm|worker_threads|perf_hooks|string_decoder|v8|module|punycode|inspector|async_hooks|timers|constants|__future__|abc|functools|itertools|logging|subprocess|shutil|random|unittest|dataclasses|enum|io|argparse|copy|csv|hashlib|uuid|tempfile|threading|asyncio|contextlib|inspect|traceback|warnings|operator|string|struct|glob|pickle|base64|decimal|fractions|statistics|textwrap|urllib|http|email|socket|ssl|select|signal|platform|getpass|pprint|queue|heapq|bisect|array|weakref|types|numbers|cmath|codecs|locale|gettext|zipfile|tarfile|gzip|bz2|lzma|sqlite3|xml|html|concurrent|multiprocessing|ctypes|importlib|pkgutil|site|sysconfig|builtins|atexit|gc|dis|ast|token|tokenize|keyword|symtable|compileall|py_compile|zipimport|runpy|unicodedata|stringprep|difflib|shlex|fnmatch|linecache|fileinput|filecmp|stat|mimetypes|mailbox|binascii|quopri|uu|secrets|hmac|ipaddress|selectors|socketserver|xmlrpc|webbrowser|cgi|wsgiref|turtle|tkinter|curses|pdb|profile|cProfile|timeit|trace|tracemalloc|faulthandler|test|doctest|venv|ensurepip|zipapp|errno|mmap|resource|grp|pwd|termios|fcntl|pipes|syslog|posix|nis|spwd|crypt|msvcrt|winreg|winsound)$/.test(pkg) && !/^[A-Z]/.test(pkg)) {
          from.ext.set(pkg, (from.ext.get(pkg) || 0) + 1);
        }
      }
    }
  }

  // manifest → declared deps + frameworks
  const declared = new Map<string, 'dep' | 'dev'>();
  const pkgJson = files.find((f) => f.path === 'package.json' && f.content);
  if (pkgJson) {
    try {
      const j = JSON.parse(pkgJson.content!);
      Object.keys(j.dependencies || {}).forEach((k) => declared.set(k, 'dep'));
      Object.keys(j.devDependencies || {}).forEach((k) => { if (!declared.has(k)) declared.set(k, 'dev'); });
    } catch { /* not our problem */ }
  }
  for (const f of files) {
    if (!f.content) continue;
    if (/(^|\/)(requirements[\w.-]*\.txt)$/.test(f.path)) f.content.split('\n').forEach((l) => { const m = l.match(/^\s*([A-Za-z0-9_.-]+)/); if (m && !l.trim().startsWith('#')) declared.set(m[1].toLowerCase(), 'dep'); });
    if (/(^|\/)pyproject\.toml$/.test(f.path)) (f.content.match(/^\s*"?([A-Za-z0-9_.-]+)"?\s*[>=<~!\[]/gm) || []).forEach((l) => declared.set(l.replace(/["\s>=<~!\[].*$/, '').trim().toLowerCase(), 'dep'));
  }
  const frameworks = [...new Set([...declared.keys()].map((k) => FRAMEWORKS[k]).filter((v): v is string => !!v))];
  const usesBun = files.some((f) => /^bun\.lockb?$/.test(f.path));
  const runtime = usesBun ? 'Bun' : files.some((f) => f.path === 'pnpm-lock.yaml') ? 'pnpm' : files.some((f) => f.path === 'yarn.lock') ? 'Yarn' : files.some((f) => f.path === 'package-lock.json') ? 'npm' : '';

  // ── layout: one row band per group, wrap long rows ──
  const groupsPresent = GROUP_ORDER.filter((g) => U.some((u) => u.group === g));
  const ROW_W = 19; let gy = 0;
  const GROUPS: Group[] = [];
  for (const g of groupsPresent) {
    const members = U.filter((u) => u.group === g).sort((a, b) => b.bytes - a.bytes);
    GROUPS.push([g, members.map((m) => m.id)]);
    let gx = 0, rowD = 0;
    for (const u of members) {
      if (gx > 0 && gx + u.w > ROW_W) { gy += rowD + 1.6; gx = 0; rowD = 0; }
      u.gx = Math.round(gx * 10) / 10; u.gy = Math.round(gy * 10) / 10;
      gx += u.w + 1.2; rowD = Math.max(rowD, u.d);
    }
    gy += rowD + 1.8;
  }

  // ── edges ──
  const allEdges: { f: Unit; t: Unit; n: number; ex: string }[] = [];
  U.forEach((f) => f.out.forEach((rec, tid) => allEdges.push({ f, t: unitById.get(tid)!, n: rec.n, ex: rec.ex })));
  allEdges.sort((a, b) => b.n - a.n);
  const kept = allEdges.slice(0, MAX_EDGES);
  const flowCut = kept.length ? kept[Math.min(kept.length - 1, Math.floor(kept.length * 0.3))].n : 0;
  const EDGES: Edge[] = kept.map((e) => ({
    f: e.f.id, t: e.t.id,
    ...(e.n >= Math.max(2, flowCut) ? { flow: 1 as const } : {}),
    ...(e.n === 1 && kept.length > 12 ? { dashed: 1 as const } : {}),
    pay: `${e.n} import${e.n === 1 ? '' : 's'} · e.g. ${e.ex}`,
  }));

  // ── externals: top packages by use, pinned to the block that uses each most ──
  const extTotals = new Map<string, { n: number; by: Map<string, number> }>();
  U.forEach((u) => u.ext.forEach((n, pkg) => { const r = extTotals.get(pkg) || { n: 0, by: new Map() }; r.n += n; r.by.set(u.id, n); extTotals.set(pkg, r); }));
  const OFFSETS: [number, number][] = [[-1.8, -1.3], [1.8, -1.3], [-2.2, 0.6], [2.2, 0.6]];
  const perUnitExt = new Map<string, number>();
  const EXTERNALS: External[] = [...extTotals.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 8).map(([pkg, r]) => {
    const host = [...r.by.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const k = perUnitExt.get(host) || 0; perUnitExt.set(host, k + 1);
    const [dx, dy] = OFFSETS[k % OFFSETS.length];
    return { name: pkg.toUpperCase(), t: host, dx, dy };
  }).filter((x) => (perUnitExt.get(x.t) || 0) <= 4);

  // ── structures ──
  const langsOf = (fs: RepoFile[]) => {
    const m = new Map<string, number>(); fs.forEach((f) => m.set(langOf(f.path), (m.get(langOf(f.path)) || 0) + f.size));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const STRUCTURES: Structure[] = U.map((u) => {
    const sorted = u.files.slice().sort((a, b) => b.size - a.size);
    const sortedText = sorted.filter((f) => isText(f.path));
    const langs = langsOf(u.files.filter((f) => isText(f.path)));
    const subdirs = [...new Set(u.files.map((f) => { const rest = u.dir ? f.path.slice(u.dir.length + 1) : f.path; return rest.includes('/') ? rest.split('/')[0] : ''; }).filter(Boolean))];
    const talks = [...u.out.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 6).map(([id]) => id);
    const usedBy = [...u.inn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id]) => unitById.get(id)!.name);
    const topDeps = [...u.ext.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([p]) => p);
    const codeFiles = u.files.filter((f) => isCode(f.path)).length;
    const what = [
      `${u.dir ? `[[${u.dir}/]]` : 'Files at the repo root'} — ${u.files.length} file${u.files.length === 1 ? '' : 's'}, ${kb(u.bytes)} of text${u.assets ? ` plus ${u.assets} binary asset${u.assets === 1 ? '' : 's'}` : ''}${langs.length ? `, mostly ${langs[0][0]}${langs[1] ? ` and ${langs[1][0]}` : ''}` : ''}.`,
      sortedText[0] ? `The largest file is ${base(sortedText[0].path)} (${kb(sortedText[0].size)}).` : '',
      subdirs.length ? `Holds ${subdirs.length === 1 ? 'one folder' : subdirs.length + ' folders'}: ${subdirs.slice(0, 5).join(', ')}${subdirs.length > 5 ? ', …' : ''}.` : '',
      talks.length ? `Imports from ${list(talks.slice(0, 3).map((id) => unitById.get(id)!.name))}.` : '',
      usedBy.length ? `Used by ${list(usedBy.slice(0, 3))}.` : (talks.length ? '' : codeFiles ? 'No in-repo imports were found in either direction — a leaf.' : ''),
    ].filter(Boolean).join(' ');
    const how = [
      `${codeFiles} code file${codeFiles === 1 ? '' : 's'}${u.files.length - codeFiles ? ` and ${u.files.length - codeFiles} other` : ''}${langs[0] ? ` · ${pct(langs[0][1], u.bytes)}% ${langs[0][0]} by size` : ''}.`,
      topDeps.length ? `Leans on ${list(topDeps)}.` : '',
      u.slab ? 'Drawn as a slab: this is storage and records rather than logic.' : '',
    ].filter(Boolean).join(' ');
    let children: ChildPart[] | undefined;
    if (u.files.length > 1) {
      const pool = sortedText.length >= 2 ? sortedText : sorted;
      const top = pool.slice(0, 9), maxS = top[0].size || 1;
      const ccodes = assignCodes(top.map((f) => base(f.path)));
      children = top.map((f, i) => ({ code: ccodes[i], name: base(f.path), h: Math.max(0.18, f.size / maxS), what: `${f.path} · ${kb(f.size)} · ${langOf(f.path)}` }));
    }
    return {
      id: u.id, code: u.code, name: u.name, group: u.group, loc: `${u.files.length} file${u.files.length === 1 ? '' : 's'} · ${kb(u.bytes)}`,
      gx: u.gx, gy: u.gy, w: u.w, d: u.d, h: u.h, ...(u.slab ? { slab: 1 as const } : {}),
      what, how, src: (sortedText.length ? sortedText : sorted).slice(0, 8).map((f) => f.path), talks, ...(children ? { children } : {}),
    };
  });

  // ── trace: follow the heaviest unvisited import edge from the entry point ──
  const entryScore = (f: RepoFile) => {
    const name = base(f.path).replace(/\.[^.]+$/, '').toLowerCase();
    const rank = ['main', 'index', 'app', 'server', 'cli', 'program', 'mod', 'lib', '__init__'].indexOf(name);
    const segs = f.path.split('/');
    const bad = segs.some((x) => /^(db|database|scripts?|tests?|__tests__|e2e|spec|docs?|examples?|prototype|tools|bin|migrations|public|static|assets)$/i.test(x));
    const good = segs[0] === 'src' || segs[0] === 'app' || segs.length === 1;
    return (rank < 0 ? 9 : rank) * 10 + segs.length * 2 + (bad ? 100 : 0) - (good ? 5 : 0) + (/\.(test|spec)\./.test(f.path) ? 100 : 0);
  };
  const entryFile = files.filter((f) => ENTRY.test(f.path)).sort((a, b) => entryScore(a) - entryScore(b))[0];
  let cur: Unit | undefined = entryFile ? units.get(unitOf(entryFile.path)) : undefined;
  if (!cur || cur.out.size === 0) cur = U.slice().sort((a, b) => b.out.size - a.out.size || b.bytes - a.bytes)[0];
  const TRACE: TraceStep[] = [];
  const seen = new Set<string>();
  if (cur) {
    const entryNote = entryFile && units.get(unitOf(entryFile.path)) === cur ? `${entryFile.path} is the entry point.` : 'it has the most outgoing imports.';
    TRACE.push([cur.id, `Starts in [[${cur.name}]] — ${entryNote} ${cur.files.length} files, ${kb(cur.bytes)}.`]);
    seen.add(cur.id);
    for (let i = 0; i < 11; i++) {
      const next: [string, { n: number; ex: string; exTest?: boolean }] | undefined = [...cur!.out.entries()].filter(([id]) => !seen.has(id)).sort((a, b) => b[1].n - a[1].n)[0];
      if (!next) break;
      const to: Unit = unitById.get(next[0])!;
      TRACE.push([to.id, `${cur!.name} reaches into [[${to.name}]] — ${next[1].n} import${next[1].n === 1 ? '' : 's'}, e.g. ${next[1].ex}. ${to.files.length} file${to.files.length === 1 ? '' : 's'}, ${kb(to.bytes)}${to.out.size ? `, which in turn imports from ${to.out.size} other block${to.out.size === 1 ? '' : 's'}` : ' — the chain ends here'}.`]);
      seen.add(to.id); cur = to;
    }
  }

  // ── overview ──
  const langs = langsOf(textFiles);
  const topLangs = langs.slice(0, 3).map(([l, b]) => `${l} ${pct(b, totalBytes)}%`);
  const big = U.slice().sort((a, b) => b.bytes - a.bytes).slice(0, 3);
  const bigShare = pct(big.reduce((a, u) => a + u.bytes, 0), totalBytes);
  const testFiles = files.filter((f) => /(\.(test|spec)\.|(^|\/)(tests?|__tests__|e2e|spec)\/)/.test(f.path)).length;
  const codeFilesTotal = files.filter((f) => isCode(f.path)).length;
  const topEdge = allEdges[0];
  const depNames = [...declared.entries()].filter(([, k]) => k === 'dep').length, devNames = [...declared.entries()].filter(([, k]) => k === 'dev').length;
  const product = (source.name.split('/').pop() || source.name).replace(/[-_]+/g, ' ').toUpperCase();
  const subj = `a ${langs[0] ? langs[0][0] : 'mixed'}${frameworks[0] ? ' / ' + frameworks.slice(0, 2).join(' + ') : ''} codebase`;

  return {
    repo: `${source.name} · ${source.ref}`, product,
    traceTitle: 'ONE IMPORT CHAIN',
    stats: [
      ['FILES', String(files.length)],
      ['TEXT', kb(totalBytes)],
      ...(assetCount ? [['ASSETS', String(assetCount)] as [string, string]] : []),
      ['LANGUAGE', langs[0] ? `${langs[0][0]} ${pct(langs[0][1], totalBytes)}%` : '—'],
      ['BLOCKS', String(U.length)],
      ['IMPORT LINKS', String(allEdges.length)],
      ['DEPENDENCIES', declared.size ? `${depNames}${devNames ? ` + ${devNames} dev` : ''}` : String(extTotals.size)],
    ],
    overviewTitle: `${files.length} files, ${U.length} blocks, ${allEdges.length} import paths — seen from above`,
    overviewKicker: product,
    overviewSub: subj,
    OVERVIEW_WHAT: [
      `This atlas was generated from a scan of [[${source.name}]] at ${source.ref}: ${files.length} files, ${kb(totalBytes)} of text${assetCount ? ` plus ${assetCount} binary asset${assetCount === 1 ? '' : 's'}` : ''}${topLangs.length ? ` — ${topLangs.join(', ')}` : ''}. Each block is a folder; block height is the amount of text inside it.`,
      big.length ? `The biggest structures are ${list(big.map((u) => `[[${u.name}]] (${kb(u.bytes)})`))}${big.length > 1 ? `, together ${bigShare}% of the repository` : ''}.` : '',
      `${allEdges.length} import relationship${allEdges.length === 1 ? '' : 's'} between blocks were found by reading ${filesRead} of ${codeFilesTotal} code files (${importCount} import statements).${topEdge ? ` The busiest link is ${topEdge.f.name} → ${topEdge.t.name} with ${topEdge.n} imports.` : ''}${filesRead < codeFilesTotal ? ` ${codeFilesTotal - filesRead} code files were not read, so some links may be missing.` : ''}`,
    ].filter(Boolean),
    OVERVIEW_HOW: [
      frameworks.length || runtime ? `Detected from the manifests: ${list([...frameworks.slice(0, 6), ...(runtime ? [`${runtime} as the package runner`] : [])])}.${declared.size ? ` ${depNames} declared dependencies${devNames ? ` plus ${devNames} for development` : ''}.` : ''}` : `No package manifest was recognised; ${extTotals.size} third-party packages were inferred from import statements.`,
      `${entryFile ? `The entry point looks like [[${entryFile.path}]]. ` : ''}${testFiles ? `${testFiles} test file${testFiles === 1 ? '' : 's'} live under ${list([...new Set(files.filter((f) => /(\.(test|spec)\.|(^|\/)(tests?|__tests__|e2e|spec)\/)/.test(f.path)).map((f) => unitById.get(units.get(unitOf(f.path))!.id)!.name))].slice(0, 3))}.` : 'No test files were recognised.'}`,
      'Descriptions here are derived from the file tree and the import graph, not from reading what the code intends — treat them as a map, not as documentation.',
      ...(source.note ? [source.note] : []),
    ],
    HOW_TO_READ: 'Hover anything for a plain description; click it for the full card. [[Go inside]] a block to see its largest files. TRACE follows the heaviest import chain out from the entry point.',
    GROUPS, STRUCTURES, EDGES, EXTERNALS, TRACE,
  };
}

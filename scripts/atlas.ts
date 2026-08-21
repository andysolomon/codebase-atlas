#!/usr/bin/env bun
/* Codebase Atlas CLI — build an atlas JSON from a local folder or a GitHub URL.

     bun run atlas .                                  # this repo → public/atlases/<name>.json
     bun run atlas ../some-repo                       # any local folder
     bun run atlas https://github.com/owner/repo      # any public GitHub repo
     bun run atlas owner/repo@branch -o out.json      # explicit output path
     bun run atlas owner/repo --stdout                # print JSON instead of writing

   Then open http://localhost:5173/?atlas=/atlases/<name>.json (bun run dev).
   Set GITHUB_TOKEN for private repos or a higher rate limit. */

import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { buildAtlas, loadGitHub, parseGitHub, type RepoFile, type RepoSource } from '../src/analyze';
import { IGNORED_DIRS, isCode, isIgnoredPath } from '../src/analyze/ignore';

const MANIFEST = /(^|\/)(package\.json|requirements[\w.-]*\.txt|pyproject\.toml|go\.mod|Cargo\.toml|Gemfile|composer\.json)$/;
const MAX_FILE = 300 * 1024;

async function loadLocal(root: string): Promise<RepoSource> {
  const abs = resolve(root);
  const files: RepoFile[] = [];
  const walk = async (dir: string) => {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      if (ent.isSymbolicLink()) continue;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) { if (!IGNORED_DIRS.has(ent.name)) await walk(full); continue; }
      if (!ent.isFile()) continue;
      const rel = relative(abs, full).split('\\').join('/');
      if (isIgnoredPath(rel)) continue;
      const st = await stat(full);
      const f: RepoFile = { path: rel, size: st.size };
      if ((isCode(rel) || MANIFEST.test(rel)) && st.size > 0 && st.size <= MAX_FILE) {
        try { f.content = await readFile(full, 'utf8'); } catch { /* binary or unreadable */ }
      }
      files.push(f);
    }
  };
  await walk(abs);
  let ref = 'local';
  try { ref = (await readFile(join(abs, '.git', 'HEAD'), 'utf8')).trim().replace(/^ref: refs\/heads\//, '') || 'local'; } catch { /* not a git repo */ }
  return { name: basename(abs), ref, files };
}

async function main() {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith('-'));
  if (!target || args.includes('-h') || args.includes('--help')) {
    console.log('usage: bun run atlas <path | github-url | owner/repo[@ref]> [-o out.json] [--stdout]');
    process.exit(target ? 0 : 1);
  }
  const oi = args.indexOf('-o');
  const out = oi >= 0 ? args[oi + 1] : null;
  const toStdout = args.includes('--stdout');
  const log = (m: string) => { if (!toStdout) process.stderr.write(m + '\n'); };

  const gh = /github\.com|^[\w.-]+\/[\w.-]+(@[^/]+)?$/.test(target) && !(await stat(target).catch(() => null)) ? parseGitHub(target) : null;
  let src: RepoSource;
  if (gh) {
    log(`scanning github.com/${gh.owner}/${gh.repo}${gh.ref ? '@' + gh.ref : ''} …`);
    let last = '';
    src = await loadGitHub(gh, {
      token: process.env.GITHUB_TOKEN,
      onProgress: (p) => { const m = p.phase === 'content' ? `  reading ${p.done}/${p.total}` : `  ${p.phase}: ${p.message || ''}`; if (m !== last && (p.phase !== 'content' || p.done % 25 === 0 || p.done === p.total)) { log(m); last = m; } },
    });
  } else {
    log(`scanning ${resolve(target)} …`);
    src = await loadLocal(target);
  }
  log(`  ${src.files.length} files, ${src.files.filter((f) => f.content).length} read`);
  const atlas = buildAtlas(src);
  const json = JSON.stringify(atlas, null, 1);
  if (toStdout) { process.stdout.write(json + '\n'); return; }
  const slug = src.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const dest = out || join('public', 'atlases', `${slug}.json`);
  await mkdir(resolve(dest, '..'), { recursive: true });
  await writeFile(dest, json);
  log(`wrote ${dest} — ${atlas.STRUCTURES.length} blocks, ${atlas.EDGES.length} edges`);
  if (!out) log(`open: http://localhost:5173/?atlas=/atlases/${slug}.json`);
}

main().catch((e) => { console.error(String(e?.message || e)); process.exit(1); });

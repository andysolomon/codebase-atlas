#!/usr/bin/env bun
/* Codebase Atlas CLI — build an atlas JSON from a local folder or a GitHub URL.

     bun run atlas .                                  # this repo → public/atlases/<name>.json
     bun run atlas ../some-repo                       # any local folder
     bun run atlas https://github.com/owner/repo      # any public GitHub repo
     bun run atlas owner/repo@branch -o out.json      # explicit output path
     bun run atlas owner/repo --stdout                # print JSON instead of writing

   Add --ai to have a model decide what the blocks are and write the prose:

     bun run atlas . --ai                             # cheap default model
     bun run atlas . --ai --model spacexai/grok-4.6   # any AI Gateway model id
     bun run atlas . --ai --model-partition anthropic/claude-opus-4.8
     bun run atlas . --ai --dry-run                   # token estimate, makes no calls
     bun run atlas . --ai --explain                   # print where each headline number came from

   Then open http://localhost:5173/?atlas=/atlases/<name>.json (bun run dev).
   Set GITHUB_TOKEN for private repos or a higher rate limit.
   Set AI_GATEWAY_API_KEY for --ai (or MINIMAX_API_KEY with --model minimax-direct/MiniMax-M3). */

import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { buildAtlas, loadGitHub, parseGitHub, type RepoFile, type RepoSource } from '../src/analyze';
import { CONTEXT_FILE, IGNORED_DIRS, isCode, isIgnoredPath } from '../src/analyze/ignore';
import { enrichAtlas, planEnrichment } from '../src/analyze/ai';
import { credentialStatus, DEFAULT_MODEL } from '../src/analyze/ai/provider';

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
      if ((isCode(rel) || MANIFEST.test(rel) || CONTEXT_FILE.test(rel)) && st.size > 0 && st.size <= MAX_FILE) {
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
    console.log('       [--ai] [--model <id>] [--model-partition <id>] [--dry-run] [--explain] [--no-cache]');
    process.exit(target ? 0 : 1);
  }
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('-') ? args[i + 1] : null; };
  const out = flag('-o');
  const toStdout = args.includes('--stdout');
  const useAi = args.includes('--ai');
  const dryRun = args.includes('--dry-run');
  const explain = args.includes('--explain');
  const model = flag('--model') ?? DEFAULT_MODEL;
  const partitionModel = flag('--model-partition') ?? model;
  const log = (m: string) => { if (!toStdout) process.stderr.write(m + '\n'); };

  if (useAi && !dryRun) {
    const creds = credentialStatus();
    const wantsDirect = [model, partitionModel].some((m) => m.startsWith('minimax-direct/'));
    if (wantsDirect ? !creds.minimaxDirect : !creds.gateway) {
      console.error(wantsDirect
        ? 'MINIMAX_API_KEY is not set, and --model asks MiniMax directly.'
        : 'AI_GATEWAY_API_KEY is not set. Run `vercel env pull` after `vercel link`, or export a gateway key.\n'
          + 'To try it with no Vercel setup: --model minimax-direct/MiniMax-M3 with MINIMAX_API_KEY set.');
      process.exit(1);
    }
  }

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

  if (useAi && dryRun) {
    const plan = planEnrichment(src);
    const total = plan.reduce((a, p) => a + p.tokens, 0);
    for (const p of plan) log(`  ${p.label.padEnd(16)} ~${p.tokens.toLocaleString()} input tokens`);
    log(`  ${'TOTAL'.padEnd(16)} ~${total.toLocaleString()} input tokens across ${plan.length} calls`);
    log('  (no calls were made; output tokens are typically 10-20% of input for these passes)');
    return;
  }

  let atlas = buildAtlas(src);
  if (useAi) {
    const r = await enrichAtlas(src, {
      model, partitionModel, useCache: !args.includes('--no-cache'), onProgress: log,
    });
    atlas = r.data;
    if (r.usage.input || r.usage.output) {
      log(`  spent ${r.usage.known ? '' : 'at least '}${r.usage.input.toLocaleString()} in / ${r.usage.output.toLocaleString()} out tokens`);
    }
    for (const note of r.report.notes) log(`  note: ${note}`);
    if (r.report.dropped.length) {
      log(`  rejected ${r.report.dropped.length} claim${r.report.dropped.length === 1 ? '' : 's'} the scan could not confirm:`);
      for (const d of r.report.dropped.slice(0, 8)) log(`    - ${d}`);
      if (r.report.dropped.length > 8) log(`    - and ${r.report.dropped.length - 8} more`);
    }
    for (const f of r.fallbacks) log(`  fell back to templated prose - ${f}`);
    if (explain) {
      log('  headline numbers and where they came from:');
      for (const e of r.evidence) log(`    ${e}`);
    }
  }
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

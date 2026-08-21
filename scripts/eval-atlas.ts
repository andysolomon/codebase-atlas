#!/usr/bin/env bun
/* Score a generated atlas against the hand-written one.

   `src/data/arc-worlds.ts` is a human-authored map of a repository that sits at ../arc-worlds, which
   makes it a real held-out target rather than a matter of taste. This measures how close an --ai build
   gets to it.

     bun scripts/eval-atlas.ts /tmp/aw-ai.json
     bun scripts/eval-atlas.ts /tmp/aw-ai.json --verbose

   Run it against a plain build too, to see what the AI pass is actually buying. */

import { readFileSync } from 'node:fs';
import type { AtlasData } from '../src/atlas/types';
import { ARC_WORLDS } from '../src/data/arc-worlds';

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const words = (s: string) => new Set(norm(s).split(' ').filter((w) => w.length > 2 && !STOP.has(w)));
const STOP = new Set(['the', 'and', 'for', 'root', 'files', 'file', 'lib', 'src']);

/** Two names match when one contains the other, or they share a distinctive word. */
function matches(a: string, b: string): boolean {
  const [x, y] = [norm(a), norm(b)];
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const [wx, wy] = [words(a), words(b)];
  for (const w of wx) if (wy.has(w)) return true;
  return false;
}

/** Prose the scan templated, rather than prose someone (or something) wrote. */
const isTemplated = (s: string) =>
  /^\[\[[^\]]+\]\] — \d+ files?,/.test(s) || /^Files at the repo root — /.test(s)
  || /^\d+ code files?/.test(s) || /· \d+% \w+ by size/.test(s);

/** A stat about the file tree, not about the system. */
const isFileTreeStat = (k: string) =>
  /^(files|text|assets|language|blocks|import links|dependencies|loc|lines)$/i.test(k.trim());

function main() {
  const path = process.argv[2];
  const verbose = process.argv.includes('--verbose');
  if (!path) { console.error('usage: bun scripts/eval-atlas.ts <atlas.json> [--verbose]'); process.exit(1); }

  const got = JSON.parse(readFileSync(path, 'utf8')) as AtlasData;
  const want = ARC_WORLDS;

  const wantNames = want.STRUCTURES.map((s) => s.name);
  const gotNames = got.STRUCTURES.map((s) => s.name);
  const recovered = wantNames.filter((w) => gotNames.some((g) => matches(w, g)));
  const missed = wantNames.filter((w) => !gotNames.some((g) => matches(w, g)));

  const wantGroups = want.GROUPS.map(([g]) => g);
  const gotGroups = got.GROUPS.map(([g]) => g);
  const bespoke = wantGroups.filter((g) => gotGroups.includes(g));
  const generic = gotGroups.filter((g) => ['THE CODE', 'THE ROOT', 'TOOLING', 'DOCS'].includes(g));

  const traceIds = got.TRACE.map(([id]) => id);
  const revisits = traceIds.length - new Set(traceIds).size;

  const written = got.STRUCTURES.filter((s) => !isTemplated(s.what)).length;
  const domainStats = got.stats.filter(([k]) => !isFileTreeStat(k));

  const rows: [string, string, string][] = [
    ['blocks', `${got.STRUCTURES.length}`, `${want.STRUCTURES.length}`],
    ['hand-written names recovered', `${recovered.length}/${wantNames.length} (${Math.round((recovered.length / wantNames.length) * 100)}%)`, '—'],
    ['bespoke groups present', `${bespoke.length}/${wantGroups.length} — ${bespoke.join(', ') || 'none'}`, `${wantGroups.length}`],
    ['generic groups left over', `${generic.length}${generic.length ? ' — ' + generic.join(', ') : ''}`, '0'],
    ['blocks with written prose', `${written}/${got.STRUCTURES.length}`, `${want.STRUCTURES.length}`],
    ['trace steps', `${got.TRACE.length}`, `${want.TRACE.length}`],
    ['trace revisits a block', revisits > 0 ? `yes (${revisits})` : 'no', 'yes'],
    ['trace title', got.traceTitle ?? '—', want.traceTitle ?? '—'],
    ['system-level stats', `${domainStats.length}/${got.stats.length}`, `${want.stats.length}`],
    ['edge labels written', `${got.EDGES.filter((e) => !/^\d+ imports? · e\.g\./.test(e.pay)).length}/${got.EDGES.length}`, `${want.EDGES.length}`],
  ];

  const w = Math.max(...rows.map((r) => r[0].length));
  console.log(`\n${path}  vs  the hand-written arc-worlds\n`);
  console.log(`  ${'metric'.padEnd(w)}   generated                          hand-written`);
  console.log(`  ${'-'.repeat(w)}   ${'-'.repeat(33)}  ${'-'.repeat(12)}`);
  for (const [k, a, b] of rows) console.log(`  ${k.padEnd(w)}   ${a.padEnd(33)}  ${b}`);

  if (got.provenance) {
    console.log(`\n  written by ${Object.entries(got.provenance.models).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    if (got.provenance.usage) console.log(`  spent ${got.provenance.usage.input.toLocaleString()} in / ${got.provenance.usage.output.toLocaleString()} out tokens`);
    if (got.provenance.fallbacks?.length) console.log(`  ${got.provenance.fallbacks.length} pass(es) fell back to templated prose`);
  }

  if (verbose) {
    console.log(`\n  recovered: ${recovered.join(', ')}`);
    console.log(`\n  not found: ${missed.join(', ')}`);
    console.log(`\n  generated: ${gotNames.join(', ')}`);
  }
  console.log('');
}

main();

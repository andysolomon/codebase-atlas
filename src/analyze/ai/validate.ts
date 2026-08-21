/** Everything a model returns passes through here before it can touch the map.

    Two jobs. Reject what is not real — a path the scan never saw, a block id that does not exist —
    and bound what is real, so one verbose answer cannot overrun a card that has room for three
    sentences. Anything dropped is reported, never silently accepted. */

import type { AtlasData } from '../../atlas/types';
import type { Narration, Partition, RepoFile, UnitSpec } from '../types';
import type { ComposeOut, NarrateOut, PartitionOut } from './schemas';

/** Room on the drawn card, in characters. Measured against the hand-written arc-worlds dataset. */
const CAP = {
  what: 460, how: 360, child: 160, trace: 300, overview: 720,
  title: 110, sub: 80, kicker: 32, statKey: 20, statValue: 34, payload: 46, name: 34,
};

/** Trim on a word boundary — a card that ends mid-word reads as a bug. */
function clamp(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:.\s]+$/, '') + '…';
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'block';
const titleish = (s: string) => s.replace(/[-_.]+/g, ' ').trim().replace(/\b\w/, (c) => c.toUpperCase());
const dirOf = (p: string) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };

export interface Report { dropped: string[]; notes: string[] }

/** A proposed set of blocks becomes a Partition only if the scan agrees the files are there. */
export function validatePartition(out: PartitionOut, files: RepoFile[], max = 24): { partition: Partition; report: Report } {
  const report: Report = { dropped: [], notes: [] };
  const known = new Set(files.map((f) => f.path));
  const claimed = new Set<string>();
  const keys = new Set<string>();
  const units: UnitSpec[] = [];

  for (const b of out.blocks.slice(0, max)) {
    const paths: string[] = [];
    for (const raw of b.paths) {
      const p = raw.replace(/^\.?\//, '').trim();
      if (!p) continue;
      if (p.endsWith('/')) {
        const dir = p.slice(0, -1);
        if (files.some((f) => f.path.startsWith(dir + '/'))) paths.push(p);
        else report.dropped.push(`${b.name}: no files under "${p}"`);
      } else if (known.has(p)) {
        paths.push(p);
      } else {
        report.dropped.push(`${b.name}: no such file "${p}"`);
      }
    }
    // A block claiming only files another block already took would draw as empty.
    const fresh = paths.filter((p) => !claimed.has(p));
    if (!fresh.length) { report.dropped.push(`${b.name}: every path was already claimed`); continue; }
    fresh.forEach((p) => claimed.add(p));

    let key = slug(b.key || b.name);
    while (keys.has(key)) key += '2';
    keys.add(key);
    units.push({ key, name: clamp(b.name, CAP.name), group: b.group.toUpperCase().trim(), paths: fresh, slab: b.slab });
  }

  if (out.blocks.length > max) report.notes.push(`${out.blocks.length - max} blocks past the ${max}-block limit were dropped.`);
  if (!units.length) return { partition: { units: [] }, report };

  // Anything the model forgot joins the block it sits closest to, so no file falls off the map.
  const covered = (path: string) => units.some((u) => u.paths.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p)));
  const orphans = files.filter((f) => !covered(f.path));
  if (orphans.length) {
    let placed = 0;
    for (const f of orphans) {
      const dir = dirOf(f.path);
      const host = units
        .map((u) => ({ u, score: Math.max(...u.paths.map((p) => sharedPrefix(dir, p.endsWith('/') ? p.slice(0, -1) : dirOf(p)))) }))
        .sort((a, b) => b.score - a.score)[0];
      if (host && host.score > 0) { host.u.paths.push(f.path); placed++; }
    }
    const left = orphans.filter((f) => !covered(f.path));
    if (left.length) {
      // Group what is left by top-level folder, so a forgotten `tests/` draws as "Tests" and not as
      // an unreadable bucket of everything the model missed.
      const byTop = new Map<string, string[]>();
      for (const f of left) {
        const top = f.path.includes('/') ? f.path.split('/')[0] : '';
        (byTop.get(top) ?? byTop.set(top, []).get(top)!).push(f.path);
      }
      const group = units[units.length - 1].group;
      for (const [top] of [...byTop.entries()].sort((a, b) => b[1].length - a[1].length)) {
        if (units.length >= max) break;
        let key = slug(top || 'root-files');
        while (keys.has(key)) key += '2';
        keys.add(key);
        units.push({ key, name: top ? titleish(top) : 'Root files', group, paths: [top ? top + '/' : ''] });
      }
      report.notes.push(`${left.length} file${left.length === 1 ? '' : 's'} the model left out were placed by folder.`);
    } else if (placed) {
      report.notes.push(`${placed} file${placed === 1 ? '' : 's'} the model did not place were folded into the nearest block.`);
    }
  }

  const groups = out.groups.map((g) => g.toUpperCase().trim());
  for (const u of units) if (!groups.includes(u.group)) groups.push(u.group);
  return { partition: { groups, units }, report };
}

/** How many leading path segments two folders share. */
function sharedPrefix(a: string, b: string): number {
  if (!a || !b) return 0;
  const x = a.split('/'), y = b.split('/');
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return i;
}

/** Block prose, kept only where it names a block that exists. */
export function validateNarrate(out: NarrateOut, data: AtlasData, report: Report): Narration['units'] {
  const ids = new Set(data.STRUCTURES.map((s) => s.id));
  const seen = new Set<string>();
  const units: NonNullable<Narration['units']> = [];
  for (const b of out.blocks) {
    if (!ids.has(b.id)) { report.dropped.push(`prose for unknown block "${b.id}"`); continue; }
    if (seen.has(b.id)) continue;
    seen.add(b.id);
    const children: Record<string, string> = {};
    for (const c of b.children ?? []) if (c.file && c.what) children[c.file.replace(/^\.?\//, '')] = clamp(c.what, CAP.child);
    units.push({
      id: b.id,
      ...(b.name ? { name: clamp(b.name, CAP.name) } : {}),
      what: clamp(b.what, CAP.what),
      how: clamp(b.how, CAP.how),
      ...(Object.keys(children).length ? { children } : {}),
    });
  }
  return units;
}

/** The overview, stats, trace and edge labels. */
export function validateCompose(out: ComposeOut, data: AtlasData, report: Report): Narration {
  const ids = new Set(data.STRUCTURES.map((s) => s.id));
  const edgeKeys = new Set(data.EDGES.map((e) => `${e.f}->${e.t}`));

  const trace: [string, string][] = [];
  for (const step of out.trace.slice(0, 14)) {
    if (!ids.has(step.id)) { report.dropped.push(`trace step on unknown block "${step.id}"`); continue; }
    trace.push([step.id, clamp(step.sentence, CAP.trace)]);
  }

  const edgeLabels: Record<string, string> = {};
  for (const e of out.edgeLabels) {
    const k = `${e.from}->${e.to}`;
    if (!edgeKeys.has(k)) { report.dropped.push(`label for an edge that is not drawn: ${k}`); continue; }
    edgeLabels[k] = clamp(e.payload, CAP.payload);
  }

  // A stat with no stated source is exactly the kind of number that gets invented.
  const stats: [string, string][] = [];
  for (const s of out.stats.slice(0, 7)) {
    if (!s.evidence?.trim()) { report.dropped.push(`stat "${s.key}" cited no evidence`); continue; }
    stats.push([clamp(s.key, CAP.statKey).toUpperCase(), clamp(s.value, CAP.statValue)]);
  }

  return {
    overviewTitle: clamp(out.overviewTitle, CAP.title),
    overviewKicker: clamp(out.overviewKicker, CAP.kicker).toUpperCase(),
    overviewSub: clamp(out.overviewSub, CAP.sub),
    OVERVIEW_WHAT: out.overviewWhat.slice(0, 4).map((p) => clamp(p, CAP.overview)),
    OVERVIEW_HOW: out.overviewHow.slice(0, 4).map((p) => clamp(p, CAP.overview)),
    HOW_TO_READ: clamp(out.howToRead, CAP.title),
    traceTitle: clamp(out.traceTitle, CAP.kicker).toUpperCase(),
    ...(stats.length ? { stats } : {}),
    ...(trace.length >= 2 ? { trace } : {}),
    ...(Object.keys(edgeLabels).length ? { edgeLabels } : {}),
  };
}

/** The stat evidence pointers, for `--explain`. Stats are the one output nothing can check. */
export function statEvidence(out: ComposeOut): string[] {
  return out.stats.map((s) => `${s.key} = ${s.value}   ← ${s.evidence}`);
}

/** Four passes over a scanned repository: decide what the blocks are, describe each one, write the
    front matter, then script the ride over the finished map. Server-side only.

    The scan stays the authority on every number. If a pass fails, is rejected, or credentials are
    missing, that part of the atlas keeps the prose `buildAtlas` templated for it — so an enriched
    build is never worse than a plain one. */

import type { AtlasData } from '../../atlas/types.js';
import { buildAtlas } from '../build.js';
import type { Narration, Partition, RepoSource } from '../types.js';
import { blockEvidence, composeEvidence, estimateTokens, repoEvidence, rideEvidence,
  type BlockEvidence, type ComposeEvidence, type RepoEvidence, type RideEvidence } from './evidence.js';
import { readCache, writeCache } from './cache.js';
import { COMPOSE, NARRATE, PARTITION, RIDE, SYSTEM } from './prompts.js';
import { addUsage, DEFAULT_MODEL, noUsage, runPass, type Usage } from './provider.js';
import { ComposeOut, NarrateOut, PartitionOut, RideOut } from './schemas.js';
import { statEvidence, validateCompose, validateNarrate, validatePartition, validateRide, type Report } from './validate.js';

export interface EnrichOptions {
  /** Model for every pass unless overridden. */
  model?: string;
  /** The partition pass carries the most quality per call, and is only one call. */
  partitionModel?: string;
  maxStructures?: number;
  /** Blocks described per call. */
  batchSize?: number;
  /** Calls in flight at once. Cheap providers rate-limit sooner than the Gateway does. */
  concurrency?: number;
  useCache?: boolean;
  onProgress?: (message: string) => void;
}

export interface EnrichResult {
  data: AtlasData;
  usage: Usage;
  report: Report;
  /** Passes that fell back to templated prose. */
  fallbacks: string[];
  /** Stat evidence pointers, for `--explain`. */
  evidence: string[];
  prompts: { label: string; tokens: number }[];
}

/** Roughly one block per eight files, held inside what the map can draw legibly. */
const blockTarget = (files: number) => Math.max(8, Math.min(24, Math.round(files / 8)));

const section = (title: string, body: string) => `\n--- ${title} ---\n${body}\n`;

/** Prompt builders take evidence, not a repository, so the same code serves the CLI (which scans
    locally) and the enrich endpoint (which is handed a pack by the browser and never sees the repo). */
export function buildPartitionPrompt(e: RepoEvidence & { blockTarget?: number }): string {
  const target = e.blockTarget ?? blockTarget(e.fileCount);
  return [
    PARTITION,
    section('REPOSITORY', `${e.name} @ ${e.ref} - ${e.fileCount} files`),
    section('HOW MANY BLOCKS', `Aim for about ${target} blocks. Fewer than ${Math.max(6, target - 6)} means you have merged things that deserve to be seen apart.`),
    section('README', e.readme),
    section('MANIFESTS', e.manifests),
    section('ENTRY POINTS', e.entryPoints.join('\n') || '(none recognised)'),
    section('WHAT THE LARGEST FILES DECLARE', e.symbols),
    section('FILE TREE', e.tree),
  ].join('\n');
}

export function buildNarratePrompt(blocks: BlockEvidence[]): string {
  return [
    NARRATE,
    ...blocks.map((b) => section(`BLOCK ${b.id} - ${b.name}  [${b.group}]  ${b.loc}`, [
      `FILES\n${b.files}`,
      `DECLARES\n${b.symbols}`,
      `IMPORT LINKS\n${b.links}`,
      `EXCERPTS\n${b.excerpts}`,
    ].join('\n\n'))),
  ].join('\n');
}

export function buildComposePrompt(e: ComposeEvidence): string {
  return [
    COMPOSE,
    section('REPOSITORY', `${e.name} @ ${e.ref}`),
    section('MEASURED FACTS FROM THE SCAN', e.facts),
    section('BLOCKS', e.blocks),
    section('EDGES (use these exact from->to ids for labels)', e.edges),
    section('EXTERNAL SERVICES AND PACKAGES', e.externals),
  ].join('\n');
}

export function buildRidePrompt(e: RideEvidence): string {
  return [
    RIDE,
    section('REPOSITORY', `${e.name} @ ${e.ref} - ${e.product}`),
    section('MEASURED FACTS FROM THE SCAN', e.facts),
    section('GROUPS (use these exact names)', e.groups),
    section('BLOCKS (use these exact ids)', e.blocks),
    section('EDGES (use these exact from->to pairs)', e.edges),
    section('THE TRACE, AS WRITTEN', e.trace),
  ].join('\n');
}

const partitionPrompt = (source: RepoSource) => buildPartitionPrompt(repoEvidence(source));
const narratePrompt = buildNarratePrompt;
const composePrompt = (source: RepoSource, data: AtlasData) => buildComposePrompt(composeEvidence(source, data));
const ridePrompt = (source: RepoSource, data: AtlasData) => buildRidePrompt(rideEvidence(source, data));

/** What an enrichment would cost, without spending anything. */
export function planEnrichment(source: RepoSource, opts: EnrichOptions = {}): { label: string; tokens: number }[] {
  const base = buildAtlas(source, { maxStructures: opts.maxStructures });
  const blocks = blockEvidence(source, base);
  const size = opts.batchSize ?? 6;
  const batches: { label: string; tokens: number }[] = [];
  for (let i = 0; i < blocks.length; i += size) {
    batches.push({ label: `narrate ${i / size + 1}`, tokens: estimateTokens(narratePrompt(blocks.slice(i, i + size))) });
  }
  return [
    { label: 'partition', tokens: estimateTokens(partitionPrompt(source)) },
    ...batches,
    { label: 'compose', tokens: estimateTokens(composePrompt(source, base)) },
    { label: 'ride', tokens: estimateTokens(ridePrompt(source, base)) },
  ];
}

/** Run `fns` with at most `limit` in flight. */
async function pool<T>(fns: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(fns.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, fns.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= fns.length) return;
      out[i] = await fns[i]();
    }
  }));
  return out;
}

export async function enrichAtlas(source: RepoSource, opts: EnrichOptions = {}): Promise<EnrichResult> {
  const model = opts.model ?? DEFAULT_MODEL;
  const partitionModel = opts.partitionModel ?? model;
  const say = opts.onProgress ?? (() => {});
  const report: Report = { dropped: [], notes: [] };
  const fallbacks: string[] = [];
  const prompts: { label: string; tokens: number }[] = [];
  let usage = noUsage();

  async function cached<T>(label: string, m: string, prompt: string, schema: Parameters<typeof runPass<T>>[0]['schema']) {
    prompts.push({ label, tokens: estimateTokens(prompt) });
    if (opts.useCache !== false) {
      const hit = readCache<T>(m, prompt);
      // A cache hit costs nothing, and zero is a measured figure — not an unknown one.
      if (hit) { say(`  ${label}: cached`); usage = addUsage(usage, { input: 0, output: 0, known: true }); return { value: hit, error: undefined, salvaged: false }; }
    }
    const r = await runPass<T>({ model: m, system: SYSTEM, prompt, schema });
    usage = addUsage(usage, r.usage);
    if (r.value && opts.useCache !== false) writeCache(m, prompt, r.value);
    say(`  ${label}: ${r.value ? (r.salvaged ? 'recovered from raw text' : 'ok') : `failed - ${r.error}`}`);
    return { value: r.value, error: r.error, salvaged: r.salvaged };
  }

  // pass 1 - what are the blocks
  say('pass 1/4 - deciding what the blocks are');
  const base = buildAtlas(source, { maxStructures: opts.maxStructures });
  const p1 = await cached<PartitionOut>('partition', partitionModel, partitionPrompt(source), PartitionOut);

  let partition: Partition | undefined;
  let product: string | undefined;
  if (p1.value) {
    const v = validatePartition(p1.value, source.files, opts.maxStructures ?? 24);
    report.dropped.push(...v.report.dropped);
    report.notes.push(...v.report.notes);
    if (v.partition.units.length >= 2) { partition = v.partition; product = p1.value.product; }
    else fallbacks.push('partition: nothing survived validation');
  } else {
    fallbacks.push(`partition: ${p1.error ?? 'no result'}`);
  }

  let data = partition ? buildAtlas(source, { partition, maxStructures: opts.maxStructures }) : base;
  say(`  ${data.STRUCTURES.length} blocks in ${new Set(data.STRUCTURES.map((s) => s.group)).size} groups`);

  // pass 2 - describe each block
  say('pass 2/4 - describing each block');
  const blocks = blockEvidence(source, data);
  const size = opts.batchSize ?? 6;
  const batches: ReturnType<typeof blockEvidence>[] = [];
  for (let i = 0; i < blocks.length; i += size) batches.push(blocks.slice(i, i + size));

  const results = await pool(
    batches.map((b, i) => () => cached<NarrateOut>(`narrate ${i + 1}/${batches.length}`, model, narratePrompt(b), NarrateOut)),
    opts.concurrency ?? 3,
  );

  const units: NonNullable<Narration['units']> = [];
  for (const r of results) {
    if (r.value) units.push(...(validateNarrate(r.value, data, report) ?? []));
    else fallbacks.push(`narrate: ${r.error ?? 'no result'}`);
  }

  // A block renamed after its code was read goes back into the partition, so the name it is drawn
  // with and the two-letter code derived from that name stay in step.
  if (partition) {
    const nameById = new Map(units.filter((u) => u.name).map((u) => [u.id, u.name!]));
    if (nameById.size) {
      const oldNameById = new Map(data.STRUCTURES.map((s) => [s.id, s.name]));
      const renamed = new Map<string, string>();
      for (const [id, next] of nameById) { const prev = oldNameById.get(id); if (prev && prev !== next) renamed.set(prev, next); }
      if (renamed.size) {
        partition = { ...partition, units: partition.units.map((u) => (renamed.has(u.name) ? { ...u, name: renamed.get(u.name)! } : u)) };
        data = buildAtlas(source, { partition, maxStructures: opts.maxStructures });
      }
    }
  }

  // pass 3 - the overview, the headline numbers, the journey
  say('pass 3/4 - writing the overview and the trace');
  const p3 = await cached<ComposeOut>('compose', model, composePrompt(source, data), ComposeOut);
  let narration: Narration = { units, ...(product ? { product } : {}) };
  let evidence: string[] = [];
  if (p3.value) {
    narration = { ...validateCompose(p3.value, data, report, composeEvidence(source, data)), ...narration };
    evidence = statEvidence(p3.value);
  } else {
    fallbacks.push(`compose: ${p3.error ?? 'no result'}`);
  }

  // pass 4 - the ride, over the composed map: its beats quote the final trace, which compose may have replaced
  say('pass 4/4 - scripting the ride');
  const composed = buildAtlas(source, { partition, narration, maxStructures: opts.maxStructures });
  const p4 = await cached<RideOut>('ride', model, ridePrompt(source, composed), RideOut);
  if (p4.value) {
    const v = validateRide(p4.value, composed, report);
    if (v) narration = { ...narration, ride: v.ride, rideTitle: v.rideTitle };
    else fallbacks.push('ride: nothing survived validation');
  } else {
    fallbacks.push(`ride: ${p4.error ?? 'no result'}`);
  }

  const final = buildAtlas(source, { partition, narration, maxStructures: opts.maxStructures });
  final.provenance = {
    models: { partition: partitionModel, narrate: model, compose: model, ride: model },
    generatedAt: new Date().toISOString(),
    ...(fallbacks.length ? { fallbacks } : {}),
    ...(usage.input || usage.output ? { usage: { input: usage.input, output: usage.output } } : {}),
  };

  return { data: final, usage, report, fallbacks, evidence, prompts };
}

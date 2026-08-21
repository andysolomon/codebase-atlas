/** The browser's half of AI analysis.

    The scan already happens in the browser, so the browser also builds the evidence packs, validates
    what comes back against its own file list, and recomputes the map. The server is asked only to run
    a model over a pack — it never sees the repository, and this file never imports `ai` or `zod`, so
    the bundle stays dependency-free.

    Three small round trips rather than one large one: the second pass cannot be built until the first
    has changed what the blocks are. */

import type { AtlasData } from '../../atlas/types';
import { buildAtlas } from '../build';
import type { Narration, Partition, RepoSource } from '../types';
import { blockEvidence, composeEvidence, repoEvidence } from './evidence';
import type { ComposeOut, NarrateOut, PartitionOut } from './schemas';
import { statEvidence, validateCompose, validateNarrate, validatePartition, type Report } from './validate';

export const ENRICH_ENDPOINT = '/api/enrich';

export interface EnrichClientOptions {
  endpoint?: string;
  batchSize?: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface EnrichClientResult {
  data: AtlasData;
  report: Report;
  fallbacks: string[];
  evidence: string[];
}

/** Roughly one block per eight files, held inside what the map can draw legibly. */
const blockTarget = (files: number) => Math.max(8, Math.min(24, Math.round(files / 8)));

class PassError extends Error {}

async function callPass<T>(endpoint: string, pass: string, evidence: unknown, signal?: AbortSignal): Promise<T> {
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pass, evidence }),
    ...(signal ? { signal } : {}),
  });
  if (!r.ok) throw new PassError(`${r.status} ${(await r.text()).slice(0, 200) || r.statusText}`);
  const body = (await r.json()) as { ok: boolean; value?: T; error?: string };
  if (!body.ok || body.value == null) throw new PassError(body.error || 'the model returned nothing usable');
  return body.value;
}

/** Returns an enriched atlas, or the plain one if the endpoint is not there. Never throws for a
    server that is missing or refusing — a map without written prose is still a map. */
export async function enrichInBrowser(source: RepoSource, opts: EnrichClientOptions = {}): Promise<EnrichClientResult> {
  const endpoint = opts.endpoint ?? ENRICH_ENDPOINT;
  const say = opts.onProgress ?? (() => {});
  const report: Report = { dropped: [], notes: [] };
  const fallbacks: string[] = [];

  let partition: Partition | undefined;
  let product: string | undefined;

  say('reading the repository');
  try {
    const out = await callPass<PartitionOut>(endpoint, 'partition', {
      ...repoEvidence(source), blockTarget: blockTarget(source.files.length),
    }, opts.signal);
    const v = validatePartition(out, source.files);
    report.dropped.push(...v.report.dropped);
    report.notes.push(...v.report.notes);
    if (v.partition.units.length >= 2) { partition = v.partition; product = out.product; }
    else fallbacks.push('partition: nothing survived validation');
  } catch (e) {
    fallbacks.push(`partition: ${(e as Error).message}`);
  }

  let data = buildAtlas(source, partition ? { partition } : {});
  if (!partition) return { data, report, fallbacks, evidence: [] };

  say(`describing ${data.STRUCTURES.length} blocks`);
  const blocks = blockEvidence(source, data);
  const size = opts.batchSize ?? 6;
  const batches: ReturnType<typeof blockEvidence>[] = [];
  for (let i = 0; i < blocks.length; i += size) batches.push(blocks.slice(i, i + size));

  const settled = await Promise.all(batches.map((b) =>
    callPass<NarrateOut>(endpoint, 'narrate', b, opts.signal).catch((e: Error) => e)));

  const units: NonNullable<Narration['units']> = [];
  for (const r of settled) {
    if (r instanceof Error) fallbacks.push(`narrate: ${r.message}`);
    else units.push(...(validateNarrate(r, data, report) ?? []));
  }

  say('writing the overview');
  let narration: Narration = { units, ...(product ? { product } : {}) };
  let evidence: string[] = [];
  try {
    const out = await callPass<ComposeOut>(endpoint, 'compose', composeEvidence(source, data), opts.signal);
    narration = { ...validateCompose(out, data, report), ...narration };
    evidence = statEvidence(out);
  } catch (e) {
    fallbacks.push(`compose: ${(e as Error).message}`);
  }

  data = buildAtlas(source, { partition, narration });
  data.provenance = {
    models: { server: 'set by the enrich endpoint' },
    generatedAt: new Date().toISOString(),
    ...(fallbacks.length ? { fallbacks } : {}),
  };
  return { data, report, fallbacks, evidence };
}

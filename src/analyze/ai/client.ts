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
import { atlasKey, drop, fingerprint, passKey, read, write } from './browser-cache';

export const ENRICH_ENDPOINT = '/api/enrich';

export interface EnrichClientOptions {
  endpoint?: string;
  batchSize?: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  /** Ignore anything cached and ask again — the `--no-cache` of the browser. */
  refresh?: boolean;
  /** Ask the endpoint for its declared fallback model. Costs money, so it is never set by default:
      it is what the person clicks when a run came back rate-limited. Passes already answered by any
      model are reused, so this buys only the holes. */
  useFallback?: boolean;
}

export interface EnrichClientResult {
  data: AtlasData;
  report: Report;
  fallbacks: string[];
  evidence: string[];
  /** True when the whole map came out of the cache and no model was called at all. */
  cached: boolean;
  /** Which models actually wrote this map. Empty when it came from cache without a recorded model. */
  models: string[];
  /** A pass failed because a provider said no, rather than because the answer was unusable. */
  rateLimited: boolean;
  /** The model this deployment would finish the work on, if asked. Empty when it offers none. */
  fallbackModel: string;
}

/** What the endpoint says it would run, asked once per analysis. A GET spends nothing. */
interface ServerModels { model: string; fallback: string; prompts: string }
const NO_SERVER: ServerModels = { model: '', fallback: '', prompts: '' };

async function serverModels(endpoint: string, signal?: AbortSignal): Promise<ServerModels> {
  try {
    const r = await fetch(endpoint, { method: 'GET', ...(signal ? { signal } : {}) });
    if (!r.ok) return NO_SERVER;
    const b = (await r.json()) as Partial<ServerModels>;
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    return { model: str(b.model), fallback: str(b.fallback), prompts: str(b.prompts) };
  } catch {
    return NO_SERVER;   // an older deployment, or none at all
  }
}

/** A provider refusing on quota is not a bad answer — it is the same answer, later. Worth telling
    apart, because it is the one failure a different model can fix. */
const isRefusal = (m: string) => /rate.?limit|free tier|quota|\b429\b|credits?/i.test(m);

interface CachedPass { model: string; value: unknown }
interface CachedAtlas { primary: string; models: string[]; data: AtlasData }

/** Roughly one block per eight files, held inside what the map can draw legibly. */
const blockTarget = (files: number) => Math.max(8, Math.min(24, Math.round(files / 8)));

class PassError extends Error {}

/** The sentence out of a failed reply, rather than the JSON it arrived in. */
async function reason(r: Response): Promise<string> {
  const text = (await r.text()).slice(0, 400);
  try {
    const j = JSON.parse(text) as { error?: unknown };
    if (typeof j.error === 'string' && j.error) return j.error;
  } catch { /* not JSON — an HTML error page, or nothing at all */ }
  return text.trim().slice(0, 200) || r.statusText;
}

/** Which model the endpoint used, as it reported it. Set on the first pass that comes back. */
let servedBy = '';

async function callPass<T>(endpoint: string, pass: string, evidence: unknown, signal?: AbortSignal, fallback?: boolean): Promise<T> {
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pass, evidence, ...(fallback ? { fallback: true } : {}) }),
    ...(signal ? { signal } : {}),
  });
  if (!r.ok) throw new PassError(`${r.status} ${await reason(r)}`);
  const body = (await r.json()) as { ok: boolean; value?: T; error?: string; model?: string };
  if (!body.ok || body.value == null) throw new PassError(body.error || 'the model returned nothing usable');
  if (body.model) servedBy = body.model;
  return body.value;
}

/** Returns an enriched atlas, or the plain one if the endpoint is not there. Never throws for a
    server that is missing or refusing — a map without written prose is still a map. */
export async function enrichInBrowser(source: RepoSource, opts: EnrichClientOptions = {}): Promise<EnrichClientResult> {
  const endpoint = opts.endpoint ?? ENRICH_ENDPOINT;
  const say = opts.onProgress ?? (() => {});
  const report: Report = { dropped: [], notes: [] };
  const fallbacks: string[] = [];
  servedBy = '';

  const models = await serverModels(endpoint, opts.signal);
  const primary = models.model;
  const wanted = opts.useFallback && models.fallback ? models.fallback : primary;
  const fp = fingerprint(source);
  const version = models.prompts || 'unversioned';
  const aKey = atlasKey(fp, version);
  const spent = new Set<string>();
  const usedModels = new Set<string>();
  const base = () => ({ cached: false, models: [...usedModels], rateLimited: fallbacks.some(isRefusal), fallbackModel: models.fallback });

  // Already analysed, unchanged, by the model this deployment still runs: hand it back and call nobody.
  if (!opts.refresh) {
    const hit = read<CachedAtlas>(aKey);
    if (hit?.data && hit.primary === primary) {
      say('already analysed');
      return { data: hit.data, report, fallbacks: [], evidence: [], cached: true, models: hit.models ?? [], rateLimited: false, fallbackModel: models.fallback };
    }
  }

  /** One pass, bought once. A cached answer counts when it came from the model this run wants — or
      from any model at all when the point of this run is to finish work already partly paid for. */
  const pass = async <T>(name: string, evidence: unknown): Promise<T> => {
    const key = passKey(name, evidence, version);
    if (!opts.refresh) {
      const hit = read<CachedPass>(key);
      if (hit && (hit.model === wanted || opts.useFallback)) { spent.add(key); usedModels.add(hit.model); return hit.value as T; }
    }
    const value = await callPass<T>(endpoint, name, evidence, opts.signal, opts.useFallback);
    write(key, { model: servedBy || wanted, value } satisfies CachedPass);
    spent.add(key);
    usedModels.add(servedBy || wanted);
    return value;
  };

  let partition: Partition | undefined;
  let product: string | undefined;

  say('reading the repository');
  try {
    const out = await pass<PartitionOut>('partition', {
      ...repoEvidence(source), blockTarget: blockTarget(source.files.length),
    });
    const v = validatePartition(out, source.files);
    report.dropped.push(...v.report.dropped);
    report.notes.push(...v.report.notes);
    if (v.partition.units.length >= 2) { partition = v.partition; product = out.product; }
    else fallbacks.push('partition: nothing survived validation');
  } catch (e) {
    fallbacks.push(`partition: ${(e as Error).message}`);
  }

  let data = buildAtlas(source, partition ? { partition } : {});
  if (!partition) return { data, report, fallbacks, evidence: [], ...base() };

  say(`describing ${data.STRUCTURES.length} blocks`);
  const blocks = blockEvidence(source, data);
  const size = opts.batchSize ?? 6;
  const batches: ReturnType<typeof blockEvidence>[] = [];
  for (let i = 0; i < blocks.length; i += size) batches.push(blocks.slice(i, i + size));

  const settled = await Promise.all(batches.map((b) =>
    pass<NarrateOut>('narrate', b).catch((e: Error) => e)));

  const units: NonNullable<Narration['units']> = [];
  for (const r of settled) {
    if (r instanceof Error) fallbacks.push(`narrate: ${r.message}`);
    else units.push(...(validateNarrate(r, data, report) ?? []));
  }

  say('writing the overview');
  let narration: Narration = { units, ...(product ? { product } : {}) };
  let evidence: string[] = [];
  try {
    const packed = composeEvidence(source, data);
    const out = await pass<ComposeOut>('compose', packed);
    narration = { ...validateCompose(out, data, report, packed), ...narration };
    evidence = statEvidence(out);
  } catch (e) {
    fallbacks.push(`compose: ${(e as Error).message}`);
  }

  data = buildAtlas(source, { partition, narration });
  data.provenance = {
    models: { server: [...usedModels].join(' + ') || servedBy || 'set by the enrich endpoint' },
    generatedAt: new Date().toISOString(),
    ...(fallbacks.length ? { fallbacks } : {}),
  };

  // A map with no holes in it collapses to one entry and its passes are released. A map with holes
  // keeps its passes instead, so the next attempt — on this model or the fallback — buys only the
  // holes, and is not cached whole: it is not the finished thing.
  if (!fallbacks.length) {
    write(aKey, { primary, models: [...usedModels], data } satisfies CachedAtlas);
    spent.forEach(drop);
  }
  return { data, report, fallbacks, evidence, ...base() };
}

/** Run one AI pass over an evidence pack the browser built. Vercel Function, Node runtime.

    This endpoint spends money on behalf of anyone who loads the page, so the shape of the request is
    the main defence: it accepts only a known pass name and a pack of named string fields, and it
    returns only the object that pass is defined to return. There is no free-text field and no way to
    choose the model, so it cannot be used as a general-purpose LLM proxy.

    Rate limiting belongs in front of this, as a Vercel Firewall rule on /api/enrich — no code, no
    storage, and it survives the function being cold. */

import { createHash } from 'node:crypto';
import { buildComposePrompt, buildNarratePrompt, buildPartitionPrompt } from '../src/analyze/ai/index.js';
import { COMPOSE, NARRATE, PARTITION, SYSTEM } from '../src/analyze/ai/prompts.js';
import { credentialStatus, runPass } from '../src/analyze/ai/provider.js';
import { ComposeOut, NarrateOut, PartitionOut } from '../src/analyze/ai/schemas.js';

/** The client may not choose the model — that is how a public endpoint stays affordable. It is told
    which one ran, though: a card written by a cheap model should be read as one. */
const MODEL = process.env.ATLAS_ENRICH_MODEL || 'minimax/minimax-m3';

/** The one other model a caller may ask for, by name-less boolean. It exists because the AI Gateway's
    free tier will not carry a whole atlas: half the passes come back rate-limited and the map is left
    with holes. Rather than fail, the browser can offer to finish the work somewhere else — and since
    that spends money, it offers rather than decides.

    Still not a model parameter. `fallback: true` selects between two models this deployment chose;
    an arbitrary model id remains unreachable from the client. Set it empty to withdraw the offer. */
const FALLBACK_MODEL = process.env.ATLAS_ENRICH_FALLBACK_MODEL ?? 'minimax-direct/MiniMax-M3';

/** Whether the credentials that model needs are actually here. Offering a fallback that cannot run
    is worse than offering none. */
function ready(model: string): boolean {
  if (!model) return false;
  const creds = credentialStatus();
  return model.startsWith('minimax-direct/') ? creds.minimaxDirect : creds.gateway;
}

/** What the instructions currently say, in eight characters. The browser mixes this into its cache
    keys: it builds the evidence but never sees the prompt, so without it, editing prompts.ts would
    keep serving answers written to the old ones. */
const PROMPTS_VERSION = createHash('sha256').update([SYSTEM, PARTITION, NARRATE, COMPOSE].join('\u0000')).digest('hex').slice(0, 8);

const MAX_BODY = 768 * 1024;
const MAX_BLOCKS_PER_CALL = 8;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

const str = (v: unknown, max = 60_000) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Keep only the fields each pack is defined to have, at the sizes they are allowed to be. Anything
    else a caller sends is dropped here rather than forwarded to a model. */
function cleanPartition(e: Record<string, unknown>) {
  return {
    name: str(e.name, 200), ref: str(e.ref, 100),
    fileCount: typeof e.fileCount === 'number' ? Math.max(0, Math.min(100_000, e.fileCount)) : 0,
    blockTarget: typeof e.blockTarget === 'number' ? Math.max(4, Math.min(24, e.blockTarget)) : undefined,
    readme: str(e.readme, 8_000), manifests: str(e.manifests, 20_000),
    symbols: str(e.symbols, 30_000), tree: str(e.tree, 120_000),
    entryPoints: Array.isArray(e.entryPoints) ? e.entryPoints.slice(0, 12).map((x) => str(x, 300)) : [],
  };
}

function cleanBlocks(list: unknown) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_BLOCKS_PER_CALL).map((b: Record<string, unknown>) => ({
    id: str(b.id, 80), name: str(b.name, 120), group: str(b.group, 80), loc: str(b.loc, 80),
    files: str(b.files, 6_000), symbols: str(b.symbols, 6_000),
    excerpts: str(b.excerpts, 20_000), links: str(b.links, 6_000),
  }));
}

function cleanCompose(e: Record<string, unknown>) {
  return {
    name: str(e.name, 200), ref: str(e.ref, 100), product: str(e.product, 120),
    facts: str(e.facts, 4_000), blocks: str(e.blocks, 40_000),
    edges: str(e.edges, 20_000), externals: str(e.externals, 4_000),
  };
}

export default async function handler(req: Request): Promise<Response> {
  // Which models would run, without running one. The browser records the primary against its cached
  // maps, so switching ATLAS_ENRICH_MODEL misses cleanly instead of serving the cheap model's answers
  // for ever — and it needs to know whether a fallback is worth offering before it offers it.
  if (req.method === 'GET') {
    const fallback = FALLBACK_MODEL !== MODEL && ready(FALLBACK_MODEL) ? FALLBACK_MODEL : '';
    return new Response(JSON.stringify({ ok: true, model: MODEL, fallback, prompts: PROMPTS_VERSION }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' },
    });
  }
  if (req.method !== 'POST') return json(405, { ok: false, error: 'GET or POST only' });

  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > MAX_BODY) return json(413, { ok: false, error: 'evidence pack too large' });

  let body: { pass?: string; evidence?: unknown; fallback?: unknown };
  try {
    const text = await req.text();
    if (text.length > MAX_BODY) return json(413, { ok: false, error: 'evidence pack too large' });
    body = JSON.parse(text);
  } catch {
    return json(400, { ok: false, error: 'body was not JSON' });
  }

  const evidence = (body.evidence ?? {}) as Record<string, unknown>;
  // A boolean, deliberately: it picks one of this deployment's two models and cannot name a third.
  const wanted = body.fallback === true && FALLBACK_MODEL && ready(FALLBACK_MODEL) ? FALLBACK_MODEL : MODEL;
  try {
    switch (body.pass) {
      case 'partition': {
        const r = await runPass({ model: wanted, system: SYSTEM, schema: PartitionOut, prompt: buildPartitionPrompt(cleanPartition(evidence)) });
        return json(r.value ? 200 : 502, r.value ? { ok: true, value: r.value, model: wanted } : { ok: false, error: r.error });
      }
      case 'narrate': {
        const blocks = cleanBlocks(body.evidence);
        if (!blocks.length) return json(400, { ok: false, error: 'no blocks given' });
        const r = await runPass({ model: wanted, system: SYSTEM, schema: NarrateOut, prompt: buildNarratePrompt(blocks) });
        return json(r.value ? 200 : 502, r.value ? { ok: true, value: r.value, model: wanted } : { ok: false, error: r.error });
      }
      case 'compose': {
        const r = await runPass({ model: wanted, system: SYSTEM, schema: ComposeOut, prompt: buildComposePrompt(cleanCompose(evidence)) });
        return json(r.value ? 200 : 502, r.value ? { ok: true, value: r.value, model: wanted } : { ok: false, error: r.error });
      }
      default:
        return json(400, { ok: false, error: 'unknown pass' });
    }
  } catch (e) {
    // Never echo a provider error verbatim — it can carry key fragments and endpoint detail.
    console.error('enrich failed', e);
    return json(502, { ok: false, error: 'the enrichment service could not complete this pass' });
  }
}

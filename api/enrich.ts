/** Run one AI pass over an evidence pack the browser built. Vercel Function, Node runtime.

    This endpoint spends money on behalf of anyone who loads the page, so the shape of the request is
    the main defence: it accepts only a known pass name and a pack of named string fields, and it
    returns only the object that pass is defined to return. There is no free-text field and no way to
    choose the model, so it cannot be used as a general-purpose LLM proxy.

    Rate limiting belongs in front of this, as a Vercel Firewall rule on /api/enrich — no code, no
    storage, and it survives the function being cold. */

import { buildComposePrompt, buildNarratePrompt, buildPartitionPrompt } from '../src/analyze/ai/index';
import { SYSTEM } from '../src/analyze/ai/prompts';
import { runPass } from '../src/analyze/ai/provider';
import { ComposeOut, NarrateOut, PartitionOut } from '../src/analyze/ai/schemas';

/** The client may not choose the model — that is how a public endpoint stays affordable. */
const MODEL = process.env.ATLAS_ENRICH_MODEL || 'minimax/minimax-m3';

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
  if (req.method !== 'POST') return json(405, { ok: false, error: 'POST only' });

  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > MAX_BODY) return json(413, { ok: false, error: 'evidence pack too large' });

  let body: { pass?: string; evidence?: unknown };
  try {
    const text = await req.text();
    if (text.length > MAX_BODY) return json(413, { ok: false, error: 'evidence pack too large' });
    body = JSON.parse(text);
  } catch {
    return json(400, { ok: false, error: 'body was not JSON' });
  }

  const evidence = (body.evidence ?? {}) as Record<string, unknown>;
  try {
    switch (body.pass) {
      case 'partition': {
        const r = await runPass({ model: MODEL, system: SYSTEM, schema: PartitionOut, prompt: buildPartitionPrompt(cleanPartition(evidence)) });
        return json(r.value ? 200 : 502, r.value ? { ok: true, value: r.value } : { ok: false, error: r.error });
      }
      case 'narrate': {
        const blocks = cleanBlocks(body.evidence);
        if (!blocks.length) return json(400, { ok: false, error: 'no blocks given' });
        const r = await runPass({ model: MODEL, system: SYSTEM, schema: NarrateOut, prompt: buildNarratePrompt(blocks) });
        return json(r.value ? 200 : 502, r.value ? { ok: true, value: r.value } : { ok: false, error: r.error });
      }
      case 'compose': {
        const r = await runPass({ model: MODEL, system: SYSTEM, schema: ComposeOut, prompt: buildComposePrompt(cleanCompose(evidence)) });
        return json(r.value ? 200 : 502, r.value ? { ok: true, value: r.value } : { ok: false, error: r.error });
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

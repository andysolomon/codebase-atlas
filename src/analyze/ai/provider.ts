/** Reaching a model, and coming back with something the atlas can use — or nothing at all.

    Server-side only. Nothing under `src/` that the browser bundles may import this file. */

import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText, NoObjectGeneratedError, Output, type LanguageModel } from 'ai';
import { z } from 'zod';
import { salvageCandidates } from './salvage.js';

/** Cheap by default. Every pass can be pointed somewhere better. */
export const DEFAULT_MODEL = 'minimax/minimax-m3';

const MINIMAX_DIRECT = /^minimax-direct\//;

/** Tokens actually spent. `known` means every pass reported its usage; when it is false the figures
    are a LOWER BOUND — some pass spent tokens it did not account for. A lower bound is worth printing;
    silence is not, and a fabricated zero is worse than either. */
export interface Usage { input: number; output: number; known: boolean }
export const noUsage = (): Usage => ({ input: 0, output: 0, known: false });
export const addUsage = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input, output: a.output + b.output, known: a.known && b.known,
});

export interface PassOutcome<T> {
  value: T | null;
  usage: Usage;
  model: string;
  /** Set when the schema call failed and the object was recovered from raw text. */
  salvaged?: boolean;
  /** Set when the pass produced nothing. The caller falls back to templated prose. */
  error?: string;
  /** True when retrying the same model is pointless (bad credentials, unknown model). */
  terminal?: boolean;
}

/** Which credentials are present, for an error message worth reading. */
export function credentialStatus(env: Record<string, string | undefined> = process.env) {
  return {
    gateway: !!(env.AI_GATEWAY_API_KEY || env.VERCEL_OIDC_TOKEN),
    minimaxDirect: !!env.MINIMAX_API_KEY,
  };
}

/** `provider/model` goes through the AI Gateway. `minimax-direct/<id>` goes straight to MiniMax's
    Anthropic-compatible endpoint, which needs only MINIMAX_API_KEY — useful before a Gateway key exists. */
export function resolveModel(spec: string, env: Record<string, string | undefined> = process.env): LanguageModel {
  if (MINIMAX_DIRECT.test(spec)) {
    const key = env.MINIMAX_API_KEY;
    if (!key) throw new Error('MINIMAX_API_KEY is not set, and the model was asked for directly from MiniMax.');
    const anthropic = createAnthropic({ baseURL: env.MINIMAX_BASE_URL || 'https://api.minimax.io/anthropic/v1', apiKey: key });
    return anthropic(spec.replace(MINIMAX_DIRECT, ''));
  }
  // The Gateway is the AI SDK's default global provider, so a bare model string resolves to it.
  return spec;
}

const usageOf = (u: { inputTokens?: number; outputTokens?: number } | undefined): Usage =>
  u && (u.inputTokens != null || u.outputTokens != null)
    ? { input: u.inputTokens ?? 0, output: u.outputTokens ?? 0, known: true }
    : noUsage();

/** Bad credentials and unknown models will fail the same way every time — say so rather than retrying. */
function isTerminal(message: string): boolean {
  return /\b(401|403|invalid[_ -]?api[_ -]?key|unauthorized|authentication|not set)\b/i.test(message)
    || /\b(unknown model|model not (?:found|available)|no such model|404)\b/i.test(message);
}

/** A second ask, when the first came back in the wrong shape. Cheap models drift into prose or wrap
    the object in a code fence; saying so plainly usually fixes it. */
const REPAIR = '\n\nReturn ONLY the JSON object, matching the schema exactly. No explanation before or after it.';

/** One schema-validated call, with one repair attempt and a salvage pass behind it. Returns
    `value: null` rather than throwing — a failed pass degrades that part of the atlas to templated
    prose, it never fails the build. */
export async function runPass<T>(opts: {
  model: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  maxRetries?: number;
  maxOutputTokens?: number;
  /** Repair attempts left. Internal. */
  attempt?: number;
}): Promise<PassOutcome<T>> {
  const { model: spec, system, prompt, schema } = opts;
  const attempt = opts.attempt ?? 0;
  try {
    const model = resolveModel(spec);
    if (attempt >= 2) {
      // Text mode drops the SDK's structured-output machinery, which is also the only thing that was
      // telling the model what the keys are called. Without the schema spelled out here it invents
      // its own field names from the prose and every answer fails validation.
      const r = await generateText({
        model, system,
        prompt: `${prompt}\n\nReturn a JSON object matching this JSON Schema exactly, using these exact\nproperty names and nothing else:\n\n${JSON.stringify(z.toJSONSchema(schema as z.ZodType), null, 1)}`,
        maxRetries: opts.maxRetries ?? 2,
        maxOutputTokens: opts.maxOutputTokens ?? 16000,
      });
      for (const candidate of salvageCandidates(r.text).reverse()) {
        const parsed = schema.safeParse(candidate);
        if (parsed.success) return { value: parsed.data, usage: usageOf(r.usage), model: spec, salvaged: true };
      }
      return { value: null, usage: usageOf(r.usage), model: spec, error: 'no valid object in the text response' };
    }
    const r = await generateText({
      model, system, prompt,
      output: Output.object({ schema }),
      maxRetries: opts.maxRetries ?? 2,
      // Always explicit: the SDK silently clamps an unrecognised model to 4096, which truncates a
      // partition or an overview mid-JSON and looks like the model failing to follow the schema.
      maxOutputTokens: opts.maxOutputTokens ?? 16000,
    });
    return { value: r.output as T, usage: usageOf(r.usage), model: spec };
  } catch (e) {
    // The model answered but not in the shape asked for — the text may still hold the object.
    if (NoObjectGeneratedError.isInstance(e) && typeof e.text === 'string') {
      for (const candidate of salvageCandidates(e.text).reverse()) {
        const parsed = schema.safeParse(candidate);
        if (parsed.success) return { value: parsed.data, usage: usageOf(e.usage), model: spec, salvaged: true };
      }
    }
    if (process.env.ATLAS_DEBUG && NoObjectGeneratedError.isInstance(e) && e.text) {
      try {
        const { mkdirSync, writeFileSync } = await import('node:fs');
        mkdirSync('.atlas-cache', { recursive: true });
        const at = `.atlas-cache/failed-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`;
        writeFileSync(at, e.text);
        process.stderr.write(`  raw response kept at ${at}\n`);
      } catch { /* debugging must never break the run */ }
    }
    let message = String((e as Error)?.message || e).split('\n')[0].slice(0, 300);
    // The Gateway's free-tier message is long, repeats per failed call, and buries the one thing
    // worth knowing: this is a quota, not a bad prompt.
    if (/rate.?limit|free tier/i.test(message)) {
      // The free tier's allowance does not stretch to a whole atlas even one call at a time, so
      // point at credits rather than at concurrency.
      message = /free tier/i.test(message)
        ? 'the AI Gateway free tier is rate limited - add credits, or use --model minimax-direct/MiniMax-M3'
        : 'rate limited by the provider - try --concurrency 1';
    }
    const terminal = isTerminal(message);
    // Shape failures are worth one more ask; credential and model failures are not.
    if (!terminal && attempt < 2) {
      const again = await runPass<T>({ ...opts, prompt: prompt + REPAIR, attempt: attempt + 1 });
      return again.value ? { ...again, salvaged: true } : { ...again, error: again.error ?? message };
    }
    return { value: null, usage: noUsage(), model: spec, error: message, terminal };
  }
}

/** A content-addressed cache, so iterating on a prompt does not re-buy the same answer.

    Server-side only. Keyed on the model and the exact prompt text, so any change to either misses
    cleanly rather than serving a stale answer. */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CACHE_DIR = process.env.ATLAS_CACHE_DIR || '.atlas-cache';

const key = (model: string, prompt: string) =>
  createHash('sha256').update(model).update(' ').update(prompt).digest('hex').slice(0, 32);

export function readCache<T>(model: string, prompt: string): T | null {
  try {
    return JSON.parse(readFileSync(join(CACHE_DIR, `${key(model, prompt)}.json`), 'utf8')) as T;
  } catch {
    return null;
  }
}

export function writeCache(model: string, prompt: string, value: unknown): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(join(CACHE_DIR, `${key(model, prompt)}.json`), JSON.stringify(value));
  } catch { /* a cache that cannot be written is not worth failing a build over */ }
}

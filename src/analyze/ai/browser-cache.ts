/** What the browser has already paid a model for.

    Two layers, because there are two ways to waste money. Opening a repository that has been analysed
    before should cost nothing at all — that is the atlas layer, keyed by a fingerprint of the scan.
    And a run that was cut short (a rate limit, a dropped connection) should only re-ask the passes
    that failed — that is the pass layer, keyed by the evidence pack, which is what the CLI's
    `.atlas-cache` does for `bun run atlas --ai`. Finishing a rate-limited atlas on a fallback model
    therefore buys only the passes that never landed.

    A complete run collapses into a single atlas entry and its pass entries are dropped; an incomplete
    one keeps its pass entries and writes no atlas entry, so the next attempt finishes the map instead
    of buying it again. Every entry records which model wrote it, so pointing the endpoint at a better
    one misses cleanly rather than serving the cheap answer for ever.

    localStorage rather than IndexedDB: a few maps, synchronous reads, and no schema to migrate. */

import type { RepoFile, RepoSource } from '../types';

const PREFIX = 'codebase-atlas:ai:';
/** Roughly what a 5 MB origin quota leaves for maps, once everything else has its share. */
const BUDGET = 3_500_000;

/** FNV-1a, twice, with different mixing — 12-odd characters of key, no async and no secure context.
    A collision would serve the wrong map; at this scale that is not a risk worth paying async for. */
function hash(text: string): string {
  let a = 0x811c9dc5, b = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x85ebca6b); b ^= b >>> 13;
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}

/** What makes this scan *this* scan: where it came from, and every path and size in it. A file added,
    removed or edited moves the fingerprint, so the map is re-analysed; re-opening an unchanged
    repository is free. */
export function fingerprint(source: RepoSource): string {
  const files = source.files.map((f: RepoFile) => `${f.path}:${f.size}`).sort();
  return hash(`${source.name}@${source.ref}|${files.length}|${files.join('\n')}`);
}

/** The model is recorded in the value rather than the key, so a run that finishes on a fallback model
    can still reuse the passes the primary model already answered. Which entries that makes eligible
    is the caller's decision — see `client.ts`.

    `version` is what the instructions currently say. The browser builds the evidence but never sees
    the prompt, so without it in the key, rewriting a prompt would keep serving answers written to the
    old one. */
export const atlasKey = (fp: string, version: string) => `atlas:${version}:${fp}`;
export const passKey = (pass: string, evidence: unknown, version: string) =>
  `pass:${version}:${pass}:${hash(JSON.stringify(evidence))}`;

interface Stored { t: number; v: unknown }

export function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const s = JSON.parse(raw) as Stored;
    // Touch it, so the least useful entry is the one evicted rather than the oldest written.
    localStorage.setItem(PREFIX + key, JSON.stringify({ t: Date.now(), v: s.v }));
    return s.v as T;
  } catch {
    return null;   // private mode, or an entry from an older shape
  }
}

export function write(key: string, value: unknown): void {
  let payload: string;
  try {
    payload = JSON.stringify({ t: Date.now(), v: value } satisfies Stored);
  } catch { return; }
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      if (used() + payload.length > BUDGET && !evictOldest()) return;
      localStorage.setItem(PREFIX + key, payload);
      return;
    } catch {
      // A quota error can arrive before our own budget says so — other things share this origin.
      if (!evictOldest()) return;
    }
  }
}

export function drop(key: string): void {
  try { localStorage.removeItem(PREFIX + key); } catch { /* nothing to do about it */ }
}

/** Every cached answer, forgotten. */
export function clear(): void {
  for (const k of ours()) { try { localStorage.removeItem(k); } catch { /* keep going */ } }
}

function ours(): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) keys.push(k);
    }
  } catch { /* no storage at all */ }
  return keys;
}

function used(): number {
  let n = 0;
  for (const k of ours()) n += (localStorage.getItem(k)?.length ?? 0) + k.length;
  return n;
}

/** Returns false when there was nothing left to evict — the caller must then give up rather than loop. */
function evictOldest(): boolean {
  let oldest: string | null = null, at = Infinity;
  for (const k of ours()) {
    try {
      const t = (JSON.parse(localStorage.getItem(k) || '{}') as Stored).t ?? 0;
      if (t < at) { at = t; oldest = k; }
    } catch {
      oldest = k; at = -1;   // unreadable: the best possible thing to throw away
      break;
    }
  }
  if (!oldest) return false;
  try { localStorage.removeItem(oldest); } catch { return false; }
  return true;
}

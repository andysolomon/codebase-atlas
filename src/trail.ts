/** The repositories opened this session, in the order they were opened.

    Two jobs. Stepping back is instant and free: the built map — including any AI analysis paid for —
    is kept with the entry, so ◀ redraws rather than rescanning, and a local folder can be returned
    to without the picker. And what is *reopenable* (a GitHub repo, an atlas URL) is written to
    localStorage, so the field still suggests them after a reload.

    Browser-history semantics: opening something new from partway back drops what was ahead. */

import type { AtlasData } from './atlas/types';
import type { RepoSource } from './analyze';

export type TrailKind = 'demo' | 'github' | 'atlas' | 'local';

export interface TrailEntry {
  kind: TrailKind;
  /** What the ◀ ▶ tooltips call it. */
  label: string;
  /** What would reopen it by typing. Absent for a local folder — a path is not a handle. */
  query?: string;
  /** The map as last seen. Kept so stepping back costs nothing and keeps the analysis. */
  data?: AtlasData;
  /** The scan behind it, so ANALYZE still works after stepping back. */
  source?: RepoSource;
}

const KEY = 'codebase-atlas:recent';
const MAX = 12;

export const entries: TrailEntry[] = [];
export let index = -1;

const keyOf = (e: TrailEntry) => `${e.kind}:${e.query ?? e.label}`;

/** Reopenable entries only. A local folder cannot be restored from a string, and the demo is always
    one click away, so neither is worth a slot. */
function persist() {
  try {
    const keep = entries.filter((e) => e.query && (e.kind === 'github' || e.kind === 'atlas'))
      .map((e) => ({ kind: e.kind, label: e.label, query: e.query }));
    localStorage.setItem(KEY, JSON.stringify(keep.slice(-MAX)));
  } catch { /* private mode, a full quota — history is a convenience, never a requirement */ }
}

/** Seed the trail from the last session. These entries carry no map: choosing one rescans. */
export function restore() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]') as TrailEntry[];
    for (const e of raw) {
      if (!e || (e.kind !== 'github' && e.kind !== 'atlas') || typeof e.query !== 'string') continue;
      if (!entries.some((x) => keyOf(x) === keyOf(e))) entries.push({ kind: e.kind, label: String(e.label || e.query), query: e.query });
    }
    // Start at the end of last session's history, so this session's first repository is appended to
    // it rather than truncating it — `record` drops whatever sits ahead of where we are.
    index = entries.length - 1;
  } catch { /* unreadable history is no history */ }
}

/** Land on a repository. Anything ahead of where we are is dropped, and an earlier visit to the same
    place is folded into this one rather than left as a stale duplicate. */
export function record(entry: TrailEntry) {
  const here = entries[index];
  if (here && keyOf(here) === keyOf(entry)) { Object.assign(here, entry); persist(); return; }
  entries.splice(index + 1);
  const dup = entries.findIndex((e) => keyOf(e) === keyOf(entry));
  if (dup >= 0) entries.splice(dup, 1);
  entries.push(entry);
  while (entries.length > MAX) entries.shift();
  index = entries.length - 1;
  persist();
}

/** Keep the current entry in step as its map changes under it — an analysis finishing, mostly. */
export function update(patch: Partial<TrailEntry>) {
  if (entries[index]) Object.assign(entries[index], patch);
}

/** Move to an entry without recording a new one. Returns it, or undefined if the index is off the end. */
export function moveTo(i: number): TrailEntry | undefined {
  if (i < 0 || i >= entries.length) return undefined;
  index = i;
  return entries[i];
}

export const current = (): TrailEntry | undefined => entries[index];

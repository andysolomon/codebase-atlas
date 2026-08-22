/** Inputs to the analyzer. A source is just a flat list of files; where they came from is irrelevant. */

import type { RideBeat } from '../atlas/types.js';

export interface RepoFile {
  /** Path relative to the repo root, forward slashes, no leading "./". */
  path: string;
  /** Size in bytes. */
  size: number;
  /** Text content, when the source chose to load it (code files only). */
  content?: string;
}

export interface RepoSource {
  /** Display name, e.g. "owner/name" or a folder name. */
  name: string;
  /** Branch / ref label shown next to the name. */
  ref: string;
  files: RepoFile[];
  /** Optional human-readable note on how the scan was produced. */
  note?: string;
}

export interface ScanProgress {
  phase: 'tree' | 'content' | 'build';
  done: number;
  total: number;
  message?: string;
}
export type OnProgress = (p: ScanProgress) => void;

/** One block of the map: which files it holds, what it is called, which group it sits in. */
export interface UnitSpec {
  /** Stable key. `dirPartition` uses the folder path; an AI partition uses a slug. */
  key: string;
  name: string;
  group: string;
  /** Exact file paths, or folder prefixes ending in `/`. `''` is the catch-all. */
  paths: string[];
  /** Two-letter code drawn on the block. Derived from the name when absent. */
  code?: string;
  /** Draw flat — storage and records rather than logic. */
  slab?: boolean;
  /** The folder this block lives in. Derived from `paths` when absent. */
  dir?: string;
}

/** A complete assignment of a repository's files to blocks. */
export interface Partition {
  /** Group names in the order they should be laid out, top to bottom. */
  groups?: string[];
  units: UnitSpec[];
}

/** Prose written about a block. Every field is optional — missing ones keep the templated text. */
export interface UnitNarration {
  id: string;
  name?: string;
  what?: string;
  how?: string;
  /** Keyed by file path, so a child can be described without pinning its order. */
  children?: Record<string, string>;
}

/** The prose overlay applied after the scan has fixed every number. */
export interface Narration {
  product?: string;
  overviewTitle?: string;
  overviewKicker?: string;
  overviewSub?: string;
  OVERVIEW_WHAT?: string[];
  OVERVIEW_HOW?: string[];
  HOW_TO_READ?: string;
  traceTitle?: string;
  stats?: [string, string][];
  /** Trace steps as block id + sentence. May revisit a block. */
  trace?: [string, string][];
  /** Edge payload labels, keyed `"from→to"`. */
  edgeLabels?: Record<string, string>;
  units?: UnitNarration[];
  /** The ride, in order. Every beat names something the map has drawn. */
  ride?: RideBeat[];
  rideTitle?: string;
}

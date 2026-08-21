/** Inputs to the analyzer. A source is just a flat list of files; where they came from is irrelevant. */

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

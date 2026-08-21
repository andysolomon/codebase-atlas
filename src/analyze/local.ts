/** Loads a folder on this machine as a RepoSource, entirely in the browser.

    Two ways in, because only Chromium has the good one:

      - `showDirectoryPicker()` — a real directory handle. Ignored folders are never descended into,
        so `node_modules` costs nothing.
      - `<input type="file" webkitdirectory>` — everywhere else. The browser enumerates the whole
        tree up front and we filter afterwards, which is slower but works in Safari and Firefox.

    Either way the files stay in the tab. Nothing is uploaded: the scan runs here, and AI analysis
    sends only the evidence packs the browser builds. */

import { CONTEXT_FILE, IGNORED_DIRS, isCode, isIgnoredPath } from './ignore';
import type { OnProgress, RepoFile, RepoSource } from './types';

export interface LocalOptions {
  /** Max code files whose content is read for import analysis. Default 400. */
  maxContentFiles?: number;
  /** Skip content for files larger than this (bytes). Default 300 KB. */
  maxFileBytes?: number;
  /** Stop walking after this many entries, so a home directory cannot hang the tab. Default 60000. */
  maxEntries?: number;
  onProgress?: OnProgress;
}

const MANIFEST = /(^|\/)(package\.json|requirements[\w.-]*\.txt|pyproject\.toml|go\.mod|Cargo\.toml|Gemfile|composer\.json)$/;

/** True when this browser can open a folder without copying it through an input element. */
export const supportsDirectoryPicker = () =>
  typeof window !== 'undefined' && typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';

/** True when this browser can open a folder at all. */
export const supportsLocalRepos = () =>
  supportsDirectoryPicker() || (typeof document !== 'undefined' && 'webkitdirectory' in document.createElement('input'));

/** A file the walk found, paired with the lazy read that gets its bytes. */
interface Found { path: string; size: number; read: () => Promise<string> }

/** The whole flow: ask for a folder, walk it, read what is worth reading. `null` means the person
    closed the picker — a cancel is not an error and should leave the current map alone. */
export async function openLocalRepo(opts: LocalOptions = {}): Promise<RepoSource | null> {
  const found = supportsDirectoryPicker() ? await viaDirectoryPicker(opts) : await viaInput(opts);
  return found && buildSource(found.name, found.files, opts);
}

// ── picking ──

async function viaDirectoryPicker(opts: LocalOptions): Promise<{ name: string; files: Found[] } | null> {
  type Picker = (o?: { mode?: 'read' | 'readwrite'; id?: string }) => Promise<FileSystemDirectoryHandle>;
  const pick = (window as unknown as { showDirectoryPicker: Picker }).showDirectoryPicker;
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await pick({ mode: 'read', id: 'codebase-atlas' });
  } catch (e) {
    // AbortError is the person closing the dialog. Anything else is worth surfacing.
    if ((e as DOMException)?.name === 'AbortError') return null;
    throw e;
  }
  const files: Found[] = [];
  const max = opts.maxEntries ?? 60_000;
  await walk(dir, '', files, max, opts.onProgress);
  return { name: dir.name || 'folder', files };
}

async function walk(dir: FileSystemDirectoryHandle, prefix: string, out: Found[], max: number, say?: OnProgress) {
  // `entries()` is on the handle at runtime but not in every lib.dom, so it is reached structurally.
  const entries = (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries();
  for await (const [name, handle] of entries) {
    if (out.length >= max) return;
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'directory') {
      if (IGNORED_DIRS.has(name)) continue;
      await walk(handle as FileSystemDirectoryHandle, path, out, max, say);
      continue;
    }
    if (isIgnoredPath(path)) continue;
    const fh = handle as FileSystemFileHandle;
    const file = await fh.getFile();
    out.push({ path, size: file.size, read: () => file.text() });
    if (out.length % 250 === 0) say?.({ phase: 'tree', done: out.length, total: 0, message: `${out.length} files` });
  }
}

async function viaInput(opts: LocalOptions): Promise<{ name: string; files: Found[] } | null> {
  const picked = await promptForDirectoryInput();
  if (!picked || !picked.length) return null;
  // Every path from a directory input is prefixed with the chosen folder's own name; the atlas wants
  // paths relative to the repo root, so that first segment is the repo name and then it goes.
  const rootName = (picked[0].webkitRelativePath || picked[0].name).split('/')[0] || 'folder';
  const files: Found[] = [];
  const max = opts.maxEntries ?? 60_000;
  for (const f of picked) {
    if (files.length >= max) break;
    const rel = (f.webkitRelativePath || f.name).split('/').slice(1).join('/');
    if (!rel || isIgnoredPath(rel)) continue;
    files.push({ path: rel, size: f.size, read: () => f.text() });
  }
  opts.onProgress?.({ phase: 'tree', done: files.length, total: files.length, message: `${files.length} files` });
  return { name: rootName, files };
}

function promptForDirectoryInput(): Promise<File[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.style.cssText = 'position:fixed;left:-9999px';
    // Non-standard, but it is the only directory upload Safari and Firefox have.
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
    input.multiple = true;
    const done = (v: File[] | null) => { input.remove(); resolve(v); };
    input.onchange = () => done(input.files ? Array.from(input.files) : null);
    // A cancelled file dialog fires nothing at all in older browsers; `cancel` covers the rest.
    input.oncancel = () => done(null);
    document.body.appendChild(input);
    input.click();
  });
}

// ── reading ──

/** Same content budget as the GitHub loader: manifests and prose first, then the biggest, shallowest
    code files, so the evidence packs describe the repository rather than its leaves. */
async function buildSource(name: string, found: Found[], opts: LocalOptions): Promise<RepoSource> {
  const files: RepoFile[] = found.map((f) => ({ path: f.path, size: f.size }));
  const byPath = new Map(found.map((f) => [f.path, f]));
  const maxBytes = opts.maxFileBytes ?? 300 * 1024;

  const want = files.filter((x) => (MANIFEST.test(x.path) || CONTEXT_FILE.test(x.path) || isCode(x.path)) && x.size <= maxBytes && x.size > 0);
  const score = (x: RepoFile) => (MANIFEST.test(x.path) ? 1e12 : 0) + (CONTEXT_FILE.test(x.path) ? 5e11 : 0) + (/(^|\/)(index|main|app|server)\./.test(x.path) ? 1e9 : 0) + x.size - x.path.split('/').length * 1000;
  want.sort((a, b) => score(b) - score(a));
  const picked = want.slice(0, opts.maxContentFiles ?? 400);

  let done = 0;
  for (const x of picked) {
    try { x.content = await byPath.get(x.path)!.read(); }
    catch { /* an unreadable file costs an edge, not the map */ }
    done++;
    if (done % 20 === 0 || done === picked.length) opts.onProgress?.({ phase: 'content', done, total: picked.length, message: x.path });
  }

  const skipped = want.length - picked.length;
  return {
    name, ref: 'local', files,
    ...(skipped > 0 ? { note: `Content was read for the ${picked.length} largest code files; ${skipped} smaller ones were skipped.` } : {}),
  };
}

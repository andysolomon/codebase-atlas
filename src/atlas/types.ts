/** Data contract for a Codebase Atlas dataset (see prototype/atlas-data.js for a worked example). */

export type PaperTheme = 'tan' | 'light' | 'dark';

export interface Theme {
  bg: string;
  paper: string;
  top: string;
  faceA: string;
  faceB: string;
  ink: string;
  dim: string;
  faint: string;
}

export interface ChildPart {
  code: string;
  name: string;
  h: number;
  what: string;
}

export interface Structure {
  id: string;
  code: string;
  name: string;
  group: string;
  loc: string;
  gx: number;
  gy: number;
  w: number;
  d: number;
  h: number;
  slab?: 0 | 1;
  what: string;
  how: string;
  src: string[];
  talks: string[];
  children?: ChildPart[];
}

export interface Edge {
  f: string;
  t: string;
  flow?: 0 | 1;
  dashed?: 0 | 1;
  pay: string;
  via?: [number, number][];
}

export interface External {
  name: string;
  t: string;
  dx: number;
  dy: number;
}

export type TraceStep = [structureId: string, sentence: string];
export type Group = [name: string, ids: string[]];
export type Stat = [key: string, value: string];

export interface AtlasData {
  repo: string;
  product: string;
  stats: Stat[];
  overviewTitle: string;
  overviewKicker: string;
  overviewSub: string;
  OVERVIEW_WHAT: string[];
  OVERVIEW_HOW: string[];
  HOW_TO_READ: string;
  /** Short label for the trace, e.g. 'ONE SLIDER DRAG'. Shown as 'TRACE <title> — N STEPS'. */
  traceTitle?: string;
  GROUPS: Group[];
  STRUCTURES: Structure[];
  EDGES: Edge[];
  EXTERNALS?: External[];
  TRACE: TraceStep[];
  /** Present when the prose was written by a model rather than templated from the scan. */
  provenance?: Provenance;
}

/** Where an atlas's prose came from. Every number on the map still comes from the scan. */
export interface Provenance {
  /** Model id per pass, e.g. { partition: 'spacexai/grok-4.6', narrate: 'minimax/minimax-m3' }. */
  models: Record<string, string>;
  generatedAt: string;
  /** Passes that fell back to templated prose, with the reason. */
  fallbacks?: string[];
  usage?: { input: number; output: number };
}

declare global {
  interface Window {
    ATLAS_DATA?: AtlasData;
  }
}

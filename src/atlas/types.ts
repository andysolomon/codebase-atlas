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
  GROUPS: Group[];
  STRUCTURES: Structure[];
  EDGES: Edge[];
  EXTERNALS?: External[];
  TRACE: TraceStep[];
}

declare global {
  interface Window {
    ATLAS_DATA?: AtlasData;
  }
}

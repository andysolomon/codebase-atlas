/** Data contract for a Codebase Atlas dataset (see prototype/atlas-data.js for a worked example). */

/** The papers the design system ships. `light` and `dark` are still accepted in URLs and resolve to
    `blueprint` and `dark-luxe` — see `resolvePaper` in ./theme. */
export type PaperTheme = 'tan' | 'blueprint' | 'dark-luxe' | 'graphite' | 'oxblood';

/** One paper, resolved out of the design system's colour tokens (see ./theme). Canvas and WebGL
    cannot read `var(--ink)`, so the map carries the resolved pair around instead. */
export interface Theme {
  /** --paper */          bg: string;
  /** --paper-sunken */   paper: string;
  /** --paper-raised */   top: string;
  /** --face-shade */     faceA: string;
  /** --face-tint */      faceB: string;
  /** --ink */            ink: string;
  /** --ink-dim, 55% */   dim: string;
  /** --ink-hair, 28% */  hair: string;
  /** --ink-faint, 16% */ faint: string;
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

/** One stop on the ride: what the camera frames, and the line read while it is framed. Exactly one
    of `all`, `block`, `edge`, `group` is set — the whole vocabulary, because it is exactly what the
    map has something drawn for. */
export interface RideBeat {
  /** Frame the whole atlas: the opening and closing shots. */
  all?: 1;
  /** A `STRUCTURES` id. */
  block?: string;
  /** An `EDGES` pair — a tuple, never a key string, because two key formats exist (see scene.ts). */
  edge?: [from: string, to: string];
  /** A `GROUPS` name. */
  group?: string;
  /** The line: captioned, and spoken. [[marks]] allowed; stripped before speech. */
  say: string;
  /** Heading for this beat, radians from the default isometric heading. A turn around the subject. */
  turn?: number;
  /** Hold in ms. Derived from `say` when absent. */
  hold?: number;
}
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
  /** A narrated flight over the map. Built from the scan when absent from the source; never empty on
      a freshly built atlas. */
  RIDE?: RideBeat[];
  /** Short label for the ride, e.g. 'ONE PASS OVER THE SYSTEM'. */
  rideTitle?: string;
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

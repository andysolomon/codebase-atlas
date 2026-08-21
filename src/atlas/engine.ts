/* Codebase Atlas engine — isometric hatched drafting-paper map.
   1:1 TypeScript port of prototype/atlas-engine.js (the source of truth).
   Framework-free: operates directly on SVG + DOM. Zero runtime dependencies.
   Registers <codebase-atlas paper="tan|light|dark" flow="true|false">.
   Data is supplied via the `data` property (or window.ATLAS_DATA as a fallback). */

import type { AtlasData, Edge, PaperTheme, Structure, Theme } from './types';

export const MONO = "ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,monospace";

export const THEMES: Record<PaperTheme, Theme> = {
  tan:   { bg: '#cfc79c', paper: '#c8c093', top: '#ddd6b2', faceA: '#bdb488', faceB: '#cec696', ink: '#16130a', dim: 'rgba(22,19,10,.55)', faint: 'rgba(22,19,10,.16)' },
  light: { bg: '#f1eee4', paper: '#eae6d8', top: '#fdfcf7', faceA: '#dcd7c6', faceB: '#e9e5d6', ink: '#233457', dim: 'rgba(35,52,87,.55)',  faint: 'rgba(35,52,87,.14)' },
  dark:  { bg: '#191510', paper: '#14100c', top: '#2c251b', faceA: '#211b13', faceB: '#271f16', ink: '#e4d3a1', dim: 'rgba(228,211,161,.55)', faint: 'rgba(228,211,161,.16)' },
};

// ── isometric projection ──
export const SX = 26, SY = 14.3, SH = 16;
type Pt = [number, number];
export const P = (gx: number, gy: number, h?: number): Pt => [(gx - gy) * SX, (gx + gy) * SY - (h || 0) * SH];
const pts = (a: Pt[]) => a.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
const esc = (t: unknown) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  if (attrs) for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  return e;
}
function el<K extends keyof HTMLElementTagNameMap>(tag: K, css?: string, html?: string | null): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (html != null) e.innerHTML = html;
  return e;
}

/** A structure as laid out in the current view (top level, or a child inside a parent). */
interface ViewStruct {
  id: string; code: string; name: string; group?: string; loc: string;
  gx: number; gy: number; w: number; d: number; h: number; slab?: 0 | 1;
  what: string; how: string; src?: string[]; talks: string[];
  children?: Structure['children'];
  _child?: NonNullable<Structure['children']>[number];
}
interface Seg { a: Pt; b: Pt; l: number; at: number }
interface EdgeGeo { e: Edge; segs: Seg[]; len: number }
interface Dot { g: EdgeGeo; t: number; el: SVGCircleElement }
interface BlockRef { g: SVGGElement; top: SVGPolygonElement; code: SVGTextElement; s: ViewStruct }

export class Atlas extends HTMLElement {
  static get observedAttributes() { return ['paper', 'flow']; }

  private _data: AtlasData | null = null;
  /** Supply the dataset programmatically. Falls back to window.ATLAS_DATA if never set. */
  get data(): AtlasData | null { return this._data; }
  set data(d: AtlasData | null) {
    this._data = d;
    if (!d || !this.isConnected) return;
    if (!this.booted) { this.bootIfReady(); return; }
    // Swap datasets in place: reset view state and rebuild.
    this.sel = null; this.inside = null; this.traceI = -1; this.dots = [];
    this.D = d; this.byId = {}; d.STRUCTURES.forEach((s) => { this.byId[s.id] = s; });
    this.setHash('');
    this.build();
  }
  /** Optional hook: when set, the topbar shows an OPEN REPO field and calls this with the typed value. */
  openRepo: ((query: string) => void) | null = null;
  /** Optional hook: when set, the topbar shows a FOLDER button that opens a repository on this machine. */
  openLocal: (() => void) | null = null;
  /** Optional hook: when set, the topbar shows an ANALYZE button that runs AI analysis over the
      repository currently on screen. `analyzeState` decides what the button says. */
  analyze: (() => void) | null = null;
  /** `idle` | `busy` | `done` | `off` — `off` greys the button out (no scanned repository to analyze). */
  analyzeState: 'idle' | 'busy' | 'done' | 'off' = 'off';
  /** Optional hook: the trail of repositories opened this session, and where in it we are. When set,
      the topbar grows ◀ ▶ buttons that step through it, and the field suggests what has been typed. */
  nav: { entries: { label: string; query?: string }[]; index: number; go: (i: number) => void } | null = null;
  /** Redraw the topbar alone. Used to move the ANALYZE button between its states mid-run. */
  refreshBar() { if (this.booted && this.barEl) this.paintBar(); }

  private D!: AtlasData;
  private byId: Record<string, Structure> = {};
  private sel: string | null = null;
  private inside: string | null = null;
  private traceI = -1;
  private dots: Dot[] = [];
  private dead = false;
  private lastT = 0;
  private booted = false;
  private pollIv: number | null = null;
  private onKey: ((e: KeyboardEvent) => void) | null = null;

  private barEl: HTMLDivElement | null = null;
  private sideEl!: HTMLDivElement;
  private mapWrap!: HTMLDivElement;
  private panelEl!: HTMLDivElement;
  private svg!: SVGSVGElement;
  private tipEl!: HTMLDivElement;
  private rowEls: Record<string, HTMLDivElement> = {};
  private blockEls: Record<string, BlockRef> = {};
  private edgeGeo: EdgeGeo[] = [];
  private vb: [number, number, number, number] = [0, 0, 1, 1];
  private fitW = 1;

  connectedCallback() {
    this.sel = null; this.inside = null; this.traceI = -1;
    this.dots = []; this.dead = false; this.lastT = 0;
    this.bootIfReady();
  }
  private bootIfReady() {
    if (this.booted) return;
    const src = this._data || window.ATLAS_DATA;
    if (src) { this.boot(src); return; }
    if (this.pollIv == null) {
      this.pollIv = window.setInterval(() => {
        const d = this._data || window.ATLAS_DATA;
        if (d) { window.clearInterval(this.pollIv!); this.pollIv = null; this.boot(d); }
      }, 50);
    }
  }
  private boot(d: AtlasData) {
    this.booted = true;
    if (this.pollIv != null) { window.clearInterval(this.pollIv); this.pollIv = null; }
    this.D = d;
    this.byId = {}; this.D.STRUCTURES.forEach((s) => { this.byId[s.id] = s; });
    this.build();
    const m = (location.hash || '').match(/#(inside|trace)=([\w-]+)/);
    if (m) {
      if (m[1] === 'inside' && this.byId[m[2]]) this.goInside(m[2], true);
      else if (m[1] === 'trace') { this.traceI = Math.max(0, Math.min(this.D.TRACE.length - 1, parseInt(m[2], 10) || 0)); this.applyTrace(); }
    }
    this.onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { if (this.inside) this.comeOut(); else if (this.traceI >= 0) this.endTrace(); else { this.sel = null; this.syncUI(); } }
      else if (e.key === 'ArrowRight' && this.traceI >= 0) this.stepTrace(1);
      else if (e.key === 'ArrowLeft' && this.traceI >= 0) this.stepTrace(-1);
    };
    window.addEventListener('keydown', this.onKey);
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }
  disconnectedCallback() {
    this.dead = true;
    if (this.onKey) window.removeEventListener('keydown', this.onKey);
    if (this.pollIv != null) { window.clearInterval(this.pollIv); this.pollIv = null; }
  }
  attributeChangedCallback(n: string, a: string | null, b: string | null) { if (a === b || !this.D) return; if (n === 'paper') this.build(); }
  theme(): Theme { return THEMES[this.getAttribute('paper') as PaperTheme] || THEMES.tan; }
  flowOn() { return this.getAttribute('flow') !== 'false'; }

  /** The topbar. Split out of `build` so a long-running action — a scan, an analysis — can move its
      button between states without rebuilding the scene under it. */
  private paintBar() {
    const T = this.theme(), D = this.D, bar = this.barEl!;
    bar.innerHTML = '';
    const cell = (k: string, v: string) => el('div', `padding:8px 14px;border-right:1.5px solid ${T.ink};display:flex;flex-direction:column;justify-content:space-between;flex:none`,
      `<div style="font-size:9px;letter-spacing:.16em;color:${T.dim}">${k}</div><div style="font-size:14px;white-space:nowrap">${v}</div>`);
    const statRow = el('div', 'display:flex;align-items:stretch;flex:1;min-width:0;overflow-x:auto;scrollbar-width:none');
    statRow.appendChild(cell('CODEBASE ATLAS', '<b>' + esc(D.product) + '</b>'));
    statRow.appendChild(cell('REPOSITORY', esc(D.repo)));
    D.stats.forEach(([k, v]) => statRow.appendChild(cell(k, esc(v))));
    bar.appendChild(statRow);

    const BTN = `font-family:${MONO};font-size:10px;letter-spacing:.12em;background:none;border:1.5px solid ${T.ink};color:${T.ink};padding:7px 11px;cursor:pointer;align-self:center;white-space:nowrap;flex:none;height:30px;box-sizing:border-box`;

    if (this.nav && this.nav.entries.length > 1) {
      const { entries, index, go } = this.nav;
      const step = (label: string, to: number, title: string) => {
        const b = el('button', `${BTN};padding:7px 8px;margin:0 0 0 6px${to < 0 || to >= entries.length ? ';opacity:.3;cursor:default' : ''}`, label);
        b.title = to < 0 || to >= entries.length ? title : `${title}: ${entries[to].label}`;
        b.disabled = to < 0 || to >= entries.length;
        b.onclick = () => go(to);
        return b;
      };
      bar.appendChild(step('◀', index - 1, 'Previous repository'));
      bar.appendChild(step('▶', index + 1, 'Next repository'));
    }
    if (this.openRepo) {
      const form = el('form', `display:flex;align-items:center;gap:0;margin:0 0 0 6px;flex:none;align-self:center`);
      const inp = el('input', `font-family:${MONO};font-size:10px;letter-spacing:.06em;background:none;border:1.5px solid ${T.ink};border-right:none;color:${T.ink};padding:7px 9px;width:220px;outline:none;box-sizing:border-box;height:30px`);
      inp.placeholder = 'github.com/owner/repo'; inp.spellcheck = false; inp.autocomplete = 'off';
      inp.value = this.getAttribute('repo-query') || '';
      // Everything openable by typing is offered back as you type — no extra topbar width spent.
      const queries = [...new Set((this.nav?.entries ?? []).map((e) => e.query).filter((x): x is string => !!x))];
      if (queries.length) {
        const list = el('datalist');
        list.id = 'atlas-recent-repos';
        queries.forEach((v) => { const o = el('option'); o.value = v; list.appendChild(o); });
        inp.setAttribute('list', list.id);
        form.appendChild(list);
      }
      const go = el('button', `${BTN};background:${T.ink};border-color:${T.ink};color:${T.bg};padding:7px 11px;margin:0`, '⌕ OPEN REPO');
      form.appendChild(inp); form.appendChild(go);
      form.onsubmit = (ev) => { ev.preventDefault(); const q = inp.value.trim(); if (q) this.openRepo!(q); };
      bar.appendChild(form);
    }
    if (this.openLocal) {
      const lb = el('button', `${BTN};margin:0 0 0 6px`, '⌂ LOCAL FOLDER');
      lb.title = 'Open a repository on this machine. Nothing is uploaded.';
      lb.onclick = () => this.openLocal!();
      bar.appendChild(lb);
    }
    if (this.analyze) {
      const st = this.analyzeState;
      const ab = el('button', `${BTN};margin:0 0 0 6px${st === 'busy' || st === 'done' ? `;background:${T.ink};border-color:${T.ink};color:${T.bg}` : ''}${st === 'off' ? ';opacity:.35;cursor:default' : ''}`,
        st === 'busy' ? '◐ ANALYZING …' : st === 'done' ? '✦ RE-ANALYZE' : '✦ ANALYZE');
      ab.title = st === 'off'
        ? 'Scan a repository first — a pre-built atlas is already written.'
        : 'Read the code with a model: blocks become concepts and the prose gets written.';
      ab.disabled = st === 'off' || st === 'busy';
      ab.onclick = () => { if (st !== 'off' && st !== 'busy') this.analyze!(); };
      bar.appendChild(ab);
    }

    const fb = el('button', `${BTN};margin:0 12px`);
    const setFB = () => { fb.textContent = this.flowOn() ? '❚❚ PAUSE THE FLOW' : '▶ RESUME THE FLOW'; };
    setFB();
    fb.onclick = () => { this.setAttribute('flow', this.flowOn() ? 'false' : 'true'); setFB(); };
    bar.appendChild(fb);
    // paper switch (app chrome; the prototype received `paper` from its host editor)
    const PAPERS: PaperTheme[] = ['tan', 'light', 'dark'];
    const pb = el('button', `${BTN};margin:0 12px 0 0`);
    const cur = (this.getAttribute('paper') as PaperTheme) || 'tan';
    pb.textContent = 'PAPER · ' + (THEMES[cur] ? cur : 'tan').toUpperCase();
    pb.onclick = () => { const i = PAPERS.indexOf(THEMES[cur] ? cur : 'tan'); this.setAttribute('paper', PAPERS[(i + 1) % PAPERS.length]); };
    bar.appendChild(pb);
  }

  build() {
    const T = this.theme();
    this.style.cssText = `display:grid;grid-template-rows:auto 1fr;width:100%;height:100vh;min-height:640px;background:${T.bg};color:${T.ink};font-family:${MONO};overflow:hidden;box-sizing:border-box`;
    this.innerHTML = '';
    // ── topbar ──
    this.barEl = el('div', `display:flex;align-items:stretch;height:60px;border-bottom:1.5px solid ${T.ink};min-width:0;overflow:hidden`);
    this.paintBar();
    this.appendChild(this.barEl);
    // ── main grid ──
    const main = el('div', 'display:grid;grid-template-columns:232px minmax(0,1fr) 398px;min-height:0');
    this.sideEl = el('div', `border-right:1.5px solid ${T.ink};overflow-y:auto;padding:10px 0 24px`);
    this.mapWrap = el('div', 'position:relative;min-width:0;overflow:hidden');
    this.panelEl = el('div', `border-left:1.5px solid ${T.ink};overflow-y:auto;padding:20px 22px 40px;background:${T.bg}`);
    main.appendChild(this.sideEl); main.appendChild(this.mapWrap); main.appendChild(this.panelEl);
    this.appendChild(main);
    this.renderSidebar(); this.renderScene(); this.renderPanel();
  }

  // ───────────────────────── sidebar ─────────────────────────
  renderSidebar() {
    const T = this.theme(), D = this.D;
    this.sideEl.innerHTML = '';
    this.rowEls = {};
    D.GROUPS.forEach(([gname, ids]) => {
      this.sideEl.appendChild(el('div', `margin:14px 12px 5px;font-size:9px;letter-spacing:.18em;color:${T.bg};background:${T.ink};display:inline-block;padding:2px 7px`, esc(gname)));
      this.sideEl.appendChild(el('div', ''));
      ids.forEach((id) => {
        const s = this.byId[id]; if (!s) return;
        const r = el('div', `display:flex;align-items:baseline;gap:8px;padding:4px 12px;cursor:pointer;font-size:11px;line-height:1.3`);
        r.innerHTML = `<span style="flex:none;width:20px;font-size:9px;border:1px solid ${T.ink};text-align:center;padding:1px 0">${s.code}</span><span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.name)}</span><span style="flex:none;font-size:9px;color:${T.dim}">${esc(s.loc.split('·')[1] || s.loc)}</span>`;
        r.onmouseenter = () => { if (this.sel !== id) r.style.background = T.faint; };
        r.onmouseleave = () => { if (this.sel !== id) r.style.background = ''; };
        r.onclick = () => { if (this.inside) this.comeOut(true); this.select(id); };
        this.rowEls[id] = r;
        this.sideEl.appendChild(r);
      });
    });
  }

  // ───────────────────────── scene ─────────────────────────
  structsNow(): ViewStruct[] {
    if (!this.inside) return this.D.STRUCTURES;
    const p = this.byId[this.inside];
    return (p.children || []).map((c, i) => ({
      id: this.inside + ':' + i, code: c.code.toUpperCase().slice(0, 2), name: c.name,
      gx: (i % 3) * 4.2, gy: Math.floor(i / 3) * 4.2, w: 2.3, d: 2.3, h: Math.max(0.45, c.h * 1.9),
      loc: '', what: c.what, how: '', talks: [], _child: c,
    }));
  }
  renderScene() {
    const T = this.theme(), D = this.D;
    this.mapWrap.innerHTML = '';
    const svg = svgEl('svg', { style: `width:100%;height:100%;display:block;background:${T.bg}` });
    this.svg = svg;
    const defs = svgEl('defs');
    const mkPat = (id: string, rot: number, gap: number, op: number) => {
      const p = svgEl('pattern', { id, width: gap, height: gap, patternUnits: 'userSpaceOnUse', patternTransform: `rotate(${rot})` });
      const ln = svgEl('line', { x1: 0, y1: 0, x2: 0, y2: gap, stroke: T.ink, 'stroke-width': 0.9, opacity: op });
      p.appendChild(ln); return p;
    };
    defs.appendChild(mkPat('atlasHA', 45, 4.2, 0.5));
    defs.appendChild(mkPat('atlasHB', -45, 5.2, 0.28));
    svg.appendChild(defs);
    const L = { edges: svgEl('g'), dots: svgEl('g'), blocks: svgEl('g'), labels: svgEl('g'), over: svgEl('g') };
    const structs = this.structsNow();
    const ctr = (s: ViewStruct): Pt => [s.gx + s.w / 2, s.gy + s.d / 2];

    // edges (main view only)
    this.edgeGeo = [];
    if (!this.inside) {
      D.EDGES.forEach((e) => {
        const f = this.byId[e.f], t = this.byId[e.t]; if (!f || !t) return;
        const a = ctr(f), b = ctr(t);
        let grid: Pt[] = [a];
        if (e.via) grid = grid.concat(e.via);
        else if (Math.abs(a[0] - b[0]) > 0.3 && Math.abs(a[1] - b[1]) > 0.3) grid.push([b[0], a[1]]);
        grid.push(b);
        const scr = grid.map((g) => P(g[0], g[1], 0));
        const poly = svgEl('polyline', { points: pts(scr), fill: 'none', stroke: T.ink, 'stroke-width': e.flow ? 1.3 : 1, opacity: e.dashed ? 0.4 : 0.55, ...(e.dashed ? { 'stroke-dasharray': '4 3.5' } : {}) });
        L.edges.appendChild(poly);
        L.edges.appendChild(svgEl('circle', { cx: scr[scr.length - 1][0], cy: scr[scr.length - 1][1], r: 2, fill: T.ink, opacity: 0.6 }));
        // segment table for dots + hover hit line
        let len = 0; const segs: Seg[] = [];
        for (let i = 1; i < scr.length; i++) {
          const d = Math.hypot(scr[i][0] - scr[i - 1][0], scr[i][1] - scr[i - 1][1]);
          segs.push({ a: scr[i - 1], b: scr[i], l: d, at: len }); len += d;
        }
        const hit = svgEl('polyline', { points: pts(scr), fill: 'none', stroke: 'transparent', 'stroke-width': 9, style: 'pointer-events:stroke;cursor:help' });
        hit.addEventListener('pointerenter', (ev) => this.tip(ev, `<b>${esc(f.name)} → ${esc(t.name)}</b><br>${esc(e.pay || '')}`));
        hit.addEventListener('pointermove', (ev) => this.tipMove(ev));
        hit.addEventListener('pointerleave', () => this.tipHide());
        L.edges.appendChild(hit);
        this.edgeGeo.push({ e, segs, len });
      });
    }
    // dots
    this.dots = [];
    this.edgeGeo.forEach((g) => {
      if (!g.e.flow) return;
      for (let k = 0; k < 2; k++) {
        const c = svgEl('circle', { r: 2.7, fill: T.ink, stroke: T.bg, 'stroke-width': 1 });
        L.dots.appendChild(c);
        this.dots.push({ g, t: k * 0.5, el: c });
      }
    });
    // blocks
    this.blockEls = {};
    structs.slice().sort((a, b) => (a.gx + a.gy + (a.w + a.d) / 2) - (b.gx + b.gy + (b.w + b.d) / 2)).forEach((s) => {
      const { gx, gy, w, d, h } = s;
      const Bg = P(gx + w, gy, 0), Cg = P(gx + w, gy + d, 0), Dg = P(gx, gy + d, 0);
      const At = P(gx, gy, h), Bt = P(gx + w, gy, h), Ct = P(gx + w, gy + d, h), Dt = P(gx, gy + d, h);
      const g = svgEl('g', { style: 'cursor:pointer', 'data-id': s.id });
      const faceL = svgEl('polygon', { points: pts([Dt, Ct, Cg, Dg]), fill: T.faceA, stroke: T.ink, 'stroke-width': 1.2, 'stroke-linejoin': 'round' });
      const faceLh = svgEl('polygon', { points: pts([Dt, Ct, Cg, Dg]), fill: 'url(#atlasHA)', stroke: 'none' });
      const faceR = svgEl('polygon', { points: pts([Ct, Bt, Bg, Cg]), fill: T.faceB, stroke: T.ink, 'stroke-width': 1.2, 'stroke-linejoin': 'round' });
      const faceRh = svgEl('polygon', { points: pts([Ct, Bt, Bg, Cg]), fill: 'url(#atlasHB)', stroke: 'none' });
      const top = svgEl('polygon', { points: pts([At, Bt, Ct, Dt]), fill: T.top, stroke: T.ink, 'stroke-width': 1.4, 'stroke-linejoin': 'round' });
      [faceL, faceLh, faceR, faceRh, top].forEach((f) => g.appendChild(f));
      const tc = P(gx + w / 2, gy + d / 2, h);
      const codeFS = s.slab ? 9 : Math.max(10, Math.min(19, Math.min(w, d) * 6.5));
      const code = svgEl('text', { x: tc[0], y: tc[1] + codeFS * 0.36, 'text-anchor': 'middle', 'font-family': MONO, 'font-size': codeFS, 'font-weight': 700, fill: T.ink, 'letter-spacing': '.08em', style: 'pointer-events:none' });
      code.textContent = s.code; g.appendChild(code);
      const lp: Pt = [(Dg[0] + Cg[0]) / 2, Math.max(Cg[1], Dg[1]) + 11];
      const name = svgEl('text', { x: lp[0], y: lp[1], 'text-anchor': 'middle', 'font-family': MONO, 'font-size': 8.5, fill: T.ink, 'letter-spacing': '.1em', style: 'pointer-events:none' });
      name.textContent = s.name.toUpperCase(); L.labels.appendChild(name);
      if (s.loc) {
        const loc = svgEl('text', { x: lp[0], y: lp[1] + 10, 'text-anchor': 'middle', 'font-family': MONO, 'font-size': 7.5, fill: T.dim, style: 'pointer-events:none' });
        loc.textContent = s.loc; L.labels.appendChild(loc);
      }
      g.addEventListener('pointerenter', (ev) => { if (this.sel !== s.id) top.setAttribute('fill', T.faceB); this.tip(ev, `<b>${s.code} · ${esc(s.name)}</b><br>${esc(s.what.split('. ')[0])}.${(s.children || s._child) ? `<br><i style="color:${T.dim}">${s.children ? 'double-click to go inside' : ''}</i>` : ''}`); });
      g.addEventListener('pointermove', (ev) => this.tipMove(ev));
      g.addEventListener('pointerleave', () => { this.tipHide(); this.paintSel(); });
      g.addEventListener('click', (ev) => { ev.stopPropagation(); this.select(s.id); });
      g.addEventListener('dblclick', (ev) => { ev.stopPropagation(); if (s.children) this.goInside(s.id); });
      L.blocks.appendChild(g);
      this.blockEls[s.id] = { g, top, code, s };
    });
    // externals
    if (!this.inside) (D.EXTERNALS || []).forEach((x) => {
      const t = this.byId[x.t]; if (!t) return;
      const anchor = P(t.gx + t.w / 2, t.gy + t.d / 2, t.h + 0.15);
      const lp = P(t.gx + t.w / 2 + x.dx, t.gy + t.d / 2 + x.dy, t.h + 0.15);
      L.over.appendChild(svgEl('line', { x1: anchor[0], y1: anchor[1], x2: lp[0], y2: lp[1], stroke: T.ink, 'stroke-width': 0.9, 'stroke-dasharray': '2.5 3', opacity: 0.5 }));
      const tx = svgEl('text', { x: lp[0], y: lp[1] - 4, 'text-anchor': 'middle', 'font-family': MONO, 'font-size': 8, fill: T.dim, 'letter-spacing': '.14em' });
      tx.textContent = x.name; L.over.appendChild(tx);
    });
    svg.appendChild(L.edges); svg.appendChild(L.dots); svg.appendChild(L.blocks); svg.appendChild(L.labels); svg.appendChild(L.over);
    this.mapWrap.appendChild(svg);
    // overlays
    const cart = el('div', `position:absolute;left:14px;bottom:14px;border:1.5px solid ${T.ink};background:${T.bg};padding:9px 13px;font-size:9px;letter-spacing:.12em;line-height:1.9;pointer-events:none`);
    cart.innerHTML = this.inside
      ? `<b style="font-size:11px">INSIDE ${this.byId[this.inside].code} — ${esc(this.byId[this.inside].name.toUpperCase())}</b><br><span style="color:${T.dim}">${esc(this.byId[this.inside].loc)}</span>`
      : `<b style="font-size:11px">${esc(D.product)} — CODEBASE ATLAS</b><br><span style="color:${T.dim}">${esc(D.repo)} · BLOCK HEIGHT = CODE SIZE · SLABS = STORAGE &amp; RECORDS</span>`;
    this.mapWrap.appendChild(cart);
    const hint = el('div', `position:absolute;right:14px;bottom:14px;font-size:9px;letter-spacing:.12em;color:${T.dim};pointer-events:none`,
      this.inside ? 'ESC TO COME BACK OUT' : 'DRAG TO PAN · SCROLL TO ZOOM · HOVER · CLICK · DOUBLE-CLICK TO GO INSIDE');
    this.mapWrap.appendChild(hint);
    if (this.inside) {
      const back = el('button', `position:absolute;left:14px;top:14px;font-family:${MONO};font-size:10px;letter-spacing:.12em;background:${T.ink};color:${T.bg};border:none;padding:8px 12px;cursor:pointer`, '← BACK TO THE MAP');
      back.onclick = () => this.comeOut();
      this.mapWrap.appendChild(back);
    }
    const fit = el('button', `position:absolute;right:14px;top:14px;font-family:${MONO};font-size:10px;background:none;border:1.5px solid ${T.ink};color:${T.ink};padding:6px 10px;cursor:pointer;letter-spacing:.1em`, '⌖ FIT');
    fit.onclick = () => this.fitView();
    this.mapWrap.appendChild(fit);
    this.tipEl = el('div', `position:absolute;display:none;max-width:250px;border:1.5px solid ${T.ink};background:${T.bg};color:${T.ink};padding:7px 10px;font-size:10.5px;line-height:1.5;pointer-events:none;z-index:5`);
    this.mapWrap.appendChild(this.tipEl);
    this.bindPanZoom();
    this.fitView();
    this.paintSel();
  }
  tip(ev: PointerEvent, html: string) { this.tipEl.innerHTML = html; this.tipEl.style.display = 'block'; this.tipMove(ev); }
  tipMove(ev: PointerEvent) {
    const r = this.mapWrap.getBoundingClientRect();
    let x = ev.clientX - r.left + 14, y = ev.clientY - r.top + 14;
    const tw = this.tipEl.offsetWidth, th = this.tipEl.offsetHeight;
    if (x + tw > r.width - 8) x = ev.clientX - r.left - tw - 12;
    if (y + th > r.height - 8) y = ev.clientY - r.top - th - 12;
    this.tipEl.style.left = x + 'px'; this.tipEl.style.top = y + 'px';
  }
  tipHide() { this.tipEl.style.display = 'none'; }
  fitView() {
    const bb = this.svg.getBBox(), pad = 34;
    this.vb = [bb.x - pad, bb.y - pad, bb.width + pad * 2, bb.height + pad * 2];
    this.fitW = this.vb[2];
    this.applyVB();
  }
  applyVB() { this.svg.setAttribute('viewBox', this.vb.map((n) => n.toFixed(1)).join(' ')); }
  bindPanZoom() {
    const svg = this.svg;
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
      const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
      const k = e.deltaY > 0 ? 1.12 : 1 / 1.12;
      const nw = Math.max(this.fitW / 5, Math.min(this.fitW * 2.2, this.vb[2] * k));
      const kk = nw / this.vb[2];
      this.vb = [p.x - (p.x - this.vb[0]) * kk, p.y - (p.y - this.vb[1]) * kk, nw, this.vb[3] * kk];
      this.applyVB();
    }, { passive: false });
    let drag: { x: number; y: number; vb: [number, number, number, number]; moved: boolean } | null = null;
    // NB: pointer capture is taken only once a real drag begins. Capturing on pointerdown
    // retargets the following pointerup/click/dblclick to the <svg>, which silently breaks
    // block selection and double-click-to-go-inside.
    svg.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; drag = { x: e.clientX, y: e.clientY, vb: this.vb.slice() as [number, number, number, number], moved: false }; });
    svg.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (!drag.moved) {
        if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) <= 4) return;
        drag.moved = true; svg.setPointerCapture(e.pointerId); svg.style.cursor = 'grabbing'; this.tipHide();
      }
      const sc = this.vb[2] / svg.clientWidth;
      const dx = (e.clientX - drag.x) * sc, dy = (e.clientY - drag.y) * sc;
      this.vb = [drag.vb[0] - dx, drag.vb[1] - dy, drag.vb[2], drag.vb[3]];
      this.applyVB();
    });
    const end = (e: PointerEvent) => {
      const wasDrag = !!(drag && drag.moved); drag = null; svg.style.cursor = '';
      if (wasDrag) { if (svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId); return; }
      const tgt = e.target as Element;
      if (tgt === svg || tgt.tagName === 'defs') { this.sel = null; if (this.traceI >= 0) this.endTrace(); else this.syncUI(); }
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
  }
  loop(t: number) {
    if (this.dead) return;
    const dt = Math.min(0.06, (t - this.lastT) / 1000 || 0.016); this.lastT = t;
    if (this.flowOn()) this.dots.forEach((d) => {
      d.t = (d.t + dt * 46 / d.g.len) % 1;
      const dist = d.t * d.g.len;
      for (const s of d.g.segs) {
        if (dist <= s.at + s.l) { const u = (dist - s.at) / s.l; d.el.setAttribute('cx', (s.a[0] + (s.b[0] - s.a[0]) * u).toFixed(1)); d.el.setAttribute('cy', (s.a[1] + (s.b[1] - s.a[1]) * u).toFixed(1)); break; }
      }
    });
    requestAnimationFrame(this.loop);
  }

  // ───────────────────────── state ─────────────────────────
  select(id: string, fromTrace?: boolean) {
    if (!fromTrace && this.traceI >= 0) { this.traceI = -1; this.setHash(''); }
    this.sel = (this.sel === id && !fromTrace) ? null : id;
    this.syncUI();
  }
  syncUI() { this.paintSel(); this.renderPanel(); }
  paintSel() {
    const T = this.theme();
    const traceIds = this.traceI >= 0 ? [this.D.TRACE[this.traceI][0]] : null;
    for (const id in this.blockEls) {
      const b = this.blockEls[id];
      const isSel = this.sel === id;
      b.top.setAttribute('fill', isSel ? T.ink : T.top);
      b.code.setAttribute('fill', isSel ? T.bg : T.ink);
      b.top.setAttribute('stroke-width', isSel ? '2' : '1.4');
      b.g.style.opacity = traceIds ? (traceIds.includes(id) ? '1' : '0.22') : '1';
    }
    if (this.rowEls) for (const id in this.rowEls) {
      const r = this.rowEls[id], on = this.sel === id;
      r.style.background = on ? T.ink : ''; r.style.color = on ? T.bg : '';
      (r.querySelector('span') as HTMLSpanElement).style.borderColor = on ? T.bg : T.ink;
    }
  }
  setHash(h: string) { try { history.replaceState(null, '', location.pathname + location.search + (h || '#')); } catch { /* noop */ } }
  goInside(id: string, silent?: boolean) {
    this.inside = id; this.sel = null; this.traceI = -1;
    if (!silent) this.setHash('#inside=' + id);
    this.renderScene(); this.renderPanel();
  }
  comeOut(silent?: boolean) {
    const was = this.inside;
    this.inside = null; this.sel = was;
    if (!silent) this.setHash('');
    this.renderScene(); this.renderPanel();
  }
  startTrace() { if (this.inside) this.comeOut(true); this.traceI = 0; this.applyTrace(); }
  stepTrace(d: number) { this.traceI = Math.max(0, Math.min(this.D.TRACE.length - 1, this.traceI + d)); this.applyTrace(); }
  endTrace() { this.traceI = -1; this.sel = null; this.setHash(''); this.syncUI(); }
  applyTrace() { const st = this.D.TRACE[this.traceI]; this.sel = st[0]; this.setHash('#trace=' + this.traceI); this.syncUI(); }

  // ───────────────────────── right panel ─────────────────────────
  rich(t: string) { const T = this.theme(); return esc(t).replace(/\[\[(.+?)\]\]/g, `<span style="background:${T.ink};color:${T.bg};padding:0 4px">$1</span>`); }
  hRule(label: string) { const T = this.theme(); return `<div style="display:flex;align-items:center;gap:9px;margin:20px 0 9px"><span style="font-size:9px;letter-spacing:.18em;white-space:nowrap">${label}</span><span style="flex:1;height:1.5px;background:${T.ink}"></span></div>`; }
  renderPanel() {
    const T = this.theme(), D = this.D, Pn = this.panelEl;
    const btn = `font-family:${MONO};font-size:10.5px;letter-spacing:.12em;border:1.5px solid ${T.ink};background:none;color:${T.ink};padding:9px 13px;cursor:pointer`;
    if (this.traceI >= 0) {
      const [id, sentence] = D.TRACE[this.traceI];
      const s = this.byId[id];
      Pn.innerHTML = `
        <div style="font-size:9px;letter-spacing:.18em;color:${T.dim}">TRACE — ${esc(D.traceTitle || 'ONE SLIDER DRAG')}, END TO END</div>
        <div style="font-size:30px;font-weight:700;margin:10px 0 2px">${String(this.traceI + 1).padStart(2, '0')}<span style="color:${T.dim};font-size:15px"> / ${D.TRACE.length}</span></div>
        <div style="font-size:12px;letter-spacing:.1em;margin-bottom:14px">${s.code} · ${esc(s.name.toUpperCase())}</div>
        <div style="font-size:13px;line-height:1.75;border-left:3px solid ${T.ink};padding-left:13px">${this.rich(sentence)}</div>
        <div style="display:flex;gap:8px;margin-top:22px">
          <button id="tPrev" style="${btn}${this.traceI === 0 ? ';opacity:.35' : ''}">‹ PREV</button>
          <button id="tNext" style="${btn};background:${T.ink};color:${T.bg}${this.traceI === D.TRACE.length - 1 ? ';opacity:.35' : ''}">NEXT ›</button>
          <span style="flex:1"></span>
          <button id="tEnd" style="${btn}">✕ END</button>
        </div>
        <div style="margin-top:14px;font-size:9px;letter-spacing:.12em;color:${T.dim}">← → ARROW KEYS STEP · ESC ENDS</div>`;
      (Pn.querySelector('#tPrev') as HTMLButtonElement).onclick = () => this.stepTrace(-1);
      (Pn.querySelector('#tNext') as HTMLButtonElement).onclick = () => this.stepTrace(1);
      (Pn.querySelector('#tEnd') as HTMLButtonElement).onclick = () => this.endTrace();
      return;
    }
    const cur: ViewStruct | undefined = this.sel
      ? (this.inside ? this.structsNow().find((x) => x.id === this.sel) : this.byId[this.sel])
      : undefined;
    if (cur) {
      const talks = (cur.talks || []).map((tid) => this.byId[tid]).filter(Boolean);
      Pn.innerHTML = `
        <button id="pBack" style="border:none;background:none;color:${T.dim};font-family:${MONO};font-size:10px;letter-spacing:.14em;cursor:pointer;padding:0">← ${this.inside ? esc(this.byId[this.inside].name.toUpperCase()) : 'OVERVIEW'}</button>
        <div style="display:flex;align-items:baseline;gap:12px;margin:14px 0 2px">
          <span style="font-size:26px;font-weight:700;border:2px solid ${T.ink};padding:1px 9px">${cur.code}</span>
          <span style="font-size:19px;font-weight:700;line-height:1.2">${esc(cur.name)}</span>
        </div>
        <div style="font-size:10px;letter-spacing:.14em;color:${T.dim};margin-bottom:4px">${cur.group ? esc(cur.group) + ' · ' : ''}${esc(cur.loc || '')}</div>
        ${this.hRule('WHAT IT DOES')}
        <div style="font-size:12.5px;line-height:1.75">${this.rich(cur.what)}</div>
        ${cur.how ? this.hRule("HOW IT'S BUILT") + `<div style="font-size:12.5px;line-height:1.75">${this.rich(cur.how)}</div>` : ''}
        ${cur.src ? this.hRule('SOURCE') + `<div style="font-size:10.5px;line-height:2;color:${T.dim}">${cur.src.map(esc).join('<br>')}</div>` : ''}
        ${talks.length ? this.hRule('TALKS TO') + `<div id="pTalks" style="display:flex;flex-wrap:wrap;gap:6px">${talks.map((t) => `<button data-id="${t.id}" style="${btn};padding:5px 9px;font-size:10px">${t.code} ${esc(t.name.toUpperCase())}</button>`).join('')}</div>` : ''}
        ${cur.children ? `<button id="pIn" style="${btn};background:${T.ink};color:${T.bg};margin-top:22px;width:100%">▣ GO INSIDE — ${cur.children.length} PARTS</button>` : ''}`;
      (Pn.querySelector('#pBack') as HTMLButtonElement).onclick = () => { this.sel = null; this.syncUI(); };
      const pin = Pn.querySelector('#pIn') as HTMLButtonElement | null; if (pin) pin.onclick = () => this.goInside(cur.id);
      Pn.querySelectorAll<HTMLButtonElement>('#pTalks button').forEach((b) => { b.onclick = () => this.select(b.dataset.id!); });
      return;
    }
    // overview
    Pn.innerHTML = `
      <div style="font-size:9px;letter-spacing:.2em;color:${T.dim}">${esc(D.overviewKicker)} — ${esc(D.overviewSub.toUpperCase())}</div>
      <div style="font-size:21px;font-weight:700;line-height:1.3;margin:10px 0 4px;text-wrap:balance">${esc(D.overviewTitle)}</div>
      ${this.hRule('WHAT IT DOES')}
      ${D.OVERVIEW_WHAT.map((p) => `<p style="font-size:12.5px;line-height:1.75;margin:0 0 11px">${this.rich(p)}</p>`).join('')}
      ${this.hRule("HOW IT'S BUILT")}
      ${D.OVERVIEW_HOW.map((p) => `<p style="font-size:12.5px;line-height:1.75;margin:0 0 11px">${this.rich(p)}</p>`).join('')}
      <div style="border:1.5px solid ${T.ink};padding:11px 13px;font-size:11px;line-height:1.7;margin-top:18px">${this.rich(D.HOW_TO_READ)}</div>
      <button id="pTrace" style="${btn};background:${T.ink};color:${T.bg};margin-top:18px;width:100%">▶ TRACE ${esc(D.traceTitle || 'ONE SLIDER DRAG')} — ${D.TRACE.length} STEPS</button>`;
    (Pn.querySelector('#pTrace') as HTMLButtonElement).onclick = () => this.startTrace();
  }
}

export function defineAtlas() {
  if (!customElements.get('codebase-atlas')) customElements.define('codebase-atlas', Atlas);
}

declare global {
  interface HTMLElementTagNameMap { 'codebase-atlas': Atlas }
}

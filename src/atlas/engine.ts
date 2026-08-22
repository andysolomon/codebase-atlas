/* Codebase Atlas engine — isometric hatched drafting-paper map.
   Ported from prototype/atlas-engine.js (the source of truth for the look). The chrome — topbar,
   sidebar, right panel, tooltip, trace — is plain DOM. The map itself is a Three.js scene (scene.ts)
   navigated like a map: pan, rotate, tilt, zoom to the cursor. The default camera reproduces the
   prototype's isometric projection exactly.
   Registers <codebase-atlas paper="tan|blueprint|dark-luxe|graphite|oxblood" flow="true|false">.
   Colour, type and rule weights all come from the design system tokens in src/styles/ (see ./theme).
   Data is supplied via the `data` property (or window.ATLAS_DATA as a fallback). */

import type { AtlasData, Structure, Theme } from './types';
import { AtlasScene, MONO, edgeKey } from './scene';
import type { Projection, SceneBlock, SceneEdge, SceneExternal } from './scene';
import { PAPERS, readTheme, resolvePaper } from './theme';

export { MONO, PAPERS, resolvePaper };

/* The design system's small button: 10px, tight padding — a step under --fs-label, which is the
   default size (see components/actions/Button.jsx upstream). The chrome is built from the small one;
   the right panel's buttons are the default. Nothing else in the app sizes type off the scale. */
const FS_SM = '10px';

const esc = (t: unknown) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');

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
    this.sel = null; this.selEdge = null; this.inside = null; this.traceI = -1;
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
  /** A selected import, keyed by its endpoints (see `edgeKey`). Never set at the same time as `sel`. */
  private selEdge: string | null = null;
  private inside: string | null = null;
  private traceI = -1;
  private booted = false;
  private pollIv: number | null = null;
  private onKey: ((e: KeyboardEvent) => void) | null = null;

  private barEl: HTMLDivElement | null = null;
  private sideEl!: HTMLDivElement;
  private mapWrap!: HTMLDivElement;
  private panelEl!: HTMLDivElement;
  private tipEl!: HTMLDivElement;
  private rowEls: Record<string, HTMLDivElement> = {};
  private views: Record<string, ViewStruct> = {};
  private scene: AtlasScene | null = null;
  private compassEl: HTMLElement | null = null;
  private projEl: HTMLButtonElement | null = null;
  private hoveredEdge: SceneEdge | null = null;
  private edgeByKey: Record<string, SceneEdge> = {};
  /** FLAT (orthographic, the drafting look) or DEEP (perspective). Survives rebuilds and theme changes. */
  private projection: Projection = 'flat';

  connectedCallback() {
    this.sel = null; this.selEdge = null; this.inside = null; this.traceI = -1;
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
    const m = (location.hash || '').match(/#(inside|trace|edge)=([\w,-]+)/);
    if (m) {
      if (m[1] === 'inside' && this.byId[m[2]]) this.goInside(m[2], true);
      else if (m[1] === 'trace') { this.traceI = Math.max(0, Math.min(this.D.TRACE.length - 1, parseInt(m[2], 10) || 0)); this.applyTrace(); }
      else if (m[1] === 'edge') { const [f, t] = m[2].split(','); if (this.edgeByKey[edgeKey({ f, t })]) this.selectEdge(edgeKey({ f, t }), true); }
    }
    this.onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { if (this.inside) this.comeOut(); else if (this.traceI >= 0) this.endTrace(); else { this.clearSelection(); } }
      else if (e.key === 'ArrowRight' && this.traceI >= 0) this.stepTrace(1);
      else if (e.key === 'ArrowLeft' && this.traceI >= 0) this.stepTrace(-1);
    };
    window.addEventListener('keydown', this.onKey);
  }
  disconnectedCallback() {
    this.scene?.dispose(); this.scene = null;
    if (this.onKey) window.removeEventListener('keydown', this.onKey);
    if (this.pollIv != null) { window.clearInterval(this.pollIv); this.pollIv = null; }
  }
  attributeChangedCallback(n: string, a: string | null, b: string | null) {
    if (a === b || !this.D) return;
    if (n === 'paper') this.build();
    else if (n === 'flow') this.scene?.setFlow(this.flowOn());
  }
  theme(): Theme { return readTheme(resolvePaper(this.getAttribute('paper'))); }
  flowOn() { return this.getAttribute('flow') !== 'false'; }

  /** The topbar. Split out of `build` so a long-running action — a scan, an analysis — can move its
      button between states without rebuilding the scene under it. */
  private paintBar() {
    const T = this.theme(), D = this.D, bar = this.barEl!;
    bar.innerHTML = '';
    const cell = (k: string, v: string) => el('div', `padding:8px 14px;border-right:var(--border-w) solid ${T.ink};display:flex;flex-direction:column;justify-content:space-between;flex:none`,
      `<div style="font-size:var(--fs-kicker);letter-spacing:var(--ls-kicker);color:${T.dim}">${k}</div><div style="font-size:var(--fs-stat);white-space:nowrap">${v}</div>`);
    const statRow = el('div', 'display:flex;align-items:stretch;flex:1;min-width:0;overflow-x:auto;scrollbar-width:none');
    statRow.appendChild(cell('CODEBASE ATLAS', '<b>' + esc(D.product) + '</b>'));
    statRow.appendChild(cell('REPOSITORY', esc(D.repo)));
    D.stats.forEach(([k, v]) => statRow.appendChild(cell(k, esc(v))));
    bar.appendChild(statRow);

    const BTN = `font-family:${MONO};font-size:${FS_SM};letter-spacing:var(--ls-label);background:none;border:var(--border-w) solid ${T.ink};color:${T.ink};padding:7px 11px;cursor:pointer;align-self:center;white-space:nowrap;flex:none;height:30px;box-sizing:border-box`;

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
      const inp = el('input', `font-family:${MONO};font-size:${FS_SM};letter-spacing:.06em;background:none;border:var(--border-w) solid ${T.ink};border-right:none;color:${T.ink};padding:7px 9px;width:220px;outline:none;box-sizing:border-box;height:30px`);
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
    // paper switch (app chrome; the prototype received `paper` from its host editor). The list is the
    // design system's — add a theme to tokens/colors.css and PAPERS and it joins the cycle here.
    const pb = el('button', `${BTN};margin:0 12px 0 0`);
    const cur = resolvePaper(this.getAttribute('paper'));
    pb.textContent = 'PAPER · ' + cur.toUpperCase();
    pb.title = `Paper ${PAPERS.indexOf(cur) + 1} of ${PAPERS.length} — ${PAPERS.join(', ')}`;
    pb.onclick = () => this.setAttribute('paper', PAPERS[(PAPERS.indexOf(cur) + 1) % PAPERS.length]);
    bar.appendChild(pb);
  }

  build() {
    const T = this.theme();
    this.scene?.dispose(); this.scene = null;
    this.style.cssText = `display:grid;grid-template-rows:auto 1fr;width:100%;height:100vh;min-height:640px;background:${T.bg};color:${T.ink};font-family:${MONO};overflow:hidden;box-sizing:border-box`;
    this.innerHTML = '';
    // ── topbar ──
    this.barEl = el('div', `display:flex;align-items:stretch;height:60px;border-bottom:var(--border-w) solid ${T.ink};min-width:0;overflow:hidden`);
    this.paintBar();
    this.appendChild(this.barEl);
    // ── main grid ──
    const main = el('div', 'display:grid;grid-template-columns:232px minmax(0,1fr) 398px;min-height:0');
    this.sideEl = el('div', `border-right:var(--border-w) solid ${T.ink};overflow-y:auto;padding:10px 0 24px`);
    this.mapWrap = el('div', 'position:relative;min-width:0;overflow:hidden');
    this.panelEl = el('div', `border-left:var(--border-w) solid ${T.ink};overflow-y:auto;padding:20px 22px 40px;background:${T.bg}`);
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
      this.sideEl.appendChild(el('div', `margin:14px 12px 5px;font-size:var(--fs-kicker);letter-spacing:var(--ls-kicker);color:${T.bg};background:${T.ink};display:inline-block;padding:2px 7px`, esc(gname)));
      this.sideEl.appendChild(el('div', ''));
      ids.forEach((id) => {
        const s = this.byId[id]; if (!s) return;
        const r = el('div', `display:flex;align-items:baseline;gap:8px;padding:4px 12px;cursor:pointer;font-size:11px;line-height:1.3`);
        r.innerHTML = `<span style="flex:none;width:20px;font-size:var(--fs-kicker);border:var(--border-w-hair) solid ${T.ink};text-align:center;padding:1px 0">${s.code}</span><span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.name)}</span><span style="flex:none;font-size:var(--fs-kicker);color:${T.dim}">${esc(s.loc.split('·')[1] || s.loc)}</span>`;
        r.onmouseenter = () => { if (this.sel !== id) r.style.background = T.faint; };
        r.onmouseleave = () => { if (this.sel !== id) r.style.background = ''; };
        r.onclick = () => { if (this.inside) this.comeOut(true); this.select(id); if (this.sel === id) this.scene?.focus(id); };
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
    this.scene?.dispose(); this.scene = null;
    this.mapWrap.innerHTML = '';
    this.mapWrap.style.background = T.bg;
    const structs = this.structsNow();
    this.views = {}; structs.forEach((s) => { this.views[s.id] = s; });

    const blocks: SceneBlock[] = structs.map((s) => ({
      id: s.id, code: s.code, name: s.name, loc: s.loc, gx: s.gx, gy: s.gy, w: s.w, d: s.d, h: s.h,
      ...(s.slab ? { slab: s.slab } : {}), enterable: !!s.children,
    }));
    const blockById: Record<string, SceneBlock> = {}; blocks.forEach((b) => { blockById[b.id] = b; });
    const edges: SceneEdge[] = [];
    const externals: SceneExternal[] = [];
    this.edgeByKey = {};
    if (!this.inside) {
      D.EDGES.forEach((e) => { const f = blockById[e.f], t = blockById[e.t]; if (f && t) { const se = { e, f, t }; edges.push(se); this.edgeByKey[edgeKey(e)] = se; } });
      (D.EXTERNALS || []).forEach((x) => { const t = blockById[x.t]; if (t) externals.push({ x, t }); });
    }

    this.scene = new AtlasScene(this.mapWrap, T, {
      onHoverBlock: (b, ev) => {
        if (!b) { this.tipHide(); return; }
        const s = this.views[b.id];
        this.tip(ev, `<b>${s.code} · ${esc(s.name)}</b><br>${esc(s.what.split('. ')[0])}.${(s.children || s._child) ? `<br><i style="color:${T.dim}">${s.children ? 'double-click to go inside' : ''}</i>` : ''}`);
      },
      onHoverEdge: (e, ev) => {
        if (!e) { if (this.hoveredEdge) { this.hoveredEdge = null; this.tipHide(); } return; }
        if (e === this.hoveredEdge) { this.tipMove(ev); return; }
        this.hoveredEdge = e;
        this.tip(ev, `<b>${esc(e.f.name)} → ${esc(e.t.name)}</b><br>${esc(e.e.pay || '')}<br><i style="color:${T.dim}">click to read the relationship</i>`);
      },
      onClick: ({ block, edge }) => {
        if (block) this.select(block.id);
        else if (edge) this.selectEdge(edgeKey(edge.e));
        else if (this.traceI >= 0) this.endTrace();
        else this.clearSelection();
      },
      onDblClick: ({ block, edge }) => {
        if (block) { if (block.enterable) this.goInside(block.id); else if (this.sel !== block.id) this.select(block.id); }
        else if (edge && this.selEdge !== edgeKey(edge.e)) this.selectEdge(edgeKey(edge.e));
      },
      onView: (turn, proj) => {
        if (this.compassEl) this.compassEl.style.transform = `rotate(${(-turn * 180 / Math.PI).toFixed(1)}deg)`;
        if (this.projEl) this.projEl.textContent = proj === 'flat' ? '▱ FLAT' : '◇ DEEP';
      },
      arrowsTaken: () => this.traceI >= 0,
    });
    this.scene.setFlow(this.flowOn());
    this.scene.setData(blocks, edges, externals, T);
    if (this.projection !== 'flat') this.scene.setProjection(this.projection);

    // overlays
    const cart = el('div', `position:absolute;left:14px;bottom:14px;border:var(--border-w) solid ${T.ink};background:${T.bg};padding:9px 13px;font-size:var(--fs-kicker);letter-spacing:var(--ls-label);line-height:1.9;pointer-events:none`);
    cart.innerHTML = this.inside
      ? `<b style="font-size:11px">INSIDE ${this.byId[this.inside].code} — ${esc(this.byId[this.inside].name.toUpperCase())}</b><br><span style="color:${T.dim}">${esc(this.byId[this.inside].loc)}</span>`
      : `<b style="font-size:11px">${esc(D.product)} — CODEBASE ATLAS</b><br><span style="color:${T.dim}">${esc(D.repo)} · BLOCK HEIGHT = CODE SIZE · SLABS = STORAGE &amp; RECORDS</span>`;
    this.mapWrap.appendChild(cart);
    const hint = el('div', `position:absolute;right:14px;bottom:14px;font-size:var(--fs-kicker);letter-spacing:var(--ls-label);color:${T.dim};pointer-events:none;text-align:right`,
      this.inside ? 'ESC TO COME BACK OUT' : 'DRAG TO PAN · RIGHT-DRAG TO TURN · SCROLL TO ZOOM · CLICK · DOUBLE-CLICK TO GO INSIDE');
    this.mapWrap.appendChild(hint);
    if (this.inside) {
      const back = el('button', `position:absolute;left:14px;top:14px;font-family:${MONO};font-size:${FS_SM};letter-spacing:var(--ls-label);background:${T.ink};color:${T.bg};border:none;padding:8px 12px;cursor:pointer`, '← BACK TO THE MAP');
      back.onclick = () => this.comeOut();
      this.mapWrap.appendChild(back);
    }
    this.mapWrap.appendChild(this.navControl(T));
    this.tipEl = el('div', `position:absolute;display:none;max-width:250px;border:var(--border-w) solid ${T.ink};background:${T.bg};color:${T.ink};padding:7px 10px;font-size:var(--fs-label);line-height:1.5;pointer-events:none;z-index:5`);
    this.mapWrap.appendChild(this.tipEl);
    this.paintSel();
  }

  /** The map's own controls, stacked top-right: fit, reset, zoom, compass, projection, help. */
  private navControl(T: Theme) {
    const box = el('div', `position:absolute;right:14px;top:14px;display:flex;flex-direction:column;border:var(--border-w) solid ${T.ink};background:${T.bg};z-index:4`);
    const BTN = `font-family:${MONO};font-size:${FS_SM};letter-spacing:var(--ls-label);background:none;border:none;border-bottom:var(--border-w) solid ${T.ink};color:${T.ink};padding:7px 10px;cursor:pointer;text-align:left;white-space:nowrap;min-width:78px;line-height:1;box-sizing:border-box`;
    const btn = (label: string, title: string, act: () => void, css = '') => {
      const b = el('button', BTN + css, label);
      b.title = title; b.setAttribute('aria-label', title);
      b.onclick = act;
      box.appendChild(b);
      return b;
    };
    btn('⌖ FIT', 'Frame the whole atlas (F)', () => this.scene?.fit());
    btn('⟲ RESET', 'Back to the isometric view (R)', () => this.scene?.reset());
    const zoomRow = el('div', `display:flex;border-bottom:var(--border-w) solid ${T.ink}`);
    const zb = (label: string, title: string, k: number, extra: string) => {
      const b = el('button', `${BTN};border-bottom:none;flex:1;min-width:0;text-align:center;${extra}`, label);
      b.title = title; b.setAttribute('aria-label', title);
      b.onclick = () => this.scene?.zoomBy(k);
      zoomRow.appendChild(b);
    };
    zb('+', 'Zoom in (+)', 1.35, `border-right:var(--border-w) solid ${T.ink}`);
    zb('−', 'Zoom out (−)', 1 / 1.35, '');
    box.appendChild(zoomRow);
    // compass: the needle points to the map's north — the top of the default isometric view
    const cb = el('button', `${BTN};display:flex;align-items:center;gap:8px`);
    cb.title = 'Turn back to north (N)'; cb.setAttribute('aria-label', cb.title);
    const needle = el('span', 'display:inline-block;width:16px;height:16px;transition:transform .12s linear;transform-origin:50% 50%');
    needle.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" style="display:block"><circle cx="8" cy="8" r="7" fill="none" stroke="${T.ink}" stroke-width="1.2"/><path d="M8 1.5 L10.4 8 L8 6.8 L5.6 8 Z" fill="${T.ink}"/><path d="M8 14.5 L10.4 8 L8 9.2 L5.6 8 Z" fill="none" stroke="${T.ink}" stroke-width="1"/></svg>`;
    cb.appendChild(needle); cb.appendChild(el('span', '', 'N'));
    cb.onclick = () => this.scene?.resetHeading();
    box.appendChild(cb);
    this.compassEl = needle;
    // projection
    this.projEl = btn(this.projection === 'flat' ? '▱ FLAT' : '◇ DEEP', 'FLAT is the drafting view (orthographic); DEEP adds perspective', () => {
      if (!this.scene) return;
      this.projection = this.scene.getProjection() === 'flat' ? 'deep' : 'flat';
      this.scene.setProjection(this.projection);
    });
    // help
    const wrap = el('div', 'position:relative');
    const tipBox = el('div', `position:absolute;right:100%;bottom:0;margin-right:8px;width:236px;display:none;border:var(--border-w) solid ${T.ink};background:${T.bg};color:${T.ink};padding:10px 12px;font-size:${FS_SM};line-height:1.8;letter-spacing:.06em;text-align:left;white-space:normal`);
    const row = (k: string, v: string) => `<div style="display:flex;gap:10px"><span style="flex:none;width:96px;color:${T.dim}">${k}</span><span>${v}</span></div>`;
    tipBox.innerHTML = [
      `<div style="font-size:var(--fs-kicker);letter-spacing:var(--ls-kicker);margin-bottom:6px">MOUSE</div>`,
      row('DRAG', 'pan'), row('RIGHT-DRAG', 'rotate &amp; tilt'), row('CTRL + DRAG', 'rotate &amp; tilt'), row('WHEEL', 'zoom at the cursor'),
      row('CLICK', 'select a block, or an import to read it'), row('DOUBLE-CLICK', 'go inside · a line frames both ends'),
      `<div style="font-size:var(--fs-kicker);letter-spacing:var(--ls-kicker);margin:8px 0 6px">TOUCH</div>`,
      row('ONE FINGER', 'pan'), row('TWO FINGERS', 'pinch to zoom, twist to turn'),
      `<div style="font-size:var(--fs-kicker);letter-spacing:var(--ls-kicker);margin:8px 0 6px">KEYBOARD (MAP FOCUSED)</div>`,
      row('ARROWS', 'pan · shift for more'), row('+ / −', 'zoom'), row('F', 'fit'), row('R', 'reset view'), row('N', 'north'), row('ESC', 'back out'),
    ].join('');
    const help = el('button', `${BTN};border-bottom:none;text-align:center;width:100%`, '?');
    help.title = 'How to move around'; help.setAttribute('aria-label', help.title);
    const show = (on: boolean) => { tipBox.style.display = on ? 'block' : 'none'; };
    help.onclick = () => show(tipBox.style.display === 'none');
    help.onmouseenter = () => show(true);
    help.onfocus = () => show(true);
    help.onblur = () => show(false);
    box.onmouseleave = () => show(false);
    wrap.appendChild(help); wrap.appendChild(tipBox);
    box.appendChild(wrap);
    return box;
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
  fitView() { this.scene?.fit(); }

  // ───────────────────────── state ─────────────────────────
  select(id: string, fromTrace?: boolean) {
    if (!fromTrace && this.traceI >= 0) { this.traceI = -1; this.setHash(''); }
    if (this.selEdge) { this.selEdge = null; this.setHash(''); }
    this.sel = (this.sel === id && !fromTrace) ? null : id;
    this.syncUI();
  }
  /** Select an import by its key. Clicking the selected one again lets go of it. */
  selectEdge(key: string, silent?: boolean) {
    if (this.traceI >= 0) this.traceI = -1;
    this.sel = null;
    this.selEdge = this.selEdge === key ? null : key;
    if (!silent) { const e = this.selEdge ? this.edgeByKey[this.selEdge] : null; this.setHash(e ? `#edge=${e.e.f},${e.e.t}` : ''); }
    this.syncUI();
  }
  /** Nothing picked out: no block, no import, no trace. */
  clearSelection() {
    const had = this.selEdge || this.traceI >= 0;
    this.sel = null; this.selEdge = null;
    if (had) this.setHash('');
    this.syncUI();
  }
  syncUI() { this.paintSel(); this.renderPanel(); }
  paintSel() {
    const T = this.theme();
    const edge = this.selEdge ? this.edgeByKey[this.selEdge] : null;
    // a trace dims to its step; a selected import dims to its two ends
    const keep = this.traceI >= 0 ? [this.D.TRACE[this.traceI][0]] : edge ? [edge.e.f, edge.e.t] : null;
    this.scene?.setSelection(this.sel, keep, edge ? this.selEdge : null);
    if (this.rowEls) for (const id in this.rowEls) {
      const r = this.rowEls[id], on = this.sel === id;
      r.style.background = on ? T.ink : ''; r.style.color = on ? T.bg : '';
      (r.querySelector('span') as HTMLSpanElement).style.borderColor = on ? T.bg : T.ink;
    }
  }
  setHash(h: string) { try { history.replaceState(null, '', location.pathname + location.search + (h || '#')); } catch { /* noop */ } }
  goInside(id: string, silent?: boolean) {
    this.inside = id; this.sel = null; this.selEdge = null; this.traceI = -1;
    if (!silent) this.setHash('#inside=' + id);
    this.renderScene(); this.renderPanel();
  }
  comeOut(silent?: boolean) {
    const was = this.inside;
    this.inside = null; this.sel = was;
    if (!silent) this.setHash('');
    this.renderScene(); this.renderPanel();
  }
  startTrace() { if (this.inside) this.comeOut(true); this.selEdge = null; this.traceI = 0; this.applyTrace(); }
  stepTrace(d: number) { this.traceI = Math.max(0, Math.min(this.D.TRACE.length - 1, this.traceI + d)); this.applyTrace(); }
  endTrace() { this.traceI = -1; this.sel = null; this.selEdge = null; this.setHash(''); this.syncUI(); }
  applyTrace() { const st = this.D.TRACE[this.traceI]; this.sel = st[0]; this.setHash('#trace=' + this.traceI); this.syncUI(); this.scene?.focus(st[0]); }

  // ───────────────────────── right panel ─────────────────────────
  rich(t: string) { const T = this.theme(); return esc(t).replace(/\[\[(.+?)\]\]/g, `<span style="background:${T.ink};color:${T.bg};padding:0 4px">$1</span>`); }
  hRule(label: string) { const T = this.theme(); return `<div style="display:flex;align-items:center;gap:9px;margin:20px 0 9px"><span style="font-size:var(--fs-kicker);letter-spacing:var(--ls-kicker);white-space:nowrap">${label}</span><span style="flex:1;height:var(--border-w);background:${T.ink}"></span></div>`; }
  renderPanel() {
    const T = this.theme(), D = this.D, Pn = this.panelEl;
    const btn = `font-family:${MONO};font-size:var(--fs-label);letter-spacing:var(--ls-label);border:var(--border-w) solid ${T.ink};background:none;color:${T.ink};padding:9px 13px;cursor:pointer`;
    if (this.traceI >= 0) {
      const [id, sentence] = D.TRACE[this.traceI];
      const s = this.byId[id];
      Pn.innerHTML = `
        <div style="font-size:var(--fs-kicker);letter-spacing:var(--ls-kicker);color:${T.dim}">TRACE — ${esc(D.traceTitle || 'ONE SLIDER DRAG')}, END TO END</div>
        <div style="font-size:var(--fs-display);font-weight:700;margin:10px 0 2px">${String(this.traceI + 1).padStart(2, '0')}<span style="color:${T.dim};font-size:var(--fs-stat)"> / ${D.TRACE.length}</span></div>
        <div style="font-size:var(--fs-body);letter-spacing:var(--ls-label);margin-bottom:14px">${s.code} · ${esc(s.name.toUpperCase())}</div>
        <div style="font-size:var(--fs-body);line-height:var(--leading-body);border-left:var(--border-w-heavy) solid ${T.ink};padding-left:13px">${this.rich(sentence)}</div>
        <div style="display:flex;gap:8px;margin-top:22px">
          <button id="tPrev" style="${btn}${this.traceI === 0 ? ';opacity:.35' : ''}">‹ PREV</button>
          <button id="tNext" style="${btn};background:${T.ink};color:${T.bg}${this.traceI === D.TRACE.length - 1 ? ';opacity:.35' : ''}">NEXT ›</button>
          <span style="flex:1"></span>
          <button id="tEnd" style="${btn}">✕ END</button>
        </div>
        <div style="margin-top:14px;font-size:var(--fs-kicker);letter-spacing:var(--ls-label);color:${T.dim}">← → ARROW KEYS STEP · ESC ENDS</div>`;
      (Pn.querySelector('#tPrev') as HTMLButtonElement).onclick = () => this.stepTrace(-1);
      (Pn.querySelector('#tNext') as HTMLButtonElement).onclick = () => this.stepTrace(1);
      (Pn.querySelector('#tEnd') as HTMLButtonElement).onclick = () => this.endTrace();
      return;
    }
    const edge = this.selEdge ? this.edgeByKey[this.selEdge] : null;
    if (edge) {
      // an import: where it comes from, where it goes, and what travels along it
      const { f, t } = edge, e = edge.e;
      const sf = this.byId[f.id], st = this.byId[t.id];
      const endBtn = (s: Structure) => `<button data-id="${s.id}" style="${btn};display:flex;align-items:baseline;gap:10px;width:100%;text-align:left"><span style="font-size:var(--fs-stat);font-weight:700;border:var(--border-w) solid ${T.ink};padding:0 6px">${s.code}</span><span style="flex:1;font-size:var(--fs-body);font-weight:700">${esc(s.name)}</span><span style="font-size:var(--fs-kicker);color:${T.dim};white-space:nowrap">${esc(s.loc.split('·')[1] || s.loc)}</span></button>`;
      Pn.innerHTML = `
        <button id="pBack" style="border:none;background:none;color:${T.dim};font-family:${MONO};font-size:${FS_SM};letter-spacing:var(--ls-label);cursor:pointer;padding:0">← OVERVIEW</button>
        <div style="font-size:var(--fs-kicker);letter-spacing:var(--ls-kicker);color:${T.dim};margin:14px 0 6px">${e.dashed ? 'LOOSE LINK' : 'IMPORT'}${e.flow ? ' · CARRIES THE FLOW' : ''}</div>
        <div style="font-size:var(--fs-title);font-weight:700;line-height:var(--leading-title)">${esc(f.name)} <span style="color:${T.dim}">→</span> ${esc(t.name)}</div>
        ${this.hRule('WHAT TRAVELS')}
        <div style="font-size:var(--fs-body);line-height:var(--leading-body);border-left:var(--border-w-heavy) solid ${T.ink};padding-left:13px">${e.pay ? this.rich(e.pay) : `<span style="color:${T.dim}">The scan saw the import but nothing names what it carries.</span>`}</div>
        ${this.hRule('FROM')}
        <div id="pEnds">${sf ? endBtn(sf) : ''}</div>
        ${this.hRule('TO')}
        <div id="pEnds2">${st ? endBtn(st) : ''}</div>
        ${e.dashed ? `<div style="margin-top:14px;font-size:var(--fs-label);line-height:1.6;color:${T.dim}">Dashed means the link is optional, lazy, or a type-only import: nothing runs through it at start-up.</div>` : ''}
        <button id="pFocus" style="${btn};margin-top:22px;width:100%">⌖ FRAME BOTH ENDS</button>
        <div style="margin-top:14px;font-size:var(--fs-kicker);letter-spacing:var(--ls-label);color:${T.dim}">DOUBLE-CLICK THE LINE FRAMES IT · ESC LETS GO</div>`;
      (Pn.querySelector('#pBack') as HTMLButtonElement).onclick = () => this.clearSelection();
      (Pn.querySelector('#pFocus') as HTMLButtonElement).onclick = () => this.scene?.focusEdge(this.selEdge!);
      Pn.querySelectorAll<HTMLButtonElement>('#pEnds button, #pEnds2 button').forEach((b) => { b.onclick = () => { this.select(b.dataset.id!); this.scene?.focus(b.dataset.id!); }; });
      return;
    }
    const cur: ViewStruct | undefined = this.sel
      ? (this.inside ? this.structsNow().find((x) => x.id === this.sel) : this.byId[this.sel])
      : undefined;
    if (cur) {
      const talks = (cur.talks || []).map((tid) => this.byId[tid]).filter(Boolean);
      Pn.innerHTML = `
        <button id="pBack" style="border:none;background:none;color:${T.dim};font-family:${MONO};font-size:${FS_SM};letter-spacing:var(--ls-label);cursor:pointer;padding:0">← ${this.inside ? esc(this.byId[this.inside].name.toUpperCase()) : 'OVERVIEW'}</button>
        <div style="display:flex;align-items:baseline;gap:12px;margin:14px 0 2px">
          <span style="font-size:26px;font-weight:700;border:var(--border-w-heavy) solid ${T.ink};padding:1px 9px">${cur.code}</span>
          <span style="font-size:var(--fs-title);font-weight:700;line-height:var(--leading-title)">${esc(cur.name)}</span>
        </div>
        <div style="font-size:var(--fs-label);letter-spacing:var(--ls-label);color:${T.dim};margin-bottom:4px">${cur.group ? esc(cur.group) + ' · ' : ''}${esc(cur.loc || '')}</div>
        ${this.hRule('WHAT IT DOES')}
        <div style="font-size:var(--fs-body);line-height:var(--leading-body)">${this.rich(cur.what)}</div>
        ${cur.how ? this.hRule("HOW IT'S BUILT") + `<div style="font-size:var(--fs-body);line-height:var(--leading-body)">${this.rich(cur.how)}</div>` : ''}
        ${cur.src ? this.hRule('SOURCE') + `<div style="font-size:var(--fs-label);line-height:2;color:${T.dim}">${cur.src.map(esc).join('<br>')}</div>` : ''}
        ${talks.length ? this.hRule('TALKS TO') + `<div id="pTalks" style="display:flex;flex-wrap:wrap;gap:6px">${talks.map((t) => `<button data-id="${t.id}" style="${btn};padding:5px 9px;font-size:${FS_SM}">${t.code} ${esc(t.name.toUpperCase())}</button>`).join('')}</div>` : ''}
        <div style="display:flex;gap:8px;margin-top:22px">
          <button id="pFocus" style="${btn};flex:1">⌖ FLY TO</button>
          ${cur.children ? `<button id="pIn" style="${btn};background:${T.ink};color:${T.bg};flex:2">▣ GO INSIDE — ${cur.children.length} PARTS</button>` : ''}
        </div>`;
      (Pn.querySelector('#pBack') as HTMLButtonElement).onclick = () => { this.sel = null; this.syncUI(); };
      (Pn.querySelector('#pFocus') as HTMLButtonElement).onclick = () => this.scene?.focus(cur.id);
      const pin = Pn.querySelector('#pIn') as HTMLButtonElement | null; if (pin) pin.onclick = () => this.goInside(cur.id);
      Pn.querySelectorAll<HTMLButtonElement>('#pTalks button').forEach((b) => { b.onclick = () => { this.select(b.dataset.id!); this.scene?.focus(b.dataset.id!); }; });
      return;
    }
    // overview
    Pn.innerHTML = `
      <div style="font-size:var(--fs-kicker);letter-spacing:var(--ls-kicker);color:${T.dim}">${esc(D.overviewKicker)} — ${esc(D.overviewSub.toUpperCase())}</div>
      <div style="font-size:var(--fs-title);font-weight:700;line-height:var(--leading-title);margin:10px 0 4px;text-wrap:balance">${esc(D.overviewTitle)}</div>
      ${this.hRule('WHAT IT DOES')}
      ${D.OVERVIEW_WHAT.map((p) => `<p style="font-size:var(--fs-body);line-height:var(--leading-body);margin:0 0 11px">${this.rich(p)}</p>`).join('')}
      ${this.hRule("HOW IT'S BUILT")}
      ${D.OVERVIEW_HOW.map((p) => `<p style="font-size:var(--fs-body);line-height:var(--leading-body);margin:0 0 11px">${this.rich(p)}</p>`).join('')}
      <div style="border:var(--border-w) solid ${T.ink};padding:11px 13px;font-size:var(--fs-body);line-height:var(--leading-body);margin-top:18px">${this.rich(D.HOW_TO_READ)}</div>
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

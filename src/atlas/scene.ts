/* Codebase Atlas — the 3D scene.

   The map is a Three.js scene navigated with MapControls: left-drag pans, right-drag (or ctrl-drag)
   rotates and tilts, the wheel zooms toward the cursor, one finger pans, two fingers pinch and turn.
   The orthographic camera is the default so the drafting-paper isometric look survives; DEEP swaps in
   a perspective camera at the same target, heading, and visual scale.

   Everything the engine knows — blocks, edges, externals, the theme — comes in through `setData`.
   Everything the engine needs back — hover, click, double-click, the heading for the compass — goes
   out through the callbacks in `SceneHooks`. Labels are DOM, not WebGL: crisp monospace text that
   stays upright at any angle, positioned by projecting anchors each time the camera moves. */

import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Edge, External, Theme } from './types';

export const MONO = "ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,monospace";

/** The prototype's isometric projection: x = (gx−gy)·SX, y = (gx+gy)·SY − h·SH. The camera below
    reproduces it exactly: azimuth 45°, elevation asin(SY/SX), one grid unit = SX/cos45 pixels. */
const SX = 26, SY = 14.3, SH = 16;
const ELEV = Math.asin(SY / SX);                     // 33.4° above the ground
export const BASE_PX = SX / Math.cos(Math.PI / 4);   // px per world unit at camera.zoom = 1
const HZ = SH / (Math.cos(ELEV) * BASE_PX);          // world height of h = 1
const DEFAULT_POLAR = Math.PI / 2 - ELEV;
const DEFAULT_AZIMUTH = Math.PI / 4;
const FOV = 38;
const ORTHO_RADIUS = 160;                            // how far back the ortho camera sits; only depth matters
const ZOOM_OUT = 2.2, ZOOM_IN = 5;                   // how far past the fit view you may go, either way
const PAD_PX = 34;
const DRAG_PX = 4;                                   // pointer travel that turns a click into a drag

export type Projection = 'flat' | 'deep';

export interface SceneBlock {
  id: string; code: string; name: string; loc: string;
  gx: number; gy: number; w: number; d: number; h: number; slab?: 0 | 1;
  /** The block has an inside — the tooltip and double-click say so. */
  enterable: boolean;
}
export interface SceneEdge { e: Edge; f: SceneBlock; t: SceneBlock }
export interface SceneExternal { x: External; t: SceneBlock }

export interface SceneHooks {
  onHoverBlock(b: SceneBlock | null, ev: PointerEvent): void;
  onHoverEdge(e: SceneEdge | null, ev: PointerEvent): void;
  onClick(b: SceneBlock | null): void;
  onDblClick(b: SceneBlock): void;
  /** Camera heading changed — `turn` is radians away from the default isometric heading. */
  onView(turn: number, projection: Projection): void;
  /** Arrow keys are spoken for elsewhere (the trace), so the scene leaves them alone. */
  arrowsTaken(): boolean;
}

interface BlockRec {
  b: SceneBlock; mesh: THREE.Mesh; top: THREE.MeshBasicMaterial;
  codeEl: HTMLDivElement; nameEl: HTMLDivElement; locEl: HTMLDivElement | null;
  codeFS: number; area: number;
}
interface EdgeRec { e: SceneEdge; curve: THREE.Curve<THREE.Vector3>; len: number; line: THREE.Line; proxy: THREE.Mesh }
interface Dot { rec: EdgeRec; t: number; sprite: THREE.Sprite }
interface ExtRec { el: HTMLDivElement; at: THREE.Vector3 }

interface CamState { target: THREE.Vector3; theta: number; phi: number; radius: number; zoom: number }
interface Tween { from: CamState; to: CamState; t0: number; ms: number; done?: () => void }

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export class AtlasScene {
  private T: Theme;
  private host: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private labelLayer: HTMLDivElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private ortho: THREE.OrthographicCamera;
  private persp: THREE.PerspectiveCamera;
  private camera: THREE.Camera;
  private controls: MapControls;
  private projection: Projection = 'flat';
  private raycaster = new THREE.Raycaster();
  private light: THREE.DirectionalLight;
  private ground: THREE.Mesh;

  private blocks: BlockRec[] = [];
  private byId: Record<string, BlockRec> = {};
  private edges: EdgeRec[] = [];
  private dots: Dot[] = [];
  private exts: ExtRec[] = [];
  private content = new THREE.Group();
  /** Block meshes and edge proxies — the only things the raycaster looks at. */
  private pickables: THREE.Object3D[] = [];
  private disposables: { dispose(): void }[] = [];
  private textures: Record<string, THREE.Texture> = {};

  /** Where the target may go (content plus a margin) and what FIT frames (content alone). */
  private bounds = new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 1, 1));
  private fitBox = new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 1, 1));
  private fitZoom = 1;
  private hovered: BlockRec | null = null;
  private hoveredEdge: EdgeRec | null = null;
  private selected: string | null = null;
  private dimmed: Set<string> | null = null;
  private flow = true;
  private needsRender = true;
  private labelsDirty = true;
  private tween: Tween | null = null;
  private raf = 0;
  private lastT = 0;
  private dead = false;
  private ro: ResizeObserver;
  private press: { x: number; y: number; id: number; moved: boolean } | null = null;
  private suppressClick = false;
  private lastView = { turn: NaN, projection: 'flat' as Projection };

  constructor(host: HTMLDivElement, theme: Theme, private hooks: SceneHooks) {
    this.T = theme;
    this.host = host;
    (host as unknown as { __scene?: AtlasScene }).__scene = this;   // a handle for devtools
    host.style.cssText += ';position:relative;overflow:hidden;touch-action:none';

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.setClearColor(theme.bg);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.canvas = this.renderer.domElement;
    this.canvas.style.cssText = 'display:block;width:100%;height:100%;outline:none;cursor:grab';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'application');
    this.canvas.setAttribute('aria-label', 'Codebase atlas map. Drag to pan, right-drag to rotate, scroll to zoom. Arrow keys pan, plus and minus zoom, F fits, R resets.');
    host.appendChild(this.canvas);

    this.labelLayer = document.createElement('div');
    this.labelLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;font-family:' + MONO;
    host.appendChild(this.labelLayer);

    const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight);
    this.ortho = new THREE.OrthographicCamera(-w / 2 / BASE_PX, w / 2 / BASE_PX, h / 2 / BASE_PX, -h / 2 / BASE_PX, 0.1, 2000);
    this.persp = new THREE.PerspectiveCamera(FOV, w / h, 0.1, 2000);
    this.camera = this.ortho;
    this.renderer.setSize(w, h, false);

    // lights: a soft key from the upper left so depth reads from every angle, shadows on the paper
    this.scene.add(new THREE.AmbientLight(0xffffff, 1));
    this.light = new THREE.DirectionalLight(0xffffff, 0.4);
    this.light.castShadow = true;
    this.light.shadow.mapSize.set(2048, 2048);
    this.light.shadow.radius = 3;
    this.light.shadow.bias = -0.0008;
    this.scene.add(this.light, this.light.target);
    const shadowMat = new THREE.ShadowMaterial({ color: new THREE.Color(theme.ink), opacity: 0.16, transparent: true });
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shadowMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
    this.scene.add(this.content);

    this.controls = this.makeControls(this.ortho);
    this.applyState({ target: new THREE.Vector3(), theta: DEFAULT_AZIMUTH, phi: DEFAULT_POLAR, radius: ORTHO_RADIUS, zoom: 1 });

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.bindPointer();
    this.bindKeys();
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  // ───────────────────────── controls ─────────────────────────
  private makeControls(cam: THREE.Camera) {
    const c = new MapControls(cam, this.canvas);
    c.enableDamping = !reducedMotion();
    c.dampingFactor = 0.12;
    c.zoomToCursor = true;
    c.screenSpacePanning = false;            // pan along the paper, never off it
    c.minPolarAngle = 0.18;                  // almost straight down …
    c.maxPolarAngle = 1.34;                  // … to 77°: never under the ground
    c.zoomSpeed = 1.1;
    c.rotateSpeed = 0.6;
    c.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    c.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
    c.addEventListener('start', () => { this.tween = null; this.canvas.style.cursor = 'grabbing'; });
    c.addEventListener('end', () => { this.canvas.style.cursor = this.hovered ? 'pointer' : 'grab'; });
    c.addEventListener('change', () => { this.clampTarget(); this.invalidate(); });
    this.applyLimits(c);
    return c;
  }
  private applyLimits(c = this.controls) {
    c.minZoom = this.fitZoom / ZOOM_OUT; c.maxZoom = this.fitZoom * ZOOM_IN;
    // distance limits only mean something to the perspective camera; the ortho camera's radius is depth, not scale
    const deep = this.projection === 'deep';
    c.minDistance = deep ? this.distanceFor(this.fitZoom * ZOOM_IN) : 0;
    c.maxDistance = deep ? this.distanceFor(this.fitZoom / ZOOM_OUT) : Infinity;
  }
  /** Perspective distance that shows the target plane at the same scale as an ortho zoom. */
  private distanceFor(zoom: number) {
    const visible = this.host.clientHeight / (BASE_PX * zoom);
    return visible / (2 * Math.tan(THREE.MathUtils.degToRad(FOV) / 2));
  }
  private zoomFor(distance: number) {
    const visible = 2 * distance * Math.tan(THREE.MathUtils.degToRad(FOV) / 2);
    return this.host.clientHeight / (BASE_PX * visible);
  }
  private currentZoom() {
    return this.projection === 'flat' ? this.ortho.zoom : this.zoomFor(this.persp.position.distanceTo(this.controls.target));
  }
  private clampTarget() {
    const t = this.controls.target, b = this.bounds;
    const x = THREE.MathUtils.clamp(t.x, b.min.x, b.max.x), z = THREE.MathUtils.clamp(t.z, b.min.z, b.max.z);
    const dx = x - t.x, dz = z - t.z, dy = -t.y;
    if (dx || dz || dy) { t.set(x, 0, z); this.camera.position.x += dx; this.camera.position.z += dz; this.camera.position.y += dy; }
  }

  private state(): CamState {
    const off = new THREE.Vector3().copy(this.camera.position).sub(this.controls.target);
    const s = new THREE.Spherical().setFromVector3(off);
    return { target: this.controls.target.clone(), theta: s.theta, phi: s.phi, radius: s.radius, zoom: this.currentZoom() };
  }
  private applyState(s: CamState) {
    this.controls.target.copy(s.target);
    const radius = this.projection === 'flat' ? ORTHO_RADIUS : this.distanceFor(s.zoom);
    const off = new THREE.Vector3().setFromSpherical(new THREE.Spherical(radius, s.phi, s.theta));
    this.camera.position.copy(s.target).add(off);
    this.camera.lookAt(s.target);
    if (this.projection === 'flat') { this.ortho.zoom = s.zoom; this.ortho.updateProjectionMatrix(); }
    this.controls.update();
    this.invalidate();
  }
  private animateTo(to: Partial<CamState>, ms = 650, done?: () => void) {
    const from = this.state();
    const full: CamState = { ...from, ...to, target: (to.target ?? from.target).clone() };
    // turn the short way round
    let dth = full.theta - from.theta;
    dth = Math.atan2(Math.sin(dth), Math.cos(dth));
    full.theta = from.theta + dth;
    if (reducedMotion() || ms <= 0) { this.applyState(full); done?.(); return; }
    this.tween = { from, to: full, t0: performance.now(), ms, done };
    this.invalidate();
  }
  private stepTween(now: number) {
    const tw = this.tween; if (!tw) return;
    const u = Math.min(1, (now - tw.t0) / tw.ms), k = ease(u);
    const f = tw.from, t = tw.to;
    this.applyState({
      target: f.target.clone().lerp(t.target, k),
      theta: f.theta + (t.theta - f.theta) * k,
      phi: f.phi + (t.phi - f.phi) * k,
      radius: f.radius + (t.radius - f.radius) * k,
      zoom: Math.exp(Math.log(f.zoom) + (Math.log(t.zoom) - Math.log(f.zoom)) * k),
    });
    if (u >= 1) { this.tween = null; tw.done?.(); }
  }

  // ───────────────────────── public camera actions ─────────────────────────
  /** Frame the whole atlas at the current heading and tilt. */
  fit(animate = true) {
    const { zoom, center } = this.fitFor(this.state());
    this.fitZoom = zoom; this.applyLimits();
    this.animateTo({ target: center, zoom }, animate ? 650 : 0);
  }
  /** The original isometric composition: default heading and tilt, whole atlas framed. */
  reset(animate = true) {
    const s = { ...this.state(), theta: DEFAULT_AZIMUTH, phi: DEFAULT_POLAR };
    const { zoom, center } = this.fitFor(s);
    this.fitZoom = zoom; this.applyLimits();
    this.animateTo({ target: center, zoom, theta: DEFAULT_AZIMUTH, phi: DEFAULT_POLAR }, animate ? 750 : 0);
  }
  /** Fly to a block and frame it. */
  focus(id: string) {
    const r = this.byId[id]; if (!r) return;
    const b = r.b;
    const target = new THREE.Vector3(b.gx + b.w / 2, 0, b.gy + b.d / 2);
    const zoom = THREE.MathUtils.clamp(Math.max(this.currentZoom(), this.fitZoom * 2.4), this.fitZoom / ZOOM_OUT, this.fitZoom * ZOOM_IN);
    this.animateTo({ target, zoom }, 700);
  }
  /** Turn back to the default heading, keeping tilt, zoom, and target. */
  resetHeading() { this.animateTo({ theta: DEFAULT_AZIMUTH }, 550); }
  zoomBy(k: number) {
    const zoom = THREE.MathUtils.clamp(this.currentZoom() * k, this.fitZoom / ZOOM_OUT, this.fitZoom * ZOOM_IN);
    this.animateTo({ zoom }, 300);
  }
  panBy(px: number, py: number) {
    // screen-space pixels → world, along the paper
    const s = this.state();
    const scale = 1 / (BASE_PX * s.zoom);
    const right = new THREE.Vector3(Math.cos(s.theta), 0, -Math.sin(s.theta));
    const fwd = new THREE.Vector3(-Math.sin(s.theta), 0, -Math.cos(s.theta));
    const target = s.target.clone().addScaledVector(right, px * scale).addScaledVector(fwd, py * scale / Math.max(0.2, Math.sin(s.phi)));
    target.x = THREE.MathUtils.clamp(target.x, this.bounds.min.x, this.bounds.max.x);
    target.z = THREE.MathUtils.clamp(target.z, this.bounds.min.z, this.bounds.max.z);
    this.animateTo({ target }, 220);
  }
  getProjection() { return this.projection; }
  /** FLAT (orthographic) ↔ DEEP (perspective), keeping target, heading, tilt, and visual scale. */
  setProjection(p: Projection) {
    if (p === this.projection) return;
    const s = this.state();
    this.tween = null;
    this.controls.dispose();
    this.projection = p;
    this.camera = p === 'flat' ? this.ortho : this.persp;
    this.controls = this.makeControls(this.camera);
    this.applyState(s);
    this.invalidate(); this.labelsDirty = true;
  }

  private fitFor(s: CamState): { zoom: number; center: THREE.Vector3 } {
    // project the content box into a camera at this heading/tilt and size it to the viewport
    const b = this.fitBox, center = new THREE.Vector3(); b.getCenter(center); center.y = 0;
    const off = new THREE.Vector3().setFromSpherical(new THREE.Spherical(100, s.phi, s.theta));
    const cam = new THREE.OrthographicCamera(); cam.position.copy(center).add(off); cam.lookAt(center); cam.updateMatrixWorld();
    const inv = cam.matrixWorld.clone().invert();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < 8; i++) {
      const p = new THREE.Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).applyMatrix4(inv);
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const w = Math.max(0.5, maxX - minX), h = Math.max(0.5, maxY - minY);
    const vw = Math.max(1, this.host.clientWidth - PAD_PX * 2), vh = Math.max(1, this.host.clientHeight - PAD_PX * 2 - 44);
    const zoom = Math.min(vw / (w * BASE_PX), vh / (h * BASE_PX));
    // centre on the box centre, nudged so the projected box sits in the middle of the viewport
    const mid = new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, 0).applyMatrix4(cam.matrixWorld);
    // move the target along the paper by the horizontal component only; vertical shift would lift it off the ground
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const dx = mid.clone().sub(center).dot(right);
    center.addScaledVector(right, dx);
    return { zoom, center };
  }

  // ───────────────────────── content ─────────────────────────
  setFlow(on: boolean) { this.flow = on; this.invalidate(); }
  setSelection(sel: string | null, dim: string[] | null) {
    this.selected = sel; this.dimmed = dim ? new Set(dim) : null;
    this.blocks.forEach((r) => this.paintBlock(r));
    this.invalidate();
  }
  private paintBlock(r: BlockRec) {
    const T = this.T, sel = this.selected === r.b.id, hover = this.hovered === r;
    r.top.color.set(sel ? T.ink : hover ? T.faceB : T.top);
    r.codeEl.style.color = sel ? T.bg : T.ink;
    const dim = this.dimmed ? !this.dimmed.has(r.b.id) : false;
    const mats = r.mesh.material as THREE.Material[];
    mats.forEach((m) => { m.transparent = dim; m.opacity = dim ? 0.22 : 1; m.needsUpdate = true; });
    r.codeEl.style.opacity = r.nameEl.style.opacity = dim ? '0.22' : '1';
    if (r.locEl) r.locEl.style.opacity = dim ? '0.22' : '1';
  }

  private clear() {
    this.content.clear();
    this.disposables.forEach((d) => d.dispose()); this.disposables = [];
    this.blocks = []; this.byId = {}; this.edges = []; this.dots = []; this.exts = []; this.pickables = [];
    this.hovered = null; this.hoveredEdge = null;
    this.labelLayer.innerHTML = '';
  }

  private hatch(key: 'A' | 'B' | 'Ad' | 'Bd') {
    if (this.textures[key]) return this.textures[key];
    const T = this.T, size = 128, c = document.createElement('canvas'); c.width = c.height = size;
    const g = c.getContext('2d')!;
    const base = new THREE.Color(key[0] === 'A' ? T.faceA : T.faceB);
    if (key.endsWith('d')) base.multiplyScalar(0.88);   // the faces that hide at the default angle: a touch darker
    g.fillStyle = '#' + base.getHexString(); g.fillRect(0, 0, size, size);
    const n = key[0] === 'A' ? 8 : 6, gap = size / n;
    g.strokeStyle = T.ink; g.globalAlpha = key[0] === 'A' ? 0.5 : 0.28; g.lineWidth = 1.6;
    const dir = key[0] === 'A' ? 1 : -1;
    for (let i = -n; i <= 2 * n; i++) {
      const k = i * gap;
      g.beginPath();
      if (dir > 0) { g.moveTo(k, 0); g.lineTo(k - size, size); } else { g.moveTo(k, 0); g.lineTo(k + size, size); }
      g.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    tex.colorSpace = THREE.SRGBColorSpace;
    this.textures[key] = tex; this.disposables.push(tex);
    return tex;
  }
  private label(css: string, text: string) {
    const d = document.createElement('div');
    d.style.cssText = `position:absolute;left:0;top:0;white-space:nowrap;will-change:transform;${css}`;
    d.textContent = text;
    this.labelLayer.appendChild(d);
    return d;
  }

  setData(blocks: SceneBlock[], edges: SceneEdge[], externals: SceneExternal[], theme: Theme) {
    this.T = theme;
    this.clear();
    this.textures = {};
    this.renderer.setClearColor(theme.bg);
    (this.ground.material as THREE.ShadowMaterial).color.set(theme.ink);
    const T = theme;
    const ink = new THREE.Color(T.ink);

    // ── blocks ──
    const sideB = new THREE.MeshBasicMaterial({ map: this.hatch('B') });
    const sideBd = new THREE.MeshBasicMaterial({ map: this.hatch('Bd') });
    const sideA = new THREE.MeshBasicMaterial({ map: this.hatch('A') });
    const sideAd = new THREE.MeshBasicMaterial({ map: this.hatch('Ad') });
    const bottom = new THREE.MeshBasicMaterial({ color: T.faceA });
    this.disposables.push(sideA, sideAd, sideB, sideBd, bottom);
    const outlineGeos: THREE.BufferGeometry[] = [];
    const box = new THREE.Box3();
    blocks.forEach((b) => {
      const H = Math.max(0.02, b.h * HZ);
      const geo = new THREE.BoxGeometry(b.w, H, b.d);
      // hatch in world units: scale each face's UVs by its size. faces: +x −x +y −y +z −z, 4 verts each
      const uv = geo.attributes.uv as THREE.BufferAttribute;
      const faceScale = [[b.d, H], [b.d, H], [b.w, b.d], [b.w, b.d], [b.w, H], [b.w, H]];
      for (let f = 0; f < 6; f++) for (let v = 0; v < 4; v++) { const i = f * 4 + v; uv.setXY(i, uv.getX(i) * faceScale[f][0], uv.getY(i) * faceScale[f][1]); }
      const top = new THREE.MeshBasicMaterial({ color: T.top });
      const mesh = new THREE.Mesh(geo, [sideB.clone(), sideBd.clone(), top, bottom, sideA.clone(), sideAd.clone()]);
      mesh.position.set(b.gx + b.w / 2, H / 2, b.gy + b.d / 2);
      mesh.castShadow = true;
      mesh.userData.id = b.id;
      this.content.add(mesh); this.pickables.push(mesh);
      this.disposables.push(geo, top, ...(mesh.material as THREE.Material[]));
      const eg = new THREE.EdgesGeometry(geo, 1); eg.translate(mesh.position.x, mesh.position.y, mesh.position.z);
      outlineGeos.push(eg);
      box.expandByObject(mesh);
      const codeFS = b.slab ? 9 : Math.max(10, Math.min(19, Math.min(b.w, b.d) * 6.5));
      const codeEl = this.label(`font-weight:700;letter-spacing:.08em;color:${T.ink}`, b.code);
      const nameEl = this.label(`font-size:8.5px;letter-spacing:.1em;color:${T.ink}`, b.name.toUpperCase());
      const locEl = b.loc ? this.label(`font-size:7.5px;color:${T.dim}`, b.loc) : null;
      const rec: BlockRec = { b, mesh, top, codeEl, nameEl, locEl, codeFS, area: b.w * b.d };
      this.blocks.push(rec); this.byId[b.id] = rec;
    });
    if (outlineGeos.length) {
      const merged = mergeGeometries(outlineGeos)!;
      outlineGeos.forEach((g) => g.dispose());
      const lines = new THREE.LineSegments(merged, new THREE.LineBasicMaterial({ color: ink }));
      lines.renderOrder = 1;
      this.content.add(lines);
      this.disposables.push(merged, lines.material as THREE.Material);
    }

    // ── edges: elevated arcs from roof to roof ──
    const dotTex = this.dotTexture(T);
    const dashMat = new THREE.LineDashedMaterial({ color: ink, dashSize: 0.12, gapSize: 0.1, transparent: true, opacity: 0.45 });
    const solidMat = new THREE.LineBasicMaterial({ color: ink, transparent: true, opacity: 0.6 });
    const proxyMat = new THREE.MeshBasicMaterial({ visible: false });
    const endMat = new THREE.MeshBasicMaterial({ color: ink, transparent: true, opacity: 0.6 });
    const endGeo = new THREE.SphereGeometry(0.06, 8, 6);
    this.disposables.push(dashMat, solidMat, proxyMat, endMat, endGeo);
    edges.forEach((se) => {
      const { e, f, t } = se;
      const a = new THREE.Vector3(f.gx + f.w / 2, f.h * HZ, f.gy + f.d / 2);
      const z = new THREE.Vector3(t.gx + t.w / 2, t.h * HZ, t.gy + t.d / 2);
      const flat = a.distanceTo(z);
      const lift = Math.max(0.45, flat * 0.22) + Math.max(a.y, z.y);
      let curve: THREE.Curve<THREE.Vector3>;
      if (e.via && e.via.length) {
        const pts = [a, ...e.via.map(([vx, vy]) => new THREE.Vector3(vx, lift, vy)), z];
        curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.6);
      } else {
        const m = a.clone().add(z).multiplyScalar(0.5); m.y = lift;
        curve = new THREE.QuadraticBezierCurve3(a, m, z);
      }
      const n = 24 + (e.via?.length || 0) * 12;
      const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(n));
      const line = new THREE.Line(geo, e.dashed ? dashMat : solidMat);
      if (e.dashed) line.computeLineDistances();
      line.renderOrder = 2;
      const proxy = new THREE.Mesh(new THREE.TubeGeometry(curve, n, 0.16, 5, false), proxyMat);
      proxy.visible = false;                                   // raycast only
      const end = new THREE.Mesh(endGeo, endMat); end.position.copy(z);
      this.content.add(line, proxy, end);
      this.disposables.push(geo, proxy.geometry);
      const rec: EdgeRec = { e: se, curve, len: curve.getLength(), line, proxy };
      proxy.userData.edge = rec;
      this.edges.push(rec); this.pickables.push(proxy);
      if (e.flow) for (let k = 0; k < 2; k++) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, depthTest: false }));
        sp.scale.setScalar(0.2); sp.renderOrder = 3;
        this.content.add(sp);
        this.disposables.push(sp.material);
        this.dots.push({ rec, t: k * 0.5, sprite: sp });
      }
    });

    // ── externals: a dashed leader from the roof to a floating name ──
    const extMat = new THREE.LineDashedMaterial({ color: ink, dashSize: 0.08, gapSize: 0.09, transparent: true, opacity: 0.5 });
    this.disposables.push(extMat);
    externals.forEach(({ x, t }) => {
      const y = (t.h + 0.15) * HZ;
      const a = new THREE.Vector3(t.gx + t.w / 2, y, t.gy + t.d / 2), b = new THREE.Vector3(a.x + x.dx, y + 0.25, a.z + x.dy);
      const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
      const ln = new THREE.Line(geo, extMat); ln.computeLineDistances();
      this.content.add(ln); this.disposables.push(geo);
      this.exts.push({ el: this.label(`font-size:8px;letter-spacing:.14em;color:${T.dim}`, x.name), at: b });
    });

    // ── bounds, shadow frustum, ground ──
    if (box.isEmpty()) box.set(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 1, 1));
    externals.forEach(({ x, t }) => box.expandByPoint(new THREE.Vector3(t.gx + t.w / 2 + x.dx, 0, t.gy + t.d / 2 + x.dy)));
    this.fitBox.copy(box); this.fitBox.min.y = 0;
    this.bounds.copy(box).expandByVector(new THREE.Vector3(1.5, 0, 1.5)); this.bounds.min.y = 0;
    const c = new THREE.Vector3(); box.getCenter(c);
    const size = new THREE.Vector3(); box.getSize(size);
    const span = Math.max(size.x, size.z) * 1.2 + 4;
    this.ground.position.set(c.x, -0.002, c.z);
    this.ground.scale.set(span * 3, span * 3, 1);
    this.light.position.set(c.x - span * 0.45, span * 0.9, c.z - span * 0.25);
    this.light.target.position.set(c.x, 0, c.z);
    const sc = this.light.shadow.camera;
    sc.left = -span / 2; sc.right = span / 2; sc.top = span / 2; sc.bottom = -span / 2; sc.near = 0.5; sc.far = span * 3;
    sc.updateProjectionMatrix();
    this.light.shadow.needsUpdate = true;

    this.blocks.forEach((r) => this.paintBlock(r));
    this.reset(false);
    this.labelsDirty = true;
    this.invalidate();
  }
  private dotTexture(T: Theme) {
    const c = document.createElement('canvas'); c.width = c.height = 32;
    const g = c.getContext('2d')!;
    g.beginPath(); g.arc(16, 16, 12, 0, Math.PI * 2); g.fillStyle = T.ink; g.fill();
    g.lineWidth = 3; g.strokeStyle = T.bg; g.stroke();
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    this.disposables.push(tex);
    return tex;
  }

  // ───────────────────────── picking ─────────────────────────
  private ndc = new THREE.Vector2();
  private pick(ev: PointerEvent | MouseEvent): { block?: BlockRec; edge?: EdgeRec } {
    const r = this.canvas.getBoundingClientRect();
    this.ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.pickables, false);
    // blocks win over edges: every arc starts and ends on a roof, and the fat pick tube would otherwise
    // shadow the block it springs from
    let edge: EdgeRec | undefined;
    for (const h of hits) {
      const id = h.object.userData.id as string | undefined;
      if (id && this.byId[id]) return { block: this.byId[id] };
      edge ??= h.object.userData.edge as EdgeRec | undefined;
    }
    return edge ? { edge } : {};
  }
  private setHover(rec: BlockRec | null, ev: PointerEvent) {
    if (rec === this.hovered) return;
    const prev = this.hovered; this.hovered = rec;
    if (prev) this.paintBlock(prev);
    if (rec) this.paintBlock(rec);
    this.canvas.style.cursor = rec ? 'pointer' : 'grab';
    this.hooks.onHoverBlock(rec ? rec.b : null, ev);
    this.invalidate();
  }
  private bindPointer() {
    const c = this.canvas;
    const on = <K extends keyof HTMLElementEventMap>(k: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      c.addEventListener(k, fn, opts); this.unbind.push(() => c.removeEventListener(k, fn, opts));
    };
    on('pointerdown', (e) => { this.press = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: false }; });
    on('pointermove', (e) => {
      if (this.press && !this.press.moved && Math.abs(e.clientX - this.press.x) + Math.abs(e.clientY - this.press.y) > DRAG_PX) {
        this.press.moved = true; this.suppressClick = true;
        this.setHover(null, e); if (this.hoveredEdge) { this.hoveredEdge = null; this.hooks.onHoverEdge(null, e); }
        return;
      }
      if (this.press?.moved || e.pointerType === 'touch') return;
      const p = this.pick(e);
      this.setHover(p.block || null, e);
      const edge = p.block ? null : p.edge || null;
      if (edge !== this.hoveredEdge) { this.hoveredEdge = edge; this.hooks.onHoverEdge(edge ? edge.e : null, e); }
      else if (edge) this.hooks.onHoverEdge(edge.e, e);
    });
    const up = (e: PointerEvent) => {
      const pr = this.press; this.press = null;
      if (!pr || pr.moved) { this.suppressClick = !!pr?.moved; return; }
      this.suppressClick = false;
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      const p = this.pick(e);
      this.hooks.onClick(p.block ? p.block.b : null);
    };
    on('pointerup', up); on('pointercancel', () => { this.press = null; });
    on('pointerleave', (e) => { this.setHover(null, e); if (this.hoveredEdge) { this.hoveredEdge = null; this.hooks.onHoverEdge(null, e); } });
    on('dblclick', (e) => {
      if (this.suppressClick) return;
      const p = this.pick(e);
      if (p.block) { this.hooks.onDblClick(p.block.b); this.focus(p.block.b.id); }
    });
    on('contextmenu', (e) => e.preventDefault());
  }
  private unbind: (() => void)[] = [];
  private bindKeys() {
    const fn = (e: KeyboardEvent) => {
      const arrows = !this.hooks.arrowsTaken();
      const step = e.shiftKey ? 160 : 48;
      switch (e.key) {
        case 'ArrowLeft': if (!arrows) return; this.panBy(-step, 0); break;
        case 'ArrowRight': if (!arrows) return; this.panBy(step, 0); break;
        case 'ArrowUp': if (!arrows) return; this.panBy(0, step); break;
        case 'ArrowDown': if (!arrows) return; this.panBy(0, -step); break;
        case '+': case '=': this.zoomBy(1.25); break;
        case '-': case '_': this.zoomBy(1 / 1.25); break;
        case 'f': case 'F': this.fit(); break;
        case 'r': case 'R': this.reset(); break;
        case 'n': case 'N': this.resetHeading(); break;
        default: return;
      }
      e.preventDefault();
    };
    this.canvas.addEventListener('keydown', fn);
    this.unbind.push(() => this.canvas.removeEventListener('keydown', fn));
  }

  // ───────────────────────── frame ─────────────────────────
  invalidate() { this.needsRender = true; this.labelsDirty = true; }
  private resize() {
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.ortho.left = -w / 2 / BASE_PX; this.ortho.right = w / 2 / BASE_PX; this.ortho.top = h / 2 / BASE_PX; this.ortho.bottom = -h / 2 / BASE_PX;
    this.ortho.updateProjectionMatrix();
    this.persp.aspect = w / h; this.persp.updateProjectionMatrix();
    this.applyLimits();
    this.invalidate();
  }
  private loop(t: number) {
    if (this.dead) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.06, (t - this.lastT) / 1000 || 0.016); this.lastT = t;
    if (this.tween) this.stepTween(t);
    else if (this.controls.update(dt)) this.needsRender = true;   // damping still settling
    if (this.flow && this.dots.length) {
      this.dots.forEach((d) => {
        d.t = (d.t + dt * 1.25 / d.rec.len) % 1;
        d.sprite.position.copy(d.rec.curve.getPointAt(d.t));
      });
      this.needsRender = true;
    }
    if (!this.needsRender) return;
    this.needsRender = false;
    if (this.labelsDirty) { this.placeLabels(); this.labelsDirty = false; }
    this.renderer.render(this.scene, this.camera);
    this.reportView();
  }
  private reportView() {
    const s = this.state();
    let turn = s.theta - DEFAULT_AZIMUTH; turn = Math.atan2(Math.sin(turn), Math.cos(turn));
    if (Number.isNaN(this.lastView.turn) || Math.abs(turn - this.lastView.turn) > 1e-3 || this.projection !== this.lastView.projection) {
      this.lastView = { turn, projection: this.projection };
      this.hooks.onView(turn, this.projection);
    }
  }

  // ───────────────────────── labels ─────────────────────────
  private v = new THREE.Vector3();
  private project(x: number, y: number, z: number, w: number, h: number): [number, number, boolean] {
    this.v.set(x, y, z).project(this.camera);
    return [(this.v.x + 1) / 2 * w, (1 - this.v.y) / 2 * h, this.v.z < 1 && this.v.z > -1];
  }
  private placeLabels() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    // secondary text appears once it would be legible at its natural size; codes stay for as long as they can
    const zoom = this.currentZoom();
    const showNames = 8.5 * zoom >= 6.2, showLoc = 7.5 * zoom >= 6.4, showExt = 8 * zoom >= 5.8;
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    const grid = new Map<string, number[]>();
    const cell = 80;
    const collides = (x: number, y: number, lw: number, lh: number) => {
      const cx0 = Math.floor((x - lw / 2) / cell), cx1 = Math.floor((x + lw / 2) / cell), cy0 = Math.floor((y - lh / 2) / cell), cy1 = Math.floor((y + lh / 2) / cell);
      for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
        const ids = grid.get(cx + ',' + cy); if (!ids) continue;
        for (const i of ids) { const p = placed[i]; if (Math.abs(p.x - x) < (p.w + lw) / 2 && Math.abs(p.y - y) < (p.h + lh) / 2) return true; }
      }
      return false;
    };
    const place = (x: number, y: number, lw: number, lh: number) => {
      const i = placed.push({ x, y, w: lw, h: lh }) - 1;
      const cx0 = Math.floor((x - lw / 2) / cell), cx1 = Math.floor((x + lw / 2) / cell), cy0 = Math.floor((y - lh / 2) / cell), cy1 = Math.floor((y + lh / 2) / cell);
      for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) { const k = cx + ',' + cy; (grid.get(k) || grid.set(k, []).get(k)!).push(i); }
    };
    // big blocks claim their label room first
    const order = this.blocks.slice().sort((a, b) => b.area - a.area);
    for (const r of order) {
      const b = r.b, H = Math.max(0.02, b.h * HZ);
      const cx = b.gx + b.w / 2, cz = b.gy + b.d / 2;
      const [tx, ty, tin] = this.project(cx, H, cz, w, h);
      const offscreen = !tin || tx < -60 || tx > w + 60 || ty < -60 || ty > h + 60;
      if (offscreen) { r.codeEl.style.display = r.nameEl.style.display = 'none'; if (r.locEl) r.locEl.style.display = 'none'; continue; }
      const fs = THREE.MathUtils.clamp(r.codeFS * zoom, 7, 30);
      r.codeEl.style.display = ''; r.codeEl.style.fontSize = fs.toFixed(1) + 'px';
      r.codeEl.style.transform = `translate(-50%,-50%) translate(${tx.toFixed(1)}px,${ty.toFixed(1)}px)`;
      // the name hangs below the lowest ground corner on screen, whichever corner that is right now
      let bottom = -Infinity;
      for (let i = 0; i < 4; i++) {
        const [, py] = this.project(i & 1 ? b.gx + b.w : b.gx, 0, i & 2 ? b.gy + b.d : b.gy, w, h);
        if (py > bottom) bottom = py;
      }
      const [gx] = this.project(cx, 0, cz, w, h);
      const nfs = THREE.MathUtils.clamp(8.5 * zoom, 6.5, 13), lfs = THREE.MathUtils.clamp(7.5 * zoom, 6.5, 11.5);
      const ny = bottom + nfs * 0.6 + 4;
      const nw = r.nameEl.textContent!.length * nfs * 0.72;
      const showThis = showNames && (this.selected === r.b.id || !collides(gx, ny, nw, nfs * 1.3));
      if (showThis) {
        place(gx, ny, nw, nfs * 1.3);
        r.nameEl.style.display = ''; r.nameEl.style.fontSize = nfs.toFixed(1) + 'px';
        r.nameEl.style.transform = `translate(-50%,-50%) translate(${gx.toFixed(1)}px,${ny.toFixed(1)}px)`;
        if (r.locEl) {
          if (showLoc) {
            r.locEl.style.display = ''; r.locEl.style.fontSize = lfs.toFixed(1) + 'px';
            r.locEl.style.transform = `translate(-50%,-50%) translate(${gx.toFixed(1)}px,${(ny + nfs * 1.25).toFixed(1)}px)`;
          } else r.locEl.style.display = 'none';
        }
      } else { r.nameEl.style.display = 'none'; if (r.locEl) r.locEl.style.display = 'none'; }
    }
    for (const x of this.exts) {
      const [px, py, vis] = this.project(x.at.x, x.at.y, x.at.z, w, h);
      x.el.style.display = vis && showExt ? '' : 'none';
      x.el.style.transform = `translate(-50%,-100%) translate(${px.toFixed(1)}px,${(py - 3).toFixed(1)}px)`;
    }
  }

  // ───────────────────────── teardown ─────────────────────────
  dispose() {
    this.dead = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.unbind.forEach((f) => f()); this.unbind = [];
    this.controls.dispose();
    this.clear();
    (this.ground.material as THREE.Material).dispose(); this.ground.geometry.dispose();
    this.renderer.dispose();
    this.canvas.remove(); this.labelLayer.remove();
  }
}

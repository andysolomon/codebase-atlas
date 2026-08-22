/* Codebase Atlas — the ride.

   A narrated, auto-playing flight over the map that a stranger can watch without touching anything,
   and interrupt at any moment to take the controls. The chrome recedes into letterbox bands, the
   camera flies a scripted route, and a caption band reads each stop.

   This file owns the state machine, the overlay and the hold timer. The engine passes in what the
   ride may not know — how a beat becomes a selection, how [[marks]] render — so this imports only
   ./types and ./scene and there is no cycle.

       idle ──start──▶ flying(i) ──land──▶ holding(i) ──timer──▶ flying(i+1) … ──▶ ended
                          │  ▲                 │  ▲
                    pause │  │ resume    pause │  │ resume
                          ▼  │                 ▼  │
                        paused                paused

   One rule makes it robust: a generation counter. Every entry into a beat bumps it, and every async
   callback — a landing, a cancellation, the hold timer, a speech event — opens by checking it is
   still current.

   Voice is the browser's own speech synthesis: free, local, offline, no dependency. It is hostile in
   the wild — speak() before a gesture is a silent no-op on Safari, onend sometimes never fires,
   Chrome stops after fifteen seconds — so the hold timer is always authoritative: speech may only
   extend a hold, never shorten it, and never past a cap. */

import type { RideBeat, Theme } from './types';
import type { AtlasScene, FlightEnd, FlightHandle, FlightTarget, Projection } from './scene';
import { MONO } from './scene';

export type RidePhase = 'idle' | 'flying' | 'holding' | 'paused' | 'ended';
export type RideEnd = 'finished' | 'exited' | 'destroyed';

export interface RideHooks {
  /** A beat is on: selection, panel, hash — the engine's business. */
  onBeat(beat: RideBeat, i: number, n: number): void;
  onEnd(reason: RideEnd): void;
  /** The engine's [[mark]] renderer. */
  rich(s: string): string;
  /** The ids a group's row holds. */
  groupIds(name: string): string[];
  /** Flip FLAT/DEEP and say which one it is now. The nav control is under the bands, so the ride
      carries the toggle itself. */
  toggleProjection(): Projection;
}

/** The small button: the nav control's recipe, so the ride's chrome is the map's chrome. */
const FS_SM = '10px';

const CAN_SPEAK = typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance === 'function';
/** The most a line may run on past its hold before the ride moves on without it. */
const GRACE = 6000;
/** speak() with no onstart and nothing speaking after this long is a synth that is not going to. */
const PROBE_MS = 900;
/** Chrome stops synthesis after about fifteen seconds; a pause/resume every ten keeps it talking. */
const KEEP_ALIVE_MS = 10_000;
const plain = (s: string) => s.replace(/\[\[(.+?)\]\]/g, '$1');

/** How long a caption stays up, from how long it takes to read at about 180 words a minute, plus a
    moment to settle. The hold timer is always authoritative. */
export const holdFor = (beat: RideBeat) =>
  beat.hold ?? Math.max(2200, Math.min(9000, 1400 + 55 * beat.say.length));

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css?: string, html?: string | null): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (html != null) e.innerHTML = html;
  return e;
}

/** What a beat asks the camera to frame. */
function targetOf(beat: RideBeat, groupIds: (g: string) => string[]): FlightTarget {
  if (beat.block) return { block: beat.block };
  if (beat.edge) return { edge: beat.edge };
  if (beat.group) return { blocks: groupIds(beat.group) };
  return { all: true };
}

export class Ride {
  phase: RidePhase = 'idle';
  index = -1;
  private gen = 0;
  private flight: FlightHandle | null = null;
  /** What was going on when the ride was paused, so resume knows whether to re-fly or re-time. */
  private pausedFrom: 'flying' | 'holding' = 'flying';
  /** The user reached in: the flight is dead and resume has to re-fly from wherever the camera is. */
  private taken = false;
  private holdTimer = 0;
  private holdLeft = 0;
  private holdStart = 0;

  // ── voice ──
  private voice = false;
  /** The synth took a line and said nothing. Once is enough: stop waiting on it for the session. */
  private voiceBroken = false;
  private utter: SpeechSynthesisUtterance | null = null;
  private speaking = false;
  private waitingOnVoice = false;
  private watchdog = 0;
  private probe = 0;
  private keepAlive = 0;
  private voiceBtn: HTMLButtonElement | null = null;

  private root: HTMLDivElement;
  private counter!: HTMLDivElement;
  private caption!: HTMLDivElement;
  private bar!: HTMLDivElement;
  private note!: HTMLDivElement;
  private pauseBtn!: HTMLButtonElement;
  private backBtn!: HTMLButtonElement;
  private nextBtn!: HTMLButtonElement;
  private projBtn!: HTMLButtonElement;

  constructor(
    host: HTMLDivElement,
    private scene: AtlasScene,
    private T: Theme,
    private beats: RideBeat[],
    private title: string,
    private hooks: RideHooks,
  ) {
    this.root = this.buildOverlay();
    host.appendChild(this.root);
  }

  // ───────────────────────── driving ─────────────────────────
  start(from = 0) { this.go(from); }
  go(i: number) {
    if (this.phase === 'ended') return;
    const n = this.beats.length;
    if (i >= n) { this.stop('finished'); return; }
    i = Math.max(0, i);
    const g = ++this.gen;
    this.clearHold();
    this.index = i; this.taken = false;
    const beat = this.beats[i];
    this.phase = 'flying';
    this.hooks.onBeat(beat, i, n);
    this.paint();
    this.fly(g);
    this.speak(g, beat.say);
  }
  step(d: 1 | -1) {
    if (this.phase === 'ended') return;
    const i = this.index + d;
    if (i < 0) return;
    this.go(i);
  }
  pause() {
    if (this.phase !== 'flying' && this.phase !== 'holding') return;
    this.pausedFrom = this.phase;
    if (this.phase === 'flying') this.scene.pauseFlight();
    else { this.clearHold(); this.holdLeft = Math.max(0, this.holdLeft - (performance.now() - this.holdStart)); }
    this.phase = 'paused';
    this.pauseSpeech();
    this.paint();
  }
  resume() {
    if (this.phase !== 'paused') return;
    const g = this.gen;
    if (this.pausedFrom === 'holding' && !this.taken) { this.phase = 'holding'; this.armHold(g, this.holdLeft); }
    else if (this.flight?.state === 'flying' && !this.taken) { this.phase = 'flying'; this.scene.resumeFlight(); }
    else { this.phase = 'flying'; this.fly(g); }   // the user moved the camera: re-fly the stop from here
    this.taken = false;
    this.resumeSpeech();
    this.paint();
  }
  toggle() { if (this.phase === 'paused') this.resume(); else this.pause(); }
  /** The user reached in. Freeze where it stands and hand the controls over; the caption stays up,
      because they are still reading it. Resume re-flies the current stop from wherever the camera is. */
  takeOver() {
    if (this.phase === 'ended' || this.phase === 'idle') return;
    const was = this.phase;
    this.taken = true;
    if (was === 'holding') { this.clearHold(); this.holdLeft = Math.max(0, this.holdLeft - (performance.now() - this.holdStart)); }
    if (was !== 'paused') { this.pausedFrom = was; this.phase = 'paused'; }
    this.pauseSpeech();
    this.paint();
  }

  /** Teardown touches only DOM and timers, never the scene: `dispose()` cancels the live flight with
      `'dispose'`, which lands here while the scene is mid-dispose. A deliberate exit does let go of
      its flight, so the camera does not carry on to a stop nobody is reading. */
  stop(reason: RideEnd = 'exited') {
    if (this.phase === 'ended') return;
    this.gen++;
    this.clearHold();
    this.phase = 'ended';
    this.stopSpeech();
    if (reason === 'exited') this.flight?.cancel();
    this.flight = null;
    this.root.remove();
    this.hooks.onEnd(reason);
  }

  // ───────────────────────── voice ─────────────────────────
  /** Switching the voice on speaks the current line right here, inside the click: that is the gesture
      Safari needs to unlock the engine, and it is instant feedback. Every later speak() fires from a
      timer and works because the engine is unlocked. */
  setVoice(on: boolean) {
    if (!CAN_SPEAK || this.voiceBroken) on = false;
    this.voice = on;
    if (on && this.index >= 0 && this.phase !== 'ended') this.speak(this.gen, this.beats[this.index].say);
    else this.stopSpeech();
    this.paintVoice();
  }
  private speak(g: number, say: string) {
    this.stopSpeech();
    if (!this.voice || this.voiceBroken || !CAN_SPEAK) return;
    const u = new SpeechSynthesisUtterance(plain(say));
    let started = false;
    u.onstart = () => { if (g !== this.gen) return; started = true; this.speaking = true; };
    u.onend = u.onerror = () => {
      if (g !== this.gen) return;
      this.speaking = false;
      this.clearKeepAlive();
      if (this.waitingOnVoice) { this.waitingOnVoice = false; this.clearWatchdog(); this.next(); }
    };
    this.utter = u;
    this.speaking = true;
    speechSynthesis.speak(u);
    if (this.phase === 'paused') speechSynthesis.pause();
    this.probe = window.setTimeout(() => {
      this.probe = 0;
      if (g !== this.gen) return;
      if (!started && !speechSynthesis.speaking) {
        // a silent no-op — iOS before a gesture, a browser with no voices: say so rather than wait
        this.voiceBroken = true; this.voice = false; this.speaking = false;
        this.stopSpeech();
        this.paintVoice();
      }
    }, PROBE_MS);
    this.armKeepAlive();
  }
  private armKeepAlive() {
    this.clearKeepAlive();
    this.keepAlive = window.setInterval(() => { if (this.speaking && this.phase !== 'paused') { speechSynthesis.pause(); speechSynthesis.resume(); } }, KEEP_ALIVE_MS);
  }
  private clearKeepAlive() { if (this.keepAlive) { window.clearInterval(this.keepAlive); this.keepAlive = 0; } }
  private clearWatchdog() { if (this.watchdog) { window.clearTimeout(this.watchdog); this.watchdog = 0; } }
  /** Null the outgoing line's handlers, then cancel: some engines fire onend on cancel, some do not,
      and some do so after the ride has moved on. */
  private stopSpeech() {
    if (this.utter) { this.utter.onstart = this.utter.onend = this.utter.onerror = null; this.utter = null; }
    if (CAN_SPEAK && (this.speaking || speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel();
    this.speaking = false; this.waitingOnVoice = false;
    this.clearWatchdog(); this.clearKeepAlive();
    if (this.probe) { window.clearTimeout(this.probe); this.probe = 0; }
  }
  private pauseSpeech() { if (CAN_SPEAK && this.speaking) speechSynthesis.pause(); }
  private resumeSpeech() { if (CAN_SPEAK && this.speaking) speechSynthesis.resume(); }
  private paintVoice() {
    const b = this.voiceBtn; if (!b) return;
    b.textContent = this.voice ? 'VOICE ON' : 'VOICE OFF';
    b.title = this.voiceBroken ? 'Speech synthesis did not answer in this browser' : 'Read each stop aloud, with the browser\'s own voice';
    b.style.opacity = this.voiceBroken ? '.35' : '';
  }

  private fly(g: number, opts: { ms?: number; arc?: number } = {}) {
    const beat = this.beats[this.index];
    this.flight = this.scene.flyTo(
      { to: targetOf(beat, this.hooks.groupIds), arc: opts.arc ?? 1, ...(opts.ms != null ? { ms: opts.ms } : {}), ...(beat.turn != null ? { turn: beat.turn } : {}) },
      {
        land: () => { if (g !== this.gen) return; this.landed(g); },
        cancel: (why) => { if (g !== this.gen) return; this.cancelled(g, why); },
      },
    );
  }
  private landed(g: number) {
    if (this.phase === 'paused') { this.pausedFrom = 'holding'; this.holdLeft = holdFor(this.beats[this.index]); return; }
    this.phase = 'holding';
    this.armHold(g, holdFor(this.beats[this.index]));
    this.paint();
  }
  private armHold(g: number, ms: number) {
    this.clearHold();
    this.holdLeft = ms; this.holdStart = performance.now();
    this.holdTimer = window.setTimeout(() => { if (g !== this.gen) return; this.holdTimer = 0; this.onHoldOver(g); }, ms);
  }
  private clearHold() { if (this.holdTimer) { window.clearTimeout(this.holdTimer); this.holdTimer = 0; } }
  /** The caption has been up long enough. A line still being read may hold the stop a little longer —
      never past GRACE, whatever the synth does. */
  private onHoldOver(g: number) {
    if (this.voice && this.speaking) {
      this.waitingOnVoice = true;
      this.watchdog = window.setTimeout(() => { if (g !== this.gen) return; this.watchdog = 0; this.waitingOnVoice = false; this.next(); }, GRACE);
    } else this.next();
  }
  private next() { this.go(this.index + 1); }

  private cancelled(g: number, why: FlightEnd) {
    switch (why) {
      case 'gesture': case 'user':
        this.takeOver();   // the camera stays exactly where the user put it
        return;
      case 'projection':
        // the scene rebuilt its controls under us: re-fly the same stop, flat and quick, same phase
        this.fly(g, { ms: 420, arc: 0 });
        if (this.phase === 'paused') this.scene.pauseFlight();
        return;
      case 'data': case 'dispose':
        this.stop('destroyed');
        return;
      case 'replaced':
        return;   // the ride did it itself
    }
  }
  // ───────────────────────── overlay ─────────────────────────
  private buildOverlay(): HTMLDivElement {
    const T = this.T;
    const root = el('div', 'position:absolute;inset:0;pointer-events:none;z-index:6;display:flex;flex-direction:column;justify-content:space-between');
    const band = `pointer-events:auto;background:${T.bg};color:${T.ink};font-family:${MONO};box-sizing:border-box`;
    // top: the title, and the repo's name for the room
    const top = el('div', `${band};height:clamp(56px,12%,120px);border-bottom:var(--border-w-hair) solid ${T.ink};display:flex;align-items:flex-end;justify-content:space-between;padding:0 16px 12px`);
    top.appendChild(el('div', `font-size:var(--fs-kicker);letter-spacing:var(--ls-kicker)`, `THE RIDE — ${esc(this.title)}`));
    top.appendChild(el('div', `font-size:var(--fs-kicker);letter-spacing:var(--ls-kicker);color:${T.dim}`, 'TOUCH THE MAP TO TAKE THE CONTROLS'));
    root.appendChild(top);

    const bottom = el('div', `${band};min-height:clamp(56px,12%,120px);border-top:var(--border-w-hair) solid ${T.ink};display:flex;flex-direction:column`);
    // progress: stepped per beat, never per frame — it matches the counter and the chrome does not animate
    const rule = el('div', `height:var(--border-w);background:${T.faint};flex:none`);
    this.bar = el('div', `height:100%;width:0;background:${T.ink}`);
    rule.appendChild(this.bar);
    bottom.appendChild(rule);
    const row = el('div', 'display:flex;align-items:stretch;gap:0;padding:12px 16px 10px;min-height:0');
    this.counter = el('div', `font-size:var(--fs-stat);font-weight:700;white-space:nowrap;flex:none;padding-right:14px;border-right:var(--border-w-hair) solid ${T.ink};align-self:stretch`);
    this.caption = el('div', `font-size:var(--fs-body);line-height:var(--leading-body);padding-left:14px;flex:1;min-width:0;max-width:72ch`);
    this.caption.setAttribute('aria-live', 'polite');
    row.appendChild(this.counter); row.appendChild(this.caption);
    bottom.appendChild(row);
    const ctl = el('div', 'display:flex;align-items:center;gap:6px;padding:0 16px 12px;flex-wrap:wrap');
    const BTN = `font-family:${MONO};font-size:${FS_SM};letter-spacing:var(--ls-label);background:none;border:var(--border-w) solid ${T.ink};color:${T.ink};padding:7px 10px;cursor:pointer;white-space:nowrap;line-height:1;box-sizing:border-box;height:30px`;
    const btn = (label: string, title: string, act: () => void) => {
      const b = el('button', BTN, label);
      b.title = title; b.setAttribute('aria-label', title);
      b.onclick = act;
      ctl.appendChild(b);
      return b;
    };
    this.pauseBtn = btn('❚❚ PAUSE', 'Pause or resume (space)', () => this.toggle());
    this.backBtn = btn('‹ BACK', 'Previous stop (←)', () => this.step(-1));
    this.nextBtn = btn('NEXT ›', 'Next stop (→)', () => this.step(1));
    this.projBtn = btn(this.scene.getProjection() === 'flat' ? '▱ FLAT' : '◇ DEEP', 'FLAT is the drafting view (orthographic); DEEP adds perspective', () => {
      const p = this.hooks.toggleProjection();
      this.projBtn.textContent = p === 'flat' ? '▱ FLAT' : '◇ DEEP';
    });
    // a control that can never work is chrome for nothing
    if (CAN_SPEAK) { this.voiceBtn = btn('VOICE OFF', '', () => this.setVoice(!this.voice)); this.paintVoice(); }
    this.note = el('div', `flex:1;text-align:right;font-size:var(--fs-kicker);letter-spacing:var(--ls-label);color:${T.dim};white-space:nowrap`);
    ctl.appendChild(this.note);
    btn('✕ EXIT', 'Leave the ride (esc)', () => this.stop('exited'));
    bottom.appendChild(ctl);
    root.appendChild(bottom);
    return root;
  }
  private paint() {
    const T = this.T, n = this.beats.length, i = this.index;
    if (i < 0) return;
    this.counter.innerHTML = `${String(i + 1).padStart(2, '0')}<span style="color:${T.dim};font-size:var(--fs-label)"> / ${String(n).padStart(2, '0')}</span>`;
    this.caption.innerHTML = this.hooks.rich(this.beats[i].say);
    this.bar.style.width = `${((i + 1) / n * 100).toFixed(2)}%`;
    const paused = this.phase === 'paused';
    this.pauseBtn.textContent = paused ? '▶ RESUME' : '❚❚ PAUSE';
    this.backBtn.style.opacity = i === 0 ? '.35' : '';
    this.nextBtn.textContent = i === n - 1 ? 'FINISH ›' : 'NEXT ›';
    this.note.textContent = paused ? (this.taken ? 'PAUSED — YOU HAVE THE CONTROLS' : 'PAUSED') : '';
  }
}

const esc = (t: unknown) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');

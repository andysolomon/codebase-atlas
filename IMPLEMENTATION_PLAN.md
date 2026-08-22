# The ride — a narrated flight over the map

> **Implementation brief.** Self-contained: everything an implementer needs is below, including
> orientation on the codebase. Branch `feat/the-ride` is already created. `main` is protected —
> land through a PR that passes the Merge Gate check.

---

## Context

Codebase Atlas draws a repository as a city and lets you move through it, but it only ever answers
questions you already knew to ask. You have to know to press `▶ TRACE`, know to click a block, know
which of twenty-four blocks is worth clicking. Someone opening a map of a codebase they have never
seen — the exact person the tool is for — gets a beautiful city and no way in.

The one narrative surface that exists, `TRACE`, is close but manual: twelve steps, one per arrow-key
press, prose in a side panel, camera cutting from block to block. It is a reference, not a demo.

This adds **the ride**: a narrated, auto-playing flight over the map that a stranger can watch
without touching anything, and interrupt at any moment to take the controls. It is the thing you
send someone as a link, and the thing you put on a screen in front of a room.

Two properties are non-negotiable, because they are what the project already is:

- **It works with no model, no key and no network.** A ride is built from facts the scan already
  computed and prose the atlas already carries. The model makes it better; it is never required.
- **The scan keeps sole authority over every number and every position.** The model chooses the
  order and writes the connective narration. It cannot point the camera anywhere the map does not
  already have something drawn.

**Naming, once, everywhere** — mirroring how `TRACE` / `traceTitle` / `#trace=` / `▶ TRACE …` already
line up: data field `RIDE`, `RideBeat`, `rideTitle`; AI pass `ride`; controller `Ride`; deep link
`#ride=`; button `▶ TAKE THE RIDE — N STOPS`.

---

## Orientation — what this codebase is

Read this before touching anything. Line numbers are from the state of `main` at
commit `8f1bc84`; re-check them, they will drift.

**Stack.** Vite 6 + vanilla TypeScript + Bun. **No React, no store, no router.** One page
(`index.html`), one custom element `<codebase-atlas>` (`src/atlas/engine.ts`, 571 lines), one
Three.js scene (`src/atlas/scene.ts`, 820 lines), one Vercel Function (`api/enrich.ts`). The browser
bundle's only runtime dependency is `three` — `ai` and `zod` are server/CLI only, and **nothing under
`src/` that the browser bundles may import them**.

```sh
bun install
bun run dev        # http://localhost:5173 — also mounts api/enrich.ts as dev middleware
bun run typecheck  # tsc --noEmit
bun run build      # typecheck + vite build
bun run atlas .    # the CLI; --ai to run the model passes
```

**State lives in private class fields**, not a store. `Atlas` (engine.ts) holds `sel`, `selEdge`,
`inside`, `traceI`, all mutually exclusive. `main.ts` wires hooks onto the element by property
assignment (`atlas.data`, `atlas.analyze`, `atlas.nav`, …). Panels re-render wholesale via
`innerHTML`; there is no diffing.

**The data contract** is `AtlasData` in `src/atlas/types.ts`: `repo`, `product`, `stats`,
`overviewTitle/Kicker/Sub`, `OVERVIEW_WHAT[]`, `OVERVIEW_HOW[]`, `HOW_TO_READ`, `traceTitle?`,
`GROUPS: [name, ids[]][]`, `STRUCTURES: Structure[]`, `EDGES: Edge[]`, `EXTERNALS?`,
`TRACE: [blockId, sentence][]`, `provenance?`.

**The camera** (`scene.ts`) is a spherical orbit camera, not a 2D transform:

```ts
interface CamState { target: THREE.Vector3; theta: number; phi: number; radius: number; zoom: number }
```

Relevant existing members, with line numbers:

| Member | Line | Notes |
| --- | --- | --- |
| `ease` | 85 | easeInOutCubic |
| `reducedMotion()` | 86 | `prefers-reduced-motion` |
| `interface Tween` | 83 | `{ from, to, t0, ms, done? }` — **one slot**, `private tween` |
| `makeControls` | 197 | MapControls; `'start'` listener at **209** nulls the tween |
| `applyLimits` | 215 | `minZoom = fitZoom / ZOOM_OUT`, `maxZoom = fitZoom * ZOOM_IN` |
| `distanceFor` / `zoomFor` | 223 / 228 | perspective distance ↔ ortho zoom |
| `clampTarget` | 234 | forces `target.y = 0` on every `change` |
| `state()` / `applyState()` | 241 / 247 | `applyState` calls `controls.update()`, which fires `change` |
| `animateTo(to, ms, done?)` | 256 | private; hard-cuts under reduced motion or `ms <= 0` |
| `stepTween` | 267 | lerps target/theta/phi/radius linearly, **`log(zoom)` linearly** |
| `fit` / `reset` | 283 / 289 | |
| `focus(id)` | 296 | 700ms, keeps ≥ `fitZoom * 2.4` |
| `focusEdge(key)` | 304 | builds a `Box3` over both endpoints → `fitFor` |
| `setProjection` | 331 | **nulls the tween, disposes and rebuilds controls** |
| `fitFor(s, box)` | 343 | the framing math; projects 8 box corners, sizes to viewport |
| `setSelection(sel, keep, edge)` | 368 | `keep` is a list of ids held at full opacity; rest → 0.22 |
| `setData` | 467 | |
| the rAF loop | 712 | render-on-demand |
| `resize()` | 703 | |
| `dispose()` | 809 | |

Constants: `SX=26, SY=14.3, SH=16`, `BASE_PX = SX / cos(π/4)`, `HZ`, `DEFAULT_POLAR = π/2 − asin(SY/SX)`
(≈0.99 rad), `DEFAULT_AZIMUTH = π/4`, `ZOOM_OUT = 2.2`, `ZOOM_IN = 5`, `PAD_PX = 34`,
`minPolarAngle = 0.18`, `maxPolarAngle = 1.34`.

**`SceneHooks`** (scene.ts:57) is the scene→engine channel: `onHoverBlock`, `onHoverEdge`, `onClick`,
`onDblClick`, `onView`, `arrowsTaken`.

**The AI layer** (`src/analyze/ai/`) is three passes — `partition`, `narrate`, `compose` — run two
ways from the same prompt builders: `index.ts` `enrichAtlas()` (CLI, calls the provider directly) and
`client.ts` `enrichInBrowser()` (POSTs evidence packs to `/api/enrich`, which never sees the repo).
Everything a model returns goes through `validate.ts` before it can touch the map. `provider.ts`
`runPass()` does schema-validated calls with a repair retry and a salvage pass, returning
`value: null` rather than throwing. Results are cached in `.atlas-cache/` (CLI) and `localStorage`
(browser, keyed partly by an 8-char `PROMPTS_VERSION` hash of the prompt texts).

**Design system rules are strict** and enforced by convention (`prototype/readme.md`):

- **No emoji, ever.** Glyphs are unicode in the mono face: `❚❚ ▶ ⌖ ▣ ✕ ‹ › ← → ·`. Note `⏭`
  (U+23ED) renders as a colour emoji on iOS and Android — do not use it.
- Radius 0 everywhere, no shadows, no gradients, two colours per paper, one mono family.
- Colour comes only from tokens (`src/styles/tokens/`); the canvas gets a resolved `Theme` via
  `readTheme()` in `theme.ts` because WebGL cannot read `var(--ink)`.
- **DOM chrome motion is instant — no fades, eases or transitions.** Camera motion is the one
  established exception.
- Separator is ` · `. Labels UPPERCASE and letter-spaced; body sentence case.
- Voice: plain, matter-of-fact, present tense. No marketing words. Never "This module is
  responsible for".

**Two edge-key formats exist and they are not interchangeable.** `scene.ts:52`
`edgeKey = f + '→' + t` (U+2192, for selection and `#edge=`); `validate.ts:211` and `build.ts:504`
use `` `${f}->${t}` `` (ASCII, for edge labels). Anything new must store the **pair**, not a key
string, or it will silently miss on one side.

---

## What it is, concretely

Press `▶ TAKE THE RIDE`. The chrome recedes into letterbox bands and the camera flies a scripted
route over the city, rising between distant stops and settling in on arrival, while a caption band
reads each stop — and, if `VOICE` is on, says it aloud through the browser's own speech synthesis.
Eight to sixteen stops, roughly ninety seconds.

```
┌──────────────────────────────────────────────────┐
│                                                  │   letterbox, paper colour, hairline inner rule
├──────────────────────────────────────────────────┤
│                                                  │
│              [ the map, flying ]                 │
│                                                  │
├──────────────────────────────────────────────────┤
│ ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │   stepped per beat, never per frame
│ 04/11 │ Five Vercel Functions sit over Postgres, │
│       │ and every write re-checks the same       │
│       │ sanitize().                              │
│                                                  │
│ ❚❚ PAUSE   ‹ BACK   NEXT ›   VOICE OFF   ✕ EXIT  │
└──────────────────────────────────────────────────┘
```

A beat frames one of four things — the whole vocabulary, because it is exactly what the map has to
point at:

| `RideBeat` says | The camera | Where it comes from |
| --- | --- | --- |
| `all: 1` | frames the whole atlas | the opening and closing shots |
| `block: id` | flies to one block, everything else dimmed | a `STRUCTURES` id |
| `edge: [f, t]` | frames both ends of an import, the arc lit | an `EDGES` pair |
| `group: name` | frames one group's row | a `GROUPS` entry |

An optional `turn` on a beat gives the orbit shot for free: the same subject framed at a different
heading is a turn around it, with no extra machinery.

**Interruption is the interactive half.** Touch the map — drag, wheel, right-drag — and the ride
hands you the controls, freezes where it is, and says so. The caption stays up while you look
around, because you are still reading it. Press `▶ RESUME` and it re-flies the current stop from
wherever you left the camera and carries on. It never fights you and never resumes on its own.

---

## Part 1 — the data contract

`src/atlas/types.ts`, beside `TraceStep`. Additive and optional, so every existing atlas keeps
working:

```ts
export interface RideBeat {
  /** Exactly one of these says what the camera frames. */
  all?: 1;
  block?: string;
  edge?: [from: string, to: string];
  group?: string;
  /** The line: captioned, and spoken. [[marks]] allowed; stripped before speech. */
  say: string;
  /** Heading for this beat, radians from the default isometric heading. A turn around the subject. */
  turn?: number;
  /** Hold in ms. Derived from `say` when absent. */
  hold?: number;
}
```

`AtlasData` gains `RIDE?: RideBeat[]` and `rideTitle?: string`; `Narration`
(`src/analyze/types.ts`) gains `ride?: RideBeat[]` and `rideTitle?: string`.

`edge` is a tuple, not a key string — see the two-edge-key-formats note in Orientation.

---

## Part 2 — the templated ride (zero inference)

`src/analyze/build.ts`, a local `buildRide(...)` called just before the `data` literal (~L447),
reading only what is already in scope: `U`, `GROUPS`, `groupsPresent`, `allEdges`, `topEdge`,
`TRACE`, `big`, `kb`, `list`.

Order: `{all:1}` opening → one `{group}` per entry in `groupsPresent` order → the two largest blocks
as `{block}` landmarks → `{edge:[topEdge.f.id, topEdge.t.id]}` for the busiest link →
`TRACE.map(([id, sentence]) => ({ block: id, say: sentence }))` → `{all:1}` close.
`rideTitle: 'ONE PASS OVER THE SYSTEM'`.

Two details that carry real weight:

- **Landmark beats say `s.what.split('. ')[0]`** — the same first-sentence trick `onHoverBlock`
  already uses at `engine.ts:298`. On a plain scan that is the templated fact; on an `--ai` build
  where `narrate` ran but the `ride` pass failed, the templated ride silently inherits the model's
  prose. Free quality, no extra call.
- **Cap at 16 beats, dropping group beats first.** The opening, the trace and the close are the
  story; group beats are the padding.

`RIDE` is therefore never empty on a freshly built atlas — the button is live on a plain non-AI
scan, offline, with no `provenance`.

---

## Part 3 — the camera

`src/atlas/scene.ts`. `stepTween` already lerps `log(zoom)`, which is the right curve — it needs a
**symmetric dip in the middle** so the camera pulls back over the flight and settles in on arrival.

Everything is driven by `k = ease(u)` (the existing `easeInOutCubic`, L85), not by `u`: `ease` is
symmetric about ½ and has `dk/du = 0` at both ends, so the lift starts from rest instead of yanking.

**Zoom** — replace the log-lerp at L276:

```
log z(u) = (1−k)·log z₀ + k·log z₁ − L·sin(π·k)^ARC_SHAPE
```

**`L`, the apex pull-back in nepers, comes from how far the camera actually travels, in screenfuls**
— so a hop between neighbours does not launch into orbit:

```ts
const d      = Math.hypot(b.target.x - a.target.x, b.target.z - a.target.z);
const zm     = Math.sqrt(a.zoom * b.zoom);
const screen = Math.min(host.clientWidth, host.clientHeight) / (BASE_PX * zm);
const spans  = d / Math.max(0.001, screen);
const want   = strength * Math.log(1 + spans);            // saturating, not linear
const room   = Math.max(0, Math.log(zm * ZOOM_OUT / this.fitZoom));
const L      = Math.min(want, room);
```

`ln(1 + spans)` saturates: `spans 0.2 → L 0.18` (a pull-back you barely notice); `spans 1 → L ≈ ln 2`
(apex shows twice as much); `spans 4 → L ≈ 1.6` (apex shows 5× — you see the neighbourhood you are
leaving *and* the one you are arriving at). **`room` is not optional**: `stepTween` writes
`ortho.zoom` directly, and `controls.minZoom` is only enforced by MapControls during *user*
interaction — so a tween can currently fly outside the limits. Clamping the apex to
`fitZoom / ZOOM_OUT` means the highest the ride ever goes is exactly "the whole atlas", the same
ceiling the user's own wheel has.

**Tilt** — a zoom-only dip reads as *the drawing got smaller*, not *I went up*. In an oblique
projection altitude reads from two channels, so `phi` gets a matching dip toward plan view:

```
phi(u) = (1−k)·φ₀ + k·φ₁ − Φ·sin(π·k)
Φ      = min(0.22·L, 0.28, min(φ₀,φ₁) − (MIN_PHI + 0.02))     // 0.28 rad ≈ 16°; MIN_PHI = 0.18 (L203)
```

Precomputed in `animateTo`, so `stepTween` stays a pure evaluation with no clamping in the hot path.

**Heading** — no orbital swing. The topbar compass reads heading, and a ride that leaves the map
crooked fights the `N` button. When a beat asks for no turn, hold `theta`; the sense of motion comes
from the ground sweep plus the altitude arc, which in an oblique projection is already strong
parallax. When a beat *does* ask for a turn, let heading **lead** the descent so the camera is
already facing the destination as it comes down: evaluate `theta` at `k^0.75` instead of `k`, gated
on `L > 0` so every existing caller stays bit-identical.

`radius` is dead in the tween — `applyState` overrides it (`ORTHO_RADIUS` flat, `distanceFor(zoom)`
perspective). Leave it alone.

**Rejected alternatives, so they are not re-attempted.** A Bezier on `target` is wrong: `target` is
pinned to the ground plane — `clampTarget()` forces `y = 0` on every `change`, `fitFor` assumes
`center.y = 0`, and DOM label anchors project against that plane, so an arced target is flattened
back and `focus`/`fit` stop agreeing on what "centred" means. A two-segment tween is wrong: it
doubles the tween-ownership problem in Part 4, needs a `done`-chained continuation that any gesture
silently kills mid-seam, and has a velocity discontinuity at the joint unless derivatives are
hand-matched.

**The ride does *not* force `setProjection('deep')`.** Three reasons, the first decisive:
`setProjection` (L331-341) nulls the tween, disposes the controls and builds fresh ones — calling it
mid-ride destroys the ride's own flight and rebuilds the listeners it depends on. Second, the arc
works in both projections: `applyState` L248 derives perspective distance from `zoom`, so under DEEP
the dip *literally* lifts the camera, and under FLAT it is a scale change plus a tilt toward plan.
Third, FLAT is the identity of the thing; DEEP is a mode the user chose. The overlay can carry the
existing `▱ FLAT / ◇ DEEP` toggle, and because a mid-ride `setProjection` cancels the live flight
with reason `'projection'`, the ride simply re-flies the current beat — which falls out of Part 4
for free.

```ts
const ARC_SHAPE = 1;   // exponent on sin(πk): >1 briefer apex, <1 broader. Named so it is not re-derived.

/** 0 = a flat slide (every existing caller). 1 = a full hop. */
private animateTo(to: Partial<CamState>, ms = 650, done?: () => void, arc = 0, owner?: FlightRec): void
private arcLift(a: CamState, b: CamState, strength: number): number
/** ms derived from the work the move does: ground crossed, zoom octaves, quarter turns. */
private flightMs(a: CamState, b: CamState): number {
  const zm = Math.sqrt(a.zoom * b.zoom);
  const screen  = Math.min(this.host.clientWidth, this.host.clientHeight) / (BASE_PX * zm);
  const spans   = Math.hypot(b.target.x - a.target.x, b.target.z - a.target.z) / Math.max(0.001, screen);
  const octaves = Math.abs(Math.log(b.zoom / a.zoom)) / Math.LN2;
  const turns   = Math.abs(b.theta - a.theta) / (Math.PI / 2);
  return THREE.MathUtils.clamp(520 + 420 * (spans + octaves + turns), 520, 2400);
}
```

`fit` / `reset` / `focus` / `focusEdge` / `resetHeading` / `zoomBy` / `panBy` all pass `arc = 0` and
must be **pixel-identical afterwards** — that is the acceptance test for this step. `fitFor`,
`clampTarget` and `applyLimits` are untouched, and reduced motion needs no work: `animateTo` L263
hard-cuts before a tween exists, so the arc never applies.

---

## Part 4 — flight ownership, then the ride controller

### The root fix: the tween slot gets an owner

The ride cannot be made robust from outside, because the scene kills tweens **silently** in four
places and `animateTo`'s `done` is simply dropped. Nothing passes `done` today, so there is no live
bug — the ride is exactly the caller that would hit it. New surface on `AtlasScene`:

```ts
export type FlightEnd = 'user' | 'gesture' | 'replaced' | 'projection' | 'data' | 'dispose';
export type FlightTarget = { all: true } | { block: string } | { edge: [string, string] } | { blocks: string[] };

export interface Flight { to: FlightTarget; arc?: number; ms?: number; turn?: number; tighten?: number }
export interface FlightHandle { readonly id: number; readonly state: 'flying' | 'landed' | 'cancelled'; cancel(): void }
export interface FlightCallbacks { land?: () => void; cancel?: (why: FlightEnd) => void }

flyTo(f: Flight, on?: FlightCallbacks): FlightHandle
pauseFlight(): void          // freeze where it stands
resumeFlight(): void
isFlying(): boolean
```

A **handle with callbacks, not a Promise**: a Promise cannot report an interruption in the frame it
happens, cannot be polled, and creates stale continuations — the awaited flight for beat 4 resolves
*after* the user skipped to beat 6, and the `await` resumes into the wrong state. The handle carries
a monotonic `id`; every ride callback opens with `if (h.id !== this.flightId) return;`.

Not an `onInterrupt` on `SceneHooks` either: `SceneHooks` is the scene→engine channel for *input*,
and flight ownership is per-call — two callers must not receive each other's interruptions.

The six cancellation sites, which is the complete list:

| site | line | reason |
| --- | --- | --- |
| `controls` `'start'` | 209 | `'gesture'`, before `this.tween = null` |
| `animateTo` | 256 | `owner ? 'replaced' : 'user'` |
| `setProjection` | 333 | `'projection'` |
| `setData` | 467 | `'data'` |
| `dispose` | 809 | `'dispose'` |
| `stepTween` at `u >= 1` | 278 | lands, not cancels |

Deriving `'user'` from *absence of an owner* is what keeps it unambiguous: every public camera action
is only reached from a nav button, a key, a panel button, a dblclick or a sidebar click. The ride
never calls them — it calls `flyTo`.

Three more scene-side details, each of which is a bug if skipped:

- **Dispatch `land` asynchronously, always.** Under reduced motion (or `ms: 0`) `animateTo` applies
  the state and calls `done` synchronously. The ride's `land` starts the next beat, which lands
  synchronously, which starts the next… and the whole ride unwinds in one stack frame and overflows.
  `flyTo` wraps the land dispatch in `queueMicrotask`. One line, in the scene, once — do not try to
  solve it in the ride.
- **Freeze on pause, don't cancel.** `private frozen = false`; the loop becomes
  `if (this.tween) { if (!this.frozen) this.stepTween(t); }`. `pauseFlight()` records the clock,
  `resumeFlight()` does `tw.t0 += now - pausedAt`. Cancelling and re-flying on resume would restart
  the arc from the apex — a second hop, which is the wrong picture.
- **Resize keeps the destination honest.** The handle keeps its resolved `Flight`; `resize()` (L703)
  re-resolves a live flight and patches `tw.to` / `lift` / `tilt` in place, leaving `t0` and `ms`
  alone so the motion does not restart. Plus an optional `SceneHooks.onResize` so the ride can
  re-frame instantly while *holding*.

`focusEdge`'s box-building (L306-308) lifts to a private `boxFor(target: FlightTarget)`, reused by
both. Padding per kind: block `(2.2, 0.6, 2.2)` so the block sits at about a third of frame with its
arcs visible; edge `(1, 0.6, 1)` as today; group `(1.4, 0.6, 1.4)`; `all` uses `fitBox` unchanged.
`flyTo` clamps zoom to `fitZoom / ZOOM_OUT … fitZoom * ZOOM_IN` and **never mutates `fitZoom`** —
that is the user's frame of reference, and only `fit` / `reset` may move it.

### The controller — `src/atlas/ride.ts`

Imports `./types` and `./scene` only; the engine passes callbacks in, so there is no cycle.

```ts
export interface RideHooks {
  onBeat(beat: RideBeat, i: number, n: number): void;   // selection, panel, hash — the engine's business
  onEnd(reason: 'finished' | 'exited' | 'destroyed'): void;
  rich(s: string): string;                              // the engine's [[mark]] renderer
}

export class Ride {
  constructor(host: HTMLDivElement, scene: AtlasScene, theme: Theme, beats: RideBeat[], title: string, hooks: RideHooks);
  start(from?: number): void;  go(i: number): void;  step(d: 1 | -1): void;
  pause(): void;  resume(): void;  toggle(): void;
  setVoice(on: boolean): void;
  stop(reason?: 'exited' | 'destroyed'): void;
  readonly phase: 'idle' | 'flying' | 'holding' | 'paused' | 'ended';
  readonly index: number;
}
```

```
idle ──start──▶ flying(i) ──land──▶ holding(i) ──timer──▶ flying(i+1) … ──▶ ended
                   │  ▲                 │  ▲
             pause │  │ resume    pause │  │ resume
                   ▼  │                 ▼  │
                 paused                paused
```

**One rule makes it robust: a generation counter.** Every entry into a beat does
`const g = ++this.gen`, and *every* async callback — flight `land`, flight `cancel`, the hold
`setTimeout`, `utterance.onend`, `onerror`, the speech watchdog, the silent-failure probe — opens
with `if (g !== this.gen) return;`. That single rule covers late `onend` from a cancelled utterance,
timers that survive a skip, and flights that land after an exit. Without it these get chased
individually for a week.

**On `cancel(why)`:**

| why | what the ride does |
| --- | --- |
| `'gesture'` / `'user'` | hand control over: freeze the hold, `speechSynthesis.pause()`, `phase = 'paused'`, button becomes `▶ RESUME`. Camera left exactly where the user put it. Resume re-flies the current beat from there — the arc recomputes from the new position, correctly. |
| `'projection'` | re-fly the current beat with `ms: 420, arc: 0`; stay in the same phase |
| `'data'` / `'dispose'` | `stop('destroyed')` |
| `'replaced'` | the ride did it itself; ignore |

**Teardown must not call back into the scene.** `renderScene()` starts with `this.scene?.dispose()`,
and `dispose()` cancels the live flight with `'dispose'` — which lands in the ride's handler *while
the scene is mid-dispose*. So `stop()` touches only DOM, timers and `speechSynthesis`, never the
scene. That plus the `dispose()` cancel means the ride dies with the scene even if an engine call
site is ever forgotten.

*Note:* MapControls fires `'start'` on pointerdown for any mapped button, so a plain click that
selects a block also pauses the ride. That is correct — the user reached in. If it proves twitchy,
the refinement is a re-entrancy guard (a private `applying` flag around `applyState`'s
`controls.update()`) and cancelling on the first `'change'` that is not ours, which means *the camera
actually moved* rather than *a button went down*. Ship the `'start'` version first.

### Speech

`speechSynthesis` in the wild is hostile: `speak()` before a user gesture is a silent no-op on
Safari/iOS; `onend` sometimes never fires; Chrome stops synthesis after ~15 s; `cancel()` fires
`onend` on some engines and not others, sometimes after you have moved on; voices load async.

**The hold timer is always authoritative. Speech may only extend a hold, never shorten it, and never
past a cap.**

```
holdMs = beat.hold ?? clamp(1400 + 55 * say.length, 2200, 9000)   // ≈180 wpm plus settle
GRACE  = 6000

onTimer:     if (voice && speaking) { waitingOnVoice = true; watchdog(GRACE); } else next();
onSpeechEnd: if (waitingOnVoice) next();      // otherwise ignore — never cut a caption short
watchdog:    next();                          // the synth never came back
```

A caption is on screen for at least `holdMs` and at most `holdMs + 6000`, whatever the synth does.
The rest:

- `CAN_SPEAK = typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance === 'function'`.
  If false the `VOICE` control is **not drawn at all** — a control that can never work is chrome for
  nothing.
- **Default OFF**, and when `VOICE` is switched on, `speak()` the current line *synchronously inside
  the click handler*. That is the gesture Safari needs to unlock the engine, and it gives instant
  feedback. Every later `speak()` fires from a timer and works because the engine is unlocked.
- **Silent-failure probe**: 900 ms after `speak()`, if neither `onstart` fired nor
  `speechSynthesis.speaking` is true, set `voiceBroken`, flip the toggle back to `VOICE OFF`, and
  stop waiting on speech for the session. That turns iOS's silent no-op into an honest UI state
  rather than a ride that waits 6 s at every stop.
- **Chrome's 15 s cutoff**: while speaking, a 10 s interval doing
  `speechSynthesis.pause(); speechSynthesis.resume();`.
- Before every `speak()`, null the outgoing utterance's `onend`/`onerror` *then* `cancel()`. With the
  generation counter, a late `onend` from line 4 cannot advance line 6.
- Strip `[[marks]]` for speech; keep them for the caption via `hooks.rich`.
- `aria-live="polite"` on the caption — screen readers get the narration without the Web Speech API
  at all, which is the accessible answer to `VOICE` and costs one attribute.

---

## Part 5 — the overlay and the engine

The overlay is built by `Ride` into `mapWrap`, above the nav control, and removed on `stop()`.

- Two letterbox bands, `background: T.bg`, hairline inner rule, `height: clamp(56px, 12%, 120px)`.
  **No transition** — the ride is a mode, and modes snap.
- Bottom band left to right: `04/11` at `--fs-stat` with the denominator in `T.dim` (the trace
  card's recipe at L485); a vertical hairline; the caption at `--fs-body` / `--leading-body` through
  `rich()`; then the buttons.
- Buttons use `navControl`'s `BTN` recipe verbatim: `❚❚ PAUSE` ⇄ `▶ RESUME` (both already in the
  topbar at L209), `‹ BACK` / `NEXT ›` (already in the trace card, L489-490), `VOICE ON` ⇄
  `VOICE OFF` (a word toggle, matching `PAPER · TAN` and `▱ FLAT`), `✕ EXIT` (already at L492).
- Progress: a `var(--border-w)` rule across the bottom, `T.faint` full width with a `T.ink` segment
  at `(i + 1) / n`. **Stepped per beat, not per frame** — it matches `04/11`, avoids a rAF-driven
  DOM write, and keeps the "chrome does not animate" rule intact.

`src/atlas/engine.ts`:

- `private ride: Ride | null = null;`
- **Split `applyTrace()` (L472)** into `showTrace(i)` — selection, hash, panel, everything but the
  camera — with `applyTrace()` becoming `showTrace(i)` + `scene.focus()`. The ride drives
  `showTrace` and owns the camera itself; otherwise every beat would issue a `focus()` that cancels
  the ride's own flight as `'user'`. Same shape for blocks: extract `showBlock(id)` out of
  `select(id, fromTrace)` (L423) rather than having the ride pass a flag named for another feature.
- `boot()` L118: widen the hash regex to `/#(inside|trace|edge|ride)=?([\w,-]*)/` and add a `ride`
  arm → `startRide(parseInt(m[2], 10) || 0)`. The ride writes `#ride=<i>` via the existing
  `setHash`, so pausing anywhere gives a link to that exact stop — the same contract as `#trace=`.
  `?repo=owner/repo#ride` therefore means *scan this repository, then fly over it*: the demo link.
- `onKey` L124: a ride branch **before** the trace branch — `SPACE` toggles pause (with
  `preventDefault` guarded on the target not being a button or input, or it re-triggers whatever has
  focus), `←` `→` step, `ESC` exits.
- `arrowsTaken()` L320 becomes `() => this.traceI >= 0 || !!this.ride` — otherwise the scene's
  arrow-pan (L684-687) fights beat stepping *and* fires a `'user'` cancel on every keypress.
- `renderPanel()` overview card L560: `▶ TAKE THE RIDE — N STOPS` above the existing TRACE button,
  when `D.RIDE?.length`. A topbar button beside `✦ ANALYZE` too.
- `this.ride?.stop('destroyed')` before: `set data` (L46), `build()`, `renderScene()`, `goInside()`,
  `comeOut()`, `startTrace()`, `disconnectedCallback()`.
- The `?` popover (L385-406) gains a `THE RIDE` block: `SPACE`, `← →`, `ESC`, and the fact that
  touching the map hands you the controls. An undocumented gesture may as well not exist.

---

## Part 6 — the `ride` AI pass

A fourth pass, built exactly like the three that exist. Its evidence is the **already-composed
atlas**, so it reads no files, needs no new scan, and costs one call. It must run after `compose`,
because its beats quote the final `TRACE` — which `compose` may have replaced.

```
compose → composed = buildAtlas(source, { partition, narration })
        → ride pass, validated against `composed`
        → final = buildAtlas(source, { partition, narration: { ...narration, ride, rideTitle } })
```

One extra pure `buildAtlas`. It goes through `Narration` rather than being assigned onto the built
object, so `applyNarration` stays the single place in the codebase where "model output overrides
templated output" is expressed.

### Schema — `src/analyze/ai/schemas.ts`

Flat, with a discriminant field and optional siblings — **not** a `z.discriminatedUnion`. The file's
own docstring is the reason: *"Deliberately flat: arrays of objects travel across every provider's
structured-output implementation."* A union inside an array is precisely what the weaker
structured-output paths mangle, and `minimax-m3` is the default model.

```ts
export const RideOut = z.object({
  rideTitle: z.string().describe('Caps label for the ride, e.g. ONE PASS OVER THE SYSTEM.'),
  beats: z.array(z.object({
    look: z.enum(['all', 'block', 'edge', 'group'])
      .describe('What the camera frames: the whole map, one block, one import, or one group.'),
    id: z.string().optional().describe('The block id from the list, when look is "block".'),
    from: z.string().optional().describe('The edge\'s from-id, when look is "edge".'),
    to: z.string().optional().describe('The edge\'s to-id, when look is "edge".'),
    group: z.string().optional().describe('The group name in caps, when look is "group".'),
    say: z.string().describe('One or two sentences, spoken aloud. Present tense. No instructions to the reader.'),
  })).describe('The ride in order: open wide, move through the system the way it runs, close.'),
});
export type RideOut = z.infer<typeof RideOut>;
```

### Validator — `src/analyze/ai/validate.ts`

`CAP` gains `say: 240, rideTitle: 32`; module constants `MAX_BEATS = 16`, `MIN_BEATS = 4`.
`validateRide(out, data, report): { rideTitle: string; ride: RideBeat[] } | null`, built on the same
sets `validateCompose` already computes (`ids`, `edgeKeys`), plus a group map filtered to groups that
actually hold a drawn block. Drop rules, each reported in the existing register:

| Condition | Message |
| --- | --- |
| `look: 'block'`, id not in `ids` | `ride beat on unknown block "x"` |
| `look: 'edge'`, `f->t` not in `edgeKeys` | `ride beat on an edge that is not drawn: a->b` |
| `look: 'group'`, no match | `ride beat on a group that is not drawn: "X"` |
| empty `say` | `a ride beat said nothing` |
| beats past `MAX_BEATS` | noted |

Then: collapse **consecutive duplicates** — flying to where you already are reads as a stall, and it
is the common shape left behind by a dropped middle beat (`A, [dropped], A`).

**Two acceptance gates, both required**: `ride.length >= MIN_BEATS`, and at least 2 distinct blocks
across the surviving beats — a ride that circles one block is not a ride. Failing either returns
`null` and the templated ride stands.

**Per-beat dropping inside a ride; all-or-nothing between rides. Never splice.** Dropping beat 5 of
11 leaves 4 and 6 reading in order — you lose a stop, not the thread. But splicing surviving model
beats into the templated ride produces exactly what the validation discipline exists to prevent: a
beat saying "having seen the API layer…" about a stop that was cut, or two beats establishing the
same thing because one came from each source. Same shape as the existing `trace.length >= 2` gate
(`validate.ts:259`) and the `units.length >= 2` partition gate (`index.ts:156`).

Merge in `applyNarration` (build.ts L482-523):

```ts
RIDE: n.ride?.length ? n.ride : d.RIDE,
rideTitle: n.rideTitle?.trim() || d.rideTitle,
```

### Wiring

| File | Change |
| --- | --- |
| `src/analyze/ai/prompts.ts` | `export const RIDE` — the narrative brief. This is the feature; the rest is plumbing. It must state: a beat may name only a block id, a group name or an edge pair from the lists; the ride opens wide and closes wide; each `say` is one or two sentences **that will be spoken aloud** — so no bracket-heavy prose, no "as you can see", no instructions to the reader. |
| `src/analyze/ai/evidence.ts` | `rideEvidence(source, data)` → `{ name, ref, product, facts, groups, blocks, edges, trace }`. `composeEvidence` has no groups and no trace, which is exactly what a ride is ordered by. Stays browser-safe: no `ai`, no `zod`. |
| `src/analyze/ai/index.ts` | `buildRidePrompt` exported beside the other three (`api/enrich.ts` imports from here); pass 4 in `enrichAtlas`; labels become `1/4 … 4/4`; a `ride` row in `planEnrichment` so `--dry-run` accounts for it; `provenance.models.ride`. |
| `src/analyze/ai/client.ts` | mirror: `pass<RideOut>('ride', rideEvidence(source, composed))` in its own `try`. The existing "a map with holes keeps its passes" cache logic covers it unchanged. |
| `api/enrich.ts` | `case 'ride'` with `cleanRide` — `{ name:200, ref:100, product:120, facts:4_000, groups:2_000, blocks:40_000, edges:20_000, trace:8_000 }`. **And add `RIDE` to the `PROMPTS_VERSION` hash at L55** — the browser mixes that into every cache key, so without it every client keeps serving pre-ride atlases from `localStorage` for ever. |
| `src/data/arc-worlds.ts` | a hand-written `RIDE` — it is the demo everyone sees, and the held-out quality target. |

**Cost**: one call on a ~6–10 KB pack — about **$0.003** on the default `minimax/minimax-m3`, against
$0.032 for the whole atlas today. A note in the README's cost table, not a new row.

**Security**: `/api/enrich` keeps its stated property — *"There is no free-text field and the client
cannot choose the model, so it is not usable as a general LLM proxy."* The `ride` pass adds no
free-text input. The `scripts/firewall.sh` note (`one atlas is roughly six requests`) becomes seven.

---

## Order of work

Each step leaves the app working and is worth its own commit, in Conventional Commits form
(commitlint runs in CI), landing through a PR as `main` is protected. **Do not add Claude, Anthropic
or any AI tool as a co-author or trailer.**

1. `feat(atlas): the map carries a route over itself` — `types.ts`, `buildRide()` in `build.ts`, the
   merge in `applyNarration`, the hand-written `RIDE` in `arc-worlds.ts`. Every dataset now has a
   ride; nothing renders it.
2. `feat(atlas): flights that can be owned, paused and taken` — flight ownership, `flyTo` /
   `pauseFlight` / `resumeFlight`, the arc math. **Acceptance: `fit` / `reset` / `focus` /
   `focusEdge` are pixel-identical to before.**
3. `feat(atlas): a ride you can take over the map` — `ride.ts` and the overlay, **with voice off and
   no speech code at all**. Get the state machine, the interruption path and the overlay right first.
4. Engine wiring: the `showTrace` / `showBlock` split, panel and topbar buttons, keys,
   `arrowsTaken`, `#ride=`, the seven `stop()` call sites, the `?` popover.
5. Speech — last, because it is the only part that can be deleted without the feature dying.
6. `feat(analyze): a model decides what order to show the map in` — the fourth pass end to end. It
   rewrites data the ride already consumes, so it lands on a working feature.
7. `docs: the ride` — README section, the `#ride` link, the seventh request in the firewall note.

Step 4 is the point at which the feature is demonstrable with no key and no network. Steps 1–4 are
worth doing even if 6 never happens.

---

## Verification

```sh
bun run typecheck                       # the contract change compiles everywhere
bun run dev                             # http://localhost:5173
```

1. **Templated ride, no key.** Move `.env.local` aside, open `/` (the bundled demo), press
   `▶ TAKE THE RIDE`. It plays end to end with no network call.
2. **Plain scan.** `/?repo=sindresorhus/got` — the ride works on a map whose prose is templated.
3. **Analysed ride.** Restore `.env.local`, `✦ ANALYZE`, then ride. Different, better order, with
   narration that carries between stops.
4. **CLI parity.** `bun run atlas . --ai`, open the printed `?atlas=` link — the baked `RIDE` plays
   identically. `bun run atlas . --ai --dry-run` accounts for the fourth call.
5. **Interruption.** Mid-flight, drag the map: the ride must hand over the controls and say so, not
   fight or hang. Resume re-flies the current stop. Then, mid-ride: resize the window; press `◀`;
   swap repositories; toggle `▱ FLAT`/`◇ DEEP`; navigate away. None may leave a flight running or a
   voice talking.
6. **Reduced motion.** Turn on *Reduce motion* in macOS Accessibility. The ride must become a
   watchable slide show — and specifically **must not overflow the stack**, which is what happens if
   `land` is dispatched synchronously.
7. **Degradation.** Break the `ride` pass deliberately (make `RIDE` in `prompts.ts` demand a field
   the schema rejects) and confirm the templated ride is used and the status line says the pass fell
   back — an `--ai` build is never worse than a plain one.
8. **Validation.** Hand `validateRide` a `RideOut` naming an undrawn block id, a non-existent group,
   and an edge that is not on the map. All three dropped and reported, the rest kept. Then one that
   leaves only three beats — the templated ride must stand.
9. **Cache invalidation.** Analyse a repo, then edit `prompts.ts`, reload, and confirm the browser
   re-asks rather than serving the pre-ride atlas — this is what the `PROMPTS_VERSION` change buys.
10. **Papers.** Cycle `PAPER ·` through all five during a ride; the overlay must be legible on each.
11. **Voice.** Toggle `VOICE ON` — including on Safari, where the first `speak()` must happen inside
    the click. Confirm timing still holds when speech is refused (the probe flips it back to OFF
    rather than waiting 6 s per stop), and that skipping or exiting cancels the utterance instead of
    talking over the next stop.

---

## Deliberately not in this

- **No free-text "show me how auth works".** Decided: it would put a free-text-in / free-text-out
  path on a public endpoint that today has neither. Its own change, with its own rate limit and its
  own README section.
- **No TTS service.** The browser's voice is free, local, offline and adds no dependency — the
  bundle's only runtime dependency stays `three`.
- **No video export.** A screen recording of the ride is already the artifact.
- **No multiple named rides per atlas.** One ride, like one trace.

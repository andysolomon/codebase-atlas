# Build prompt — Codebase Atlas web app

Copy everything below into your dev tool (Claude Code, Cursor, etc.) along with the referenced project files.

---

Build a production web app called **Codebase Atlas**: an interactive isometric map that renders a code repository as a city of hatched blocks on drafting paper. A working prototype exists and is the source of truth — the app must look and behave EXACTLY like it. Do not redesign, "modernize", or add anything.

## Source-of-truth files (attached)
- `atlas-engine.js` — the complete prototype renderer (~400 lines, vanilla JS web component). Port its behavior 1:1. When this prompt and the code disagree, the code wins.
- `atlas-data.js` — the data schema by example (`window.ATLAS_DATA` for repo andysolomon/arc-worlds).
- `readme.md` — the design system rules.

## Stack
Vite + TypeScript. Keep the renderer a framework-free module operating on SVG, as in the prototype (React allowed for app chrome only — the map itself must stay imperative SVG). No UI libraries, no CSS frameworks, no icon fonts. Zero runtime dependencies for the renderer.

## Design system — follow exactly
- **Two colors per theme: paper and ink.** All grays are ink at 55 / 28 / 16 % alpha. Three themes, exact hex values:
  - tan (default): bg `#cfc79c`, paper `#c8c093`, top `#ddd6b2`, faceA `#bdb488`, faceB `#cec696`, ink `#16130a`, dim `rgba(22,19,10,.55)`, faint `rgba(22,19,10,.16)`
  - light/blueprint: bg `#f1eee4`, paper `#eae6d8`, top `#fdfcf7`, faceA `#dcd7c6`, faceB `#e9e5d6`, ink `#233457`, dim `rgba(35,52,87,.55)`, faint `rgba(35,52,87,.14)`
  - dark/dark-luxe: bg `#191510`, paper `#14100c`, top `#2c251b`, faceA `#211b13`, faceB `#271f16`, ink `#e4d3a1`, dim `rgba(228,211,161,.55)`, faint `rgba(228,211,161,.16)`
- **Type:** system mono only — `ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,monospace`. Scale: 9px letter-spaced UPPERCASE kickers → 12.5px/1.75 body → 21px titles → 30px display. No second family.
- **Corners: radius 0 everywhere.** Borders do the work: 1px hair, 1.5px rule, 2px heavy. No shadows, no blur, no gradients (hatch patterns are the only exception). No emoji. Glyphs are unicode in the mono face: ❚❚ ▶ ⌖ ▣ ✕ ‹ › ← → ·
- **Emphasis** = inverted-ink highlight (`[[text]]` in data → ink background, paper text, `padding:0 4px`). Never color or italics.
- **Selection = full inversion** (ink bg, paper text). **Hover** = faint ink-alpha tint on rows, faceB tint on block tops, plus a bordered paper tooltip card.
- **Motion:** ONLY the flow dots (r 2.7 ink circles with a 1px paper ring) gliding along solid edges at 46 px/s, linear. Dashed lines (`4 3.5`) never animate. Everything else is instant — no eases, fades, or transitions.

## Isometric projection — exact math
- `SX=26, SY=14.3, SH=16`; screen point `P(gx,gy,h) = [(gx−gy)·26, (gx+gy)·14.3 − h·16]`.
- Blocks: 3 polygons (left face + dense 45° hatch overlay, right face + light −45° hatch, top), ink strokes 1.2/1.2/1.4, painter-sorted by `gx+gy+(w+d)/2`.
- Hatch patterns: 45° gap 4.2 opacity .5 (left), −45° gap 5.2 opacity .28 (right), stroke-width 0.9 ink lines.
- Block height encodes code size; flat slabs (`slab:1`) are storage/records. Code letters centered on top face (font-size `clamp(10, min(w,d)·6.5, 19)`, weight 700, letter-spacing .08em; 9px for slabs); UPPERCASE name label 8.5px below the block front edge, dim loc line 7.5px under it.
- Edges: orthogonal polylines on the grid (auto L-bend via `[b.x, a.y]` unless `via` waypoints given), 1.3px if flowing else 1px, opacity .55 (.4 dashed), arrowhead = r2 dot at target. 9px transparent hit line shows a tooltip: `from → to` + payload.
- Externals: dashed leader (`2.5 3`, 0.9px, .5 opacity) from block top to an 8px letter-spaced dim label.

## Layout — exact
- 60px topbar, 1.5px ink bottom border: horizontally scrolling stat cells (9px dim key over 14px value, 1.5px right borders) — CODEBASE ATLAS/product, REPOSITORY, then repo stats — plus a bordered `❚❚ PAUSE THE FLOW` / `▶ RESUME THE FLOW` toggle button at right.
- Main grid `232px | 1fr | 398px`, 1.5px ink dividers, full viewport height (min 640px).
- Left sidebar: group name as inverted-ink 9px chip; rows of [bordered 20px code badge · name · dim size], hover faint, selected fully inverted.
- Map center: pan (pointer drag), zoom (wheel toward cursor, clamped fit/5 … fit×2.2), `⌖ FIT` button top-right, cartouche (bordered paper card) bottom-left, dim hint line bottom-right, `← BACK TO THE MAP` inverted button top-left when inside a structure.
- Right panel 398px: overview (kicker, 21px balanced title, WHAT IT DOES / HOW IT'S BUILT rule-headings with paragraphs, bordered how-to-read card, full-width inverted TRACE button) ⁄ detail card (← back link, 26px bordered code badge + 19px name, dim meta line, WHAT/HOW/SOURCE sections, TALKS TO chip buttons that navigate, inverted GO INSIDE button when children exist) ⁄ trace mode (step `01 / 13` display, sentence with 3px ink left border, PREV/NEXT/END buttons, disabled = opacity .35).

## Behavior — port 1:1 from atlas-engine.js
- Click block or sidebar row → select (toggle off on re-click); click empty map → deselect. Selection syncs sidebar row, block top (inverted), and right panel.
- Double-click a block with `children` → go inside: children laid on a 3-column grid (`(i%3)·4.2, floor(i/3)·4.2`, 2.3×2.3, h·1.9 min 0.45), no edges, cartouche shows INSIDE header, ESC or back button exits (re-selecting the parent).
- TRACE mode: steps through `TRACE` [structureId, sentence] pairs; the current block stays opacity 1, all others 0.22; ←/→ step, ESC ends; entering trace exits inside-view.
- Deep links: `#inside=<id>` and `#trace=<n>` restored on load, written via `history.replaceState`.
- Flow toggle pauses/resumes dot animation (2 dots per flow edge, offset 0.5).
- Tooltip follows the pointer (+14px offset, flips at container edges).
- Theme switch (`paper` = tan | light | dark) rebuilds the scene; flow state persists.

## Data contract (see atlas-data.js)
`ATLAS_DATA = { repo, product, stats[[k,v]], overviewTitle/Kicker/Sub, OVERVIEW_WHAT[], OVERVIEW_HOW[], HOW_TO_READ, GROUPS[[name, ids[]]], STRUCTURES[{id, code, name, group, loc, gx, gy, w, d, h, slab?, what, how, src[], talks[], children?[{code,name,h,what}]}], EDGES[{f, t, flow?, dashed?, pay, via?[[gx,gy]]}], EXTERNALS[{name, t, dx, dy}], TRACE[[id, sentence]] }`. The app loads this per-repo dataset (static import or fetched JSON); ship the arc-worlds dataset as the demo.

## Content voice (for any new copy)
Plain-English, matter-of-fact, for a smart non-expert. Labels UPPERCASE, letter-spaced, tiny; body sentence case. Separator ` · `. Numbers are facts from a scan, never invented.

## Acceptance
Side-by-side with the prototype at the same viewport, the app is pixel-equivalent in all three themes, and every interaction above works: select, inside, trace, pan/zoom/fit, flow pause, tooltips, deep links, keyboard (ESC, ←, →).

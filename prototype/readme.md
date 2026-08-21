# Codebase Atlas — design system

The visual language of the Codebase Atlas tool: an isometric map that renders a repository as a city of hatched blocks on drafting paper. This system extracts its paper-and-ink aesthetic into tokens, components and specimens so any surface (panels, docs, decks, other atlases) can be built in the same hand.

Sources: built from this project’s own atlas (`atlas-engine.js`, `Codebase Atlas.dc.html`), whose content maps github.com/andysolomon/arc-worlds (main). No external brand assets were provided.

## CONTENT FUNDAMENTALS
- Voice: plain-English, matter-of-fact, written for a smart non-expert. One or two sentences per idea. ("The heart of the repo and its single biggest file.")
- Labels and headings: UPPERCASE, letter-spaced, tiny. Body text: sentence case.
- Numbers are facts from a scan, never invented; sizes shown as "7 files · 55 KB".
- Separator is the middle dot " · ". Arrows are unicode: → ‹ › ← .
- Emphasis = inverted-ink highlight span, never color or italics. No emoji, ever.
- Second person for instructions ("You drag a slider"), third for description.

## VISUAL FOUNDATIONS
- Two colors per theme: paper and ink. All grays are ink at 55/28/16% alpha. Default theme is tan drafting paper; `data-theme="blueprint"` and `data-theme="dark-luxe"` swap the pair.
- Type: system mono everywhere (`--font-mono`). Scale: 9px kickers → 12.5px/1.75 body → 21px titles → 30px display. No second family.
- Corners: radius 0 everywhere. Borders do the work: 1px hair, 1.5px rule, 2px heavy. No shadows, no blur, no transparency layers, no gradients (except hatch patterns).
- Hatching: dense 45° on left block faces, light −45° on right faces (`--hatch-dense/-light` as background-image).
- Iso projection: x=(gx−gy)·26, y=(gx+gy)·14.3 − h·16; painter order by gx+gy. Block height encodes code size; storage is flat slabs.
- Motion: only the data dots (small ink circles with a paper ring) gliding along solid flow lines, linear, ~46px/s. Dashed lines (2.5/3) are advisory and never animate. Everything else is instant — no eases, fades or bounces.
- Hover: face tint swap + paper tooltip card. Selection: full inversion (ink bg, paper text).
- Links: ink, underlined on hover only.

## ICONOGRAPHY
No icon font, no SVG icon set. Glyphs are unicode characters set in the mono face: ❚❚ ▶ ⌖ ▣ ✕ ‹ › ← → ·. The isometric hatched block (see Brand / The block) is the only illustration motif. No logo was provided — render "CODEBASE ATLAS" in a kicker where a mark would go.

## Index
- `styles.css` → `tokens/` (colors, typography, spacing, patterns)
- `components/actions/` Button · `components/display/` StatCell, CodeBadge, RuleHeading · `components/surfaces/` PaperCard, ListRow
- `guidelines/` foundation specimen cards
- `ui_kits/atlas/` the full interactive atlas (engine: `atlas-engine.js`, data: `atlas-data.js`)
- Atlases: `Codebase Atlas.dc.html` (tan) · `— Blueprint` · `— Dark Luxe`
- `github.md` source-repo receipt · `SKILL.md` agent skill

## Intentional additions
Component set is exactly the atlas UI’s own primitives — nothing standard-issue (no Tabs, Toast, Avatar…) was added.
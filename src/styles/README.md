# The design system, in the app

The Codebase Atlas design system lives at **claude.ai/design → "Codebase Atlas Design System"**
(project `3241d65e-8737-4138-8083-fcc1eabb0520`). `prototype/` is a snapshot of its export — the
specimen cards, the component JSX, and the SVG prototype the Three.js map was ported from.

`src/styles/tokens/` is the app's copy of the system's token layer, mirrored verbatim. It is the only
place in `src/` where a colour, a type size or a rule weight is written down.

| upstream | here |
| --- | --- |
| `styles.css` | `src/styles/tokens.css` |
| `tokens/colors.css` | `src/styles/tokens/colors.css` |
| `tokens/typography.css` | `src/styles/tokens/typography.css` |
| `tokens/spacing.css` | `src/styles/tokens/spacing.css` |
| `tokens/patterns.css` | `src/styles/tokens/patterns.css` |

## How the app reads them

The page loads the tokens through `src/style.css` and everything under `<codebase-atlas>` inherits
them, so the chrome — topbar, sidebar, panel, tooltip, trace — asks for `var(--fs-body)`,
`var(--border-w)` and the rest directly in its inline styles.

The map cannot: it paints on a canvas, and WebGL has never heard of `var(--ink)`. So `src/atlas/theme.ts`
resolves one theme out of the cascade — it hands a throwaway element the `data-theme` in question and
reads back its computed tokens — and passes the concrete pair to the scene. No hex value is repeated
in TypeScript; the one exception is the tan fallback in `theme.ts`, for the element used with no
stylesheet at all.

`src/atlas/scene.ts` carries the two pieces of the system that are geometry rather than CSS: the hatch
(`--hatch-dense` 45°, `--hatch-light` −45°, at the periods and ink alphas the drafting spec states) and
`--leader-dashed`, the 2.5/3 advisory dash. Both are named constants at map scale.

## Papers

`tan` (the `:root` default), `blueprint`, `dark-luxe`, `graphite`, `oxblood` — chosen with `?paper=`,
or the `PAPER · …` button in the topbar, which cycles the list in `PAPERS`. `light` and `dark` were
the names the first two shipped under and still resolve, so older links land where they used to.

## Re-syncing

When the upstream system changes, copy the four token files across (keeping the header comment on
each), add the new theme's name to `PAPERS` in `src/atlas/theme.ts`, and refresh `prototype/` to match.
Nothing else should need touching: a new colour reaches both the page and the map by cascade alone.

# Codebase Atlas

An interactive isometric map that renders a code repository as a city of hatched blocks on drafting paper.
Vite + TypeScript; the renderer is a framework-free custom element operating on SVG with zero runtime dependencies.

```sh
bun install
bun run dev        # http://localhost:5173
bun run build      # typecheck + production build → dist/
bun run preview
```

## Layout

| Path | What |
| --- | --- |
| `src/atlas/engine.ts` | The renderer — a 1:1 TypeScript port of `prototype/atlas-engine.js`. Registers `<codebase-atlas paper="tan\|light\|dark" flow="true\|false">`. |
| `src/atlas/types.ts` | The `AtlasData` contract (structures, edges, externals, trace, groups, stats). |
| `src/data/arc-worlds.ts` | Demo dataset: `andysolomon/arc-worlds` (Little Worlds). |
| `src/main.ts` | App chrome: defines the element, feeds it the dataset, reads `?paper=` from the URL. |
| `prototype/` | The original design-system bundle and prototype — the source of truth. |

## Usage

- **Theme** — `?paper=tan|light|dark` in the URL, or the `PAPER · …` button in the topbar. The URL is kept in step.
- **Deep links** — `#inside=<id>` opens a structure; `#trace=<n>` opens trace step *n* (0-based).
- **Keyboard** — `ESC` exits inside-view / ends trace / deselects; `←` `→` step a trace.
- **Map** — drag to pan, wheel to zoom toward the cursor, `⌖ FIT` to reset; click selects, double-click goes inside.

## Loading another repository

Build an `AtlasData` object (see `src/atlas/types.ts`, example in `src/data/arc-worlds.ts`) and assign it:

```ts
const atlas = document.querySelector('codebase-atlas')!;
atlas.data = await fetch('/atlases/my-repo.json').then((r) => r.json());
```

The element also falls back to `window.ATLAS_DATA` if `data` is never set, so the prototype's plain-script data files work unchanged.

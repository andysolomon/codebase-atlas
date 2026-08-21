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

## Contributing

`main` is protected: every change lands through a pull request that passes the
**Merge Gate** check. Direct pushes to `main` are rejected.

```sh
git checkout -b feat/your-change
# ... work ...
git commit -m "feat: describe the change"
gh pr create
```

### Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).
Messages are validated in CI by commitlint — there is no local git hook, so a
malformed message fails the PR rather than blocking the commit.

| Prefix | Release |
| --- | --- |
| `fix:` | patch |
| `feat:` | minor |
| `feat!:` or a `BREAKING CHANGE:` footer | major |
| `ci:` `docs:` `chore:` `refactor:` `test:` `perf:` `build:` `style:` | none |

### CI

| Workflow | Trigger | Does |
| --- | --- | --- |
| `pr.yml` | pull request | Validate Commits, Typecheck, Build — as separate checks |
| `merge.yml` | pull request | The same three as one `Merge Gate` status, required to merge |
| `release.yml` | push to `main` | Runs semantic-release |

### Releases

semantic-release tags the version and publishes a
[GitHub Release](https://github.com/andysolomon/codebase-atlas/releases) with generated
notes. **The Releases page is the changelog** — nothing is committed back to `main`,
because the Actions bot cannot be granted a ruleset bypass on a user-owned repo and a
blocked push would fail the release before the tag is created.

The package is private and is never published to npm.

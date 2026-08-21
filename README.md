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
| `src/main.ts` | App chrome: defines the element, feeds it the dataset, reads `?paper=`, `?repo=`, `?atlas=` from the URL. |
| `src/analyze/` | The repo analyzer — turns a file listing into an `AtlasData` (see below). |
| `src/analyze/ai/` | Optional AI analysis: decides what the blocks are and writes the prose. |
| `api/enrich.ts` | Vercel Function that runs one AI pass, for the in-browser scan. |
| `scripts/atlas.ts` | CLI: `bun run atlas <path \| github-url>`. |
| `scripts/eval-atlas.ts` | Scores a generated atlas against the hand-written `arc-worlds` one. |
| `prototype/` | The original design-system bundle and prototype — the source of truth. |

## Usage

- **Repository** — `?repo=owner/repo` scans GitHub live; `?atlas=/atlases/x.json` loads a pre-built atlas; neither → the bundled demo.
- **Theme** — `?paper=tan|light|dark` in the URL, or the `PAPER · …` button in the topbar. The URL is kept in step.
- **Deep links** — `#inside=<id>` opens a structure; `#trace=<n>` opens trace step *n* (0-based).
- **Keyboard** — `ESC` exits inside-view / ends trace / deselects; `←` `→` step a trace.
- **Map** — drag to pan, wheel to zoom toward the cursor, `⌖ FIT` to reset; click selects, double-click goes inside.

## Mapping any repository

Three ways in. Every number on the map is a fact from the scan (file counts, bytes, import
statements); the prose is templated from those facts, so treat it as a map, not documentation.

**1. From a GitHub URL, in the browser.** Type `github.com/owner/repo` (or `owner/repo`,
`owner/repo@branch`) into the `⌕ OPEN REPO` field in the topbar, or open
`/?repo=owner/repo` directly. The tree comes from the GitHub API (2 calls — the
unauthenticated limit is 60/hour) and file contents from `raw.githubusercontent.com`
for up to 400 code files. Public repos only; nothing leaves your browser.

**2. From a local folder, with the CLI.**

```sh
bun run atlas .                               # this repo
bun run atlas ../some-repo                    # any folder
bun run atlas https://github.com/owner/repo   # or a GitHub URL (GITHUB_TOKEN for private repos)
bun run atlas owner/repo -o out.json          # explicit output path; --stdout prints instead
bun run atlas . --ai                          # let a model name the blocks and write the prose
```

Writes `public/atlases/<name>.json` and prints the link to open it:
`http://localhost:5173/?atlas=/atlases/<name>.json` (generated atlases are git-ignored).

**3. By hand.** Build an `AtlasData` object (see `src/atlas/types.ts`; `src/data/arc-worlds.ts`
is a hand-written example with real narrative) and assign it: `atlas.data = myData`.

### AI analysis

Without `--ai`, every block is a folder and every sentence is a template over byte counts. With `--ai`,
a model decides what the blocks *are* — concepts rather than folders — and writes the cards, the
overview and one traced user journey. **The scan keeps sole authority over every number**: sizes,
heights, positions, import edges and file lists are computed exactly as before, from the model's
choice of blocks.

```sh
bun run atlas . --ai                                    # cheap default
bun run atlas . --ai --model spacexai/grok-4.6          # any AI Gateway model id
bun run atlas . --ai --model-partition anthropic/claude-opus-4.8   # spend where it counts
bun run atlas . --ai --dry-run                          # token estimate, makes no calls
bun run atlas . --ai --explain                          # where each headline number came from
```

Set `AI_GATEWAY_API_KEY` (or run `vercel link && vercel env pull`, which uses OIDC and needs no
long-lived key). To try it with no Vercel setup at all, `--model minimax-direct/MiniMax-M3` talks to
MiniMax's Anthropic-compatible endpoint with just `MINIMAX_API_KEY`.

Three passes — decide the blocks, describe each one, write the front matter. Everything a model
returns is checked against the scan before it can touch the map: a path that does not exist, a block
id that was never drawn, an edge that is not on the map, or a headline number citing no evidence is
dropped and reported. Prose is trimmed to what a card can hold. **Any pass that fails keeps the
templated prose for that part**, so an `--ai` build is never worse than a plain one. Results are
cached in `.atlas-cache/` by prompt, so re-running is free.

Measured against `src/data/arc-worlds.ts` — a map of `../arc-worlds` that a human wrote, which makes
it a real held-out target — using `bun scripts/eval-atlas.ts <atlas.json>`:

| | plain | `--ai` |
| --- | --- | --- |
| hand-written block names recovered | 39% | 82% |
| bespoke groups (`THE ENGINE`, `TERRAIN V2`, `LEGACY`) | 4/7, plus 4 generic | 7/7, none generic |
| blocks with written prose | 0/22 | 18/24 |
| trace | 6 import hops | 14 steps, revisits blocks |

**In the browser.** When `?repo=` scans a repository, the templated map is drawn immediately and then
upgraded in place if `/api/enrich` is deployed. The endpoint accepts only a known pass name and a pack
of named fields and returns only atlas-shaped JSON — there is no free-text field and the client cannot
choose the model, so it cannot be used as a general LLM proxy. Rate limit it with a Vercel Firewall
rule. Nothing in `src/` imports `ai` or `zod`, so the browser bundle stays dependency-free.

### How the scan becomes a map

`src/analyze/build.ts` — framework-free, runs in the browser and in Bun:

- **Blocks** are folders. Top-level folders to start; any folder holding more than 12 % of the
  files is split into its children, up to 24 blocks. Height = text bytes inside (binaries are
  counted as assets, never measured). `db/`, `migrations/`, `data/` … draw as slabs.
- **Groups** (THE APP · THE SERVER · THE DOMAIN · THE DATA · QUALITY · DOCS · TOOLING · THE ROOT)
  come from folder names; each group is one row of the map.
- **Edges** are import statements resolved between blocks (JS/TS incl. `@/` aliases, Python,
  Go, Rust, Ruby, PHP, Java/Kotlin, C includes). The busiest 30 % flow; singletons are dashed.
- **Externals** are the eight most-imported third-party packages, pinned to the block that
  uses each most. Frameworks are read from `package.json` / `requirements.txt` / `pyproject.toml`.
- **Trace** starts at the entry point (`main.*`, `index.*`, `app.*`, …) and follows the heaviest
  unvisited import edge, up to 12 steps. **Inside** a block are its nine largest files.

| Path | What |
| --- | --- |
| `src/analyze/build.ts` | Scan → `AtlasData` |
| `src/analyze/github.ts` | GitHub tree + raw content loader (`parseGitHub`, `loadGitHub`) |
| `src/analyze/imports.ts` | Import extraction per language |
| `src/analyze/ignore.ts` | Ignored folders, code/text extensions |
| `scripts/atlas.ts` | The CLI; adds the local-filesystem loader |
| `src/analyze/ai/` | The three AI passes, their prompts, and the validation that gates them |

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

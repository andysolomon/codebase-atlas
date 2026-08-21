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
| `src/analyze/local.ts` | Opens a folder on this machine as a scan, in the browser. |
| `src/trail.ts` | The repositories opened this session, for the topbar's `◀` `▶`. |
| `src/analyze/ai/browser-cache.ts` | What the browser has already paid a model for, so it is never bought twice. |
| `src/analyze/aliases.ts` | What a repo calls its own code — workspace names, `tsconfig` paths, the go module. |
| `src/analyze/ai/` | Optional AI analysis: decides what the blocks are and writes the prose. |
| `api/enrich.ts` | Vercel Function that runs one AI pass, for the in-browser scan. |
| `scripts/atlas.ts` | CLI: `bun run atlas <path \| github-url>`. |
| `scripts/eval-atlas.ts` | Scores a generated atlas against the hand-written `arc-worlds` one. |
| `prototype/` | The original design-system bundle and prototype — the source of truth. |

## Usage

- **Repository** — the topbar's `⌕ OPEN REPO` field takes a GitHub repo or an atlas URL; `⌂ LOCAL FOLDER` opens one off this machine. By URL: `?repo=owner/repo` scans GitHub live, `?atlas=/atlases/x.json` loads a pre-built atlas, neither → the bundled demo.
- **Analysis** — `✦ ANALYZE` reads the code with a model and rewrites the map (see [AI analysis](#ai-analysis)). Greyed out for a pre-built atlas: its prose is already written.
- **History** — `◀` `▶` step through the repositories opened this session. Stepping back is instant and costs nothing: the built map, including any analysis, is kept with the entry. Repos openable by name are remembered across reloads and suggested in the field.
- **Theme** — `?paper=tan|light|dark` in the URL, or the `PAPER · …` button in the topbar. The URL is kept in step.
- **Deep links** — `#inside=<id>` opens a structure; `#trace=<n>` opens trace step *n* (0-based).
- **Keyboard** — `ESC` exits inside-view / ends trace / deselects; `←` `→` step a trace.
- **Map** — drag to pan, wheel to zoom toward the cursor, `⌖ FIT` to reset; click selects, double-click goes inside.

## Mapping any repository

Four ways in. Every number on the map is a fact from the scan (file counts, bytes, import
statements); the prose is templated from those facts, so treat it as a map, not documentation.

Imports are resolved through the repository's own configuration, so a monorepo draws as one system
rather than as a scatter: every `package.json` `name` in the tree, `tsconfig`/`jsconfig`
`compilerOptions.paths`, and `go.mod`'s module path. Without that, `@acme/shared` reads as a
third-party dependency and the edge between two of your own packages is never drawn.

**1. From a GitHub URL, in the browser.** Type `github.com/owner/repo` (or `owner/repo`,
`owner/repo@branch`) into the `⌕ OPEN REPO` field in the topbar, or open
`/?repo=owner/repo` directly. The tree comes from the GitHub API (2 calls — the
unauthenticated limit is 60/hour) and file contents from `raw.githubusercontent.com`
for up to 400 code files. Public repos only; nothing leaves your browser.

**2. From a local folder, in the browser.** Press `⌂ LOCAL FOLDER` in the topbar and choose a
directory. Chromium opens it through `showDirectoryPicker()`, which never descends into
`node_modules` and friends; Safari and Firefox fall back to a directory `<input>`, which enumerates
the whole tree and filters afterwards — slower on a big checkout, same result. Up to 400 code files
are read for imports, exactly as with a GitHub scan. **Nothing is uploaded**: the scan runs in the
tab, and `✦ ANALYZE` sends only the evidence packs the browser builds, never the files.

**3. From a local folder, with the CLI.**

```sh
bun run atlas .                               # this repo
bun run atlas ../some-repo                    # any folder
bun run atlas https://github.com/owner/repo   # or a GitHub URL (GITHUB_TOKEN for private repos)
bun run atlas owner/repo -o out.json          # explicit output path; --stdout prints instead
bun run atlas . --ai                          # let a model name the blocks and write the prose
```

Writes `public/atlases/<name>.json` and prints the link to open it:
`http://localhost:5173/?atlas=/atlases/<name>.json` (generated atlases are git-ignored).

**4. By hand.** Build an `AtlasData` object (see `src/atlas/types.ts`; `src/data/arc-worlds.ts`
is a hand-written example with real narrative) and assign it: `atlas.data = myData`.

### AI analysis

Without `--ai`, every block is a folder and every sentence is a template over byte counts. With `--ai`,
a model decides what the blocks *are* — concepts rather than folders — and writes the cards, the
overview and one traced user journey. **The scan keeps sole authority over every number**: sizes,
heights, positions, import edges and file lists are computed exactly as before, from the model's
choice of blocks. A block card goes from this:

> `[[src/]]` — 11 files, 101 KB of text, mostly TypeScript and CSS. The largest file is engine.ts (32 KB).

to this:

> The engine's renderer: a single `PlanetViewport` class that draws a planet, its moons, its rings, and
> their orbits, and that drives the procedural surface, atmosphere, and gas shaders. It is the only place
> the app turns `PlanetParams` and a `SystemDef` into pixels.

#### Getting a key

```sh
vercel link && vercel env pull        # OIDC, no long-lived key to rotate — preferred
export AI_GATEWAY_API_KEY=...         # or a gateway key, for CI or an unlinked machine
```

`vercel env pull` writes a `VERCEL_OIDC_TOKEN` into `.env.local`, which Bun loads automatically — so
`bun run atlas . --ai` works straight after linking, with no key to manage.

**The Gateway's free tier will not carry a whole atlas.** One call gets through and the rest come back
rate-limited, and lowering `--concurrency` does not help — the allowance is the limit, not the burst.
Add credits to the AI Gateway before relying on it.

To run with no Vercel setup at all, `--model minimax-direct/MiniMax-M3` talks to MiniMax's
Anthropic-compatible endpoint and needs only `MINIMAX_API_KEY`. That is the path the numbers below
were measured on.

#### Examples

```sh
bun run atlas . --ai                                # cheap default (minimax/minimax-m3)
bun run atlas ../some-repo --ai                     # any local folder
bun run atlas owner/repo --ai                       # any public GitHub repo

bun run atlas . --ai --dry-run                      # token estimate; makes no calls, needs no key
bun run atlas . --ai --explain                      # print where every headline number came from
bun run atlas . --ai --no-cache                     # ignore .atlas-cache and re-ask
bun run atlas . --ai --concurrency 1                # one call at a time, for a twitchy provider

bun run atlas . --ai --model spacexai/grok-4.6      # any AI Gateway model id
bun run atlas . --ai --model minimax/minimax-m3 \
                     --model-partition spacexai/grok-4.6    # spend only where it counts
```

`--model-partition` is worth knowing about. Deciding what the blocks are is **one call** but sets the
quality of everything after it, so pointing that single call at a stronger model costs a couple of
cents and lifts the whole map.

Check the result against the hand-written atlas:

```sh
bun scripts/eval-atlas.ts public/atlases/arc-worlds.json --verbose
```

#### Models and cost

One atlas of a 179-file repository measured at **49,979 input / 14,299 output tokens** — six calls plus
retries. (`--dry-run` estimates ~28k input; the rest is retries, so treat the estimate as a floor.) Any
model id the [AI Gateway](https://ai-gateway.vercel.sh/v1/models) serves works. Prices are per million
tokens; cost is for that one atlas:

| Model id | in | out | per atlas | vs. Opus |
| --- | --- | --- | --- | --- |
| `spacexai/grok-4.1-fast-reasoning` | $0.20 | $0.50 | **$0.017** | 35× cheaper |
| `minimax/minimax-m3` *(default)* | $0.30 | $1.20 | **$0.032** | 19× cheaper |
| `google/gemini-3.1-flash-lite` | $0.25 | $1.50 | **$0.034** | 18× cheaper |
| `anthropic/claude-haiku-4.5` | $1.00 | $5.00 | $0.121 | 5× cheaper |
| `spacexai/grok-4.6` | $2.00 | $6.00 | $0.186 | 3× cheaper |
| `anthropic/claude-sonnet-5` | $2.00 | $10.00 | $0.243 | 2.5× cheaper |
| `anthropic/claude-opus-4.8` | $5.00 | $25.00 | $0.607 | — |

The default sits at the cheap end on purpose: mapping ten repositories costs about a third of a dollar,
against six dollars on Opus. Splitting the work — `--model minimax/minimax-m3 --model-partition
spacexai/grok-4.6` — buys a better set of blocks for roughly **$0.05**, because the partition is a
single call.

Two things to know. Grok is namespaced `spacexai/` on the Gateway, not `xai/`. And Cursor Composer is
not on the Gateway at all — it is reachable only through the `cursor-agent` CLI, which would need a
separate adapter.

**Cheap models are not free of trouble.** Roughly one pass in four needs a retry, and results vary run
to run. That is designed for rather than fought: a pass retries, then re-asks with the JSON Schema
spelled out, then falls back to templated prose for that part alone. Run `--explain` and read the
citations before trusting a headline number.

#### What stops it making things up

Three passes — decide the blocks, describe each one, write the front matter. Everything a model returns
is checked against the scan before it can touch the map:

- a path the scan never saw is dropped;
- a block id that was never drawn, or an edge that is not on the map, is dropped;
- a headline number whose citation cannot be found in the evidence is dropped (see below);
- a headline number that restates what the scan already prints is dropped;
- prose is trimmed to what a card can actually hold.

**Headline numbers are the one output nothing else anchors.** Block prose is tied to files that have to
exist and trace steps to blocks that have to be drawn, but a stat is free text — so the model is made to
quote the evidence for it, verbatim, and the quote is looked up. A citation that is not in the evidence,
or that does not contain the number it is offered for, is not a citation, and the stat goes. The lookup
is forgiving about how a quote is written and strict about whether it is true: case, whitespace and
thousands separators are flattened, wrapping quote marks are stripped, `eight` counts as 8, a citation
may gather two lines that were not adjacent, and quoting two things is a citation for "2" — but every
fragment has to be found in the evidence, so a real line stitched to an invented one still fails.

On a cheap model this removes most stats, and the scan's own measurements stay in their place. That is
the intended trade: the numbers on a map are the part a reader cannot check, so an uncited one is worth
less than nothing.

Everything rejected is reported, never silently accepted. **Any pass that fails keeps the templated
prose for that part**, so an `--ai` build is never worse than a plain one — including with no key, a
bad key, or no network. Results are cached in `.atlas-cache/` by prompt and model, so re-running after
a partial failure only re-asks what failed.

#### Does it work?

`src/data/arc-worlds.ts` is a map of `../arc-worlds` that a human wrote, which makes it a real
held-out target rather than a matter of taste. `bun scripts/eval-atlas.ts` scores against it:

One `--ai` run on `minimax/minimax-m3`, quoted as it came out:

| | plain | `--ai` |
| --- | --- | --- |
| hand-written block names recovered | 39% | **68%** |
| bespoke groups (`THE ENGINE`, `TERRAIN V2`, …) | 4/7, plus 4 generic | **5/7, none generic** |
| blocks with written prose | 0/22 | **24/24** |
| trace | 6 import hops | **14 steps, revisits a block** |
| trace title | `ONE IMPORT CHAIN` | **`ONE PLANET SCULPT AND SAVE`** |
| headline stats about the system | 0/7 | **7/7** |

That run predates the citation check. Since headline numbers now have to quote the evidence, expect
**fewer stats and better ones**: a later run on `minimax-direct/MiniMax-M3` kept three — `PANELS 7`,
`API ENDPOINTS 5`, `E2E TESTS 97` — and dropped four whose citations could not be found. Three cited
numbers beat seven that a reader has no way to check.

Across runs on this model, name recall lands between 61% and 82% and bespoke groups between 3/7 and
7/7 — one run named the trace `ONE SLIDER DRAG`, which is what the human called it. Re-run to
re-roll: cached passes cost nothing, so only what failed is asked again. A stronger
`--model-partition` narrows the spread.

#### In the browser

Press `✦ ANALYZE` in the topbar. It runs the same three passes over whatever repository is on screen
— a GitHub scan or a local folder — showing which pass is running, and turning into `✦ RE-ANALYZE`
when the map has been rewritten. Any pass that falls back says so on the status line rather than
quietly presenting half a map as a whole one. A scan also triggers one analysis by itself, so the
templated map is drawn immediately and upgraded in place if `/api/enrich` answers.

`bun run dev` mounts `api/enrich.ts` as dev middleware (see `vite.config.ts`), so the button works on
`localhost:5173` with `.env.local` in place — no `vercel dev` needed. Set `ATLAS_ENRICH_MODEL` there
to choose the model; it is the only way the model is chosen, since the client may not ask for one.
Point it at something stronger than the default when the analysis matters:

```sh
# .env.local
ATLAS_ENRICH_MODEL=spacexai/grok-4.6              # a better set of blocks, ~$0.19 an atlas
ATLAS_ENRICH_MODEL=minimax-direct/MiniMax-M3      # no Vercel setup; needs only MINIMAX_API_KEY
```

**Nothing is bought twice.** Two caches sit in `localStorage`, mirroring what `.atlas-cache/` does for
the CLI:

- **the map** — keyed by a fingerprint of the scan (every path and size, plus the repo and ref).
  Re-opening a repository that has not changed redraws the analysed map and calls nobody:
  `ANALYSED EARLIER · FROM CACHE, NOTHING SPENT`.
- **each pass** — keyed by its evidence pack. A run cut short by a rate limit keeps the passes that
  did land, so the next attempt buys only the holes.

A run with no gaps collapses into a single map entry and releases its passes; a run with gaps keeps
its passes and stores no map, because a map with holes is not the finished thing. Every entry records
the model that wrote it, so changing `ATLAS_ENRICH_MODEL` misses cleanly rather than serving the cheap
answers for ever. `✦ RE-ANALYZE` — the button on a map that is already analysed — always skips the
cache; that press *is* the request to do it over. Storage is held to about 3.5 MB, oldest evicted first.

#### When a provider says no

The Gateway free tier will not carry a whole atlas: passes come back rate-limited and the map is left
with holes. Rather than stop at `ANALYSED, WITH GAPS`, the status card offers a way through —
**`⏵ FINISH ON <model>`**. Pressing it re-runs against the endpoint's declared fallback, reusing every
pass already paid for, so it buys only what is missing. A map finished that way records both:

    models: minimax/minimax-m3 + minimax-direct/MiniMax-M3

The offer appears only when a provider refused (rather than answered badly), the deployment declares a
fallback, and the credentials that fallback needs are present. It is an offer because it spends money:

```sh
# .env.local — the default; set it empty to withdraw the offer entirely
ATLAS_ENRICH_FALLBACK_MODEL=minimax-direct/MiniMax-M3
```

This is still not a model parameter. The browser sends `fallback: true` — a boolean that picks between
the two models *this deployment* chose. An arbitrary model id remains unreachable from the client.

The whole scan stays local. The browser builds the evidence packs and validates the replies against its
own file list, so the server never sees the repository — only a pack of named strings.

The endpoint accepts a known pass name and a whitelist of named fields at bounded sizes, and returns
only atlas-shaped JSON. There is no free-text field and the client cannot choose the model, so it is
not usable as a general LLM proxy. Set `ATLAS_ENRICH_MODEL` to pin the model it uses.

Nothing under `src/` imports `ai` or `zod`, so the browser bundle stays dependency-free.

#### Deploying it

The endpoint calls a model for anyone who loads the page, so it wants a rate limit as well as its
own shape. `scripts/firewall.sh` stages one:

```sh
vercel link                    # once
./scripts/firewall.sh          # stages: 60 requests / 300s per IP on /api/enrich, in LOG mode
vercel firewall diff           # read what changed
vercel firewall publish --yes  # you publish; nothing is live until you do
```

Sixty requests in five minutes is about ten atlases from one address — one atlas is roughly six
requests (a partition, up to four narrate batches, a compose). It starts in **log** mode so it counts
without blocking. Watch the traffic, then enforce:

```sh
./scripts/firewall.sh --tighten   # same rule, now returning 429 over the limit
vercel firewall publish --yes
```

Also set `AI_GATEWAY_API_KEY` on the project, or leave it unset and let the function use its OIDC
token. Until one of those is in place `/api/enrich` returns 502 and the browser simply keeps the
templated map.

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

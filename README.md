# Codebase Atlas

An interactive isometric map that renders a code repository as a city of hatched blocks on drafting paper.
Vite + TypeScript; the renderer is a framework-free custom element. The chrome is plain DOM; the map is a
Three.js scene you move through like a map — pan, turn, tilt, zoom to the cursor — whose default camera
reproduces the original drafting-paper isometric projection exactly.

```sh
bun install
bun run dev        # http://localhost:5173
bun run build      # typecheck + production build → dist/
bun run preview
```

## Layout

| Path | What |
| --- | --- |
| `src/atlas/engine.ts` | The element — topbar, sidebar, right panel, tooltip, trace, inside-view — ported from `prototype/atlas-engine.js`. Registers `<codebase-atlas paper="tan\|blueprint\|dark-luxe\|graphite\|oxblood" flow="true\|false">`. |
| `src/atlas/scene.ts` | The map itself: a Three.js scene with `MapControls`, an orthographic camera by default (`FLAT`) or perspective (`DEEP`), elevated import arcs, contact shadows, DOM labels that stay upright and thin out as you zoom out, and the animated FIT / RESET / focus moves. |
| `src/atlas/ride.ts` | The ride — a narrated, auto-playing flight over the map, with its letterbox overlay, hold timer and the browser's own voice. The engine hands it callbacks; it owns the camera through `scene.flyTo`. |
| `src/atlas/types.ts` | The `AtlasData` contract (structures, edges, externals, trace, groups, stats, ride). |
| `src/atlas/theme.ts` | The design system's colour tokens, resolved out of the cascade into the concrete pair the canvas needs. Owns the paper list and the old paper names. |
| `src/styles/` | The design system's token layer, mirrored into the app — colour, type, spacing, patterns. `src/styles/README.md` says how it is wired and how to re-sync it. |
| `src/data/arc-worlds.ts` | Demo dataset: `andysolomon/arc-worlds` (Little Worlds). |
| `src/main.ts` | App chrome: defines the element, feeds it the dataset, reads `?paper=`, `?repo=`, `?atlas=` from the URL. |
| `src/analyze/` | The repo analyzer — turns a file listing into an `AtlasData` (see below). |
| `src/analyze/local.ts` | Opens a folder on this machine as a scan, in the browser. |
| `src/trail.ts` | The repositories opened this session, for the topbar's `◀` `▶`. |
| `src/analyze/ai/browser-cache.ts` | What the browser has already paid a model for, so it is never bought twice. |
| `src/analyze/aliases.ts` | What a repo calls its own code — workspace names, `tsconfig` paths, the go module. |
| `src/analyze/resolve.ts` | Where an import points, used by both the map and the scan. |
| `src/analyze/references.ts` | How much the repo leans on each file, which decides what is worth reading. |
| `src/analyze/tarball.ts` | A whole repository in one request. CLI only — CORS refuses it in a browser. |
| `src/analyze/ai/` | Optional AI analysis: decides what the blocks are and writes the prose. |
| `api/enrich.ts` | Vercel Function that runs one AI pass, for the in-browser scan. |
| `scripts/atlas.ts` | CLI: `bun run atlas <path \| github-url>`. |
| `scripts/eval-atlas.ts` | Scores a generated atlas against the hand-written `arc-worlds` one. |
| `prototype/` | A snapshot of the design system's export — specimen cards, component JSX, and the SVG prototype the Three.js map was ported from. |

## Usage

- **Repository** — the topbar's `⌕ OPEN REPO` field takes a GitHub repo or an atlas URL; `⌂ LOCAL FOLDER` opens one off this machine. By URL: `?repo=owner/repo` scans GitHub live, `?atlas=/atlases/x.json` loads a pre-built atlas, neither → the bundled demo.
- **Analysis** — `✦ ANALYZE` reads the code with a model and rewrites the map (see [AI analysis](#ai-analysis)). Greyed out for a pre-built atlas: its prose is already written.
- **History** — `◀` `▶` step through the repositories opened this session. Stepping back is instant and costs nothing: the built map, including any analysis, is kept with the entry. Repos openable by name are remembered across reloads and suggested in the field.
- **Paper** — `?paper=tan|blueprint|dark-luxe|graphite|oxblood` in the URL, or the `PAPER · …` button in the topbar, which cycles them. The URL is kept in step. `light` and `dark` were the names the first two shipped under; those links still land, and leave with the current name on them.
- **The ride** — `▶ TAKE THE RIDE` in the overview card (or `▶ RIDE` in the topbar) flies a narrated route over the map: the chrome recedes into letterbox bands, the camera rises between distant stops and settles in on arrival, and a caption band reads each stop — aloud too, if `VOICE` is on. Touch the map at any moment and the ride hands you the controls and waits; `▶ RESUME` re-flies the current stop from wherever you left the camera. It works with no model, no key and no network: a ride is built from what the scan computed, and `✦ ANALYZE` replaces it with one a model scripted. `?repo=owner/repo#ride` is the link to send someone — scan this repository, then fly over it.
- **Deep links** — `#inside=<id>` opens a structure; `#trace=<n>` opens trace step *n* (0-based); `#edge=<from>,<to>` selects an import; `#ride=<n>` starts the ride at stop *n* — pausing anywhere leaves that link in the address bar.
- **Keyboard** — `ESC` exits inside-view / ends trace / deselects; `←` `→` step a trace. During a ride, `SPACE` pauses and resumes, `←` `→` step the stops, `ESC` exits. With the map focused: arrows pan (`⇧` for more), `+` `−` zoom, `F` fits, `R` resets the isometric view, `N` turns back to north.
- **Map** — drag to pan, right-drag or `ctrl`-drag to turn and tilt, wheel to zoom toward the cursor; one finger pans, two fingers pinch and twist. Click selects — a block, or an import arc, which opens the relationship in the panel: what travels along it and both ends as buttons, with the rest of the map receding. Double-click flies to a block and goes inside it; on an arc it frames both ends. The control stack top-right: `⌖ FIT` frames everything, `⟲ RESET` restores the original isometric composition, `+` `−` zoom, the compass turns back to north, `FLAT`/`DEEP` switches between orthographic and perspective without moving the view, and `?` lists every gesture. The camera never goes under the paper, never tilts past useful angles, and cannot pan or zoom the atlas out of sight. `prefers-reduced-motion` turns the flights into cuts and switches off inertia.

## The design system

The look is not invented here. It comes from the **Codebase Atlas design system** on claude.ai/design:
two colours per paper, one mono family, a nine-step type scale, three rule weights, no rounded corners
and no shadows. `src/styles/tokens/` mirrors its token files verbatim, and that is the only place in
`src/` where a colour, a size or a border weight is written down.

The chrome reads the tokens straight out of the cascade — `var(--fs-body)`, `var(--border-w)`,
`var(--highlight-bg)`. The map can't, because WebGL has never heard of `var(--ink)`, so `src/atlas/theme.ts`
resolves one paper's tokens through a throwaway element and hands the scene the concrete pair. The two
parts of the system that are geometry rather than CSS live as named constants in `src/atlas/scene.ts`:
the hatch (dense 45° on shade faces, light −45° on tint faces, at the periods and ink alphas the
drafting spec states) and the 2.5/3 advisory dash every optional link is drawn with.

Adding a paper is a token block and a name in `PAPERS`. Nothing else changes: the page, the chrome and
the map all pick it up by cascade. See `src/styles/README.md`.

## Mapping any repository

Four ways in. Every number on the map is a fact from the scan (file counts, bytes, import
statements); the prose is templated from those facts, so treat it as a map, not documentation.

Imports are resolved through the repository's own configuration, so a monorepo draws as one system
rather than as a scatter: every `package.json` `name` in the tree, `tsconfig`/`jsconfig`
`compilerOptions.paths`, and `go.mod`'s module path. Without that, `@acme/shared` reads as a
third-party dependency and the edge between two of your own packages is never drawn. A specifier that
names what the build will emit resolves too — `./x.js` written in TypeScript is `x.ts`.

**What gets read matters more than how much.** A scan that cannot read everything reads what the code
leans on: it takes a first tranche by shape, asks what that tranche imported, and spends the rest of
its budget there. A module fifty files reach for outranks any file nothing imports, whatever its size
— ranking by size alone picks bundles, fixtures and vendored blobs. Manifests and READMEs are read on
a separate allowance, so a monorepo's hundred `package.json` files never displace the code. The same
counts order the symbol evidence the partition is shown, so the model is told about load-bearing files
rather than large ones.

**1. From a GitHub URL, in the browser.** Type `github.com/owner/repo` (or `owner/repo`,
`owner/repo@branch`) into the `⌕ OPEN REPO` field in the topbar, or open
`/?repo=owner/repo` directly. The tree comes from the GitHub API (2 calls — the
unauthenticated limit is 60/hour) and file contents from `raw.githubusercontent.com`
for up to 400 code files, chosen as above. Public repos only; nothing leaves your browser.

A browser cannot take the shortcut the CLI takes: GitHub's tarball URL redirects to
`codeload.github.com`, which allows only GitHub's own origin, so the archive is refused before the
bytes arrive. Hence the budget, and hence spending it carefully.

**2. From a local folder, in the browser.** Press `⌂ LOCAL FOLDER` in the topbar and choose a
directory. Chromium opens it through `showDirectoryPicker()`, which never descends into
`node_modules` and friends; Safari and Firefox fall back to a directory `<input>`, which enumerates
the whole tree and filters afterwards — slower on a big checkout, same result. Up to 400 code files
are read for imports, exactly as with a GitHub scan. **Nothing is uploaded**: the scan runs in the
tab, and `✦ ANALYZE` sends only the evidence packs the browser builds, never the files.

**3. From a local folder or a GitHub URL, with the CLI.** No CORS, so a GitHub scan here pulls the
whole repository as a single archive instead of fetching files one at a time — for a 16,000-file
monorepo that is 7 seconds and 12,958 files read, against two minutes and 400. If the archive cannot
be had (a private repo, an unreachable ref) it falls back to reading files one by one.

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
retries, before the ride pass was added; the ride is one more call on a 6–10 KB pack, about $0.003 on
the default model, and it reads no files. (`--dry-run` estimates ~28k input; the rest is retries, so treat the estimate as a floor.) Any
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

Four passes — decide the blocks, describe each one, write the front matter, script the ride. Everything
a model returns is checked against the scan before it can touch the map:

- a path the scan never saw is dropped;
- a ride stop on a block, group or import that is not drawn is dropped, and the stops around it read on
  in order; a ride left with fewer than four stops, or circling one block, is discarded whole and the
  templated ride stands — surviving stops are never spliced into it;
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

Press `✦ ANALYZE` in the topbar. It runs the same four passes over whatever repository is on screen
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
ATLAS_ENRICH_MODEL=spacexai/grok-4.6              # everything on a better model, ~$0.19 an atlas
ATLAS_ENRICH_MODEL=minimax-direct/MiniMax-M3      # no Vercel setup; needs only MINIMAX_API_KEY
ATLAS_ENRICH_PARTITION_MODEL=spacexai/grok-4.6    # only the one call that matters — see below
```

**Spend where it counts.** `ATLAS_ENRICH_PARTITION_MODEL` points the *first* pass somewhere better and
leaves the rest on the ordinary model. Deciding what the blocks are is a single call, and it sets the
quality of everything after it: narrate describes the blocks it is handed, and compose traces a journey
through them. One call at a good model against a dozen at a cheap one costs a few cents and lifts the
whole map — the same trade as the CLI's `--model-partition`. The browser is told which model runs each
pass, so its cache misses cleanly when you change either.

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

Nothing under `src/` imports `ai` or `zod`; the browser bundle's only runtime dependency is `three`.

#### Deploying it

The endpoint calls a model for anyone who loads the page, so it wants a rate limit as well as its
own shape. `scripts/firewall.sh` stages one:

```sh
vercel link                    # once
./scripts/firewall.sh          # stages: 60 requests / 300s per IP on /api/enrich, in LOG mode
vercel firewall diff           # read what changed
vercel firewall publish --yes  # you publish; nothing is live until you do
```

Sixty requests in five minutes is about eight atlases from one address — one atlas is roughly seven
requests (a partition, up to four narrate batches, a compose, a ride). It starts in **log** mode so it counts
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
- **Ride** opens on the whole map, stops at each group's row, lands on the two largest blocks and the
  busiest link, follows the trace, and closes wide — at most 16 stops, padding dropped first. Each
  landmark stop reads the block's first sentence, so an analysed map's ride inherits the model's prose
  even when the ride pass itself fell back.

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

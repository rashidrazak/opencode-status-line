# The npm entry and packaging

Read before touching `scripts/build-entry.mjs`, `scripts/check-pack.mjs`, the
`files`/`exports` fields in `package.json`, or `.github/workflows/publish.yml`.

## The short version

- **The npm entry is built; the checkout is not.** `src/tui.tsx` stays the
  source of truth and a directory install loads it as TSX, transpiled by the
  host. npm consumers get `dist/tui.js`, which `bun run build:entry` produces
  with OpenTUI's own Solid plugin and the host's runtime left external — the
  argument below is not optional.
- `dist/` is gitignored: CI and `prepublishOnly` each build the checkout they
  are about to check or publish, so the artifact cannot go stale.
- `npm run check:pack` checks the package surface, including that the packed
  entry is the precompiled one, but it does not build — run
  `bun run build:entry` first on a checkout with no `dist/`.

## The entry's JSX pragma is still load-bearing

`src/tui.tsx` opens with `/** @jsxImportSource @opentui/solid */`. Any loader
that transpiles the TSX without the host's Solid transform resolves
`@opentui/solid/jsx-runtime` against the file's own location, and without the
pragma that is React and the install dies with `Cannot find package 'react'`
(that was 1.0.2). The *published* entry no longer depends on it — the build
precompiles the JSX and imports `@opentui/solid` by name — but keep it first:
it names the runtime for every other loader, and `bun build` proves nothing
either way, because it reads file-relative tsconfigs a runtime import ignores.
The tarball ships `tsconfig.json` too; only file-relative tooling reads it.

## Why the entry is built: the measured install story

Measured in the host's npm cache
(`~/.cache/opencode/npm/<name>@<spec>/<ts>/`), whose root `package.json` pins
just our package and whose lockfile answers *why* something landed:

- `@opentui/core`, `@opentui/solid`, `solid-js` and `babel-preset-solid` are
  installed at **0.5.14**, all marked `"peer": true` — npm auto-installed them
  because `package.json` declares them as peers **without**
  `peerDependenciesMeta`. Nothing else in that tree asks for them:
  `@opencode/plugin` marks all of them optional. The repo's own copies are
  0.5.12, the host's runtime is older still, so a package install runs the
  entry's JSX against a runtime the host did not build.
- A **working** npm TUI plugin (`opencode-cmd-provider@2.2.0`) declares those
  same packages as plain `dependencies` and its tree carries its own 0.5.14
  copies — so a second copy alone is not fatal, and neither is the version: what
  separates the two is *how the runtime is referenced*, below.
- The host binary's Solid transform carries the filter
  `^(?!.*[/\\]node_modules[/\\]).*\.[cm]?[jt]sx(?:[?#].*)?$` right beside
  `bun-plugin-solid` and `@opentui/solid`'s `runtime-plugin-support`: the host
  transpiles plugin TSX **outside `node_modules`** itself and gives it its own
  runtime, and leaves package-installed TSX to Bun, which compiles it against
  the entry's `@jsxImportSource` pragma and resolves that runtime from the
  installed tree.
- That reading explains every observation at once: a **directory** install
  shares the host's runtime (works); a **package** install runs the entry on its
  own copy of `@opentui/solid`/`solid-js` — 0.5.14, beside a host runtime it was
  not built with — which is where a render throws and abandons handles per
  repaint; and removing the copies is **not** a fix. With optional peers the
  host logs
  `plugin operation failed … stage=load error="Cannot find package '@opentui/solid' imported from …/src/tui.tsx"`
  and the plugin never loads at all (measured 2026-10-03T05:46:16Z in
  `~/.local/share/opencode/log/opencode.log`) — the peers are what make the
  entry loadable in the first place.
- The npm TUI plugin known to work (`opencode-cmd-provider`) ships a prebuilt
  `dist/`: measured, its `dist/tui.js` imports `@opentui/solid` **by name** and
  contains no `jsx-runtime` reference at all. That is the shape this package
  ships now — `bun run build:entry` compiles `src/tui.tsx` with OpenTUI's own
  Bun plugin (`generate: "universal"`, `moduleName: "@opentui/solid"`), leaves
  the host's runtime external, and writes the single `dist/tui.js` that
  `exports` points at. A prebuilt entry is transformed by nobody at load, so no
  loader resolves a runtime for it: its JSX is already `createComponent`/
  `insert` calls beside a plain import declaration.

## What the guardrails enforce

The build refuses to emit a bundle that still leans on
`@opentui/solid/jsx-runtime` or `@jsxImportSource`, and `check:pack` refuses a
tarball whose packed entry does either. Those two checks are what stop the
crash from returning by a silent regression; `prepublishOnly` and CI each run
the build before checking the tarball, and `dist/` is gitignored so there is
no committed artifact to go stale. The directory path is untouched: the root
shim still re-exports the TSX, which the host transforms itself.

## Debugging in the host

- Reproduce an install story in the host, never in a bundler: `stage=load`
  failures land in the host log, and `bun build` proves nothing about either
  path.
- `console.warn` from a plugin does **not** reach the host log (measured: the
  log holds only ERROR/WARN/INFO lines from the host itself), so the guards'
  warnings are for a developer watching the terminal — the user-visible signals
  are the `⚠`, the uncoloured line and the dimmed held figures.

## Package surface and publishing

- `npm run check:pack` inspects the tarball — every tracked `src/` file packed,
  nothing untracked in, no root shim, every `exports` target present and
  precompiled — and CI runs it on every pull request, after `bun run
  build:entry`.
- `.github/workflows/publish.yml` runs on a pushed `v*` tag and on a published
  Release: it publishes with npm trusted publishing (OIDC, `id-token: write`) —
  no `NPM_TOKEN`, provenance automatic — and creates the GitHub Release from
  the version's `CHANGELOG.md` section, checked before publishing. Every step
  checks instead of assuming (the tagged commit on `main`, tag against
  `package.json`, changelog section, version on the registry, existing
  Release), so both events are safe and a release is just `npm version` plus
  `git push --follow-tags`. Tags are created only by hand — nothing tags on
  merge — the gate just refuses a tag that points off `main`. The one-time npm
  setup (hand-published bootstrap, trusted-publisher fields) lives in
  `RELEASING.md`. Don't add a publish token unless OIDC is abandoned.
- The package is published as source, so `files` in `package.json` carries
  `src/` wholesale — every module `src/tui.tsx` imports must be under it, or
  installs break. The root shim stays out of the tarball; npm resolution goes
  through `exports`.
- `@opencode/plugin` is the dependency; `@opentui/core`, `@opentui/solid`, and
  `solid-js` are peers OpenCode provides.
- The plugin is CLI-only, so consumers add the package name to `cli.json`,
  never `opencode.json`.
- README links to files outside the tarball (`MANUAL.md`, `CONTRIBUTING.md`,
  `RELEASING.md`) must be absolute GitHub URLs — npm renders the README with
  none of the repository's files around it.

# opencode-status-line

OpenCode v2 TUI plugin: a prompt-footer status line (context, cache, streaming
speed, cost, elapsed time, uncommitted changes). `README.md` is the friendly
introduction; `MANUAL.md` is the exhaustive user reference.

## Commands

- `bun test` (or `bun test test/rate.test.ts` for one module) — needs no install.
- `bun install && bun run typecheck` — checks types, including `src/tui.tsx`,
  which no test imports.
- `bun run build:entry` — writes `dist/tui.js`, the entry npm consumers run.
- `npm run check:pack` — checks the package surface, including that the packed
  entry is the precompiled one, but it does not build — run
  `bun run build:entry` first on a checkout with no `dist/`.
- CI is `.github/workflows/ci.yml`; releases are
  `.github/workflows/publish.yml`, not a laptop.

## Shape

- `src/tui.tsx` is the plugin entry, the only file importing `@opencode/plugin`,
  `solid-js` or host APIs; the checkout loads it as TSX, npm consumers get the
  built `dist/tui.js`.
- Keep `/** @jsxImportSource @opentui/solid */` as its first line.
- The root `tui.tsx` is a load-bearing shim re-exporting `src/tui.tsx`; keep it.
- Keep new logic in the pure modules (`src/rate.ts`, `render.ts`, `format.ts`,
  `diff.ts`, `guard.ts`, `palette.ts`, `config.ts`) so it can be tested without
  a terminal; `test/*.test.ts` is one file per module.
- Internal imports carry `.ts`/`.tsx` extensions (`./rate.ts`); the host
  resolves them verbatim, so keep that style.
- The package publishes `src/` wholesale — every module `src/tui.tsx` imports
  must be under it, or installs break.

## Entry rules — every edit to `src/tui.tsx`

- Register the keymap layer inside the `app` slot's `render`, never directly in
  `setup`, and give it `mode: "global"`.
- Build rendered parts inside a `createMemo`.
- Route every event handler through `safely`.
- Route every draw step that can throw through a guard (`src/guard.ts`).
- A 250 ms ticker repaints while a stream is active; a 1 s heartbeat covers the
  idle case. Stop both in the cleanup function.
- State that must outlive a hot-reload lives on `globalThis` (`sharedMeters`).
- Verify runtime changes by hand in a session (`/opencode-status-line` opens the
  stats dialog); `opencode plugin list` shows whether this checkout is loaded.

## Config

Adding a key means `Config` + `DEFAULT_CONFIG` + validation in `src/config.ts`,
plus `rateOptions` if it is maths, plus MANUAL.md — the key's chapter and
`All settings at a glance` — and a `## [Unreleased]` bullet in `CHANGELOG.md`
when the change is user-visible. `test/config.test.ts` injects a fake `read`;
never touch disk from a test.

## Commits and pull requests

Commits follow Conventional Commits — `<type>(<scope>): <subject>`, imperative,
lowercase, no trailing period; the types and scopes, plus the pre-PR checklist,
are in `CONTRIBUTING.md`. One problem per PR; a change to `src/tui.tsx` needs a
real session to prove it, because no test covers the event wiring, and `main`
takes pull requests only: green CI plus one approving review (the maintainer
bypasses for their own work).

## Deep dives — read the matching file before touching that area

| Area | File |
| --- | --- |
| Repo shape, layout, entry and shim, import style | `docs/agents/architecture.md` |
| `src/tui.tsx` edits: keymap, memo, `safely`, tickers, reload state | `docs/agents/entry-rules.md` |
| Guards, the degradation ladder, render fallbacks | `docs/agents/render-safety.md` |
| Build, the npm entry, packaging, publishing | `docs/agents/npm-entry.md` |
| Config resolution, palettes, per-surface segments | `docs/agents/config.md` |
| Meters, speed maths, session record, shell/diff registries | `docs/agents/telemetry.md` |
| Surfaces, width, wrapping, box sizing | `docs/agents/surfaces.md` |

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues in `rashidrazak/opencode-status-line`,
managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` at the repo root and ADRs under `docs/adr/`.
See `docs/agents/domain.md`.

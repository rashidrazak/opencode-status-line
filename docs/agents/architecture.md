# Architecture

Repo shape, the entry path, and what lives where. `AGENTS.md` carries the
condensed rules; this file carries the detail behind them.

## The entry and the shim

- **`src/tui.tsx` is the plugin entry**, loaded straight from this checkout when
  `~/.config/opencode/cli.json` lists the directory. `opencode plugin list`
  shows whether it is loaded — do not assume it is. While it is, OpenCode
  transpiles the TSX on load and hot-reloads on save, so a broken save shows up
  in the running TUI immediately. The plugin cannot run standalone; verify
  runtime changes by hand in a session (`/opencode-status-line` opens the stats
  dialog).
- **The root `tui.tsx` is a load-bearing shim** re-exporting `src/tui.tsx`. On
  the 2.0.16 loader, directory-plugin resolution looked for `<dir>/tui` before
  `package.json` exports, and deleting the shim dropped the plugin from the
  live TUI; the host here has since moved to 2.0.22 and removal has not been
  re-verified, so keep it. npm consumers resolve
  `@rashidrazak/opencode-status-line/tui` through exports to the built
  `dist/tui.js` instead — the build story is in [npm-entry.md](npm-entry.md).

## Imports

Internal imports carry `.ts`/`.tsx` extensions (`./rate.ts`); the host resolves
them verbatim, so keep that style.

## Layout

| Path | Role |
| --- | --- |
| `src/tui.tsx` | Entry: event wiring, slot render, command. The only file importing `@opencode/plugin`, `solid-js`, or host APIs. |
| `src/rate.ts` | Speed maths (sliding window, turn fold, calibration, history) and the `USAGE_LABELS` icon/word sets. Pure. |
| `src/render.ts` | Gauge and context-bar geometry, run cutting and wrapping for narrow widths. Pure. |
| `src/format.ts` | Token / money / duration formatting. Pure. |
| `src/diff.ts` | Uncommitted-change totals from the host's VCS status, and the diff segment's cache policy. Pure. |
| `src/guard.ts` | The render path's degradation policy: what a throwing step falls back to, and when the line gives up entirely. Pure but for an injected `warn`. |
| `src/palette.ts` | The bundled colour palettes and palette/override resolution. Pure. |
| `src/config.ts` | JSON config loader; pure except an injectable `read`. |
| `scripts/build-entry.mjs` | Builds `dist/tui.js`, the entry npm consumers run, with OpenTUI's Solid transform and the runtime external; refuses to emit a bundle that still resolves its JSX runtime at load. |
| `scripts/check-pack.mjs` | Inspects the npm tarball for CI's package job and `prepublishOnly`; Node built-ins only. |
| `scripts/changelog-section.mjs` | Extracts a version's `CHANGELOG.md` section for the Release body; Node built-ins only. |
| `dist/tui.js` | That build's output — gitignored, never committed, built by CI and `prepublishOnly`. |
| `test/*.test.ts` | One per pure module. |
| `tui.tsx` | Root shim re-exporting `src/tui.tsx`; see *The entry and the shim* above. |

Keep new logic in the pure modules so it can be tested without a terminal.

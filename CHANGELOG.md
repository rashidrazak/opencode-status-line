# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **The plugin now identifies itself as `opencode-status-line`.** The old ID,
  `local.opencode-status-line`, suggested a plugin loaded from a folder, but the
  package is published to npm and the same ID is used however it was installed.
  If you had disabled the plugin by ID — `"plugins":
  ["-local.opencode-status-line"]` — write `"-opencode-status-line"` instead, or
  it will load again. The commands (`/opencode-status-line`, `/tps`) and the
  stats command's own ID are unchanged.

## [1.1.0] - 2026-10-03

### Changed

- npm installs now receive a ready-to-run file instead of the plugin's source,
  so OpenCode no longer has to prepare the plugin while it starts. Installing
  from a folder still uses the source. Nothing to do on your side: update the
  version and restart OpenCode as usual.

### Fixed

- **Installing from npm no longer crashes OpenCode, and the line now appears.**
  When the plugin was installed from npm — the way the README recommends — the
  status line stayed blank, and a few minutes into a session OpenCode could
  close itself with `Error: Failed to create TextBuffer`. OpenCode prepared the
  plugin while starting, and the plugin then drew with its own copy of the
  drawing library instead of OpenCode's; that drawing failed, and every failed
  attempt used up a little of the renderer's fixed supply of drawing objects.
  Once the supply ran out, OpenCode stopped. The plugin now arrives ready to
  run and draws with OpenCode's own library, so nothing is prepared or guessed
  at start-up. Installing from a folder (a checkout) was never affected and
  behaves exactly as before.
- **One thing going wrong while drawing no longer costs you the line — or your
  session.** Each part of the line now fails on its own and falls back to
  something simpler: a colour that cannot be worked out is left to your
  terminal, a reading that cannot be worked out is skipped while the rest of
  the line stays, figures that cannot be refreshed stay on screen from the last
  successful draw (dimmed, so you can see they are not new), and a row that
  cannot be drawn properly is drawn as plain text. If nothing at all can be
  drawn, the line shows a single `⚠` instead of vanishing. And if the drawing
  is broken past that point, the plugin stops after three attempts and writes
  one warning instead of retrying forever — the retries were what drained the
  renderer and closed OpenCode.

## [1.0.2] - 2026-10-02

### Fixed

- npm installs failed to load with `Cannot find package 'react'`: OpenCode
  imports the published `src/tui.tsx` from `node_modules`, where Bun ignores a
  package-local `tsconfig.json` and compiled the JSX against the React runtime.
  The entry now carries a `@jsxImportSource @opentui/solid` pragma, which Bun
  honors at runtime in every install location.

## [1.0.1] - 2026-09-29

### Fixed

- `/opencode-status-line` (alias `/tps`) was unreachable: its keymap layer was
  pinned to the `base` input mode, which v2 disables while the slash
  autocomplete or a dialog is open. The layer is now registered as `global`.

## [1.0.0] - 2026-09-28

Initial release.

### Added

- A live status line for OpenCode v2's CLI prompt footer, placed in one slot
  or several at once (`surface`), each placement stacking its own segments and
  padding
- Context-window segment: a pressure-coloured bar, the used percentage and the
  token count, read from the newest assistant message and sized to the model's
  window
- Cache segment: the cached share of what the model read
- Speed meter: a sliding live reading (`↯`) and the turn average (`μ`)
  estimated from stream deltas and calibrated against exact token counts as
  each step ends, with the settled figure held after a stream stops and
  rebuilt for a resumed session
- Cost and elapsed-time segments
- Uncommitted-changes segment (`+42 -7`) from OpenCode's own VCS registry, with
  a configurable refresh interval
- Running-shells segment, clickable to open the composer's Shell tab
- `/opencode-status-line` command (alias `/tps`) with the numbers behind the
  meter
- Segment order and visibility (`usage.segments`), overridable per placement
  through `usage.surfaces`
- Whole-segment wrapping onto further rows on narrow windows, and one-per-row
  stacking in a sidebar
- Bundled Catppuccin, Dracula, Gruvbox, Nord, Rosé Pine and Tokyo Night
  palettes plus flat `grey` and `white`, with host-theme colours, per-tone
  overrides and per-segment colour exclusion
- JSON configuration from `~/.config/opencode/opencode-status-line.json`, a
  project's `.opencode-status-line.json` and plugin entry options, validated
  with warnings that never break the line

[Unreleased]: https://github.com/rashidrazak/opencode-status-line/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/rashidrazak/opencode-status-line/releases/tag/v1.1.0
[1.0.2]: https://github.com/rashidrazak/opencode-status-line/releases/tag/v1.0.2
[1.0.1]: https://github.com/rashidrazak/opencode-status-line/releases/tag/v1.0.1
[1.0.0]: https://github.com/rashidrazak/opencode-status-line/releases/tag/v1.0.0

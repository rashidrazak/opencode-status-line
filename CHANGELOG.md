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
- **The context and cache segments no longer disappear before their first
  reading.** A fresh session draws both from the first paint — the context
  segment as an empty bar, `0%` and `0` (or a plain `0` when OpenCode does not
  know the model's window), the cache segment as `⧉ 0.0% — 0` — and the first
  step's usage replaces the zeros on the spot. The line keeps its full shape
  instead of looking like those segments are switched off.

### Fixed

- **The live speed estimate now converts visible output and reasoning at
  separate calibrated ratios.** The plugin learned one characters-per-token
  ratio from finished steps, but reasoning and output have different
  characters-per-token densities, so a single ratio skewed the estimate
  whenever a model reasoned. The meter now keeps an output ratio — text and
  tool input together, the host's own split — and a reasoning ratio, each
  seeded from `calibration.charsPerToken`, bounded by the same
  `calibration.min`/`calibration.max`, and updated from a settled step's exact
  output and reasoning token counts. A class accumulates characters across
  steps, so a run of small steps still teaches its ratio instead of being
  ignored.
- **The live speed reading (`↯`) now tells the truth on slow and stalled
  streams.** It is estimated over the span the retained stream deltas actually
  cover, so output arriving a second or two apart reads its real pace instead of
  up to twice as fast, and streams slower than the window show no live reading
  rather than a floor near 1.25 tok/s. When output stops, the figure no longer
  freezes at its last value: it rests at `↯ 0.0`, dimmed over an empty gauge —
  the same shape a resumed session shows — so a shell command, a tool run or a
  stalled stream reads as genuinely idle. `window.hold: "last"` restores the
  previous hold-the-last-value behaviour, and `window.hold: false` hides the
  segment whenever there is no live reading. Fast streams read as before.
- **The turn average (`μ`) now counts token-producing time only.** Each gap
  between streamed deltas advances its decode clock, and a pause longer than
  `window.maxGapMs` (default `3000` ms; `0` counts pauses in full) counts only
  up to that ceiling. A shell command, tool run, permission prompt or question
  wait no longer drags the live average down while it runs, and slow-but-steady
  output still reads slow.
- **The settled speed figure no longer counts tool time.** When a step settles,
  its span is the observed decode clock, or the host's stream boundary — the
  moment the provider response body ended, published before tool settlement —
  for a step the plugin met mid-stream, before the step's own end and arrival
  times. A shell command or any tool that ran after the response ended no
  longer depresses the final figure, and a step whose span is unusable still
  folds its exact tokens rather than being dropped.
- **A resumed session's rebuilt speed figure now uses the same decode basis as
  the live one.** After a restart the plugin rebuilds the last settled figure
  from the stored messages, but it ended each step's span at the message's
  completion time, which included any tool the step ran, so a tool-heavy turn
  read lower than the live figure it replaced. The rebuild now ends the span at
  the stored stream boundary — the same moment the live settlement prefers —
  falling back to completion time only when the record keeps no boundary, so
  the figure you come back to is not dragged down by tool time.
- **The stats dialog's `avg` and `mean` are now token-weighted.** Each is the
  exact tokens the finished turns produced over the decode time those tokens
  took, so a few tiny fast turns can no longer outvote one large slow one. `p95`
  deliberately stays an unweighted per-turn distribution — each finished turn
  counts once whatever its size — and the dialog labels it
  `(unweighted per turn)`, with the manual explaining the difference.
- **A failed or retried step no longer leaves the speed meter guessing.** When a
  step fails, the meter closes it the moment the failure is reported and folds
  whatever exact tokens the event carried, so an interrupted step neither keeps
  decaying until the turn ends nor disappears uncounted. When the host retries
  the same assistant message in place, the open step resumes — the characters
  and decode time already measured are kept — and streamed output is matched to
  the step that produced it, so a straggler arriving after a retry cannot be
  credited to the next step.
- **Each queued prompt now gets its own turn average.** OpenCode can run several
  queued prompts back to back inside one execution, publishing a single
  `session.execution.started`, and the plugin folded them into one figure. A
  queued prompt's delivery now ends the prompt before it and starts a fresh
  fold, so the statistics dialog gets one turn sample per queued prompt instead
  of a merged average. A mid-turn steer is not a boundary: it stays part of the
  turn it corrects and never splits the average.

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

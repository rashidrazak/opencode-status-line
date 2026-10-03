# Config

How settings resolve, what adding a key touches, and where palette and
per-surface overrides live. Read before changing `src/config.ts`,
`src/palette.ts`, or how a segment's colours are chosen.

## Resolution

Precedence: `~/.config/opencode/opencode-status-line.json` (honours
`XDG_CONFIG_HOME`) → `<project>/.opencode-status-line.json` → plugin entry
options. Invalid files or values warn and are ignored, never fatal.

## Adding a key

- `Config` + `DEFAULT_CONFIG` + validation in `src/config.ts`, plus
  `rateOptions` if it is maths, plus MANUAL.md — the key's chapter and
  `All settings at a glance`.
- README stays introductory; touch it only if the quick-start example or the
  feature list changed.
- User-visible changes also ride under `## [Unreleased]` in `CHANGELOG.md`:
  each release takes that version's section as its GitHub Release body
  (`scripts/changelog-section.mjs`), and the release fails before publishing
  without it.
- `test/config.test.ts` injects a fake `read`; never touch disk from a test.

## Palettes

`colors.palette` resolves through `src/palette.ts`: a family name follows
`context.themeMode` (the host's resolved `dark`/`light`, never `system`), and a
chosen palette's `muted` ink is where held figures and bar tracks go.

## Per-segment and per-surface overrides

- `colors.exclude` marks a segment's runs with `hostRuns` in `usageRows`, which
  `toneColor` reads to draw from the theme tokens instead.
- `usage.surfaces` overrides `usage.segments` per placement; `segmentsFor`
  resolves the fallback, an empty override hides that placement, and the map
  merges across config sources like `padding`.

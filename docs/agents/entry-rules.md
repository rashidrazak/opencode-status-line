# Entry rules — every edit to `src/tui.tsx`

Each rule here cost a TUI restart to learn. `AGENTS.md` carries the checklist;
this file carries the reasoning.

- Keep the file's first line `/** @jsxImportSource @opentui/solid */`. The
  checkout path is transpiled by whatever loads it, and a loader without the
  host's Solid transform compiles the JSX against React without the pragma
  (`Cannot find package 'react'`, see [npm-entry.md](npm-entry.md)).
- Register the keymap layer inside the `app` slot's `render`, never directly in
  `setup`: v2 keeps the keymap provider in the component tree, so a `setup`
  registration throws `Keymap.Provider is missing` and kills the plugin. Give
  the layer `mode: "global"`: a layer that names no mode is pinned to `base`,
  and v2 pushes `autocomplete` while the slash list is open and `modal` while a
  dialog is, so a mode-less command is unreachable in the two places it would
  be found.
- Build rendered parts inside a `createMemo`. `Show` calls its children
  untracked, so a plain array is evaluated once and the line never repaints.
- Route every event handler through `safely`; an uncaught throw inside one can
  kill the plugin generation, and a half-saved file has done exactly that.
- Saving any `src/` file the entry imports hot-reloads the plugin: the module is
  re-imported and module scope comes back empty, which used to blank the meter
  segment mid-turn on every save. State that must outlive a generation lives on
  `globalThis` (`sharedMeters` in `src/tui.tsx`). Touching `README.md`,
  `MANUAL.md` or `test/` does not reload; the `src/` imports do.
- A 250 ms ticker repaints only while a stream is active; a 1 s heartbeat keeps
  the elapsed timer and held figures repainting when nothing streams. Stop
  both in the cleanup function.
- A draw step that can throw goes through a guard (`src/guard.ts`): the row
  build through `valueGuard`, a segment through `segmentGuard`, a row
  renderable through `rowGuard`, the box through `boxGuard`, the colourizer
  through `inkGuard`. See [render-safety.md](render-safety.md).

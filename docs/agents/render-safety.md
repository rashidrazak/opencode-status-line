# Failing safe — the degradation ladder

The render path's failure policy (`src/guard.ts`). Read this before changing a
guard, a fallback, or anything that builds renderables.

- Two calls, two kinds of failure. `attempt(build, fallback)` is for steps whose
  fallback still draws something — the renderer's default ink, a skipped
  segment, the figures already on screen (`valueGuard`'s `heldView`, dimmed by
  `dimRuns`) — and never latches. `lastResort(build)` is for the renderables
  themselves, where a throw leaves nothing to draw.
- **The latch is not tidiness.** OpenTUI keeps every native object (text
  buffer, span, syntax style) in one shared table of 65,534 handles, and a
  repaint that throws *after* allocating abandons its handles. A plugin that
  retries every repaint therefore exhausts the pool and kills the TUI minutes
  later with `Failed to create TextBuffer` (`role=cli`) — the message names
  whatever allocation happened to be next, not the cause. So `lastResort`
  counts consecutive failures, latches shut at three, and stops building
  anything at all; only a plugin reload clears it.
- The guards are per step on purpose: a colourizer that cannot resolve a theme
  must not latch the tree away, and vice versa. A guard's `attempt` fallback
  must not throw — keep them constants, stored values or pure string joins;
  anything that builds renderables belongs in `lastResort`.
- Build a row's parts **eagerly inside the guarded function** (`richRow`), not
  in the host's lazy children getters: `Show` and `For` call their children
  later, so a renderable that throws there throws in the host's reconciler,
  where this plugin never sees it and no latch can stop the retries. That is
  also why `<text>` nodes are built by `textLine`/`clickLine` rather than
  inline in JSX.
- `spans()` falls back to the row's plain text and `toneColor` to `undefined`
  ink, so a colourizer that throws costs colour, not the line — the whole point
  of the ladder is that a missing line is the last resort, not the first
  symptom.
- When every segment fails the line draws a single muted `⚠` instead of
  nothing: a host API that is gone should be visible, not silent.
- Honest limit: a throw from inside the *host's* reconciliation of our tree
  cannot be caught from here. The ladder covers everything on this side of that
  boundary, which is why the eager-parts rule above matters.

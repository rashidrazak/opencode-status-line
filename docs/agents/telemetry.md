# Telemetry — meters, the session record, and host registries

Read before touching `src/rate.ts`, the meter/usage branches of
`src/tui.tsx`, or the shell/diff counters.

## Speed maths and the session record

- The meters are process-scoped: a session met without one — a resume, or a
  reload before any delta — seeds its last figure from the stored messages
  (`seedMeter` in `src/tui.tsx`; `recordedSteps` / `restoreFinal` in
  `src/rate.ts` hold the logic and its rationale). The seed is lazy — the meter
  branch in `usageRows` kicks it when the map misses — and retries on later
  paints, because the host hydrates messages page by page and a partial page
  must not fold as a turn; one `message.sync` per session forces the full fetch.
  It sets `final` plus a resting zero `sliding` (empty gauge, `↯ 0.0`) — never
  `turn`, which a later step would absorb — and the rebuilt figure is close to,
  not bit-identical with, the live one: accept the ~1% tolerance rather than
  chase it with tool-time heuristics. `time.streamed` is a stream-finalisation
  stamp, not a first token (see `firstTokenAt`). Window samples and the
  statistics are memory-only.
- The session record (`data.session.get`) holds token totals cumulative across
  all turns. Context and cache must read the newest assistant message's own
  `tokens` (`windowInfo` in `src/tui.tsx`), or every prompt ever sent is counted.
  Until one lands, both segments draw zero figures rather than vanishing
  (`contextRuns`/`cacheRuns` in `src/render.ts`).
- Exact token counts arrive only at `session.step.ended`; live figures are
  estimates from stream deltas, calibrated at that point. Prefer the server's
  `event.created` clock for step spans and fall back to local arrival times —
  never mix the two (see `endStep` in `src/rate.ts`). Tool-argument deltas
  (`session.tool.input.delta`) count as output, and the decode span starts at
  the first token, so TTFT is not charged.

## Host registries and the turn lifecycle

- Shell counts come from the host's shell registry (`context.data.shell`),
  which holds a shell only while it executes; background shells live in a
  separate registry and never appear there. Match `status === "running"` and
  `metadata.sessionID`.
- The diff counter reads the host's VCS registry too
  (`context.client.vcs.status`, the working tree against the location's base,
  untracked files included — its route describes itself as "uncommitted
  working-copy changes"), rather than spawning `git` from the TUI. The host
  answers each request from scratch, so the reading is cached per location and
  re-asked at `diff.refreshMs`, and a closing turn marks it stale so the next
  paint re-asks. A location that cannot answer — no repository, no provider —
  caches as a clean tree; the host caps its untracked stat read at 4 KiB, so a
  large new file can land at zero lines, and that is the host's figure, not the
  plugin's to invent around.
- `session.idle` also closes a turn as a late belt; `endTurn` is idempotent, so
  double-closing is safe.

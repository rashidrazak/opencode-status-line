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
  not bit-identical with, the live one: each step ends at the record's stream
  boundary (`time.streamed`), the same basis the live settlement prefers,
  falling back to completion time, so tool time is not charged either way; only
  the live span's observed decode clock keeps the two from matching exactly.
  `time.streamed` is never a first token (see `firstTokenAt`). Window samples
  and the statistics are memory-only. Each history sample carries the turn's
  exact tokens and decode milliseconds; `avg`/`mean` fold those totals
  token-weighted, while `p95` stays the unweighted per-turn distribution
  (`tpsStats` in `src/rate.ts`). A meter left on `globalThis` by a generation
  before the class split is brought forward by `adoptMeter`, so a hot reload
  does not read its missing fields as NaN.
- The session record (`data.session.get`) holds token totals cumulative across
  all turns. Context and cache must read the newest assistant message's own
  `tokens` (`windowInfo` in `src/tui.tsx`), or every prompt ever sent is counted.
  Until one lands, both segments draw zero figures rather than vanishing
  (`contextRuns`/`cacheRuns` in `src/render.ts`).
- Exact token counts arrive when a step settles — `session.step.ended`, or
  `session.step.failed` when the failure carried them; live figures are
  estimates from stream deltas, calibrated at that point. Calibration keeps
  two ratios — output characters (text plus tool input) over exact output
  tokens, reasoning characters over exact reasoning tokens — each an EMA
  seeded from `calibration.charsPerToken` and bounded by `calibration.min`/
  `calibration.max`. A class's characters accumulate across steps and update
  its ratio once they cross the sample floor (`RATIO_MIN_CHARS`), so a run of
  small steps still teaches; `observe` carries each delta's source so the live
  estimates convert per class. The settled span prefers the observed decode
  clock, then the host's `session.step.streamed`
  boundary (`streamedAt` on the open step, published before tool settlement),
  then the server's `event.created` span and, last, local arrival times —
  never mixing clock domains (see `endStep` in `src/rate.ts`). Exact tokens
  always fold when positive, even when no span is usable. Tool-argument deltas
  (`session.tool.input.delta`) count as output, and the decode span starts at
  the first token, so TTFT is not charged. Not every provider streams those
  deltas — this host emits only the window boundaries,
  `session.tool.input.started` and `.ended`, for some models — while argument
  tokens still count in the step's exact `output`. The boundaries therefore
  feed the decode clock (`beginToolInput`/`endToolInput` in `src/rate.ts`): the
  opening boundary drops the interval since the last tick — a previous call's
  execution can sit there — and the closing boundary charges the window,
  capped by `window.maxGapMs` like any other gap, so the argument tokens are
  not divided by a span that stopped early. Execution starts at
  `session.tool.called`, after the closing boundary, so tool runtime is still
  never charged. Known inclusion: a provider that buffers a response and
  flushes it in one or two chunks gives the decode clock only the flush window
  — the host's own part and stream stamps agree, so no bus event separates
  them; measured on the `commandcode` provider, a first response's whole
  reasoning part was recorded as an 8 ms flash. The settled figure is then the
  flush rate, documented in the manual rather than guessed around.
- A failed step settles on `session.step.failed`: the exact tokens the event
  reports fold in when it carries any, and the matching open step clears either
  way (`failStep` in `src/rate.ts`), so a failure neither lingers until turn
  end nor closes a step that is actually streaming. A repeated
  `session.step.started` for the message already open resumes that step rather
  than resetting it, and deltas are attributed by assistant message ID, so a
  straggler from a finished step is ignored. The pause between attempts is
  excluded by the same gap ceiling as any other pause.

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
- A queued prompt is a turn boundary of its own. One execution busy period
  publishes a single `session.execution.started`, so several queued prompts the
  host promotes inside it would otherwise fold into one figure. The entry
  remembers each `session.inbox.enqueued` item's delivery type by inbox ID,
  keeps it current through `session.inbox.delivery.changed`, drops it on
  `session.inbox.cancelled`, and on `session.inbox.delivered` hands the
  remembered type to `deliver` (`src/rate.ts`): `queue` runs `beginTurn` when a
  fold is actually in flight — an empty fold is already fresh, and the call
  must not clear a step that has started streaming — reusing the
  close-into-history-then-fresh-fold semantics of an execution start, cap
  included; `steer` — and an unknown type, as when the plugin loaded after the
  item was queued — leaves the fold alone. The map rides on `globalThis`
  beside the meters, for the same reason: a hot reload between enqueue and
  delivery must not lose the boundary.

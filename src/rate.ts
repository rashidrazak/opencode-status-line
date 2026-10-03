/**
 * The speed meter's maths: a sliding window for what is happening right now, a
 * cumulative average since the turn began, and the exact figures steps settle
 * with. The turn fold accumulates exact tokens and decode milliseconds across
 * a turn's steps, so a tool-heavy turn reports one weighted number rather than
 * a row of per-step figures — the same totals the statistics fold for `avg`
 * and `mean`, while `p95` stays the unweighted per-turn distribution. It also
 * rebuilds a finished turn's settled figure from a session's stored messages,
 * for a process that never saw the events.
 *
 * Everything is a pure function of a `Meter` plus options, JSX-free and free
 * of OpenCode imports, so it can be exercised directly:
 *
 *   bun test test/rate.test.ts
 */

export type LiveReading = "sliding" | "cumulative"

/**
 * What the sliding segment does when no live reading exists: `true` (the
 * default) keeps it visible resting at zero, `false` hides it, and `"last"`
 * keeps the last live reading on screen.
 */
export type HoldMode = boolean | "last"

export interface RateOptions {
  /** How much streamed output the sliding estimate looks back over. */
  windowMs: number
  /**
   * Ceiling on one inter-delta gap charged to the live turn average's decode
   * clock, in milliseconds: a provider stall contributes at most this much
   * when deltas resume. `0` counts gaps in full.
   */
  maxGapMs: number
  /** Shortest span trusted for a live figure, so the first second does not swing wildly. */
  minSpanMs: number
  /** Below this the meter is noise — a stray delta, or a model that has all but stalled. */
  minTps: number
  /** Character samples land in buckets of this size; finer granularity is only noise. */
  bucketMs: number
  /** Whether finished steps teach the estimate its characters-per-token ratio. */
  calibrate: boolean
  /** Seed ratio, used until calibration has something to say. */
  charsPerToken: number
  /** Bounds for the calibrated ratio; a sample outside them is discarded. */
  ratioMin: number
  ratioMax: number
  /** Accumulate a turn's exact steps into one weighted figure. */
  turnFold: boolean
  /** Completed figures kept for the statistics. */
  historySamples: number
  /**
   * What the sliding segment does once no live reading exists. `true` rests it
   * at zero, dimmed over an empty gauge; `false` hides the segment; `"last"`
   * keeps the last live reading on screen.
   */
  holdSliding: HoldMode
}

export const DEFAULT_RATE: RateOptions = {
  windowMs: 3_000,
  maxGapMs: 3_000,
  minSpanMs: 800,
  minTps: 0.5,
  bucketMs: 100,
  calibrate: true,
  charsPerToken: 4,
  ratioMin: 2.5,
  ratioMax: 7,
  turnFold: true,
  historySamples: 500,
  holdSliding: true,
}

/** Shortest decode span trusted: even a two-word answer deserves its figure. */
const MIN_STEP_MS = 50
/** Longest decode span trusted; beyond this a clock is lying. */
const MAX_STEP_MS = 3_600_000

/** A step needs this much streamed text before its ratio is worth calibrating from. */
const RATIO_MIN_CHARS = 40
/** Exponential moving average weight given to a fresh ratio. */
const RATIO_WEIGHT = 0.3

export interface Sample {
  /** Bucket start, aligned to bucketMs. */
  at: number
  chars: number
}

export interface Step {
  assistantMessageID: string
  chars: number
  /** Step start on the event clock. */
  at: number
  /** Step start on the local clock, for when the event clock is unusable. */
  arrivedAt: number
  /**
   * First token-bearing chunk of this step, on the event clock. The decode
   * span runs from here, not from the step, so TTFT is not charged to speed.
   */
  tokenAt?: number
  /** First token-bearing chunk on the local clock, for the fallback span. */
  tokenArrivedAt?: number
  /**
   * Whether this process watched the step from its first token: the first
   * delta it saw set `tokenAt` and started the decode clock together. A step
   * seeded from the record arrives with `tokenAt` already set, so clock time
   * accumulated later covers only part of the step and settlement must not
   * prefer it.
   */
  fromFirstToken?: boolean
  /**
   * The host's stream boundary, on the event clock: `session.step.streamed`
   * fires when the provider response body ends, before any tool it called
   * settles. Settlement ends the decode span here when the decode clock is
   * missing or unusable, so tool runtime is not charged to the step's figure.
   */
  streamedAt?: number
  /**
   * Decode time of this step, in milliseconds: the sum of the observed
   * inter-delta gaps, each capped at `maxGapMs`. The live average's
   * denominator advances only here, so a pause in output holds the figure
   * instead of decaying.
   */
  decodeMs?: number
  /** Local arrival of the newest observed delta; the next gap is measured from here. */
  lastDeltaAt?: number
}

/** Exact decode totals of the turn in flight: finished steps only. */
export interface Turn {
  tokens: number
  ms: number
}

export interface Final {
  tps: number
  at: number
  /** "turn" when the figure folds the turn, "step" when it is one step's own. */
  kind: "turn" | "step"
  /** Exact output tokens the figure divides. */
  tokens: number
  /** Decode milliseconds it divides them by. */
  ms: number
}

export interface TurnSample {
  tps: number
  at: number
  /** Exact output tokens this figure was folded from. */
  tokens: number
  /** Decode milliseconds those tokens took. */
  ms: number
}

export interface Meter {
  /** Bucketed streamed characters, oldest first. */
  samples: Sample[]
  /** Arrival of the newest delta, so a stalled stream goes quiet. */
  lastDeltaAt: number
  /** The step currently streaming, once `session.step.started` was seen. */
  step?: Step
  /** The turn's exact fold, when turn folding is on. */
  turn: Turn
  /** Estimated characters per token, calibrated from finished steps. */
  charsPerToken: number
  /** Last settled figure, shown until something newer replaces it. */
  final?: Final
  /**
   * The last live sliding reading, remembered by `liveRate` as it is produced,
   * so `window.hold: "last"` can re-show exactly the value the line showed
   * live — never a stale snapshot of a burst. A restore without one rests it
   * at zero.
   */
  sliding?: { tps: number; at: number }
  /**
   * The session's high-water mark: the gauge's upper bound. It only ever rises,
   * so a fast burst cannot shrink the scale under the readings that follow.
   */
  peak?: number
  /** One entry per completed turn (or step, when folding is off). */
  history: TurnSample[]
}

export function createMeter(opts: RateOptions = DEFAULT_RATE): Meter {
  return {
    samples: [],
    lastDeltaAt: 0,
    turn: { tokens: 0, ms: 0 },
    charsPerToken: opts.charsPerToken,
    history: [],
  }
}

/** Records `chars` of streamed output arriving at `now` (event clock optional). */
export function observe(
  meter: Meter,
  now: number,
  chars: number,
  eventNow?: number,
  opts: RateOptions = DEFAULT_RATE,
): void {
  if (chars <= 0) return
  const at = Math.floor(now / opts.bucketMs) * opts.bucketMs
  const last = meter.samples[meter.samples.length - 1]
  if (last && last.at === at) last.chars += chars
  else meter.samples.push({ at, chars })
  if (meter.step) {
    // The decode clock: every observed gap advances the step's decode time,
    // the first delta starting it at zero. Time since the newest delta is
    // deliberately not charged, and a gap is capped at `maxGapMs`, so the live
    // average holds through pauses and a provider stall cannot crater it.
    const gap = meter.step.lastDeltaAt === undefined ? 0 : Math.max(0, now - meter.step.lastDeltaAt)
    const counted = opts.maxGapMs > 0 ? Math.min(gap, opts.maxGapMs) : gap
    meter.step.decodeMs = (meter.step.decodeMs ?? 0) + counted
    meter.step.lastDeltaAt = now
    meter.step.chars += chars
    // The first delta this process sees is the step's first token only when
    // the marker is not already set: a seeded step arrives with `tokenAt`.
    if (meter.step.tokenAt === undefined) meter.step.fromFirstToken = true
    meter.step.tokenAt ??= eventNow ?? now
    meter.step.tokenArrivedAt ??= now
  }
  meter.lastDeltaAt = now
  prune(meter, now, opts)
  // `liveRate` keeps the reading for the held figure; calling it here also
  // feeds the session's high-water mark the moment a delta lands, before the
  // next repaint.
  const tps = liveRate(meter, now, opts)
  if (tps !== undefined) notePeak(meter, tps)
}

/**
 * Raise the session's high-water mark. The gauge's upper bound calls this for
 * every reading it sees, so the scale never falls back under a later figure.
 */
export function notePeak(meter: Meter, tps: number): void {
  if (tps > (meter.peak ?? 0)) meter.peak = tps
}

function prune(meter: Meter, now: number, opts: RateOptions): void {
  // The left edge is open: a bucket exactly one window old has aged out, so a
  // reading works from the deltas the covered span actually holds.
  const cutoff = now - opts.windowMs
  while (meter.samples.length > 0 && meter.samples[0]!.at <= cutoff) meter.samples.shift()
}

/**
 * The sliding estimate: streamed characters over the span the retained deltas
 * actually cover, divided by the calibrated ratio, and read as whichever of
 * two views is lower:
 *
 * - inter-arrival — what streamed after the oldest retained delta over the span
 *   between the retained deltas themselves. The oldest sample's characters are
 *   left out so a regular stream reads its true cadence; one retained delta is
 *   no speed at all, rather than a lone token scored against the span floor.
 * - density — every retained character over the age of the window, so a stream
 *   that has stopped decays with time instead of freezing at its last rate.
 *
 * Undefined once the stream has been quiet for a window, or while the figure is
 * below `minTps` (silence, by the knob's own meaning). A figure at or above the
 * floor is remembered on the meter, so `window.hold: "last"` re-shows the last
 * value the line showed live — never a stale delta snapshot.
 */
export function liveRate(meter: Meter, now: number, opts: RateOptions = DEFAULT_RATE): number | undefined {
  prune(meter, now, opts)
  if (now - meter.lastDeltaAt > opts.windowMs) return undefined
  if (meter.samples.length < 2) return undefined
  const oldest = meter.samples[0]!
  const newest = meter.samples[meter.samples.length - 1]!
  let total = 0
  for (const sample of meter.samples) total += sample.chars
  const afterOldest = total - oldest.chars
  // The span floor damps the first instants of a stream, and the window caps
  // both spans so no estimate leans on output older than it looks back over.
  const interSpan = Math.min(Math.max(newest.at - oldest.at, opts.minSpanMs), opts.windowMs)
  const densitySpan = Math.min(Math.max(now - oldest.at, opts.minSpanMs), opts.windowMs)
  const inter = afterOldest / meter.charsPerToken / (interSpan / 1000)
  const density = total / meter.charsPerToken / (densitySpan / 1000)
  const tps = Math.min(inter, density)
  if (tps < opts.minTps) return undefined
  meter.sliding = { tps, at: now }
  return tps
}

/**
 * The cumulative average: every exact token of this turn's finished steps plus
 * the characters of the step in flight, over the decode time they took. With
 * turn folding off it describes the current step alone. Live only — it needs a
 * step that has emitted its first token.
 *
 * The denominator is the step's decode clock, not wall-clock time: each gap
 * between observed deltas counts up to `maxGapMs` when the later delta lands,
 * and nothing after the newest delta does. The figure therefore holds still
 * while output is paused — a shell command, any tool, a permission or question
 * wait — and resumes with the next delta. `now` is accepted as the caller's
 * clock but deliberately does not advance the span.
 */
export function cumulativeRate(meter: Meter, now: number, opts: RateOptions = DEFAULT_RATE): number | undefined {
  const step = meter.step
  if (!step) return undefined
  // Steps that stream tool arguments expose no deltas on the bus, so their
  // first-token marker never lands — and their decode clock stays at zero.
  const tokens = meter.turn.tokens + step.chars / meter.charsPerToken
  const ms = meter.turn.ms + (step.decodeMs ?? 0)
  if (ms < opts.minSpanMs || tokens <= 0) return undefined
  const tps = tokens / (ms / 1000)
  return tps >= opts.minTps ? tps : undefined
}

/** A step began streaming; remember its start so its end can be exact. */
export function beginStep(meter: Meter, assistantMessageID: string, at: number, arrivedAt: number): void {
  // The previous figure deliberately stays on screen while this step finds its
  // feet (TTFT, tools): continuity beats a blank line, and the live estimates
  // replace it the moment this step streams.
  meter.step = { assistantMessageID, chars: 0, at, arrivedAt }
}

/**
 * The host's stream boundary for a step arrived: the provider response body
 * ended, before any tool it called settled. Recorded on the matching open step
 * so settlement can end the decode span there. A boundary naming another step,
 * or arriving with none open, is ignored — a straggler must not stamp the
 * wrong span.
 */
export function recordStreamed(meter: Meter, assistantMessageID: string, at: number): void {
  const step = meter.step
  if (!step || step.assistantMessageID !== assistantMessageID) return
  step.streamedAt = at
}

/**
 * How long a finished step spent decoding, in milliseconds — the span the
 * settled figure divides its exact tokens by.
 *
 * In priority order: the observed decode clock, when the step was watched from
 * its first token and the sum is inside the validity bounds; the host's stream
 * boundary minus that first token, when `session.step.streamed` was observed
 * (the response body ends before its tools settle, so their runtime is not
 * charged); then the `session.step.ended` span and the local arrival span, as
 * before. `ended` is never preferred when a better stamp exists.
 *
 * The bounds choose a candidate, they never discard the step: when every
 * candidate is out of range the most authoritative one is clamped into them,
 * so the step's exact tokens still fold.
 */
function stepSpan(step: Step, endedAt: number, now: number): number {
  const startAt = step.tokenAt ?? step.at
  const startArrived = step.tokenArrivedAt ?? step.arrivedAt
  const candidates: number[] = []
  // The decode clock only measures a step watched from its first token:
  // observing the first delta is what sets `tokenAt` and `fromFirstToken`.
  if (step.fromFirstToken && step.decodeMs !== undefined) candidates.push(step.decodeMs)
  if (step.streamedAt !== undefined) candidates.push(step.streamedAt - startAt)
  candidates.push(endedAt - startAt)
  candidates.push(now - startArrived)
  const usable = candidates.find((ms) => ms >= MIN_STEP_MS && ms <= MAX_STEP_MS)
  if (usable !== undefined) return usable
  return Math.min(Math.max(candidates[0]!, MIN_STEP_MS), MAX_STEP_MS)
}

/**
 * A step finished with exact `tokens` of output (output + reasoning). Folds it
 * into the turn when folding is on, so the figure is the turn's weighted
 * average rather than one step's, and returns what should be shown.
 *
 * The span measures decode time alone (see `stepSpan`), and exact tokens are
 * always folded when positive: a step with no usable span still contributes
 * its tokens, with the duration replaced or clamped.
 */
export function endStep(
  meter: Meter,
  assistantMessageID: string,
  tokens: number,
  endedAt: number,
  now: number,
  opts: RateOptions = DEFAULT_RATE,
): number | undefined {
  const step = meter.step
  meter.step = undefined
  if (!step || step.assistantMessageID !== assistantMessageID || tokens <= 0) return undefined
  const ms = stepSpan(step, endedAt, now)
  const seconds = ms / 1000

  const stepTps = tokens / seconds
  if (opts.turnFold) {
    meter.turn.tokens += tokens
    meter.turn.ms += seconds * 1000
  }
  const folded = opts.turnFold && meter.turn.ms > 0
  const tps = folded ? meter.turn.tokens / (meter.turn.ms / 1000) : stepTps
  meter.final = {
    tps,
    at: now,
    kind: folded ? "turn" : "step",
    tokens: folded ? meter.turn.tokens : tokens,
    ms: folded ? meter.turn.ms : ms,
  }
  notePeak(meter, tps)
  if (opts.calibrate && step.chars >= RATIO_MIN_CHARS) {
    const ratio = step.chars / tokens
    if (ratio >= opts.ratioMin && ratio <= opts.ratioMax) {
      meter.charsPerToken = meter.charsPerToken * (1 - RATIO_WEIGHT) + ratio * RATIO_WEIGHT
    }
  }
  return tps
}

/** A turn began: start a fresh fold. The previous figure stays for continuity. */
export function beginTurn(meter: Meter, now: number, opts: RateOptions = DEFAULT_RATE): void {
  // A turn whose end event was missed still deserves its place in history:
  // close it here rather than letting the next turn discard it. `endTurn` is a
  // no-op on an empty fold, so a normal close is not counted twice.
  if (meter.turn.ms > 0) endTurn(meter, now, opts)
  meter.turn = { tokens: 0, ms: 0 }
  meter.step = undefined
}

/** A turn ended: keep its figure forever, and remember its exact totals for the statistics. */
export function endTurn(meter: Meter, now: number, opts: RateOptions = DEFAULT_RATE): void {
  if (opts.turnFold && meter.turn.ms > 0) {
    const { tokens, ms } = meter.turn
    const tps = tokens / (ms / 1000)
    meter.final = { tps, at: now, kind: "turn", tokens, ms }
    meter.history.push({ tps, at: now, tokens, ms })
  } else if (!opts.turnFold && meter.final?.kind === "step") {
    const { tokens, ms } = meter.final
    meter.history.push({ tps: meter.final.tps, at: now, tokens, ms })
  }
  if (meter.history.length > opts.historySamples) {
    meter.history.splice(0, meter.history.length - opts.historySamples)
  }
  // Closing twice must not count the same turn twice: a second end has an
  // empty fold and simply does nothing.
  meter.turn = { tokens: 0, ms: 0 }
  meter.step = undefined
}

/**
 * A completed step as the session record kept it: exact output tokens over a
 * server-clock decode span. `at` is the first token where the record knows it,
 * `endedAt` the record's stream boundary when it keeps one — the response body
 * ending, before any tool settled — and the step's completion otherwise.
 */
export interface RecordedStep {
  tokens: number
  at: number
  endedAt: number
}

/**
 * The bits of a stored session message the reconstruction reads. Structural on
 * purpose: the host's message shape is wider, and this module takes no
 * dependency on it.
 */
export interface RecordedMessage {
  type?: string
  time?: { created?: number; streamed?: number; completed?: number }
  tokens?: { output?: number; reasoning?: number }
  content?: readonly { type?: string; time?: { created?: number; completed?: number } }[]
}

/**
 * The earliest point the record can place the step's first token: the first
 * timestamp among its reasoning parts. `time.streamed` is the stream boundary
 * — the response body ending, an end stamp, not a start; text parts
 * carry no timing at all, and a tool part is stamped when its call is
 * registered, after its arguments streamed. A message without a timed reasoning
 * part has no first token in the record, and callers fall back to its start.
 */
export function firstTokenAt(message: RecordedMessage): number | undefined {
  let first: number | undefined
  for (const part of message.content ?? []) {
    if (part?.type !== "reasoning") continue
    const at = part.time?.created
    if (typeof at === "number" && (first === undefined || at < first)) first = at
  }
  return first
}

/**
 * The last turn's steps, oldest first, read from a session's stored messages.
 * A turn begins at the last user message; only assistant messages carry exact
 * output counts, and one without a recorded end or without output is not a
 * measurement. The span starts at the first reasoning timestamp where the
 * record keeps one — the first token — and at the message's own start
 * otherwise, which charges TTFT but cannot invent a timeline. It ends at the
 * message's stream boundary when the record keeps one — the provider response
 * body ending, before any tool settled, the same end the live settlement
 * prefers — and at its completion otherwise, which charges tool time but
 * cannot invent a boundary.
 *
 * Returns undefined when the messages hold no user message at all: the TUI
 * cache can carry only the newest page of a long session, and folding its tail
 * would report a figure no process ever measured — a tail folded once showed
 * 261 where the full turn was 243. Callers wait for the page set to grow
 * instead.
 */
export function recordedSteps(messages: readonly RecordedMessage[]): RecordedStep[] | undefined {
  const steps: RecordedStep[] = []
  let bounded = false
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message?.type === "user") {
      bounded = true
      break
    }
    if (message?.type !== "assistant") continue
    const started = firstTokenAt(message) ?? message.time?.created
    const ended = message.time?.streamed ?? message.time?.completed
    const tokens = (message.tokens?.output ?? 0) + (message.tokens?.reasoning ?? 0)
    if (typeof started !== "number" || typeof ended !== "number" || tokens <= 0) continue
    steps.push({ tokens, at: started, endedAt: ended })
  }
  if (!bounded) return undefined
  return steps.reverse()
}

/** Whether a recorded step has tokens and a span worth measuring, by the same floors as `endStep`. */
function measurable(step: RecordedStep): boolean {
  if (step.tokens <= 0) return false
  const span = step.endedAt - step.at
  return span >= MIN_STEP_MS && span <= MAX_STEP_MS
}

/**
 * Rebuild the settled state a finished turn left on the line, from its
 * recorded steps — the resume counterpart of the live `endStep`/`endTurn`
 * pair, for a process that never saw the events. Each step's span ends where
 * the record's stream boundary says the response body ended — the same basis
 * the live settlement prefers — so tools a step called no longer depress the
 * figure after a restart. The rebuilt figure is close to, not bit-identical
 * with, the live one, because the live span may have run on the observed
 * decode clock instead. `final` takes the folded
 * figure and the sliding reading rests at zero, so the segment keeps its shape
 * — an empty gauge and a resting `↯` — without pretending a window the samples
 * could not support. The turn fold is left empty: a step beginning later must
 * not absorb a stale turn into its live average. Returns the figure, or
 * undefined when nothing is measurable.
 */
export function restoreFinal(
  meter: Meter,
  steps: readonly RecordedStep[],
  now: number,
  opts: RateOptions = DEFAULT_RATE,
): number | undefined {
  let tps: number | undefined
  let tokens = 0
  let ms = 0
  if (opts.turnFold) {
    for (const step of steps) {
      if (!measurable(step)) continue
      tokens += step.tokens
      ms += step.endedAt - step.at
    }
    if (tokens > 0 && ms > 0) tps = tokens / (ms / 1000)
  } else {
    for (let index = steps.length - 1; index >= 0; index--) {
      const step = steps[index]!
      if (!measurable(step)) continue
      tokens = step.tokens
      ms = step.endedAt - step.at
      tps = tokens / (ms / 1000)
      break
    }
  }
  if (tps === undefined) return undefined
  meter.final = { tps, at: now, kind: opts.turnFold ? "turn" : "step", tokens, ms }
  meter.sliding = { tps: 0, at: now }
  notePeak(meter, tps)
  return tps
}

/** Whether the live window still has something worth redrawing. */
export function active(meter: Meter, now: number, opts: RateOptions = DEFAULT_RATE): boolean {
  return now - meter.lastDeltaAt <= opts.windowMs
}

export interface Reading {
  key: LiveReading | "final"
  /** The glyph or word that says where the figure comes from. */
  label: string
  tps: number
  /** False for a held or settled figure — the line dims those. */
  live: boolean
}

export interface Display {
  /** True when at least one reading is live; the cap and colours follow it. */
  live: boolean
  readings: Reading[]
  /** The figure the colours and the gauge scale to. */
  primary: number
}

/** How the fixed words of the line read: as glyphs, or spelled out. */
export type LabelStyle = "icons" | "words"

/**
 * The fixed words each part of the line wears. `display` reads the first
 * three; the usage line takes the last for its cache segment. Every entry is
 * one cell wide in the fonts OpenCode draws with, so no label shifts the line.
 */
export interface UsageLabels {
  /** The instantaneous sliding reading. */
  sliding: string
  /** The cumulative average — live, held or settled. */
  average: string
  /** A step's own settled figure, with folding off. */
  settled: string
  /** The cache segment. */
  cache: string
}

export const USAGE_LABELS: Record<LabelStyle, UsageLabels> = {
  words: { sliding: "↯", average: "avg", settled: "✓", cache: "cache" },
  icons: { sliding: "↯", average: "μ", settled: "✓", cache: "⧉" },
}

/**
 * What to show right now.
 *
 * The two families have a life of their own rather than appearing and
 * vanishing with the stream:
 *
 *   sliding     live while the retained deltas give a rate, then at rest —
 *               `window.hold` says whether it shows `0.0`, hides, or keeps
 *               the last reading
 *   cumulative  live while a step is in flight, then the settled turn average
 *
 * A resting, held or settled figure wears `live: false` and is drawn dimmed,
 * so the line keeps its shape without pretending to be current. The sliding
 * segment rests at zero — the same shape a resumed session shows — unless
 * `"last"` keeps the previous value or `false` drops the segment; while the
 * window still holds deltas the live figure shows as before. With
 * `readings: []` only the settled figure remains.
 *
 * `labels` names the figures (`USAGE_LABELS` holds the icon and word sets);
 * the counts and the geometry never depend on it.
 */
export function display(
  meter: Meter,
  now: number,
  readings: readonly LiveReading[] = ["sliding", "cumulative"],
  opts: RateOptions = DEFAULT_RATE,
  labels: UsageLabels = USAGE_LABELS.icons,
): Display | undefined {
  const shown: Reading[] = []
  if (readings.includes("sliding")) {
    const tps = liveRate(meter, now, opts)
    if (tps !== undefined) shown.push({ key: "sliding", label: labels.sliding, tps, live: true })
    else if (opts.holdSliding === "last") {
      if (meter.sliding) {
        shown.push({ key: "sliding", label: labels.sliding, tps: meter.sliding.tps, live: false })
      }
    } else if (opts.holdSliding === true) {
      // No live reading: rest the segment at zero so the line keeps its shape
      // over an empty gauge, rather than re-showing a stale figure.
      shown.push({ key: "sliding", label: labels.sliding, tps: 0, live: false })
    }
  }
  if (readings.includes("cumulative")) {
    const tps = cumulativeRate(meter, now, opts)
    if (tps !== undefined) shown.push({ key: "cumulative", label: labels.average, tps, live: true })
    else if (meter.final?.kind === "turn") {
      shown.push({ key: "cumulative", label: labels.average, tps: meter.final.tps, live: false })
    }
  }

  const anyLive = shown.some((reading) => reading.live)
  const coveredFinal =
    shown.some((reading) => reading.key === "cumulative") && meter.final?.kind === "turn"
  // A settled figure the readings above do not already carry — a step's exact
  // rate with folding off, or the turn figure when neither family is drawn.
  if (!anyLive && meter.final && !coveredFinal) {
    shown.push({
      key: "final",
      label: meter.final.kind === "turn" ? labels.average : labels.settled,
      tps: meter.final.tps,
      live: false,
    })
  }

  if (shown.length === 0) return undefined
  return { live: anyLive, readings: shown, primary: shown[0]!.tps }
}

/** The session's high-water mark, so the gauge has a scale that only rises. */
export function peakTps(meter: Meter): number {
  let peak = meter.peak ?? 0
  for (const sample of meter.history) if (sample.tps > peak) peak = sample.tps
  return peak
}

export interface TpsStats {
  /** Token-weighted mean of the samples inside the rolling window. */
  avg: number
  /** Token-weighted mean of every sample: all tokens over all decode time. */
  mean: number
  /** Unweighted 95th percentile of every sample's own figure. */
  p95: number
  count: number
}

/**
 * The statistics behind the dialog. `avg` and `mean` fold what each finished
 * turn actually produced — its exact tokens over its decode milliseconds — so
 * one large slow turn outweighs a handful of tiny fast ones. `p95` deliberately
 * stays an unweighted per-turn distribution: each finished turn counts once,
 * whatever its size, so it reads as a typical high figure rather than an
 * overall speed.
 */
export function tpsStats(meter: Meter, now: number, windowMs: number): TpsStats {
  const samples = meter.history
  if (samples.length === 0) return { avg: 0, mean: 0, p95: 0, count: 0 }
  const window = samples.filter((sample) => now - sample.at <= windowMs)
  const sorted = samples.map((sample) => sample.tps).sort((a, b) => a - b)
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0
  return { avg: weightedRate(window), mean: weightedRate(samples), p95, count: samples.length }
}

/** Token totals over decode-time totals — the honest mean of unlike turns. */
function weightedRate(samples: readonly TurnSample[]): number {
  let tokens = 0
  let ms = 0
  for (const sample of samples) {
    // The meter map survives a hot reload on `globalThis`, so a history kept
    // from a generation before the totals existed can hold samples without
    // them. They are skipped rather than poisoning the sums with `undefined`:
    // their figures still count in `count` and `p95`, and the weighted figures
    // catch up as new turns land.
    if (!Number.isFinite(sample.tokens) || !Number.isFinite(sample.ms)) continue
    tokens += sample.tokens
    ms += sample.ms
  }
  return ms > 0 ? tokens / (ms / 1000) : 0
}

/**
 * `8.3`, ` 47`, `198` — a fixed three-character field, so the line never shifts
 * as the figure moves between digits. Tenths below ten, whole numbers above,
 * and `k` for the rare figure past a thousand; every branch pads or rounds to
 * exactly three characters.
 */
export function formatRate(tps: number): string {
  const tenths = Math.round(tps * 10) / 10
  if (tenths < 10) return tenths.toFixed(1)
  const whole = Math.round(tenths)
  if (whole < 1_000) return String(whole).padStart(3, " ")
  return `${Math.round(whole / 1_000)}k`.padStart(3, " ")
}

export type SpeedTone = "success" | "warning" | "error"

/** How the figure should read at a glance: fast, middling, or slow. */
export function speedTone(tps: number, fast = 50, slow = 20): SpeedTone {
  return tps >= fast ? "success" : tps >= slow ? "warning" : "error"
}

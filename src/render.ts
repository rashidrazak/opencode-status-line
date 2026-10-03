/**
 * Presentation geometry for the line: the live eighth-cell speed gauge, the
 * context-window bar, and the context and cache segments, as tone-tagged runs
 * for the TUI to colour.
 *
 * Pure and JSX-free, so the geometry can be asserted without a terminal:
 *
 *   bun test test/render.test.ts
 */
import { cacheShare, compact, contextUsed, pressureTone, type TokenRecord } from "./format.ts"
import { speedTone, type SpeedTone } from "./rate.ts"

export type RunTone = "muted" | SpeedTone

export interface Run {
  text: string
  tone?: RunTone
  /** Draw this run in the muted shade of its tone (held or settled figures). */
  dim?: boolean
  /** Draw this run from the host theme: its segment is excluded from the palette. */
  host?: boolean
  /** Clicking this run calls this; the shells count opens its list. */
  onClick?: () => void
}

/**
 * The runs as the host theme would draw them, a chosen palette set aside for
 * one segment (`colors.exclude`). Copies, so the caller's runs stay untouched.
 */
export function hostRuns(runs: readonly Run[]): Run[] {
  return runs.map((run) => ({ ...run, host: true }))
}

/**
 * The runs in the muted shade of their tone, the way a held figure draws. Used
 * when a paint fails and the line holds the figures already on screen: the
 * numbers stay readable and their dimness says they are not from this paint.
 * Copies, so the caller's runs stay untouched.
 */
export function dimRuns(runs: readonly Run[]): Run[] {
  return runs.map((run) => ({ ...run, dim: true }))
}

/** How the gauge is chosen; `auto` is the historical alias for `gauge`. */
export type CapStyle = "auto" | "gauge" | "none"

/**
 * Cut a run list to `width` cells, each run keeping its tone, ending in `…`
 * when something had to go. A sidebar column must not spill past the host's
 * edge, and a silently clipped tail reads as a bug rather than a shortage.
 */
export function cutRuns(runs: readonly Run[], width: number): Run[] {
  if (width <= 0) return []
  const kept: Run[] = []
  let used = 0
  for (const run of runs) {
    if (used >= width) break
    const room = width - used
    if (run.text.length <= room) {
      kept.push(run)
      used += run.text.length
      continue
    }
    const text = room <= 1 ? "…" : `${run.text.slice(0, room - 1)}…`
    kept.push({ ...run, text })
    used += text.length
    break
  }
  return kept
}

/**
 * Pack segment rows into as many lines as `width` demands, moving a row that
 * does not fit to the next line whole and dropping the separator at the break.
 * A row wider than the line keeps its drawing and is cut: the gauge and the
 * context bar have their configured widths, and shrinking them is not this
 * function's job.
 */
export function wrapRows(rows: readonly Run[][], width: number, separator: string): Run[][] {
  if (width <= 0) return []
  const lines: Run[][] = []
  let line: Run[] = []
  let used = 0
  const flush = () => {
    if (line.length > 0) lines.push(line)
    line = []
    used = 0
  }
  for (const row of rows) {
    const rowWidth = runsWidth(row)
    if (rowWidth === 0) continue
    if (line.length > 0 && used + separator.length + rowWidth > width) flush()
    if (rowWidth > width) {
      line = cutRuns(row, width)
      flush()
      continue
    }
    if (line.length > 0) {
      line.push({ text: separator, tone: "muted" })
      used += separator.length
    }
    line.push(...row)
    used += rowWidth
  }
  flush()
  return lines
}

/**
 * Every segment as one line: the cells the rows would draw unwrapped,
 * separators included. The box reserves this as its flex basis, so wrapping
 * the drawn content never changes the width the host deals the box — without
 * it, the wrapped content becomes the box's own width and pins it narrow.
 */
export function joinedWidth(rows: readonly Run[][], separator: string): number {
  let width = 0
  let seen = 0
  for (const row of rows) {
    const rowWidth = runsWidth(row)
    if (rowWidth === 0) continue
    if (seen > 0) width += separator.length
    width += rowWidth
    seen++
  }
  return width
}

/** The cells a row of runs occupies. */
function runsWidth(runs: readonly Run[]): number {
  return runs.reduce((sum, run) => sum + run.text.length, 0)
}

/** A sidebar column's width: the sidebar's share of the window, never narrower than 10 cells. */
export function columnWidth(viewport: number): number {
  return Math.max(10, Math.floor(viewport / 4))
}

export interface CapInput {
  style: CapStyle
  /** The figure the gauge shows and colours by. */
  primary: number
  /** Highest figure the session has reached, so the gauge has a scale. */
  peak: number
  gaugeWidth: number
  gaugeFloor: number
  fast: number
  slow: number
}

/** Fractions of a cell, indexed by eighths left over. */
const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"]
const TRACK = "·"
/**
 * The light edge the bar ends on, so the track stops softly rather than
 * squarely. There is no matching edge at the start: `▕` inks the right of its
 * cell, so its left reads as an empty space before the bar.
 */
const EDGE_END = "▏"

/** Fill and remaining track for a ratio, at eighth-cell resolution. */
function cells(ratio: number, width: number): { fill: string; track: string } {
  const frac = Math.min(1, Math.max(0, ratio))
  const eighths = Math.round(frac * width * 8)
  const full = Math.floor(eighths / 8)
  const rest = eighths % 8
  let fill = "█".repeat(Math.min(full, width))
  if (full < width && rest > 0) fill += EIGHTHS[rest]
  return { fill, track: TRACK.repeat(Math.max(0, width - fill.length)) }
}

/**
 * One bar, assembled: `████▋···▏`. Both bars are this same drawing at the
 * same width, so they match in cells, trailing edge, columns and level count;
 * only the fill's tone and what the ratio means differ. The bar starts on its
 * first fill (or track) cell — it has no leading edge.
 */
function barRuns(ratio: number, width: number, fillTone: RunTone): Run[] {
  const { fill, track } = cells(ratio, width)
  const runs: Run[] = []
  if (fill.length > 0) runs.push({ text: fill, tone: fillTone })
  if (track.length > 0) runs.push({ text: track, tone: "muted" })
  runs.push({ text: EDGE_END, tone: "muted" })
  return runs
}

/**
 * Live eighth-cell gauge: `████▋···▏`. Fill is the speed tone; the track is
 * muted. Scale is the session's high-water mark, never below `floor`, so the
 * bar does not rescale under every tick.
 */
export function gauge(
  tps: number,
  peak: number,
  width: number,
  floor: number,
  fast = 50,
  slow = 20,
): Run[] {
  const scale = Math.max(peak, floor)
  const frac = scale > 0 ? tps / scale : 0
  return barRuns(frac, width, speedTone(tps, fast, slow))
}

/**
 * Context-window bar: `████████······▏`, the gauge's drawing with the
 * pressure tone the caller chose — green while there is room, red near the
 * limit.
 */
export function contextBar(ratio: number, width: number, tone: RunTone = "success"): Run[] {
  return barRuns(ratio, width, tone)
}

/** One run in the muted tone; the segment's figure tone does not apply. */
export const muted = (text: string): Run => ({ text, tone: "muted" })

/**
 * The context segment's inputs: the newest usage-bearing request's record (or
 * none yet), the model's declared window, and the bar's geometry and pressure
 * thresholds (in percent, as configured).
 */
export interface ContextRunsInput {
  tokens?: TokenRecord
  /** The model's declared context window, where the catalogue declares one. */
  limit?: number
  /** Cells the bar draws. */
  width: number
  /** Fill turns yellow at this percent full. */
  warnAt: number
  /** Fill turns red at this percent full. */
  dangerAt: number
}

/**
 * The context segment: `█████▊····▏ 57% — 572.7k`, or the plain token count
 * where the model's window is unknown. With no usage yet it draws the same
 * shape at zero — an empty bar, `0%` and `0` — so a fresh session shows its
 * full line from the first paint; the first usage-bearing message replaces
 * the zeros on the next repaint. The reading is the newest request's own
 * record, never the session record's cumulative totals, which sum every turn.
 */
export function contextRuns(input: ContextRunsInput): Run[] {
  const used = contextUsed(input.tokens)
  if (input.limit === undefined) return [muted(compact(used))]
  const ratio = Math.min(1, used / input.limit)
  const tone = pressureTone(ratio, input.warnAt / 100, input.dangerAt / 100)
  return [
    ...contextBar(ratio, input.width, tone),
    { text: ` ${Math.round(ratio * 100)}%`, tone },
    muted(" — "),
    muted(compact(used)),
  ]
}

/**
 * The cache segment: its configured label, the share of the newest request's
 * window read from cache, and the cached token count. With no reading yet it
 * draws the same label at zero — `0.0% — 0` — rather than vanishing, so the
 * line keeps its shape until the first usage arrives.
 */
export function cacheRuns(tokens: TokenRecord | undefined, label: string): Run[] {
  const share = cacheShare(tokens)
  return [
    muted(`${label} `),
    muted(`${((share ?? 0) * 100).toFixed(1)}%`),
    muted(" — "),
    muted(compact(tokens?.cache?.read ?? 0)),
  ]
}

/** The leading drawing: the gauge, unless the style turns it off. */
export function gaugeFor(input: CapInput): Run[] {
  if (input.style === "none") return []
  return gauge(
    input.primary,
    Math.max(input.peak, input.primary),
    input.gaugeWidth,
    input.gaugeFloor,
    input.fast,
    input.slow,
  )
}

import { describe, expect, test } from "bun:test"
import {
  active,
  beginStep,
  beginTurn,
  createMeter,
  cumulativeRate,
  display,
  endStep,
  endTurn,
  formatRate,
  liveRate,
  notePeak,
  observe,
  peakTps,
  recordedSteps,
  recordStreamed,
  restoreFinal,
  speedTone,
  tpsStats,
  DEFAULT_RATE,
  USAGE_LABELS,
  type Meter,
  type RateOptions,
  type RecordedMessage,
  type RecordedStep,
} from "../src/rate.ts"

const T0 = 1_000_000
const WINDOW = DEFAULT_RATE.windowMs
const OPTS: RateOptions = { ...DEFAULT_RATE }

/** Feed `chars` per second for `durationMs`, in 100 ms deltas. */
function stream(
  meter: Meter,
  start: number,
  durationMs: number,
  charsPerSecond: number,
  opts: RateOptions = OPTS,
): number {
  let now = start
  for (let elapsed = 0; elapsed < durationMs; elapsed += 100) {
    now = start + elapsed + 100
    observe(meter, now, charsPerSecond / 10, undefined, opts)
  }
  return now
}

describe("sliding rate", () => {
  test("converts streamed characters at the seed ratio", () => {
    const meter = createMeter()
    const now = stream(meter, T0, 4_000, 100) // 100 chars/s = 25 tok/s
    const rate = liveRate(meter, now)
    expect(rate).toBeDefined()
    expect(Math.abs(rate! - 25)).toBeLessThan(1.5)
  })

  test("goes quiet once the window is empty", () => {
    const meter = createMeter()
    const now = stream(meter, T0, 1_000, 400)
    expect(liveRate(meter, now)).toBeDefined()
    expect(liveRate(meter, now + WINDOW + 1)).toBeUndefined()
    expect(active(meter, now + WINDOW + 1)).toBe(false)
  })
})

describe("sliding rate over sparse cadences", () => {
  /**
   * Drive the meter the way the ticker does: one-token deltas arrive on the
   * cadence `nextGap` schedules and the line repaints every 250 ms. Returns
   * the sliding reading each repaint showed, held figures included, so a test
   * can compare what the user saw with the truth.
   */
  function repaint(
    meter: Meter,
    start: number,
    durationMs: number,
    nextGap: () => number,
    opts: RateOptions = OPTS,
  ): { tps: number; live: boolean }[] {
    const readings: { tps: number; live: boolean }[] = []
    let next = start
    for (let now = start; now <= start + durationMs; now += 250) {
      while (next <= now) {
        observe(meter, next, 4, next, opts)
        next += nextGap()
      }
      const reading = display(meter, now, ["sliding"], opts)?.readings[0]
      if (reading) readings.push({ tps: reading.tps, live: reading.live })
    }
    return readings
  }

  const mean = (readings: { tps: number }[]): number =>
    readings.reduce((sum, reading) => sum + reading.tps, 0) / readings.length

  test("reads slow but regular streams at their true cadence", () => {
    for (const [gap, truth] of [
      [500, 2],
      [1_000, 1],
      [1_500, 2 / 3],
      [2_000, 0.5],
    ] as const) {
      const readings = repaint(createMeter(), T0, 60_000, () => gap)
      expect(readings.length).toBeGreaterThan(0)
      expect(mean(readings)).toBeGreaterThan(truth * 0.9)
      expect(mean(readings)).toBeLessThan(truth * 1.1)
    }
  })

  test("shows nothing when deltas are 2.5 s or more apart", () => {
    for (const gap of [2_500, 2_900, 3_500, 6_000, 30_000]) {
      expect(repaint(createMeter(), T0, 60_000, () => gap)).toHaveLength(0)
    }
  })

  test("never scores a lone post-silence delta as a speed", () => {
    const meter = createMeter()
    observe(meter, T0, 4)
    observe(meter, T0 + WINDOW + 1_000, 4)
    expect(liveRate(meter, T0 + WINDOW + 1_100)).toBeUndefined()
    expect(display(meter, T0 + WINDOW + 1_100, ["sliding"])).toBeUndefined()
  })

  test("keeps fast streams at their pace", () => {
    const readings = repaint(createMeter(), T0, 60_000, () => 100)
    expect(Math.abs(mean(readings) / 10 - 1)).toBeLessThan(0.03)
  })

  test("a stopped burst decays and never re-inflates the held figure", () => {
    const meter = createMeter()
    // 20 tokens in one second: nine 8-char deltas, then the tenth at the tick.
    for (let index = 0; index < 9; index++) observe(meter, T0 + 100 + index * 100, 8)
    const readings = repaint(meter, T0 + 1_000, 6_000, () => Number.POSITIVE_INFINITY)
    const live = readings.filter((reading) => reading.live)
    expect(live.length).toBeGreaterThan(1)
    for (let index = 1; index < live.length; index++) {
      expect(live[index]!.tps).toBeLessThanOrEqual(live[index - 1]!.tps)
    }
    const behind = readings.filter((reading) => !reading.live)
    expect(behind.length).toBeGreaterThan(0)
    const lastLive = live[live.length - 1]!.tps
    for (const reading of behind) expect(reading.tps).toBeLessThanOrEqual(lastLive)
  })

  test("tracks jittered delivery instead of piling up the gaps", () => {
    // A linear congruential generator keeps the cadence jitter deterministic.
    const jitter = (baseMs: number, seed: number) => {
      let state = seed >>> 0
      const random = () => {
        state = (state * 1_664_525 + 1_013_904_223) >>> 0
        return state / 4_294_967_296
      }
      const gap = () => Math.max(50, Math.round(baseMs * (1 - 0.3 + 0.6 * random())))
      const meter = createMeter()
      let next = T0 + gap()
      let tokens = 0
      const readings: { tps: number; live: boolean }[] = []
      for (let now = T0; now <= T0 + 60_000; now += 250) {
        while (next <= now) {
          observe(meter, next, 4, next)
          tokens += 1
          next += gap()
        }
        const reading = display(meter, now, ["sliding"])?.readings[0]
        if (reading) readings.push({ tps: reading.tps, live: reading.live })
      }
      return { truth: tokens / 60, mean: mean(readings) }
    }
    for (const seed of [7, 11]) {
      const fast = jitter(1_000, seed)
      expect(Math.abs(fast.mean / fast.truth - 1)).toBeLessThan(0.1)
      const slow = jitter(2_000, seed)
      expect(Math.abs(slow.mean / slow.truth - 1)).toBeLessThan(0.25)
    }
  })
})

describe("cumulative rate", () => {
  test("per step when folding is off", () => {
    const opts: RateOptions = { ...DEFAULT_RATE, turnFold: false }
    const meter = createMeter(opts)
    beginStep(meter, "msg", T0, T0)
    stream(meter, T0 + 1_000, 2_000, 200, opts) // first token T0+1100, 400 chars
    // 400 chars ÷ 4 = 100 tokens over the 1.9 s the deltas span: the decode
    // clock charges only time between observed deltas.
    expect(cumulativeRate(meter, T0 + 3_100, opts)).toBeCloseTo(52.6, 1)
  })

  test("folds the turn's exact steps when folding is on", () => {
    const meter = createMeter()
    beginTurn(meter, T0)
    beginStep(meter, "a", T0, T0)
    stream(meter, T0 + 1_000, 2_000, 200) // 400 chars, first token T0+1100
    endStep(meter, "a", 160, T0 + 3_100, T0 + 3_100) // 1.9 s of observed decode gaps
    beginStep(meter, "b", T0 + 3_200, T0 + 3_200)
    stream(meter, T0 + 3_300, 1_000, 200) // 200 chars, first token T0+3400
    // (160 exact + 200/3.55 estimated) / (1900 ms exact + the 900 ms
    // between b's deltas) ≈ 77.3
    expect(Math.abs(cumulativeRate(meter, T0 + 4_400)! - 77.3)).toBeLessThan(1)
  })

  test("holds the turn average through a step whose deltas are not observable", () => {
    const meter = createMeter()
    beginTurn(meter, T0)
    beginStep(meter, "a", T0, T0)
    stream(meter, T0 + 1_000, 1_000, 400)
    endStep(meter, "a", 100, T0 + 2_100, T0 + 2_100) // 100 tokens in 0.9 s
    beginStep(meter, "b", T0 + 2_200, T0 + 2_200) // tool step: no deltas arrive
    // The silent step adds no decode time, so the turn's ~111 tok/s holds
    // instead of decaying as the tool's clock runs.
    expect(cumulativeRate(meter, T0 + 3_200, OPTS)).toBeCloseTo(111.1, 1)
  })

  test("stays silent without a step in flight", () => {
    const meter = createMeter()
    expect(cumulativeRate(meter, T0)).toBeUndefined()
  })
})

describe("decode clock", () => {
  test("holds the live average through a long silence", () => {
    const meter = createMeter()
    beginTurn(meter, T0)
    beginStep(meter, "msg", T0, T0)
    const stop = stream(meter, T0, 2_000, 400)
    const held = cumulativeRate(meter, stop)!
    // 800 chars ÷ 4 = 200 tokens over the 1.9 s between the deltas.
    expect(held).toBeCloseTo(105.3, 1)
    // A silence far longer than maxGapMs, repainted at the ticker's cadence:
    // the figure stays exactly where the last delta left it, and stays live.
    for (let now = stop; now <= stop + 30_000; now += 250) {
      expect(cumulativeRate(meter, now)).toBe(held)
      expect(display(meter, now, ["cumulative"])?.readings[0]?.live).toBe(true)
    }
  })

  test("a pause longer than maxGapMs adds at most the ceiling", () => {
    const meter = createMeter() // maxGapMs: 3000
    beginStep(meter, "msg", T0, T0)
    observe(meter, T0, 400) // first delta starts the clock
    observe(meter, T0 + 1_000, 400)
    expect(cumulativeRate(meter, T0 + 1_000)).toBeCloseTo(200, 5)
    observe(meter, T0 + 31_000, 400) // a 30 s stall counts only the ceiling
    // 300 estimated tokens over 1000 ms + the 3000 ms ceiling.
    expect(cumulativeRate(meter, T0 + 31_000)).toBeCloseTo(75, 5)
  })

  test("maxGapMs 0 counts the full inter-delta gap", () => {
    const opts: RateOptions = { ...DEFAULT_RATE, maxGapMs: 0 }
    const meter = createMeter(opts)
    beginStep(meter, "msg", T0, T0)
    observe(meter, T0, 400, undefined, opts)
    observe(meter, T0 + 1_000, 400, undefined, opts)
    observe(meter, T0 + 31_000, 400, undefined, opts)
    // 300 estimated tokens over the full 31 s of observed gaps.
    expect(cumulativeRate(meter, T0 + 31_000, opts)).toBeCloseTo(300 / 31, 5)
  })

  test("genuinely slow arrival still reads slow", () => {
    const meter = createMeter()
    beginStep(meter, "msg", T0, T0)
    observe(meter, T0, 4)
    observe(meter, T0 + 2_000, 4)
    observe(meter, T0 + 4_000, 4)
    // Three estimated tokens over the four seconds between their arrivals.
    expect(cumulativeRate(meter, T0 + 4_000)).toBeCloseTo(0.75, 5)
  })

  test("a lone delta is not yet a speed", () => {
    const meter = createMeter()
    beginStep(meter, "msg", T0, T0)
    observe(meter, T0, 400)
    expect(cumulativeRate(meter, T0 + 5_000)).toBeUndefined()
  })
})

describe("step settlement", () => {
  test("yields the exact rate and steers the estimate", () => {
    const meter = createMeter()
    beginStep(meter, "msg", T0, T0)
    stream(meter, T0 + 1_000, 2_000, 200) // 400 chars, first token T0+1100
    // 160 tokens over the 1.9 s of observed decode gaps; the previous delta's
    // 100 ms tail is not charged, so the decode clock is preferred over the
    // 2 s ended span.
    const tps = endStep(meter, "msg", 160, T0 + 3_100, T0 + 3_100)
    expect(tps).toBeCloseTo(84.2, 1)
    // 400 chars / 160 tokens = 2.5; EMA from 4 → 3.55.
    expect(meter.charsPerToken).toBeCloseTo(3.55, 5)
  })

  test("the exact span starts at the first token, not the step", () => {
    const meter = createMeter()
    beginStep(meter, "msg", T0, T0)
    stream(meter, T0 + 5_000, 1_000, 100) // 5 s before the first token, then 100 chars/s
    // The decode clock starts at T0+5100: 100 tokens over the 0.9 s between
    // the deltas, not the 6.1 s since the step began.
    expect(endStep(meter, "msg", 100, T0 + 6_100, T0 + 6_100)).toBeCloseTo(111.1, 1)
  })

  test("falls back to arrival times when the event clock is unusable", () => {
    const meter = createMeter()
    beginStep(meter, "msg", 0, T0)
    expect(endStep(meter, "msg", 100, 0, T0 + 2_000)).toBeCloseTo(50, 5)
  })

  test("settles a tiny step instead of discarding it", () => {
    const meter = createMeter()
    beginStep(meter, "msg", T0, T0)
    stream(meter, T0, 100, 40) // first token T0+100
    // 5 tokens over 83 ms: a two-word answer is still a measurement.
    expect(endStep(meter, "msg", 5, T0 + 183, T0 + 183)).toBeCloseTo(60.24, 1)
    expect(meter.final?.kind).toBe("turn")
  })

  test("folds a below-floor step's tokens with the span clamped", () => {
    const meter = createMeter()
    beginTurn(meter, T0)
    beginStep(meter, "msg", T0, T0)
    // A 10 ms span is below the floor: the duration is clamped to the floor
    // and the exact tokens still fold, rather than the step being discarded.
    expect(endStep(meter, "msg", 100, T0 + 10, T0 + 10)).toBeCloseTo(2_000, 5)
    expect(meter.turn).toEqual({ tokens: 100, ms: 50 })
    expect(meter.final?.kind).toBe("turn")
  })

  test("folds an absurd span's tokens too, with the duration clamped", () => {
    const meter = createMeter()
    beginTurn(meter, T0)
    beginStep(meter, "msg", T0, T0)
    // The ended span is beyond the ceiling and the arrival span is zero: no
    // candidate is usable, so the event clock is clamped and the tokens fold.
    expect(endStep(meter, "msg", 100, T0 + 7_200_000, T0)).toBeCloseTo(100 / 3_600, 5)
    expect(meter.turn).toEqual({ tokens: 100, ms: 3_600_000 })
  })

  test("ignores a missing step or a step with no tokens", () => {
    const meter = createMeter()
    beginStep(meter, "msg", T0, T0)
    expect(endStep(meter, "other", 100, T0 + 2_000, T0)).toBeUndefined() // never started
    expect(endStep(meter, "msg", 0, T0 + 2_000, T0 + 2_000)).toBeUndefined() // no exact tokens
    expect(meter.turn).toEqual({ tokens: 0, ms: 0 })
    expect(meter.final).toBeUndefined()
  })
})

describe("settled span", () => {
  test("uses the observed decode clock, not the tool-inclusive ended span", () => {
    const meter = createMeter()
    beginStep(meter, "msg", T0, T0)
    const stop = stream(meter, T0, 2_000, 200) // first token T0+100, decode clock 1.9 s
    // A shell runs for a minute before the step settles: its runtime belongs to
    // the tool, not to the model, so the settled figure matches the decode.
    const tps = endStep(meter, "msg", 200, stop + 60_000, stop + 60_000)
    expect(tps).toBeCloseTo(200 / 1.9, 5)
    expect(meter.turn).toEqual({ tokens: 200, ms: 1_900 })
  })

  test("prefers the observed decode clock over a usable stream boundary", () => {
    const meter = createMeter()
    beginStep(meter, "msg", T0, T0)
    const stop = stream(meter, T0, 2_000, 200) // decode clock: 1.9 s
    recordStreamed(meter, "msg", T0 + 4_000) // boundary span: 3.9 s
    expect(endStep(meter, "msg", 200, stop + 60_000, stop + 60_000)).toBeCloseTo(200 / 1.9, 5)
  })

  test("a step met mid-stream does not prefer its partial decode clock", () => {
    const meter = createMeter()
    // A step seeded across a restart: the record knows the first token, but
    // the deltas before this process started were never observed.
    meter.step = {
      assistantMessageID: "msg",
      chars: 2_000,
      at: T0,
      arrivedAt: T0,
      tokenAt: T0 + 10_000,
      tokenArrivedAt: T0 + 10_000,
    }
    observe(meter, T0 + 40_000, 40) // the first two deltas this process saw
    observe(meter, T0 + 40_100, 40)
    recordStreamed(meter, "msg", T0 + 50_000)
    // 400 tokens over the stream boundary's 40 s, not the 100 ms clock the
    // later deltas alone accumulated.
    expect(endStep(meter, "msg", 400, T0 + 90_000, T0 + 90_000)).toBeCloseTo(10, 5)
    expect(meter.turn).toEqual({ tokens: 400, ms: 40_000 })
  })

  test("ends at the host's stream boundary without a decode clock", () => {
    const meter = createMeter()
    // A step met mid-stream — a reload: the first token is known from the
    // record, but its deltas were never observed.
    meter.step = {
      assistantMessageID: "msg",
      chars: 400,
      at: T0,
      arrivedAt: T0,
      tokenAt: T0 + 1_000,
      tokenArrivedAt: T0 + 1_000,
    }
    recordStreamed(meter, "msg", T0 + 6_000)
    // The ended event trails a half-minute tool; the stream boundary does not.
    expect(endStep(meter, "msg", 200, T0 + 36_000, T0 + 36_000)).toBeCloseTo(40, 5)
    expect(meter.turn).toEqual({ tokens: 200, ms: 5_000 })
  })

  test("falls from a decode clock out of bounds to the stream boundary", () => {
    const meter = createMeter()
    beginStep(meter, "msg", T0, T0)
    observe(meter, T0 + 1_000, 40) // a lone delta: the decode clock is still zero
    recordStreamed(meter, "msg", T0 + 3_000)
    // The ended span trails a tool by a minute; the boundary gives the 2 s
    // decode span the observed single delta cannot.
    expect(endStep(meter, "msg", 10, T0 + 63_000, T0 + 63_000)).toBeCloseTo(5, 5)
  })

  test("falls past an unusable stream boundary to the ended span", () => {
    const meter = createMeter()
    beginStep(meter, "msg", T0, T0)
    recordStreamed(meter, "msg", T0 + 10) // before the step even started: nonsense
    expect(endStep(meter, "msg", 100, T0 + 2_000, T0 + 2_000)).toBeCloseTo(50, 5)
  })

  test("ignores a boundary for another step or with none open", () => {
    const meter = createMeter()
    recordStreamed(meter, "msg", T0)
    expect(meter.step).toBeUndefined()
    beginStep(meter, "msg", T0, T0)
    recordStreamed(meter, "other", T0 + 5_000)
    expect(meter.step?.streamedAt).toBeUndefined()
    recordStreamed(meter, "msg", T0 + 5_000)
    expect(meter.step?.streamedAt).toBe(T0 + 5_000)
  })
})

describe("turn fold", () => {
  test("weights a turn's steps into one figure and remembers it", () => {
    const meter = createMeter()
    beginTurn(meter, T0)
    beginStep(meter, "a", T0, T0)
    stream(meter, T0 + 1_000, 1_000, 400)
    endStep(meter, "a", 100, T0 + 2_100, T0 + 2_100) // 100 tokens in 0.9 s
    beginStep(meter, "b", T0 + 2_200, T0 + 2_200)
    stream(meter, T0 + 2_300, 1_000, 400)
    endStep(meter, "b", 200, T0 + 3_400, T0 + 3_400) // 200 tokens in 0.9 s

    // 300 tokens over the 1.8 s of observed decode time, not the last step's 222.
    expect(meter.final?.tps).toBeCloseTo(166.7, 1)
    expect(meter.final?.kind).toBe("turn")

    endTurn(meter, T0 + 3_500)
    expect(meter.history).toHaveLength(1)
    expect(meter.history[0]!.tps).toBeCloseTo(166.7, 1)
  })

  test("folding off keeps each step's own figure", () => {
    const opts: RateOptions = { ...DEFAULT_RATE, turnFold: false }
    const meter = createMeter(opts)
    beginTurn(meter, T0)
    beginStep(meter, "a", T0, T0)
    stream(meter, T0 + 1_000, 1_000, 400, opts)
    endStep(meter, "a", 100, T0 + 2_100, T0 + 2_100, opts)
    expect(meter.final?.kind).toBe("step")
    endTurn(meter, T0 + 2_200, opts)
    expect(meter.history[0]!.tps).toBeCloseTo(111.1, 1)
  })

  test("closing a turn twice does not double-count it", () => {
    const meter = createMeter()
    beginTurn(meter, T0)
    beginStep(meter, "a", T0, T0)
    stream(meter, T0 + 1_000, 1_000, 400)
    endStep(meter, "a", 100, T0 + 2_100, T0 + 2_100)
    endTurn(meter, T0 + 2_200)
    endTurn(meter, T0 + 2_300)
    expect(meter.history).toHaveLength(1)
  })

  test("a missed turn end is closed when the next turn begins", () => {
    const meter = createMeter()
    beginTurn(meter, T0)
    beginStep(meter, "a", T0, T0)
    stream(meter, T0 + 1_000, 1_000, 400)
    endStep(meter, "a", 100, T0 + 2_100, T0 + 2_100)
    // No endTurn arrived: the turn simply never reported its end.
    expect(meter.history).toHaveLength(0)
    beginTurn(meter, T0 + 5_000)
    expect(meter.history).toHaveLength(1)
    // The fresh fold is empty, so a later real end does not count it twice.
    endTurn(meter, T0 + 6_000)
    expect(meter.history).toHaveLength(1)
  })

  test("history is capped at the configured length", () => {
    const opts: RateOptions = { ...DEFAULT_RATE, historySamples: 2 }
    const meter = createMeter(opts)
    for (let index = 0; index < 4; index++) {
      beginTurn(meter, T0 + index * 1_000)
      beginStep(meter, `s${index}`, T0 + index * 1_000, T0 + index * 1_000)
      stream(meter, T0 + index * 1_000 + 100, 1_000, 400, opts)
      endStep(meter, `s${index}`, 100, T0 + index * 1_000 + 1_200, T0 + index * 1_000 + 1_200, opts)
      endTurn(meter, T0 + index * 1_000 + 1_300, opts)
    }
    expect(meter.history).toHaveLength(2)
  })
})

describe("resume seed", () => {
  const step = (tokens: number, at: number, endedAt: number): RecordedStep => ({ tokens, at, endedAt })
  const message = (over: Partial<RecordedMessage> = {}): RecordedMessage => ({
    type: "assistant",
    time: { created: T0, completed: T0 + 3_000 },
    tokens: { output: 100 },
    content: [{ type: "reasoning", time: { created: T0 + 1_000, completed: T0 + 2_900 } }],
    ...over,
  })

  test("reads only the last turn's completed messages, oldest first", () => {
    const messages: RecordedMessage[] = [
      { type: "user", time: { created: T0 - 100_000 } },
      message({ time: { created: T0 - 99_000, completed: T0 - 90_000 }, tokens: { output: 500 } }),
      { type: "user", time: { created: T0 } },
      // `streamed` is a finalisation stamp, not the decode start.
      message({ time: { created: T0 + 100, streamed: T0 + 2_950, completed: T0 + 3_000 } }),
      { type: "shell", time: { created: T0 + 3_050 } },
      message({
        time: { created: T0 + 3_100, completed: T0 + 4_100 },
        tokens: { output: 50, reasoning: 50 },
        content: [{ type: "reasoning", time: { created: T0 + 3_200, completed: T0 + 4_000 } }],
      }),
    ]
    expect(recordedSteps(messages)).toEqual([
      { tokens: 100, at: T0 + 1_000, endedAt: T0 + 3_000 },
      { tokens: 100, at: T0 + 3_200, endedAt: T0 + 4_100 },
    ])
  })

  test("skips messages without a completion, a decode start or output", () => {
    const messages: RecordedMessage[] = [
      { type: "user", time: { created: T0 } },
      message(),
      message({ tokens: { output: 0, reasoning: 0 } }),
      message({ time: { created: T0 } }), // still streaming
      { type: "assistant", tokens: { output: 40 } }, // no times at all
      { type: "assistant", time: { created: T0, completed: T0 + 1_000 }, tokens: { output: 100 } }, // no reasoning: falls back to created
    ]
    expect(recordedSteps(messages)).toEqual([
      { tokens: 100, at: T0 + 1_000, endedAt: T0 + 3_000 },
      { tokens: 100, at: T0, endedAt: T0 + 1_000 },
    ])
  })

  test("the earliest reasoning part starts the span, not the clock or a tool", () => {
    const messages = [
      { type: "user", time: { created: T0 - 1 } },
      message({
        time: { created: T0, streamed: T0 + 2_950, completed: T0 + 3_000 },
        content: [
          { type: "reasoning", time: { created: T0 + 1_400, completed: T0 + 1_500 } },
          { type: "reasoning", time: { created: T0 + 1_200, completed: T0 + 1_300 } },
          { type: "tool", time: { created: T0 + 2_500, completed: T0 + 2_900 } },
        ],
      }),
    ]
    expect(recordedSteps(messages)).toEqual([{ tokens: 100, at: T0 + 1_200, endedAt: T0 + 3_000 }])
  })

  test("falls back to the message start without a timed reasoning part", () => {
    const messages = [
      { type: "user", time: { created: T0 - 1 } },
      message({
        time: { created: T0, completed: T0 + 2_000 },
        content: [
          { type: "text" },
          { type: "tool", time: { created: T0 + 1_500, completed: T0 + 1_900 } },
        ],
      }),
    ]
    expect(recordedSteps(messages)).toEqual([{ tokens: 100, at: T0, endedAt: T0 + 2_000 }])
  })

  test("refuses a tail with no user boundary — the cache may hold one page", () => {
    expect(recordedSteps([message(), message()])).toBeUndefined()
    expect(recordedSteps([])).toBeUndefined()
  })

  test("restores the folded turn figure and leaves the live fold empty", () => {
    const meter = createMeter()
    const steps = [step(100, T0, T0 + 1_000), step(200, T0 + 1_100, T0 + 2_600)]
    // 300 tokens over 2.5 s, not the newest step's 133.
    expect(restoreFinal(meter, steps, T0 + 3_000)).toBeCloseTo(120, 5)
    expect(meter.final).toEqual({ tps: 120, at: T0 + 3_000, kind: "turn" })
    // The fold stays empty so a step starting later cannot absorb a stale turn.
    expect(meter.turn).toEqual({ tokens: 0, ms: 0 })
    // A resting window reading keeps the segment's shape without inventing a figure.
    expect(meter.sliding).toEqual({ tps: 0, at: T0 + 3_000 })
    expect(meter.peak).toBe(120)
  })

  test("folding off restores the newest step's own figure", () => {
    const opts: RateOptions = { ...DEFAULT_RATE, turnFold: false }
    const meter = createMeter(opts)
    const steps = [step(100, T0, T0 + 1_000), step(100, T0 + 2_000, T0 + 4_000)]
    expect(restoreFinal(meter, steps, T0 + 5_000, opts)).toBeCloseTo(50, 5)
    expect(meter.final?.kind).toBe("step")
    const view = display(meter, T0 + 6_000, ["sliding", "cumulative"], opts)
    expect(view?.readings.map((reading) => reading.label)).toEqual(["↯", "✓"])
  })

  test("yields nothing when every recorded step is nonsense", () => {
    const meter = createMeter()
    expect(restoreFinal(meter, [], T0)).toBeUndefined()
    expect(restoreFinal(meter, [step(100, T0, T0 + 10), step(100, T0, T0 + 7_200_000), step(0, T0, T0 + 1_000)], T0)).toBeUndefined()
    expect(meter.final).toBeUndefined()
    expect(meter.sliding).toBeUndefined()
  })

  test("a restored figure reads settled over a resting sliding reading", () => {
    const meter = createMeter()
    restoreFinal(meter, [step(100, T0, T0 + 1_000)], T0 + 1_000)
    const view = display(meter, T0 + 2_000, ["sliding", "cumulative"])
    expect(view?.live).toBe(false)
    expect(view?.readings.map((reading) => reading.key)).toEqual(["sliding", "cumulative"])
    expect(view?.readings[0]!.tps).toBe(0)
    expect(view?.readings[0]!.live).toBe(false)
    expect(view?.readings[1]!.label).toBe("μ")
    expect(view?.readings[1]!.tps).toBeCloseTo(100, 5)
    // The resting figure is the primary: the gauge draws empty under it.
    expect(view?.primary).toBe(0)
  })
})

describe("display", () => {
  test("shows the requested live readings while streaming", () => {
    const meter = createMeter()
    beginTurn(meter, T0)
    beginStep(meter, "msg", T0, T0)
    const now = stream(meter, T0, 1_000, 400)
    const view = display(meter, now, ["sliding", "cumulative"])
    expect(view?.live).toBe(true)
    expect(view?.readings.map((reading) => reading.key)).toEqual(["sliding", "cumulative"])
    expect(view?.readings.map((reading) => reading.live)).toEqual([true, true])
    expect(view?.readings[0]!.label).toBe("↯")
    expect(view?.readings[1]!.label).toBe("μ")
  })

  test("labels follow the configured style", () => {
    const meter = createMeter()
    beginTurn(meter, T0)
    beginStep(meter, "msg", T0, T0)
    const now = stream(meter, T0, 1_000, 400)

    const icons = display(meter, now, ["sliding", "cumulative"], OPTS, USAGE_LABELS.icons)
    expect(icons?.readings.map((reading) => reading.label)).toEqual(["↯", "μ"])

    const words = display(meter, now, ["sliding", "cumulative"], OPTS, USAGE_LABELS.words)
    expect(words?.readings.map((reading) => reading.label)).toEqual(["↯", "avg"])
  })

  test("the label sets stay unchanged — every glyph one cell wide", () => {
    expect(USAGE_LABELS.icons).toEqual({ sliding: "↯", average: "μ", settled: "✓", cache: "⧉" })
    expect(USAGE_LABELS.words).toEqual({ sliding: "↯", average: "avg", settled: "✓", cache: "cache" })
  })

  test("respects a single-reading configuration", () => {
    const meter = createMeter()
    beginStep(meter, "msg", T0, T0)
    const now = stream(meter, T0, 1_000, 400)
    const view = display(meter, now, ["sliding"])
    expect(view?.readings.map((reading) => reading.key)).toEqual(["sliding"])
  })

  test("holds the sliding reading after the stream stops, and settles the average", () => {
    const meter = createMeter()
    beginTurn(meter, T0)
    beginStep(meter, "msg", T0, T0)
    const now = stream(meter, T0, 1_000, 400)
    const held = liveRate(meter, now)! // the last live sliding figure
    expect(held).toBeDefined()
    endStep(meter, "msg", 100, T0 + 1_100, T0 + 1_100) // 100 tokens in 1 s
    const later = T0 + 1_100 + WINDOW + 100

    const settled = display(meter, later, ["sliding", "cumulative"])
    expect(settled?.live).toBe(false)
    expect(settled?.readings.map((reading) => reading.key)).toEqual(["sliding", "cumulative"])
    expect(settled?.readings.map((reading) => reading.live)).toEqual([false, false])
    expect(settled?.readings[0]!.label).toBe("↯")
    expect(settled?.readings[0]!.tps).toBeCloseTo(held, 5)
    expect(settled?.readings[1]!.label).toBe("μ")
    expect(settled?.readings[1]!.tps).toBeCloseTo(111.1, 1)
  })

  test("a folded-off step keeps its check mark in both styles", () => {
    const opts: RateOptions = { ...DEFAULT_RATE, turnFold: false }
    const meter = createMeter(opts)
    beginStep(meter, "msg", T0, T0)
    stream(meter, T0, 1_000, 400, opts)
    endStep(meter, "msg", 100, T0 + 1_100, T0 + 1_100, opts)
    const settled = display(meter, T0 + 1_100 + WINDOW + 100, [], opts, USAGE_LABELS.icons)
    expect(settled?.readings.map((reading) => reading.label)).toEqual(["✓"])
  })

  test("holding off leaves only the settled figure", () => {
    const opts: RateOptions = { ...DEFAULT_RATE, holdSliding: false }
    const meter = createMeter(opts)
    beginTurn(meter, T0)
    beginStep(meter, "msg", T0, T0)
    const now = stream(meter, T0, 1_000, 400, opts)
    endStep(meter, "msg", 100, T0 + 1_100, T0 + 1_100, opts)
    const settled = display(meter, now + WINDOW + 100, ["sliding", "cumulative"], opts)
    expect(settled?.readings.map((reading) => reading.key)).toEqual(["cumulative"])
    expect(settled?.readings[0]!.live).toBe(false)
    expect(settled?.readings[0]!.tps).toBeCloseTo(111.1, 1)
  })

  test("a new turn keeps both figures until something newer arrives", () => {
    const meter = createMeter()
    beginTurn(meter, T0)
    beginStep(meter, "msg", T0, T0)
    stream(meter, T0, 1_000, 400)
    endStep(meter, "msg", 100, T0 + 1_100, T0 + 1_100)
    const later = T0 + 1_100 + WINDOW + 100

    beginTurn(meter, T0)
    const before = display(meter, later + 10, ["sliding", "cumulative"])
    expect(before?.live).toBe(false)
    expect(before?.readings.map((reading) => reading.key)).toEqual(["sliding", "cumulative"])

    beginStep(meter, "next", later + 20, later + 20)
    const streaming = stream(meter, later + 1_000, 1_500, 400)
    expect(display(meter, streaming, ["sliding", "cumulative"])?.live).toBe(true)
  })
})

describe("statistics", () => {
  test("peaks over completed turns", () => {
    const meter = createMeter()
    meter.history.push({ tps: 10, at: T0 }, { tps: 60, at: T0 + 1 }, { tps: 30, at: T0 + 2 })
    expect(peakTps(meter)).toBe(60)
  })

  test("the high-water mark only rises", () => {
    const meter = createMeter()
    notePeak(meter, 120)
    notePeak(meter, 40)
    expect(meter.peak).toBe(120)
    notePeak(meter, 200)
    expect(peakTps(meter)).toBe(200)
  })

  test("live readings feed the mark, and slower output never pulls it back", () => {
    const meter = createMeter()
    stream(meter, T0, 4_000, 800) // a fast burst sets the gauge's scale
    const recorded = meter.peak ?? 0
    expect(recorded).toBeGreaterThan(150)

    stream(meter, T0 + 10_000, 4_000, 40) // slower output afterwards
    expect(meter.peak).toBe(recorded)
  })

  test("averages a rolling window, all-time mean and p95", () => {
    const meter = createMeter()
    meter.history.push({ tps: 10, at: T0 }, { tps: 20, at: T0 + 1_000 }, { tps: 60, at: T0 + 2_000 })
    const stats = tpsStats(meter, T0 + 2_000, 1_500)
    expect(stats.avg).toBeCloseTo(40, 5)
    expect(stats.mean).toBeCloseTo(30, 5)
    expect(stats.p95).toBeCloseTo(60, 5)
    expect(stats.count).toBe(3)
  })

  test("an empty meter reports zeros", () => {
    expect(tpsStats(createMeter(), T0, 60_000)).toEqual({ avg: 0, mean: 0, p95: 0, count: 0 })
  })
})

test("speedTone marks fast, middling and slow figures", () => {
  expect(speedTone(80)).toBe("success")
  expect(speedTone(50)).toBe("success")
  expect(speedTone(30)).toBe("warning")
  expect(speedTone(20)).toBe("warning")
  expect(speedTone(12)).toBe("error")
})

test("formatRate draws a fixed three-character field", () => {
  expect(formatRate(8.34)).toBe("8.3")
  expect(formatRate(9.96)).toBe(" 10")
  expect(formatRate(47.2)).toBe(" 47")
  expect(formatRate(132.6)).toBe("133")
  expect(formatRate(999.4)).toBe("999")
  expect(formatRate(1_234)).toBe(" 1k")
  for (const value of [0, 5.2, 9.9, 47, 198, 999, 1_000, 25_000]) {
    expect(formatRate(value)).toHaveLength(3)
  }
})

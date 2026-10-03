/**
 * The render path's degradation policy: a step that throws must cost the line
 * as little as possible — a colour, one segment, a fresh figure — and must
 * never cost the session.
 *
 * Two kinds of failure, two calls:
 *
 *   attempt(build, fallback)  the fallback still draws something (the default
 *                             ink, a skipped segment, the figures already on
 *                             screen), so a throw only degrades the line;
 *   lastResort(build)         there is nothing plainer to draw, so a throw
 *                             means this paint cannot put anything on screen.
 *
 * `lastResort` counts *consecutive* failed builds — a successful build by the
 * same guard clears the count — and after `limit` of them the guard latches
 * shut (`broken`). Latching is not tidiness: a host that cannot draw the
 * plugin's rows fails once per *repaint*, and each failed attempt abandons the
 * native objects it already built — OpenTUI keeps every one of them in a single
 * 65,534-handle table until `destroy()` — so an unlatched retry loop exhausts
 * the pool and takes the whole TUI down minutes later. A latch is the only
 * thing that stops the retries.
 *
 * Once latched, neither call builds anything: `lastResort` returns
 * `undefined` and `attempt` falls back without touching the host. Only a
 * plugin reload (a save, a restart) makes a new guard. Guards are independent,
 * so a colour that cannot be resolved never latches the tree that can.
 *
 * Pure but for the injected `warn`, so the policy is unit-tested without a
 * terminal: `bun test test/guard.test.ts`.
 */

/** What a guard has seen. The counters are for the log and the tests. */
export interface GuardStatus {
  /** Builds that fell back to the lesser rendering. */
  degraded: number
  /** Consecutive last-resort failures; cleared by any successful build. */
  failures: number
  /** The guard latched: it will not build again until the plugin reloads. */
  broken: boolean
}

export interface Guard {
  /**
   * Build with a fallback that still draws. A throw returns `fallback()` —
   * which must not itself throw — and never latches: the line is still there.
   */
  attempt<T>(build: () => T, fallback: () => T): T
  /**
   * Build the plainest thing there is. A throw returns `undefined`, counts
   * towards the latch, and after `limit` in a row stops every further build.
   */
  lastResort<T>(build: () => T): T | undefined
  /** The latch: true once the line cannot be drawn at all. */
  readonly broken: boolean
  status(): GuardStatus
}

export interface GuardOptions {
  /** Consecutive `lastResort` failures before the guard latches. */
  limit?: number
  /** Names the guard in its warnings: "the colours", "a row". */
  label?: string
  /** What to do about a latch; appended to the give-up warning. */
  advice?: string
  /** Where warnings go; injected so tests stay silent. */
  warn?: (message: string, error?: unknown) => void
}

/** Failed last-resort builds in a row before the line is given up on. */
export const GUARD_LIMIT = 3

export function createGuard(options: GuardOptions = {}): Guard {
  const limit = options.limit ?? GUARD_LIMIT
  const label = options.label ?? "the line"
  const warn = options.warn ?? ((message: string, error?: unknown) => console.warn(message, error))
  let degraded = 0
  let failures = 0
  let broken = false
  let toldDegraded = false
  let toldBroken = false

  const gaveUp = (error: unknown) => {
    failures += 1
    if (failures < limit || broken) return
    broken = true
    if (toldBroken) return
    toldBroken = true
    warn(
      `opencode-status-line: ${label} failed ${limit} times in a row; the line stays off until the plugin reloads` +
        (options.advice ? ` — ${options.advice}` : ""),
      error,
    )
  }

  const built = () => {
    failures = 0
  }

  return {
    attempt(build, fallback) {
      if (broken) return fallback()
      try {
        const value = build()
        built()
        return value
      } catch (error) {
        degraded += 1
        if (!toldDegraded) {
          toldDegraded = true
          warn(`opencode-status-line: ${label} failed; drawing the fallback`, error)
        }
        return fallback()
      }
    },
    lastResort(build) {
      if (broken) return undefined
      try {
        const value = build()
        built()
        return value
      } catch (error) {
        degraded += 1
        if (!toldDegraded) {
          toldDegraded = true
          warn(`opencode-status-line: ${label} could not be drawn`, error)
        }
        gaveUp(error)
        return undefined
      }
    },
    get broken() {
      return broken
    },
    status: () => ({ degraded, failures, broken }),
  }
}

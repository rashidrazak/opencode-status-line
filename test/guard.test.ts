import { describe, expect, test } from "bun:test"
import { GUARD_LIMIT, createGuard } from "../src/guard.ts"

/** A guard that records its warnings instead of printing them. */
const guardFor = (options: { limit?: number; label?: string; advice?: string } = {}) => {
  const warnings: { message: string; error?: unknown }[] = []
  const guard = createGuard({
    ...options,
    warn: (message, error) => warnings.push({ message, error }),
  })
  return { guard, warnings }
}

const boom = () => {
  throw new Error("host said no")
}

describe("attempt", () => {
  test("returns what the build built", () => {
    const { guard, warnings } = guardFor()
    expect(guard.attempt(() => "drawn", () => "fallback")).toBe("drawn")
    expect(warnings).toHaveLength(0)
    expect(guard.status()).toEqual({ degraded: 0, failures: 0, broken: false })
  })

  test("a throw draws the fallback and counts a degradation", () => {
    const { guard } = guardFor()
    expect(guard.attempt(boom, () => 0)).toBe(0)
    expect(guard.status().degraded).toBe(1)
  })

  test("warns once however often it fails", () => {
    const { guard, warnings } = guardFor({ label: "the colours" })
    for (let i = 0; i < 5; i++) guard.attempt(boom, () => undefined)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toContain("the colours")
    expect(warnings[0]?.error).toBeInstanceOf(Error)
    expect(guard.status().degraded).toBe(5)
  })

  test("never latches: a drawable fallback keeps the line alive", () => {
    const { guard } = guardFor()
    for (let i = 0; i < 20; i++) guard.attempt(boom, () => "still here")
    expect(guard.broken).toBe(false)
    expect(guard.status().failures).toBe(0)
  })
})

describe("lastResort", () => {
  test("returns what the build built and clears the streak", () => {
    const { guard } = guardFor({ limit: 2 })
    guard.lastResort(boom)
    expect(guard.status().failures).toBe(1)
    expect(guard.lastResort(() => "plain")).toBe("plain")
    expect(guard.status().failures).toBe(0)
    expect(guard.broken).toBe(false)
  })

  test("a throw draws nothing and counts towards the latch", () => {
    const { guard } = guardFor()
    expect(guard.lastResort(boom)).toBeUndefined()
    expect(guard.status()).toEqual({ degraded: 1, failures: 1, broken: false })
  })

  test("latches after `limit` failures in a row, and says how to get out", () => {
    const { guard, warnings } = guardFor({ limit: 2, label: "a row", advice: "restart OpenCode" })
    guard.lastResort(boom)
    guard.lastResort(boom)
    expect(guard.broken).toBe(true)
    expect(guard.status().failures).toBe(2)
    expect(warnings).toHaveLength(2)
    expect(warnings[1]?.message).toContain("2 times in a row")
    expect(warnings[1]?.message).toContain("restart OpenCode")
  })

  test("the default limit is three", () => {
    const { guard } = guardFor()
    for (let i = 1; i < GUARD_LIMIT; i++) guard.lastResort(boom)
    expect(guard.broken).toBe(false)
    guard.lastResort(boom)
    expect(guard.broken).toBe(true)
  })

  test("a success between failures clears the streak", () => {
    const { guard } = guardFor({ limit: 3 })
    guard.lastResort(boom)
    guard.lastResort(boom)
    guard.lastResort(() => "plain")
    guard.lastResort(boom)
    guard.lastResort(boom)
    expect(guard.broken).toBe(false)
  })

  test("once latched it does not build again — the retry loop is what leaks", () => {
    const { guard } = guardFor({ limit: 1 })
    let builds = 0
    const build = () => {
      builds += 1
      throw new Error("host said no")
    }
    guard.lastResort(build)
    expect(guard.broken).toBe(true)
    expect(builds).toBe(1)
    for (let i = 0; i < 10; i++) expect(guard.lastResort(build)).toBeUndefined()
    expect(builds).toBe(1)
  })

  test("once latched, attempt falls back without touching the host", () => {
    const { guard } = guardFor({ limit: 1 })
    let attempts = 0
    guard.lastResort(boom)
    const drawn = guard.attempt(
      () => {
        attempts += 1
        return "rich"
      },
      () => "plain",
    )
    expect(drawn).toBe("plain")
    expect(attempts).toBe(0)
  })
})

describe("guards", () => {
  test("are independent: one latch does not silence another", () => {
    const first = guardFor({ limit: 1 })
    const second = guardFor({ limit: 1 })
    first.guard.lastResort(boom)
    expect(first.guard.broken).toBe(true)
    expect(second.guard.broken).toBe(false)
    expect(second.guard.lastResort(() => "plain")).toBe("plain")
  })
})

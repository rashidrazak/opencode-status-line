#!/usr/bin/env bun
/**
 * Builds the entry npm consumers run: `dist/tui.js`.
 *
 * This is the one place the repository's "no build step" rule bends, and
 * AGENTS.md (*The npm entry is built*) carries the whole argument. In short:
 * the host hands its own Solid runtime and JSX transform to plugin TSX
 * **outside `node_modules`**, and leaves the rest to Bun, which compiles the
 * entry against its `@jsxImportSource` pragma and resolves that runtime from
 * the installed tree — a second copy of OpenTUI, and the thing that threw and
 * leaked native handles in the 2026-10-03 crash. A prebuilt entry needs no
 * transform at load: `@opentui/solid` is imported by name, which is the shape
 * of the npm TUI plugins that work.
 *
 * The transform is OpenTUI's own Bun plugin, so the JSX is compiled exactly
 * the way the host compiles it (`generate: "universal"`, `moduleName:
 * "@opentui/solid"`). Everything the host provides stays external: the bundle
 * is this plugin's own code and nothing else.
 *
 * `dist/` is not committed. CI and `prepublishOnly` each build from the
 * checkout they are about to check or publish, so the artifact cannot go
 * stale — and `check:pack` still refuses a tarball whose exports point at a
 * file that is not in it.
 */
import { rm } from "node:fs/promises"
import solid from "@opentui/solid/bun-plugin"

/** What the host supplies at runtime; the bundle must not inline any of it. */
const EXTERNAL = ["@opencode/plugin", "@opencode/plugin/tui", "@opentui/core", "@opentui/solid", "solid-js"]

/** Specifiers a package-installed entry cannot resolve; the build must not emit them. */
const FORBIDDEN = ["@opentui/solid/jsx-runtime", "@opentui/solid/jsx-dev-runtime", "@jsxImportSource"]

await rm("dist", { recursive: true, force: true })

const result = await Bun.build({
  entrypoints: ["src/tui.tsx"],
  outdir: "dist",
  target: "bun",
  format: "esm",
  external: EXTERNAL,
  // One file, unminified: the entry is the plugin's whole surface, and the
  // tarball stays readable.
  splitting: false,
  minify: false,
  sourcemap: "none",
  plugins: [solid],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  throw new Error("build-entry: the entry did not build")
}

const output = result.outputs.find((file) => file.path.endsWith("tui.js"))
if (!output) throw new Error("build-entry: nothing was written to dist/tui.js")

const source = await output.text()
for (const specifier of FORBIDDEN) {
  if (source.includes(specifier)) {
    throw new Error(
      `build-entry: the built entry still leans on ${specifier}, which a package install cannot resolve — the JSX was not precompiled`,
    )
  }
}
if (!/from\s*"@opentui\/solid"/.test(source)) {
  throw new Error("build-entry: the built entry does not import @opentui/solid by name — the JSX was not precompiled")
}

console.log(`build-entry: ${output.path} — ${Math.round(source.length / 1024)} KB, runtime external`)

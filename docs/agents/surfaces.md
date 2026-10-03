# Surfaces and width

Read before touching a slot renderer, the wrapping/measurement path, or the
box's sizing.

- `config.surface` is a list of placements: `setup` registers one slot renderer
  per entry (`renderFor(surface)`), each closing over its own
  `stackFor`/`resolvedPadding`/`sharesHostRow` facts and its own `segmentsFor`
  list, owning its own measured-width signal, while the shared `version` signal
  keeps every placement repainting together. The stats command's `app` layer is
  registered once, independent of the list.
- The line renders only when a session is on screen: the renderer resolves its
  session from the slot input or the route, and a non-session route (`home`, a
  plugin page) yields an empty row. `app` and `home.footer.status` are mounted
  by the host on those routes, so the line stands down there by choice — it
  describes a conversation, and none is open. Do not "fix" this with a
  most-recent-session fallback: it was tried once, looked out of place on home,
  and was reverted.
- A `sidebar.*` surface is a narrow column: `stackFor` stacks the segments one
  per row and each row is cut to `columnWidth(context.renderer.width)` with an
  ellipsis. `context.renderer` is the shared OpenTUI renderer, so read its
  width inside the render memo — the window resizes under the line.
- `app` is the window's bottom row: `paddingFor` gives it the composer's
  2-column indent, a right margin and two clear rows underneath (each side
  overridable per surface through the `padding` config). The host sizes the
  slot to its content — `padding.bottom` already proves that — so the line
  adds a row rather than being clipped.
- A one-line surface fits itself to the width its box was **dealt by layout**,
  not `context.renderer.width`: a footer row shares its width with OpenCode's
  own status text, so the renderer overstates ours. `onSizeChange` reports the
  box's border-box width after every layout pass; store it in a signal (defer
  the write with `queueMicrotask` — the handler runs inside layout) and
  `wrapRows` moves segments that do not fit whole to further rows, with no cap;
  only a segment wider than the line is cut.
- A box in a host row (`sharesHostRow`) pins its **unwrapped** width as its
  `flexBasis`. A row child's width otherwise derives from its own drawn
  content, so once the line wrapped, the box's basis was the wrapped width:
  the shrink deal kept shrinking it and widening the window could never
  restore the line. With the basis pinned, the deal does not move, the
  measurement settles in one pass, and a widened row gets the full line back.
  `app`, the composer top and the sidebars stretch to the host's width and
  need no basis. Footers and sidebars are placed by the host and take no
  padding by default.
- The box also pins its drawn height as its `minHeight` (rows plus padding,
  which is part of the border box). The host mounts `app` as the last child of
  a column beside a transcript that often overflows it, and Yoga's default
  shrink then squashed the wrapped box below its content: every row landed on
  the same line, drawn over one another. The floor makes the transcript absorb
  the shrink instead; wrapping stays stacked and the padding rows survive.

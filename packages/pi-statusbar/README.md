# pi-statusbar

A footer for [`pi`](https://pi.dev) with three presets, emoji or nerd font
icons, twelve color schemes, and a thinking-level segment that changes color
with the level.

Derived from [pi-footer](https://github.com/wobondar/pi-footer) by wobondar,
MIT licensed, stripped to the parts this package needs and given a feature the
original does not have.

## What it shows

Three presets, switched with one command:

- `default`: provider and model, thinking level, context length, git branch and
  diff, session cost, elapsed time
- `compact`: model, thinking level, git branch, context percentage, cost
- `git-heavy`: provider and model, directory, branch, short SHA, working tree
  counts, diff, ahead and behind

## Thinking-level color

The thinking segment takes its color from the level, using the same theme
colors pi uses for its own thinking indicator. On a theme that omits one of
them it falls back to a fixed palette rather than failing to render.

With a color scheme active, the scheme owns the whole ladder instead, so the
segment cannot end up the one part of the footer wearing a different palette.

## Color schemes

Twelve terminal palettes, plus `default`.

A scheme recolors this footer and nothing else. It does not change pi's theme,
which lives in `/settings`, so choosing `github-light` here leaves your editor,
your prompt and the rest of pi looking exactly as they did.

Pick one from the `Color scheme` row in `/statusbar`, which previews each one on
the real footer as you move through the list, or name it directly:

```
/statusbar colors tokyo-night
/statusbar colors default
```

`default` is the shipped value and means inherit: every color stays whatever
pi's own theme decides. It is also the way back out of a scheme.

Schemes marked light expect a light terminal background. Nothing stops you using
one on a dark terminal, but it was not drawn for it.

- ayu: `ayu-dark`, `ayu-light` (light)
- catppuccin: `catppuccin-frappe`, `catppuccin-latte` (light),
  `catppuccin-macchiato`, `catppuccin-mocha`
- github: `github-dark`, `github-light` (light)
- tokyo night: `tokyo-night`, `tokyo-night-day` (light), `tokyo-night-moon`,
  `tokyo-night-storm`

Only foregrounds. A scheme never fills a background, so the footer keeps sitting
on your terminal's own and a light scheme cannot paint a bright band across the
bottom of a dark screen.

### A scheme needs truecolor

Every scheme is 24-bit color, so a scheme looks like itself only where your
terminal can show 24-bit color.

Below truecolor each color falls back to the nearest of the basic 16, which your
terminal then paints from its own palette. The footer still works and still
picks up the shape of the scheme, but the result sits close to what you saw with
no scheme at all. **If you chose a scheme and almost nothing changed, this is
why.**

pi decides this once, and this footer follows that decision rather than guessing
separately. kitty, ghostty, WezTerm, Warp, iTerm2 and Windows Terminal are
recognised on sight. Under tmux or screen it depends on `COLORTERM` being
`truecolor` or `24bit`. Setting `terminal.trueColor` in pi's settings overrides
the lot.

### Reaching a color no scheme offers

A widget's `fg` in the config file names a slot, and the active scheme decides
what that slot looks like. `fg: "brightCyan"` is the terminal's brightCyan under
`default` and the scheme's brightCyan under a scheme, and the widget itself never
knows which. Naming a slot and then choosing a scheme is how you reach a color no
single setting offers.

The slots are the sixteen ANSI names, `black` through `brightWhite`, plus
`default` to inherit, and `pi:<name>` for one of pi's own theme colors. A hex is
not accepted: no scheme could restyle it, and one way for color to reach the
footer is worth more than two.

## How it differs from pi-footer

pi-footer is the larger package and the right choice if you want powerline
segments, an in-terminal config editor, or any of its 56 widgets. This one
keeps 14 widgets, three presets, no config UI and no runtime dependencies.

## Status

Under construction. Not yet published.

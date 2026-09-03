# pi-statusbar

A footer for [`pi`](https://pi.dev) with three presets, emoji or nerd font
icons, and a thinking-level segment that changes color with the level.

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

## How it differs from pi-footer

pi-footer is the larger package and the right choice if you want powerline
segments, an in-terminal config editor, or any of its 56 widgets. This one
keeps 14 widgets, three presets, no config UI and no runtime dependencies.

## Status

Under construction. Not yet published.

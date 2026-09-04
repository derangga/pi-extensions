# pi-catppuccin-themes

[Catppuccin](https://catppuccin.com/) themes for the
[Pi coding agent](https://pi.dev), vendored in-house so installing them never
pulls a third-party repo:

- 🌻 **Latte** (light)
- 🪴 **Frappé** (dark)
- 🌺 **Macchiato** (dark)
- 🌿 **Mocha** (dark)

## Installation

Install from npm, then pick a flavor in Pi via `/settings`:

```sh
pi install pi-catppuccin-themes
```

Or copy the files by hand into your Pi themes directory:

```sh
cp node_modules/pi-catppuccin-themes/themes/catppuccin-*.json ~/.pi/agent/themes/
```

## Accent color

The accent is a single reference at the top of `colors` in each theme file.
To change it, edit the installed file under `~/.pi/agent/themes/`:

```json
"accent": "rosewater"
```

Any of the 26 palette roles works: `rosewater`, `flamingo`, `pink`,
`mauve`, `red`, `maroon`, `peach`, `yellow`, `green`, `teal`, `sky`,
`sapphire`, `blue`, `lavender`, `text`, `subtext1`, `subtext0`, `overlay2`,
`overlay1`, `overlay0`, `surface2`, `surface1`, `surface0`, `base`, `mantle`,
`crust`. Pi watches the themes directory and applies the edit without a
restart.

## Design notes

Theme values follow the official Catppuccin palette, except the tool
success/error backgrounds use the convention from
[catppuccin/delta](https://github.com/catppuccin/delta/blob/main/catppuccin.gitconfig)
(subtle 20% color mixes, stored as literal hex so they render without palette
resolution).

## Credits

Ported from
[otahontas/pi-coding-agent-catppuccin](https://github.com/otahontas/pi-coding-agent-catppuccin).
The palette itself is © Catppuccin, MIT licensed; see
[catppuccin/catppuccin](https://github.com/catppuccin/catppuccin) for details.

## License

MIT. See [LICENSE](./LICENSE).

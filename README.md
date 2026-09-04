# pi-extension

Monorepo for independently published [Pi Coding Agent](https://pi.dev) extensions.

Each package under `packages/` is its own npm package with its own version and
its own README. Install one without installing the others.

## Packages

| Package | What it does | Status |
| --- | --- | --- |
| [`pi-ask-popup`](packages/pi-ask-popup) | A tabbed terminal questionnaire the model opens instead of guessing | Published |
| [`pi-status-widget`](packages/pi-status-widget) | A footer with three presets, emoji or nerd icons, twelve color schemes, and a thinking level that colors itself | Published |
| [`pi-catppuccin-themes`](packages/pi-catppuccin-themes) | The four Catppuccin flavors (latte, frappe, macchiato, mocha) vendored in-house | Published |
| [`pi-unslop-rules`](packages/pi-unslop-rules) | Appends the pstack unslop writing rules to the system prompt every turn, so the prose stays free of AI tells | In progress |

## Working in this repo

```sh
npm install          # installs every workspace
npm run check        # format check, lint, typecheck, tests
npm test             # tests only
```

Every script is scoped to `packages/`. That is deliberate: the repo root also
holds reference clones of other people's Pi extension repos, kept on disk for
reading. They are excluded through `.git/info/exclude` rather than `.gitignore`,
so they stay local to this checkout and never reach anyone else's.

## Adding a package

Create `packages/<name>/` with a `package.json`, a `tsconfig.json` extending
`../../tsconfig.base.json`, `src/`, and `test/`. The workspace glob, the linter,
the formatter and the test runner pick it up with no further wiring. Run
`npm install` afterwards so `package-lock.json` registers the new workspace;
without that, `npm ci` in CI fails.

A Pi extension package needs `"pi": { "extensions": ["./src/index.ts"] }` and a
default-exported function taking `ExtensionAPI`. Extensions ship raw TypeScript;
Pi loads it through jiti, so there is no build step. A themes-only package
instead needs `"pi": { "themes": ["./themes/<name>.json", ...] }` and ships
no code; see `pi-catppuccin-themes` for the shape.

## License

MIT. Individual packages may carry additional copyright holders where they
derive from other MIT-licensed work; see each package's own LICENSE.

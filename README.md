# pi-extension

Monorepo for independently published [Pi Coding Agent](https://pi.dev) extensions.

Each package under `packages/` is its own npm package with its own version and
its own README. Install one without installing the others.

## Packages

| Package | What it does | Status |
| --- | --- | --- |
| [`pi-ask-popup`](packages/pi-ask-popup) | A tabbed terminal questionnaire the model opens instead of guessing | In progress |

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
the formatter and the test runner pick it up with no further wiring.

A Pi extension package needs `"pi": { "extensions": ["./src/index.ts"] }` and a
default-exported function taking `ExtensionAPI`. Extensions ship raw TypeScript;
Pi loads it through jiti, so there is no build step.

## License

MIT. Individual packages may carry additional copyright holders where they
derive from other MIT-licensed work; see each package's own LICENSE.

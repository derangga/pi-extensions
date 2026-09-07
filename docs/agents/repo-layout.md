# Repo layout

```
package.json           private, workspaces: packages/*
tsconfig.base.json     shared compiler options, extended per package
vitest.config.ts       one config, globs packages/*/test/**
.oxlintrc.json         lint rules
.oxfmtrc.json          format rules
packages/<name>/       one npm package each
  package.json  tsconfig.json  LICENSE  README.md  src/  test/
docs/agents/           the files this one lives in
docs/spikes/           prior-art writeups, read-only
```

Root `devDependencies` pin the Pi packages at one exact version so everything
typechecks against the same thing. Individual packages declare Pi as a
`peerDependency` at a wider range.

npm is the package manager, matching every Pi extension repo in the ecosystem.
Do not introduce a second lockfile.

## Every script is scoped to `packages/`

`oxlint packages`, `oxfmt packages`, vitest globbing `packages/*/test/**`. This
is load-bearing, not tidiness.

The repo root also holds vendored clones of other people's Pi extension repos,
kept on disk purely to read: `pi-extensions/`, `pi-footer/`, `rpiv-mono/`. They
carry thousands of their own source and test files. An unscoped glob would lint
them, format them, and run their test suites.

Those clones are excluded through `.git/info/exclude`, deliberately **not**
`.gitignore`. That file is local to the checkout and is never itself tracked, so
the exclusion cannot reach anyone else. Do not move these entries into
`.gitignore`, and do not commit the clones.

## Forked code

Some packages derive from other MIT-licensed work. Where they do, the package
LICENSE carries **every** copyright holder, the original first, and the README
credits the origin. This is the license's condition, not a courtesy. Deleting an
upstream copyright line makes the package unlicensed.

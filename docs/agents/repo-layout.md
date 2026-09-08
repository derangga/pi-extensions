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


# Working in this repo

A monorepo of independently published [Pi Coding Agent](https://pi.dev)
extensions. Each package under `packages/` is its own npm package with its own
version, README and LICENSE. Someone installs one without installing the others.

## Rules

**Never mention issue tracker IDs anywhere in this project.** Not in code
comments, commit messages, READMEs, docs, test names or TODOs. Issue IDs are
tracking metadata; they rot, they mean nothing to someone reading the published
source, and they leak internal process into a package other people install.
Write what the reader needs to know instead: "arrives once the layers it depends
on exist" beats a bare ID that answers nothing.

**Never add `Co-Authored-By` trailers to commits.** No AI attribution, no
generated-with footer. Commit messages describe the change and stop.

## Layout

```
package.json           private, workspaces: packages/*
tsconfig.base.json     shared compiler options, extended per package
vitest.config.ts       one config, globs packages/*/test/**
.oxlintrc.json         lint rules
.oxfmtrc.json          format rules
packages/<name>/       one npm package each
  package.json  tsconfig.json  LICENSE  README.md  src/  test/
```

Root `devDependencies` pin the Pi packages at one exact version so everything
typechecks against the same thing. Individual packages declare Pi as a
`peerDependency` at a wider range.

## Commands

```sh
npm install
npm run check        # fmt:check, lint, typecheck, test, test:bun
npm test             # vitest
npm run test:bun     # the same suite under Bun
npm run fmt          # rewrite formatting
npm run lint:fix
```

`npm run check` is the gate. Run it before you call anything done.

## Two runtimes, on purpose

Pi ships as **both** a Bun-compiled binary and a Node CLI (`engines: node >=22.19`),
and an extension is loaded into whichever one the user installed. So the code
has to run on both.

That gives three standing rules:

- Import Node builtins with the `node:` prefix. Bun implements that surface, so
  `node:fs`, `node:path` and `node:url` work on both.
- Never call a `bun:` API, and never reach for a Node internal that Bun does not
  implement.
- Type against `@types/node`, not `@types/bun`. It describes the surface we
  actually use. `@types/bun` would type globals we are not allowed to call.

The suite runs under vitest and under `bun test` unmodified, because Bun aliases
`vitest` imports to its own runner. Both are in the gate. That is not
belt-and-braces: it is what turns "this works on either runtime" from a claim
into something checked, and a Node-only API sneaking in fails the gate rather
than failing for half the users.

Run the Bun suite scoped, as the script does. A bare `bun test` from the repo
root walks the vendored clones and hangs on their thousands of test files.

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

## Writing a Pi extension package

Extensions ship **raw TypeScript**. Pi resolves `"pi": { "extensions":
["./src/index.ts"] }` and loads it through jiti. There is no build step and no
`dist/`. A published extension that ships compiled output is doing it wrong.

The entry point default-exports a function taking `ExtensionAPI`:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI): void {
  pi.registerTool({ /* … */ });
}
```

Conventions that apply to every package here:

- **Zero runtime dependencies.** Peer-depend on Pi, nothing else. If something
  seems to need a dependency, it almost certainly needs forty lines instead.
- **Peer `typebox`, never `@sinclair/typebox`.** Pi depends on the renamed v1
  package. The old name is a different package that Pi never loads, so peering
  it silently resolves to something unused.
- **Tool schemas are typebox.** That is what `registerTool` takes.
- Node 22+, ESM, `"type": "module"`.
- `files` ships `src/`, docs, README and LICENSE. Never `test/`, never configs.
- Check `npm pack --dry-run` before publishing and read the file list.

## Adding a package

Create `packages/<name>/` with a `package.json`, a `tsconfig.json` extending
`../../tsconfig.base.json`, `src/` and `test/`. The workspace glob, linter,
formatter and test runner pick it up with no further wiring.

Add a manifest test. `packages/pi-ask-popup/test/manifest.test.ts` is the
template: it asserts zero runtime dependencies, the correct peer names, that
every `exports` and `pi.extensions` target exists on disk, and that the tarball
excludes tests. Those are the mistakes that are cheap to prevent and expensive
to find after publishing.

## Forked code

Some packages derive from other MIT-licensed work. Where they do, the package
LICENSE carries **every** copyright holder, the original first, and the README
credits the origin. This is the license's condition, not a courtesy. Deleting an
upstream copyright line makes the package unlicensed.

## Testing

Vitest. Tests live in `packages/<name>/test/` and end in `.test.ts`.

A test that cannot fail is not a test. When you write a guard around something
important, prove it: break the thing on purpose, watch the right test go red and
the others stay green, then revert. Especially for manifest and config tests,
where a typo in the assertion passes forever without ever checking anything.

Silence from a linter looks the same as a linter that scanned nothing. If a tool
reports no findings on a fresh setup, verify it is actually reading your files
before you trust it.

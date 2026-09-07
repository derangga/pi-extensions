# Working in this repo

A monorepo of independently published [Pi Coding Agent](https://pi.dev)
extensions. Each package under `packages/` is its own npm package with its own
version, README and LICENSE. Someone installs one without installing the others.
Nothing here is an app: every package is logic loaded into somebody else's
process, which is why portability and dependency count get their own rules.

## Classify the problem before you start

- **Changing code, designing a feature, or altering a flow** goes through the
  `design-thinking` skill first. Name the shapes, draw the call graph, then
  implement. For an Effect workflow use `anak-intern:design-thinking` instead.
- **Effect code** additionally loads `docs/agents/effect.md`, and
  `anak-intern:effect-best-practices` when useful.
- **A question, a bug hunt, or a read of existing behaviour** needs neither.
  Answer it.

## Commands

```sh
npm install
npm run check        # fmt:check, lint, typecheck, test
npm test
npm run fmt          # rewrite formatting
npm run lint:fix
```

`npm run check` is the gate. Run it before you call anything done.

## Rules

**Never mention issue tracker IDs anywhere in this project.** Not in code
comments, commit messages, READMEs, docs, test names or TODOs. Issue IDs are
tracking metadata; they rot, they mean nothing to someone reading the published
source, and they leak internal process into a package other people install.
Write what the reader needs to know instead: "arrives once the layers it depends
on exist" beats a bare ID that answers nothing.

**Never add `Co-Authored-By` trailers to commits.** No AI attribution, no
generated-with footer. Commit messages describe the change and stop.

**Commits follow Conventional Commits.** `feat:`, `fix:`, `chore:`, `docs:`,
`refactor:`, scoped by package where it helps: `fix(broodmother): …`.

## Deeper detail, read on demand

- `docs/agents/repo-layout.md` covers files, workspaces, why every glob is
  scoped to `packages/`, the vendored clones at the root, and licensing of
  forked code.
- `docs/agents/extension-packages.md` covers writing and adding a package, the
  two runtimes it must survive, and the dependency and manifest conventions.
- `docs/agents/effect.md` says where the authoritative Effect docs are and why.
- `docs/agents/testing.md` covers Vitest and proving a test can fail.

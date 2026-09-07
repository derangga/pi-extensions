# Writing and adding a Pi extension package

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

## Conventions that apply to every package here

- **Fewest runtime dependencies.** Peer-depend on Pi and reach for forty lines
  before a package: most things that look like they need a dependency need code
  instead. One earns its place only by carrying a capability the package is
  built *on* rather than merely uses, and the package's README says which one
  and why. The count is pinned by that package's manifest test, so changing it
  is a deliberate edit rather than a drift.
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
template: it pins the package's exact runtime dependency count, the correct peer
names, that every `exports` and `pi.extensions` target exists on disk, and that
the tarball excludes tests. Those are the mistakes that are cheap to prevent and
expensive to find after publishing.

## The code must run on two runtimes

Pi ships as **both** a Bun-compiled binary and a Node CLI (`engines: node
>=22.19`), and an extension is loaded into whichever one the user installed. The
dev toolchain is Node and npm, but the published code does not get to assume
that.

Three standing rules follow:

- Import Node builtins with the `node:` prefix. Bun implements that surface, so
  `node:fs`, `node:path` and `node:url` work on both.
- Never call a `bun:` API, and never reach for a Node internal that Bun does not
  implement.
- Type against `@types/node`, not `@types/bun`. It describes the surface we
  actually use. `@types/bun` would type globals we are not allowed to call.

Portability is verified at publish time by installing the built package into Pi
under each package manager, not by running the unit suite twice. Extensions are
pure logic until they touch the host, and the places that actually diverge are
`process.stdout.isTTY`, filesystem paths and dynamic `import()`. Take extra care
reviewing those three.

## Reading Pi's own behaviour

Pi's published types and compiled source under
`node_modules/@earendil-works/pi-coding-agent/dist/` are the authority on what
the host actually does. The header a provider needs, the order a lifecycle
fires, whether a facade method reaches the same code path the session does: all
of that is readable there and none of it is reliably guessable.

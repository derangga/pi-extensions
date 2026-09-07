# Effect in this repo

Some packages here use the Effect TypeScript library.

Before writing any Effect code, read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in that file when required. For anything it
does not cover, search `node_modules/effect/src`.

The installed `effect` is a release candidate and its API moves, so anything
written from memory or from a third-party guide is a guess. `Schema` has no
`regex`, the string-pattern check is `Schema.isPattern`, and `Context.Service`
takes its interface as a second type parameter. Each of those was found by
hitting it.

Root pins `effect` as a devDependency at the exact installed version, which is
what keeps `node_modules/effect/src` readable and every package typechecking
against one version.

The `anak-intern:effect-best-practices` and `anak-intern:design-thinking` skills
are useful for shaping a workflow, but they lag the installed RC. Where a skill
and `node_modules/effect/AGENTS.md` disagree, the installed guide wins.

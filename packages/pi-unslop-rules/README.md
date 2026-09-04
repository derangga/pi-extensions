# pi-unslop-rules

Keeps the [Pi coding agent](https://pi.dev) writing like a person for a whole
session, not just for the reply after you ask it to.

It appends the [pstack](https://github.com/cursor/plugins/tree/main/pstack)
unslop rules to the system prompt on every turn: 31 patterns covering AI
vocabulary, em dash overuse, rule-of-three padding, "not just X but Y", title
case headings, and the rest.

## Installation

```sh
pi install npm:pi-unslop-rules
```

That is the whole setup. There is no config, no command and no toggle. Load the
extension and it is on; disable the extension and it is off.

## Why not just install unslop as a skill

Pi has a skill system, and unslop is a skill, so this looks like a package that
should not need to exist. Two things stop that from working.

Upstream's `SKILL.md` sets `disable-model-invocation: true`, and Pi's
`formatSkillsForPrompt` drops those skills from the prompt entirely. They are
reachable only through `/skill:unslop`. Strip the flag and the skill does reach
the prompt, but only as a name and a one-line description that the model may or
may not act on.

Either way it is opt-in per turn. Writing rules that apply on request are rules
that apply to the reply where you remembered to ask.

So this extension takes the one hook that runs every turn:

```ts
pi.on("before_agent_start", (event) => ({
  systemPrompt: `${event.systemPrompt}\n\n${UNSLOP}`,
}));
```

`before_agent_start` fires after the prompt is assembled and before the agent
loop, so the text goes back in after compaction, after `/resume`, and after a
fork. Roughly 1.8k tokens per turn, in the cached part of the prompt.

## What it will not touch

The vendored text opens with a scope section that upstream does not have,
because upstream assumes you invoke the skill deliberately. Always-on needs a
boundary. Code, identifiers, string literals and test fixtures are out. A file
with an established style wins over the rules, so a README already in Title Case
stays in Title Case. Commit messages following a project convention are out, and
so is anything you asked the model to reproduce verbatim.

## Credit

The 31 patterns are from [pstack](https://github.com/cursor/plugins/tree/main/pstack)
by Lauren Tan, MIT licensed, vendored from commit `73f8be4`. See
[`src/unslop.md`](src/unslop.md); everything from `## Process` down is theirs,
verbatim. The persistence and scope sections above it are ours.

## License

MIT. Both copyright holders are named in [LICENSE](LICENSE); the pstack line has
to stay there for the package to be licensed at all.

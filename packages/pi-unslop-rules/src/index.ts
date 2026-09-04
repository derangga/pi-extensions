/**
 * pi-unslop-rules — appends the unslop writing rules to the system prompt on every
 * turn, so the model's voice stays cut of AI tells for the whole session.
 *
 * Pi's own skill loader cannot do this. `formatSkillsForPrompt` drops any skill
 * carrying `disable-model-invocation`, which upstream's unslop does, and even
 * without the flag a skill only contributes its name and description to the
 * prompt. `before_agent_start` fires once per turn with the assembled prompt in
 * hand, which is what "always on" actually needs: it survives compaction,
 * resume and fork, because the prompt is rebuilt each time.
 *
 * Pi resolves this through `pi.extensions` and loads it with jiti, so it ships
 * as raw TypeScript with no build step.
 */

import { readFileSync } from "node:fs";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Read once at load rather than per turn. `new URL(..., import.meta.url)`
 * resolves against the installed package on both runtimes Pi ships as, the Bun
 * binary and the Node CLI, and `node:fs` accepts a URL on both.
 *
 * The file's leading HTML comment travels into the prompt. That is about thirty
 * cached tokens of provenance, cheaper than a regex and a test for the regex.
 */
const UNSLOP = readFileSync(new URL("./unslop.md", import.meta.url), "utf8");

export default function unslopExtension(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${UNSLOP}`,
  }));
}

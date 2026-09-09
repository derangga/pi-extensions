import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Option, Predicate, Schema } from "effect";

import type { AgentChoice } from "./resolve.js";
import { isMissingFile } from "./settings.js";
import { THINKING_LEVELS } from "./thinking.js";

const SAFE_NAME = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/));
const decodeName = Schema.decodeUnknownOption(SAFE_NAME);
const decodeThinking = Schema.decodeUnknownOption(Schema.Literals(THINKING_LEVELS));

export interface AgentFile {
  readonly path: string;
  readonly prompt: string;
  readonly choice: AgentChoice;
}

/**
 * Resolves only the file the caller named. Project-local Pi files outrank the
 * shared agents workspace, which outranks the user's global Pi agent file.
 *
 * Async all the way down: a start call reads one file per distinct agent name
 * on the path between the orchestrator's tool call and the run starting, and
 * sync reads there would hold the manager's fiber on every filesystem hop.
 */
export async function loadAgentFile(
  name: string | undefined,
  cwd: string,
  agentDir = getAgentDir(),
): Promise<AgentFile | undefined> {
  const decoded = decodeName(name?.trim());
  if (Option.isNone(decoded)) {
    return undefined;
  }

  const filename = `${decoded.value}.md`;
  for (const path of [
    join(cwd, ".pi", "agents", filename),
    join(cwd, ".agents", "agents", filename),
    join(agentDir, "agents", filename),
  ]) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (cause) {
      // A location that does not have the file is the normal case; anything
      // else the filesystem can do to a read is a failure the caller reports.
      if (isMissingFile(cause)) {
        continue;
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Could not read agent file ${basename(path)}: ${message}`, { cause });
    }
    return decodeAgentFile(path, text);
  }
  return undefined;
}

function decodeAgentFile(path: string, text: string): AgentFile {
  try {
    const { frontmatter, body } = parseFrontmatter(text);
    const model = Predicate.isString(frontmatter.model) ? frontmatter.model.trim() : "";
    const thinking = decodeThinking(frontmatter.thinking);

    return {
      path,
      prompt: body.trim(),
      choice: {
        ...(model ? { model } : {}),
        ...(Option.isSome(thinking) ? { thinking: thinking.value } : {}),
      },
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Could not read agent file ${basename(path)}: ${message}`, { cause });
  }
}

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Option, Schema } from "effect";

import type { AgentChoice } from "./resolve.js";
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
 */
export function loadAgentFile(
  name: string | undefined,
  cwd: string,
  agentDir = getAgentDir(),
): AgentFile | undefined {
  const decoded = decodeName(name?.trim());
  if (Option.isNone(decoded)) return undefined;

  const filename = `${decoded.value}.md`;
  const path = [
    join(cwd, ".pi", "agents", filename),
    join(cwd, ".agents", "agents", filename),
    join(agentDir, "agents", filename),
  ].find(existsSync);
  if (!path) return undefined;

  try {
    const { frontmatter, body } = parseFrontmatter(readFileSync(path, "utf8"));
    const model = typeof frontmatter.model === "string" ? frontmatter.model.trim() : "";
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

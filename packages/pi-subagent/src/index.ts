import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Entry point. Pi resolves this through `pi.extensions` and loads it with jiti,
 * so it stays raw TypeScript with no build step.
 *
 * The body arrives with the manager: tool registration, the settings command
 * and the widget all hang off `pi`, and none of them exist yet.
 */
export default function subagentExtension(_pi: ExtensionAPI): void {}

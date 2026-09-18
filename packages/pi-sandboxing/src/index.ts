/**
 * pi-sandboxing — Pi extension. One deny list, enforced in three places.
 *
 * Pi ships no sandbox: the file tools resolve whatever absolute path they are
 * handed, and bash runs unwrapped. This extension supplies a kernel profile for
 * bash subprocesses, a `tool_call` gate for the in-process file tools no
 * profile can reach, and a redactor that keeps harvested secret values out of
 * everything leaving a tool.
 *
 * Zero runtime dependencies: the host provides everything
 * (@earendil-works/pi-coding-agent, @earendil-works/pi-tui, typebox) as peers.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function sandboxingExtension(_pi: ExtensionAPI): void {
  // Hooks arrive with the layers they depend on: rules, harvest, redact, profile.
}

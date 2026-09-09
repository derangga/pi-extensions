/**
 * pi-todo-agent — Pi extension. Registers the `todo` tool and the persistent
 * todo overlay above the editor.
 *
 * Zero runtime dependencies: everything the host already provides
 * (@earendil-works/pi-coding-agent, @earendil-works/pi-tui, typebox) rides in
 * as peer dependencies, so an install of this package pulls nothing extra.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (_pi: ExtensionAPI): void {
  // Extension logic lands with the tool registration task; the stub keeps the
  // package loadable so the workspace gate stays green from the first commit.
}

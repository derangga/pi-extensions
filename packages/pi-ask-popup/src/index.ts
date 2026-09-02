import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Extension entry point. Pi resolves this file through `pi.extensions` in
 * package.json and calls the default export once at load.
 *
 * ponytail: deliberately empty. Tool registration and the `before_agent_start`
 * reconciler arrive once the layers they depend on exist. The file is here now
 * so `pi.extensions` resolves and the manifest test can verify the entry point
 * actually ships.
 */
export default function piAskPopup(_pi: ExtensionAPI): void {}

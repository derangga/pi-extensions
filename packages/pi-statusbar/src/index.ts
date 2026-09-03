import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Extension entry. Pi resolves this through `pi.extensions` and loads it with
 * jiti, so it ships as raw TypeScript with no build step.
 *
 * The body arrives once the layers it depends on exist: the color emitter, the
 * widget core, the render pipeline and the data collectors. Until then this is
 * a valid extension that installs cleanly and draws nothing.
 */
export default function statusbarExtension(_pi: ExtensionAPI): void {}

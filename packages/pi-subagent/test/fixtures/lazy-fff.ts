import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function lazyFffFixture(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    pi.registerTool({
      name: "ffgrep",
      label: "Fixture ffgrep",
      description: "A lazily registered stand-in for fff.",
      parameters: Type.Object({ query: Type.String() }),
      async execute(_toolCallId, { query }) {
        return { content: [{ type: "text", text: query }], details: {} };
      },
    });
  });
}
